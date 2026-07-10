const QUERY_KEY = "wgpu-synthetic";
const SCHEMA = "wasm-dolphin.wgpu-synthetic.v1";
const DIAGNOSTIC_SIZE = 64;

const VALID_MODES = new Set(["route", "clear", "static-triangle", "checker", "all"]);

export const SYNTHETIC_COLORS = Object.freeze({
  clear: Object.freeze([26, 77, 153, 255]),
  background: Object.freeze([13, 20, 31, 255]),
  triangle: Object.freeze([230, 89, 64, 255]),
  checkerA: Object.freeze([223, 31, 142, 255]),
  checkerB: Object.freeze([28, 199, 216, 255])
});

const LIMIT_NAMES = [
  "maxTextureDimension1D",
  "maxTextureDimension2D",
  "maxTextureDimension3D",
  "maxTextureArrayLayers",
  "maxBindGroups",
  "maxBindingsPerBindGroup",
  "maxDynamicUniformBuffersPerPipelineLayout",
  "maxDynamicStorageBuffersPerPipelineLayout",
  "maxSampledTexturesPerShaderStage",
  "maxSamplersPerShaderStage",
  "maxStorageBuffersPerShaderStage",
  "maxStorageTexturesPerShaderStage",
  "maxUniformBuffersPerShaderStage",
  "maxUniformBufferBindingSize",
  "maxStorageBufferBindingSize",
  "minUniformBufferOffsetAlignment",
  "minStorageBufferOffsetAlignment",
  "maxVertexBuffers",
  "maxBufferSize",
  "maxVertexAttributes",
  "maxVertexBufferArrayStride",
  "maxInterStageShaderComponents",
  "maxColorAttachments",
  "maxColorAttachmentBytesPerSample",
  "maxComputeWorkgroupStorageSize",
  "maxComputeInvocationsPerWorkgroup",
  "maxComputeWorkgroupSizeX",
  "maxComputeWorkgroupSizeY",
  "maxComputeWorkgroupSizeZ",
  "maxComputeWorkgroupsPerDimension"
];

export function readWebGpuSyntheticRequest(search) {
  const params = new URLSearchParams(search);
  if (!params.has(QUERY_KEY)) {
    return null;
  }

  const rawMode = (params.get(QUERY_KEY) || "all").trim().toLowerCase();
  const mode = rawMode === "triangle" ? "static-triangle" : rawMode;
  return {
    mode,
    presenter: (params.get("presenter") || "webgpu").trim().toLowerCase(),
    rawMode,
    valid: VALID_MODES.has(mode)
  };
}

export async function runWebGpuSyntheticPage({
  request,
  documentRef = globalThis.document,
  globalRef = globalThis
}) {
  const canvas = documentRef?.querySelector?.("#screen");
  const status = documentRef?.querySelector?.("#statusPill");
  const coreLabel = documentRef?.querySelector?.("#coreLabel");
  const gameTitle = documentRef?.querySelector?.("#gameTitle");
  const mountNote = documentRef?.querySelector?.("#mountNote");
  const adapterStatus = documentRef?.querySelector?.("#adapterStatus");
  const screenHud = documentRef?.querySelector?.("#screenHud");

  if (status) status.textContent = "WGPU diagnostic";
  if (coreLabel) coreLabel.textContent = "JS-only WebGPU synthetic route";
  if (gameTitle) gameTitle.textContent = `WebGPU synthetic: ${request.mode}`;
  if (mountNote) mountNote.textContent = "No Dolphin core or real draw commands are active.";
  if (adapterStatus) adapterStatus.textContent = "Probing";
  if (screenHud) screenHud.hidden = true;

  const result = await runWebGpuSyntheticDiagnostics({
    request,
    canvas,
    documentRef,
    gpu: globalRef.navigator?.gpu,
    constants: globalRef
  });

  globalRef.__wgpuSyntheticDiagnostics = result;
  if (status) {
    status.textContent = result.status === "pass" ? "WGPU diagnostic pass" : "WGPU diagnostic fail";
    status.classList.toggle("error", result.status !== "pass");
  }
  if (adapterStatus) adapterStatus.textContent = result.status === "pass" ? "Synthetic pass" : result.classifier.code;
  if (mountNote) mountNote.textContent = result.classifier.marker;
  appendEvidenceSummary(documentRef, result);
  return result;
}

export async function runWebGpuSyntheticDiagnostics({
  request,
  canvas,
  documentRef = globalThis.document,
  gpu = globalThis.navigator?.gpu,
  constants = globalThis,
  now = () => globalThis.performance?.now?.() ?? Date.now()
}) {
  const startedAt = now();
  const evidence = {
    schema: SCHEMA,
    status: "running",
    request: { ...request },
    route: {
      requested: true,
      presenter: request?.presenter || "",
      gpuAvailable: Boolean(gpu)
    },
    deviceLoss: { status: "not-observed" },
    uncapturedErrors: [],
    tests: [],
    markers: [],
    classifier: {
      status: "running",
      code: "RUNNING",
      stage: "route",
      marker: "WGPU_SYNTHETIC_CLASSIFIER:RUNNING"
    }
  };

  const mark = (marker) => {
    evidence.markers.push(marker);
    console.info(`[wgpu-synthetic] ${marker}`);
  };

  if (!request?.valid) {
    return fail(evidence, mark, "INVALID_QUERY", "route", `Unsupported ${QUERY_KEY} mode: ${request?.rawMode || ""}`, startedAt, now);
  }
  if (request.presenter !== "webgpu" && request.presenter !== "wgpu") {
    return fail(evidence, mark, "PRESENTER_ROUTE_MISMATCH", "route", "Synthetic diagnostics require presenter=webgpu", startedAt, now);
  }
  if (!canvas?.getContext) {
    return fail(evidence, mark, "CANVAS_UNAVAILABLE", "context", "#screen canvas is unavailable", startedAt, now);
  }
  if (!gpu?.requestAdapter) {
    return fail(evidence, mark, "WEBGPU_API_UNAVAILABLE", "route", "navigator.gpu is unavailable", startedAt, now);
  }

  const requiredConstants = ["GPUTextureUsage", "GPUBufferUsage", "GPUMapMode"];
  const missingConstants = requiredConstants.filter((name) => !constants?.[name]);
  if (missingConstants.length > 0) {
    return fail(evidence, mark, "WEBGPU_CONSTANTS_UNAVAILABLE", "route", missingConstants.join(", "), startedAt, now);
  }

  let adapter;
  try {
    adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
  } catch (error) {
    return fail(evidence, mark, "ADAPTER_REQUEST_FAILED", "adapter", messageOf(error), startedAt, now);
  }
  if (!adapter) {
    return fail(evidence, mark, "ADAPTER_UNAVAILABLE", "adapter", "requestAdapter returned null", startedAt, now);
  }

  evidence.route.adapter = {
    info: await adapterInfo(adapter),
    features: sortedFeatures(adapter.features),
    limits: supportedLimits(adapter.limits)
  };
  mark("WGPU_SYNTHETIC_ADAPTER:PASS");

  let device;
  try {
    device = await adapter.requestDevice();
  } catch (error) {
    return fail(evidence, mark, "DEVICE_REQUEST_FAILED", "device", messageOf(error), startedAt, now);
  }

  evidence.route.device = {
    features: sortedFeatures(device.features),
    limits: supportedLimits(device.limits)
  };
  mark("WGPU_SYNTHETIC_DEVICE:PASS");

  device.lost?.then((info) => {
    evidence.deviceLoss = {
      status: "lost",
      reason: String(info?.reason || "unknown"),
      message: String(info?.message || "")
    };
    mark(`WGPU_SYNTHETIC_DEVICE_LOST:${evidence.deviceLoss.reason}`);
  });

  const uncapturedHandler = (event) => {
    evidence.uncapturedErrors.push(serializeGpuError(event?.error || event));
    mark("WGPU_SYNTHETIC_UNCAPTURED_ERROR");
  };
  device.addEventListener?.("uncapturederror", uncapturedHandler);

  const context = canvas.getContext("webgpu");
  if (!context) {
    device.removeEventListener?.("uncapturederror", uncapturedHandler);
    return fail(evidence, mark, "CONTEXT_UNAVAILABLE", "context", "canvas.getContext('webgpu') returned null", startedAt, now);
  }

  const format = typeof gpu.getPreferredCanvasFormat === "function" ? gpu.getPreferredCanvasFormat() : "bgra8unorm";
  if (format !== "bgra8unorm" && format !== "rgba8unorm") {
    device.removeEventListener?.("uncapturederror", uncapturedHandler);
    return fail(evidence, mark, "UNSUPPORTED_CANVAS_FORMAT", "context", format, startedAt, now);
  }

  const previousSize = { width: canvas.width, height: canvas.height };
  canvas.width = DIAGNOSTIC_SIZE;
  canvas.height = DIAGNOSTIC_SIZE;
  const usage = constants.GPUTextureUsage.RENDER_ATTACHMENT | constants.GPUTextureUsage.COPY_SRC;
  try {
    context.configure({ device, format, alphaMode: "opaque", usage });
  } catch (error) {
    device.removeEventListener?.("uncapturederror", uncapturedHandler);
    return fail(evidence, mark, "CONTEXT_CONFIGURE_FAILED", "context", messageOf(error), startedAt, now);
  }

  evidence.route.context = {
    format,
    alphaMode: "opaque",
    usage,
    previousSize,
    diagnosticSize: { width: canvas.width, height: canvas.height }
  };
  mark("WGPU_SYNTHETIC_CONTEXT:PASS");
  mark("WGPU_SYNTHETIC_ROUTE:PASS");

  const selected = request.mode === "all" ? ["clear", "static-triangle", "checker"] : request.mode === "route" ? [] : [request.mode];
  for (const name of selected) {
    const result = await runOneDiagnostic({
      name,
      device,
      context,
      format,
      constants,
      documentRef,
      now
    });
    evidence.tests.push(result);
    mark(`WGPU_SYNTHETIC_${name.toUpperCase().replaceAll("-", "_")}:${result.status.toUpperCase()}`);
  }

  device.removeEventListener?.("uncapturederror", uncapturedHandler);
  const failedTest = evidence.tests.find((test) => test.status !== "pass");
  if (failedTest) {
    return fail(evidence, mark, failedTest.code, failedTest.stage, failedTest.error || "Expected output mismatch", startedAt, now);
  }
  if (evidence.uncapturedErrors.length > 0) {
    return fail(evidence, mark, "UNCAUGHT_GPU_ERROR", "error", evidence.uncapturedErrors[0].message, startedAt, now);
  }
  if (evidence.deviceLoss.status === "lost") {
    return fail(evidence, mark, "DEVICE_LOST", "completion", evidence.deviceLoss.message, startedAt, now);
  }

  evidence.status = "pass";
  evidence.elapsedMs = roundMs(now() - startedAt);
  evidence.classifier = {
    status: "pass",
    code: "PASS",
    stage: "complete",
    marker: "WGPU_SYNTHETIC_CLASSIFIER:PASS"
  };
  mark(evidence.classifier.marker);
  return evidence;
}

export function compareRgba(actual, expected, { tolerance = 0, mask = null } = {}) {
  if (actual.length !== expected.length || actual.length % 4 !== 0) {
    return {
      pass: false,
      comparedPixels: 0,
      mismatchCount: Math.max(actual.length, expected.length) / 4,
      maxChannelDelta: 255,
      diff: new Uint8ClampedArray(Math.max(actual.length, expected.length))
    };
  }

  const diff = new Uint8ClampedArray(actual.length);
  let comparedPixels = 0;
  let mismatchCount = 0;
  let maxChannelDelta = 0;
  for (let pixel = 0; pixel < actual.length / 4; pixel += 1) {
    if (mask && !mask[pixel]) continue;
    comparedPixels += 1;
    let mismatch = false;
    for (let channel = 0; channel < 4; channel += 1) {
      const offset = pixel * 4 + channel;
      const delta = Math.abs(actual[offset] - expected[offset]);
      maxChannelDelta = Math.max(maxChannelDelta, delta);
      mismatch ||= delta > tolerance;
    }
    if (mismatch) {
      mismatchCount += 1;
      diff.set([255, 0, 0, 255], pixel * 4);
    }
  }

  return {
    pass: mismatchCount === 0 && comparedPixels > 0,
    comparedPixels,
    mismatchCount,
    maxChannelDelta,
    diff
  };
}

export function makeSolidExpected(width, height, color) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) pixels.set(color, offset);
  return pixels;
}

export function makeCheckerExpected(width, height) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const tx = Math.min(7, Math.floor((x * 8) / width));
      const ty = Math.min(7, Math.floor((y * 8) / height));
      pixels.set((tx + ty) % 2 === 0 ? SYNTHETIC_COLORS.checkerA : SYNTHETIC_COLORS.checkerB, (y * width + x) * 4);
    }
  }
  return pixels;
}

export function makeTriangleExpected(width, height) {
  const pixels = makeSolidExpected(width, height, SYNTHETIC_COLORS.background);
  const mask = new Uint8Array(width * height);
  const a = [-0.75, -0.75];
  const b = [0.75, -0.75];
  const c = [0, 0.75];
  const edgeGuard = 2 / Math.min(width, height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const point = [((x + 0.5) / width) * 2 - 1, 1 - ((y + 0.5) / height) * 2];
      const inside = pointInTriangle(point, a, b, c);
      const pixel = y * width + x;
      if (inside) pixels.set(SYNTHETIC_COLORS.triangle, pixel * 4);
      mask[pixel] = distanceFromTriangleEdges(point, a, b, c) > edgeGuard ? 1 : 0;
    }
  }
  return { pixels, mask };
}

async function runOneDiagnostic(options) {
  try {
    if (options.name === "clear") return await runClear(options);
    if (options.name === "static-triangle") return await runTriangle(options);
    return await runChecker(options);
  } catch (error) {
    return {
      name: options.name,
      status: "fail",
      code: error?.code || "UNEXPECTED_DIAGNOSTIC_ERROR",
      stage: error?.stage || options.name,
      error: messageOf(error)
    };
  }
}

async function runClear(options) {
  const expected = makeSolidExpected(DIAGNOSTIC_SIZE, DIAGNOSTIC_SIZE, SYNTHETIC_COLORS.clear);
  return runRenderAndValidate(options, {
    expected,
    tolerance: 1,
    encode({ encoder, view }) {
      const pass = encoder.beginRenderPass({
        label: "wgpu-synthetic-clear-pass",
        colorAttachments: [{
          view,
          clearValue: normalizedColor(SYNTHETIC_COLORS.clear),
          loadOp: "clear",
          storeOp: "store"
        }]
      });
      pass.end();
    }
  });
}

async function runTriangle(options) {
  const { device, format } = options;
  const shader = createShaderModule(device, {
    label: "wgpu-synthetic-static-triangle",
    code: `
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
}

@vertex
fn vs(@builtin(vertex_index) index: u32) -> VertexOutput {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-0.75, -0.75),
    vec2<f32>(0.75, -0.75),
    vec2<f32>(0.0, 0.75)
  );
  var output: VertexOutput;
  output.position = vec4<f32>(positions[index], 0.0, 1.0);
  return output;
}

@fragment
fn fs() -> @location(0) vec4<f32> {
  return vec4<f32>(${normalizedLiteral(SYNTHETIC_COLORS.triangle)});
}`
  }, "static-triangle.shader");
  const shaderEvidence = await shaderCompilationEvidence(shader);
  if (shaderEvidence.errors.length > 0) throw stageError("SHADER_COMPILE_FAILED", "static-triangle.shader", shaderEvidence.errors[0].message);
  const pipeline = await createPipeline(device, {
    label: "wgpu-synthetic-static-triangle",
    layout: "auto",
    vertex: { module: shader, entryPoint: "vs" },
    fragment: { module: shader, entryPoint: "fs", targets: [{ format }] },
    primitive: { topology: "triangle-list" }
  }, "static-triangle.pipeline");
  const expected = makeTriangleExpected(DIAGNOSTIC_SIZE, DIAGNOSTIC_SIZE);
  const result = await runRenderAndValidate(options, {
    expected: expected.pixels,
    mask: expected.mask,
    tolerance: 1,
    encode({ encoder, view }) {
      const pass = encoder.beginRenderPass({
        label: "wgpu-synthetic-static-triangle-pass",
        colorAttachments: [{
          view,
          clearValue: normalizedColor(SYNTHETIC_COLORS.background),
          loadOp: "clear",
          storeOp: "store"
        }]
      });
      pass.setPipeline(pipeline);
      pass.draw(3);
      pass.end();
    }
  });
  result.shader = shaderEvidence;
  result.samples = validateTriangleSamples(result.actual, DIAGNOSTIC_SIZE, DIAGNOSTIC_SIZE);
  if (!result.samples.every((sample) => sample.pass)) {
    result.status = "fail";
    result.code = "TRIANGLE_SAMPLE_MISMATCH";
    result.stage = "static-triangle.expected-output";
  }
  delete result.actual;
  return result;
}

async function runChecker(options) {
  const { device, format, constants } = options;
  const textureBytes = checkerTextureBytes();
  let texture;
  try {
    texture = device.createTexture({
      label: "wgpu-synthetic-checker-upload",
      size: { width: 8, height: 8 },
      format: "rgba8unorm",
      usage: constants.GPUTextureUsage.TEXTURE_BINDING | constants.GPUTextureUsage.COPY_DST
    });
  } catch (error) {
    throw stageError("TEXTURE_CREATE_FAILED", "checker.texture", messageOf(error));
  }
  const upload = await uploadCheckerTexture(device, texture, textureBytes, options.now);

  const shader = createShaderModule(device, {
    label: "wgpu-synthetic-checker-blit",
    code: `
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
}

@vertex
fn vs(@builtin(vertex_index) index: u32) -> VertexOutput {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0)
  );
  var output: VertexOutput;
  output.position = vec4<f32>(positions[index], 0.0, 1.0);
  return output;
}

@group(0) @binding(0) var checker_texture: texture_2d<f32>;

@fragment
fn fs(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let dimensions = textureDimensions(checker_texture);
  let x = min(i32(position.x) * i32(dimensions.x) / ${DIAGNOSTIC_SIZE}, i32(dimensions.x) - 1);
  let y = min(i32(position.y) * i32(dimensions.y) / ${DIAGNOSTIC_SIZE}, i32(dimensions.y) - 1);
  return textureLoad(checker_texture, vec2<i32>(x, y), 0);
}`
  }, "checker.shader");
  const shaderEvidence = await shaderCompilationEvidence(shader);
  if (shaderEvidence.errors.length > 0) throw stageError("SHADER_COMPILE_FAILED", "checker.shader", shaderEvidence.errors[0].message);
  const pipeline = await createPipeline(device, {
    label: "wgpu-synthetic-checker-blit",
    layout: "auto",
    vertex: { module: shader, entryPoint: "vs" },
    fragment: { module: shader, entryPoint: "fs", targets: [{ format }] },
    primitive: { topology: "triangle-list" }
  }, "checker.pipeline");
  let bindGroup;
  try {
    bindGroup = device.createBindGroup({
      label: "wgpu-synthetic-checker-bind-group",
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: texture.createView() }]
    });
  } catch (error) {
    throw stageError("BIND_GROUP_CREATE_FAILED", "checker.bind-group", messageOf(error));
  }

  const result = await runRenderAndValidate(options, {
    expected: makeCheckerExpected(DIAGNOSTIC_SIZE, DIAGNOSTIC_SIZE),
    tolerance: 1,
    encode({ encoder, view }) {
      const pass = encoder.beginRenderPass({
        label: "wgpu-synthetic-checker-pass",
        colorAttachments: [{
          view,
          clearValue: normalizedColor(SYNTHETIC_COLORS.background),
          loadOp: "clear",
          storeOp: "store"
        }]
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3);
      pass.end();
    }
  });
  result.upload = upload;
  result.shader = shaderEvidence;
  result.samples = validateCheckerSamples(result.actual, DIAGNOSTIC_SIZE, DIAGNOSTIC_SIZE);
  if (!result.samples.every((sample) => sample.pass)) {
    result.status = "fail";
    result.code = "CHECKER_TEXEL_MISMATCH";
    result.stage = "checker.expected-output";
  }
  delete result.actual;
  return result;
}

async function runRenderAndValidate(options, { expected, mask = null, tolerance, encode }) {
  const { name, device, context, format, constants, documentRef, now } = options;
  let scopeOpen = false;
  const submit = { submitted: false, completed: false };
  try {
    device.pushErrorScope("validation");
    scopeOpen = true;
    const texture = context.getCurrentTexture();
    const encoder = device.createCommandEncoder({ label: `wgpu-synthetic-${name}` });
    encode({ encoder, view: texture.createView() });

    const bytesPerRow = align(DIAGNOSTIC_SIZE * 4, 256);
    const readback = device.createBuffer({
      label: `wgpu-synthetic-${name}-readback`,
      size: bytesPerRow * DIAGNOSTIC_SIZE,
      usage: constants.GPUBufferUsage.COPY_DST | constants.GPUBufferUsage.MAP_READ
    });
    encoder.copyTextureToBuffer(
      { texture },
      { buffer: readback, bytesPerRow, rowsPerImage: DIAGNOSTIC_SIZE },
      { width: DIAGNOSTIC_SIZE, height: DIAGNOSTIC_SIZE }
    );

    const submittedAt = now();
    try {
      device.queue.submit([encoder.finish()]);
      submit.submitted = true;
      submit.submittedAtMs = roundMs(submittedAt);
    } catch (error) {
      throw stageError("SUBMIT_FAILED", `${name}.submit`, messageOf(error));
    }
    try {
      await device.queue.onSubmittedWorkDone();
      submit.completed = true;
      submit.completionMs = roundMs(now() - submittedAt);
    } catch (error) {
      throw stageError("COMPLETION_FAILED", `${name}.completion`, messageOf(error));
    }

    let scopedError;
    try {
      scopedError = await device.popErrorScope();
      scopeOpen = false;
    } catch (error) {
      throw stageError("ERROR_SCOPE_FAILED", `${name}.error-scope`, messageOf(error));
    }
    if (scopedError) throw stageError("VALIDATION_ERROR", `${name}.validation`, serializeGpuError(scopedError).message);

    try {
      await readback.mapAsync(constants.GPUMapMode.READ);
    } catch (error) {
      throw stageError("READBACK_FAILED", `${name}.readback`, messageOf(error));
    }
    const actual = unpackReadback(new Uint8Array(readback.getMappedRange()), DIAGNOSTIC_SIZE, DIAGNOSTIC_SIZE, bytesPerRow, format);
    readback.unmap();

    const validation = compareRgba(actual, expected, { tolerance, mask });
    return {
      name,
      status: validation.pass ? "pass" : "fail",
      code: validation.pass ? "PASS" : "EXPECTED_OUTPUT_MISMATCH",
      stage: validation.pass ? `${name}.complete` : `${name}.expected-output`,
      errorScope: { type: "validation", error: null },
      submit,
      validation: withoutDiff(validation),
      imageArtifacts: imageArtifacts(documentRef, actual, expected, validation.diff, DIAGNOSTIC_SIZE, DIAGNOSTIC_SIZE),
      actual
    };
  } finally {
    if (scopeOpen) {
      try {
        await device.popErrorScope();
      } catch {
        // The original stage error remains the classifier source.
      }
    }
  }
}

async function createPipeline(device, descriptor, stage) {
  try {
    return typeof device.createRenderPipelineAsync === "function"
      ? await device.createRenderPipelineAsync(descriptor)
      : device.createRenderPipeline(descriptor);
  } catch (error) {
    throw stageError("PIPELINE_CREATE_FAILED", stage, messageOf(error));
  }
}

function createShaderModule(device, descriptor, stage) {
  try {
    return device.createShaderModule(descriptor);
  } catch (error) {
    throw stageError("SHADER_CREATE_FAILED", stage, messageOf(error));
  }
}

async function uploadCheckerTexture(device, texture, bytes, now) {
  let scopeOpen = false;
  const startedAt = now();
  try {
    device.pushErrorScope("validation");
    scopeOpen = true;
    device.queue.writeTexture(
      { texture },
      bytes,
      { bytesPerRow: 32, rowsPerImage: 8 },
      { width: 8, height: 8 }
    );
    await device.queue.onSubmittedWorkDone();
    const scopedError = await device.popErrorScope();
    scopeOpen = false;
    if (scopedError) {
      throw stageError("TEXTURE_UPLOAD_VALIDATION_ERROR", "checker.upload", serializeGpuError(scopedError).message);
    }
    return {
      bytes: bytes.byteLength,
      completed: true,
      completionMs: roundMs(now() - startedAt),
      errorScope: { type: "validation", error: null }
    };
  } catch (error) {
    if (error?.code) throw error;
    throw stageError("TEXTURE_UPLOAD_FAILED", "checker.upload", messageOf(error));
  } finally {
    if (scopeOpen) {
      try {
        await device.popErrorScope();
      } catch {
        // The upload failure remains the classifier source.
      }
    }
  }
}

async function shaderCompilationEvidence(shader) {
  if (typeof shader.getCompilationInfo !== "function") return { messages: [], errors: [] };
  const info = await shader.getCompilationInfo();
  const messages = [...(info?.messages || [])].map((message) => ({
    type: String(message.type || "info"),
    message: String(message.message || ""),
    lineNum: Number(message.lineNum || 0),
    linePos: Number(message.linePos || 0)
  }));
  return { messages, errors: messages.filter((message) => message.type === "error") };
}

function validateTriangleSamples(actual, width, height) {
  return [
    sample(actual, width, 32, 24, SYNTHETIC_COLORS.triangle, "inside-upper"),
    sample(actual, width, 32, 43, SYNTHETIC_COLORS.triangle, "inside-lower"),
    sample(actual, width, 4, 4, SYNTHETIC_COLORS.background, "outside-top-left"),
    sample(actual, width, 59, 32, SYNTHETIC_COLORS.background, "outside-right"),
    sample(actual, width, 32, height - 3, SYNTHETIC_COLORS.background, "outside-bottom")
  ];
}

function validateCheckerSamples(actual, width, height) {
  return [
    sample(actual, width, 4, 4, SYNTHETIC_COLORS.checkerA, "texel-0-0"),
    sample(actual, width, 12, 4, SYNTHETIC_COLORS.checkerB, "texel-1-0"),
    sample(actual, width, 4, 12, SYNTHETIC_COLORS.checkerB, "texel-0-1"),
    sample(actual, width, width - 4, height - 4, SYNTHETIC_COLORS.checkerA, "texel-7-7")
  ];
}

function sample(actual, width, x, y, expected, label) {
  const rgba = [...actual.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];
  const maxChannelDelta = Math.max(...rgba.map((value, index) => Math.abs(value - expected[index])));
  return { label, x, y, rgba, expected: [...expected], maxChannelDelta, pass: maxChannelDelta <= 1 };
}

function checkerTextureBytes() {
  const bytes = new Uint8Array(8 * 8 * 4);
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) bytes.set((x + y) % 2 === 0 ? SYNTHETIC_COLORS.checkerA : SYNTHETIC_COLORS.checkerB, (y * 8 + x) * 4);
  }
  return bytes;
}

function unpackReadback(bytes, width, height, bytesPerRow, format) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const source = y * bytesPerRow + x * 4;
      const target = (y * width + x) * 4;
      if (format === "bgra8unorm") {
        pixels.set([bytes[source + 2], bytes[source + 1], bytes[source], bytes[source + 3]], target);
      } else {
        pixels.set(bytes.subarray(source, source + 4), target);
      }
    }
  }
  return pixels;
}

function imageArtifacts(documentRef, actual, expected, diff, width, height) {
  return {
    actual: pixelsToDataUrl(documentRef, actual, width, height),
    expected: pixelsToDataUrl(documentRef, expected, width, height),
    diff: pixelsToDataUrl(documentRef, diff, width, height)
  };
}

function pixelsToDataUrl(documentRef, pixels, width, height) {
  const canvas = documentRef?.createElement?.("canvas");
  if (!canvas) return null;
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  const image = context.createImageData(width, height);
  image.data.set(pixels);
  context.putImageData(image, 0, 0);
  return canvas.toDataURL("image/png");
}

function appendEvidenceSummary(documentRef, result) {
  const panel = documentRef?.querySelector?.(".control-panel");
  if (!panel || documentRef.querySelector("#wgpuSyntheticEvidence")) return;
  const pre = documentRef.createElement("pre");
  pre.id = "wgpuSyntheticEvidence";
  pre.style.whiteSpace = "pre-wrap";
  pre.style.fontSize = "11px";
  pre.textContent = JSON.stringify({
    schema: result.schema,
    status: result.status,
    classifier: result.classifier,
    route: result.route,
    tests: result.tests.map(({ name, status, code, stage, submit, validation, samples }) => ({ name, status, code, stage, submit, validation, samples })),
    uncapturedErrors: result.uncapturedErrors,
    deviceLoss: result.deviceLoss,
    markers: result.markers
  }, null, 2);
  panel.append(pre);
}

function fail(evidence, mark, code, stage, error, startedAt, now) {
  evidence.status = "fail";
  evidence.elapsedMs = roundMs(now() - startedAt);
  evidence.classifier = {
    status: "fail",
    code,
    stage,
    error: String(error || ""),
    marker: `WGPU_SYNTHETIC_CLASSIFIER:FAIL:${code}:${stage}`
  };
  mark(evidence.classifier.marker);
  return evidence;
}

function stageError(code, stage, message) {
  const error = new Error(message);
  error.code = code;
  error.stage = stage;
  return error;
}

async function adapterInfo(adapter) {
  try {
    const info = adapter.info || (typeof adapter.requestAdapterInfo === "function" ? await adapter.requestAdapterInfo() : null);
    if (!info) return {};
    return Object.fromEntries(["vendor", "architecture", "device", "description", "subgroupMinSize", "subgroupMaxSize"].filter((key) => info[key] !== undefined).map((key) => [key, info[key]]));
  } catch (error) {
    return { error: messageOf(error) };
  }
}

function supportedLimits(limits) {
  return Object.fromEntries(LIMIT_NAMES.filter((name) => Number.isFinite(Number(limits?.[name]))).map((name) => [name, Number(limits[name])]));
}

function sortedFeatures(features) {
  try {
    return [...(features || [])].map(String).sort();
  } catch {
    return [];
  }
}

function serializeGpuError(error) {
  return {
    name: String(error?.constructor?.name || error?.name || "GPUError"),
    message: messageOf(error)
  };
}

function pointInTriangle(point, a, b, c) {
  const d1 = signedArea(point, a, b);
  const d2 = signedArea(point, b, c);
  const d3 = signedArea(point, c, a);
  return !(d1 < 0 || d2 < 0 || d3 < 0) || !(d1 > 0 || d2 > 0 || d3 > 0);
}

function distanceFromTriangleEdges(point, a, b, c) {
  return Math.min(distanceFromLine(point, a, b), distanceFromLine(point, b, c), distanceFromLine(point, c, a));
}

function signedArea(point, a, b) {
  return (point[0] - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (point[1] - b[1]);
}

function distanceFromLine(point, a, b) {
  return Math.abs((b[1] - a[1]) * point[0] - (b[0] - a[0]) * point[1] + b[0] * a[1] - b[1] * a[0]) / Math.hypot(b[1] - a[1], b[0] - a[0]);
}

function normalizedColor(color) {
  return { r: color[0] / 255, g: color[1] / 255, b: color[2] / 255, a: color[3] / 255 };
}

function normalizedLiteral(color) {
  return color.map((value) => (value / 255).toFixed(9)).join(", ");
}

function withoutDiff(validation) {
  const { diff: _diff, ...summary } = validation;
  return summary;
}

function align(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}

function roundMs(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

function messageOf(error) {
  return String(error?.message || error || "unknown error");
}
