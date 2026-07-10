import assert from "node:assert/strict";
import test from "node:test";

import {
  SYNTHETIC_COLORS,
  SYNTHETIC_WGPU_COMMAND_OP,
  buildWebGpuSyntheticExport,
  compareRgba,
  decodeSyntheticWgpuCommandRecord,
  dispatchSyntheticWgpuCommandRecord,
  encodeSyntheticWgpuCommandRecord,
  makeCheckerExpected,
  makeSolidExpected,
  makeTriangleExpected,
  readWebGpuSyntheticRequest,
  runWebGpuSyntheticDiagnostics
} from "../src/wgpu-synthetic-diagnostics.js";

test("WGPU synthetic route is absent unless its query gate is present", () => {
  assert.equal(readWebGpuSyntheticRequest("?presenter=webgpu"), null);
  const request = readWebGpuSyntheticRequest(
    "?wgpu-synthetic&presenter=webgpu&diag-repo-commit=abc123&diag-repo-dirty=1" +
      "&diag-core-id=dolphin-core&diag-core-sha256=deadbeef"
  );
  assert.equal(request.mode, "all");
  assert.equal(request.presenter, "webgpu");
  assert.equal(request.rawMode, "all");
  assert.equal(request.valid, true);
  assert.deepEqual(request.provenance, {
    repo: { commit: "abc123", dirty: true },
    core: { id: "dolphin-core", sha256: "deadbeef" }
  });
  assert.equal(readWebGpuSyntheticRequest("?wgpu-synthetic=triangle").mode, "static-triangle");
  assert.equal(readWebGpuSyntheticRequest("?wgpu-synthetic=command-ring").valid, true);
  assert.equal(readWebGpuSyntheticRequest("?wgpu-synthetic=unknown").valid, false);
});

test("clear validation permits one 8-bit channel value and rejects two", () => {
  const expected = makeSolidExpected(2, 1, SYNTHETIC_COLORS.clear);
  const withinTolerance = new Uint8ClampedArray(expected);
  withinTolerance[0] += 1;
  assert.equal(compareRgba(withinTolerance, expected, { tolerance: 1 }).pass, true);

  const outsideTolerance = new Uint8ClampedArray(expected);
  outsideTolerance[0] += 2;
  const result = compareRgba(outsideTolerance, expected, { tolerance: 1 });
  assert.equal(result.pass, false);
  assert.equal(result.mismatchCount, 1);
  assert.equal(result.maxChannelDelta, 2);
});

test("static triangle oracle compares the full safe image and ignores only raster edges", () => {
  const expected = makeTriangleExpected(64, 64);
  const clean = compareRgba(expected.pixels, expected.pixels, { tolerance: 1, mask: expected.mask });
  assert.equal(clean.pass, true);
  assert.ok(clean.comparedPixels > 3000);

  const corrupted = new Uint8ClampedArray(expected.pixels);
  corrupted.set(SYNTHETIC_COLORS.background, (24 * 64 + 32) * 4);
  const result = compareRgba(corrupted, expected.pixels, { tolerance: 1, mask: expected.mask });
  assert.equal(result.pass, false);
  assert.equal(result.mismatchCount, 1);
});

test("checker oracle has exact alternating texels and catches a wrong upload", () => {
  const expected = makeCheckerExpected(64, 64);
  assert.deepEqual([...expected.subarray((4 * 64 + 4) * 4, (4 * 64 + 4) * 4 + 4)], SYNTHETIC_COLORS.checkerA);
  assert.deepEqual([...expected.subarray((4 * 64 + 12) * 4, (4 * 64 + 12) * 4 + 4)], SYNTHETIC_COLORS.checkerB);

  const corrupted = new Uint8ClampedArray(expected);
  corrupted.set(SYNTHETIC_COLORS.checkerA, (4 * 64 + 12) * 4);
  assert.equal(compareRgba(corrupted, expected, { tolerance: 1 }).pass, false);
});

test("route failures emit a stable classifier marker before touching a core", async () => {
  const request = readWebGpuSyntheticRequest("?wgpu-synthetic=route&presenter=webgpu");
  const result = await runWebGpuSyntheticDiagnostics({
    request,
    canvas: { getContext() { throw new Error("must not ask for a context without navigator.gpu"); } },
    gpu: null,
    constants: {},
    now: () => 1
  });
  assert.equal(result.status, "fail");
  assert.equal(result.classifier.code, "WEBGPU_API_UNAVAILABLE");
  assert.equal(result.classifier.stage, "route");
  assert.equal(result.classifier.marker, "WGPU_SYNTHETIC_CLASSIFIER:FAIL:WEBGPU_API_UNAVAILABLE:route");
});

test("non-WebGPU presenter is classified without requesting an adapter", async () => {
  const request = readWebGpuSyntheticRequest("?wgpu-synthetic=all&presenter=webgl");
  let adapterRequested = false;
  const result = await runWebGpuSyntheticDiagnostics({
    request,
    canvas: { getContext() { return {}; } },
    gpu: { requestAdapter() { adapterRequested = true; } },
    constants: {},
    now: () => 1
  });
  assert.equal(result.classifier.code, "PRESENTER_ROUTE_MISMATCH");
  assert.equal(adapterRequested, false);
});

test("evidence records durable browser, source, core, and output attribution", async () => {
  const request = readWebGpuSyntheticRequest(
    "?wgpu-synthetic=route&diag-repo-commit=abc123&diag-repo-dirty=0" +
      "&diag-core-id=core.js&diag-core-sha256=feedface&diag-output=.omx/custom/run"
  );
  const result = await runWebGpuSyntheticDiagnostics({
    request,
    canvas: { getContext() { throw new Error("must not ask for a context without navigator.gpu"); } },
    gpu: null,
    constants: {},
    locationHref: "http://127.0.0.1:8080/?wgpu-synthetic=route",
    now: () => 10,
    userAgent: "Mozilla/5.0 Chrome/126.0.6478.1 Safari/537.36",
    wallNow: () => Date.parse("2026-07-09T12:34:56.000Z")
  });
  assert.equal(result.startedAtUtc, "2026-07-09T12:34:56.000Z");
  assert.equal(result.finishedAtUtc, "2026-07-09T12:34:56.000Z");
  assert.equal(result.attribution.url, "http://127.0.0.1:8080/?wgpu-synthetic=route");
  assert.equal(result.attribution.browser.chromeVersion, "126.0.6478.1");
  assert.deepEqual(result.attribution.repo, { commit: "abc123", dirty: false });
  assert.deepEqual(result.attribution.core, { id: "core.js", sha256: "feedface" });
  assert.equal(result.output.rawEvidencePath, ".omx/custom/run/evidence.json");
  assert.equal(result.output.exportFunction, "window.__exportWgpuSyntheticDiagnostics()");
});

test("evidence export includes raw JSON and named image artifacts", () => {
  const bundle = buildWebGpuSyntheticExport({
    output: { runId: "run-1", suggestedDirectory: ".omx/wgpu-synthetic/run-1" },
    status: "pass",
    tests: [{
      name: "static-triangle",
      imageArtifacts: {
        actual: "data:image/png;base64,AAAA",
        expected: "data:image/png;base64,BBBB",
        diff: "data:image/png;base64,CCCC"
      }
    }]
  });
  assert.equal(bundle.suggestedDirectory, ".omx/wgpu-synthetic/run-1");
  assert.deepEqual(bundle.files.map((file) => file.name), [
    "evidence.json",
    "static-triangle-actual.png",
    "static-triangle-expected.png",
    "static-triangle-diff.png"
  ]);
  assert.match(bundle.files[0].content, /"status": "pass"/);
});

test("synthetic command records decode and dispatch CLEAR and DRAW_TEST only", async () => {
  const clear = encodeSyntheticWgpuCommandRecord(
    SYNTHETIC_WGPU_COMMAND_OP.CLEAR,
    [0.1, 0.2, 0.3, 1]
  );
  const decoded = decodeSyntheticWgpuCommandRecord(clear);
  assert.equal(decoded.byteLength, 32);
  assert.equal(decoded.opName, "CLEAR");
  assert.ok(Math.abs(decoded.payload[1] - 0.2) < 1e-6);

  const calls = [];
  const clearDispatch = await dispatchSyntheticWgpuCommandRecord(clear, {
    clear(record) { calls.push(record.opName); return "clear-result"; }
  });
  const drawDispatch = await dispatchSyntheticWgpuCommandRecord(
    encodeSyntheticWgpuCommandRecord(SYNTHETIC_WGPU_COMMAND_OP.DRAW_TEST),
    { drawTest(record) { calls.push(record.opName); return "draw-result"; } }
  );
  assert.equal(clearDispatch.result, "clear-result");
  assert.equal(drawDispatch.result, "draw-result");
  assert.deepEqual(calls, ["CLEAR", "DRAW_TEST"]);
  assert.throws(() => decodeSyntheticWgpuCommandRecord(new Uint8Array(8)), /32 bytes/);
});

test("submit failures retain partial queue and error-scope evidence and clean resources", async () => {
  const fake = createFakeWebGpu({ submitError: new Error("synthetic submit failure") });
  const result = await runWebGpuSyntheticDiagnostics({
    request: readWebGpuSyntheticRequest("?wgpu-synthetic=clear"),
    ...fake.inputs,
    documentRef: null,
    now: incrementingClock(),
    wallNow: () => Date.parse("2026-07-09T12:34:56.000Z")
  });
  const clear = result.tests[0];
  assert.equal(result.classifier.code, "SUBMIT_FAILED");
  assert.equal(clear.submit.submitted, false);
  assert.equal(clear.submit.completed, false);
  assert.ok(Number.isFinite(clear.submit.attemptedAtMs));
  assert.equal(clear.errorScope.pushed, true);
  assert.equal(clear.errorScope.popped, true);
  assert.equal(clear.resources.readback.destroyed, true);
  assert.equal(fake.state.removedListeners, 1);
  assert.equal(result.cleanup.uncapturedListenerRemoved, true);
});

test("checker scopes resource creation and destroys texture and readback on mismatch", async () => {
  const fake = createFakeWebGpu();
  const result = await runWebGpuSyntheticDiagnostics({
    request: readWebGpuSyntheticRequest("?wgpu-synthetic=checker"),
    ...fake.inputs,
    documentRef: null,
    now: incrementingClock(),
    wallNow: () => Date.parse("2026-07-09T12:34:56.000Z")
  });
  const checker = result.tests[0];
  assert.equal(result.classifier.code, "CHECKER_TEXEL_MISMATCH");
  assert.equal(checker.resources.checkerTexture.errorScope.pushed, true);
  assert.equal(checker.resources.checkerTexture.errorScope.popped, true);
  assert.equal(checker.resources.checkerTexture.destroyed, true);
  assert.equal(checker.resources.bindGroup.errorScope.pushed, true);
  assert.equal(checker.resources.bindGroup.errorScope.popped, true);
  assert.equal(checker.resources.readback.destroyed, true);
  assert.ok(fake.state.pushedScopes >= 4);
  assert.equal(fake.state.destroyedTextures, 1);
  assert.equal(fake.state.destroyedBuffers, 1);
});

function incrementingClock() {
  let value = 0;
  return () => ++value;
}

function createFakeWebGpu({ submitError = null } = {}) {
  const state = {
    destroyedBuffers: 0,
    destroyedTextures: 0,
    pushedScopes: 0,
    removedListeners: 0
  };
  const queue = {
    onSubmittedWorkDone: async () => {},
    submit() {
      if (submitError) throw submitError;
    },
    writeTexture() {}
  };
  const device = {
    addEventListener() {},
    removeEventListener() { state.removedListeners += 1; },
    features: new Set(),
    limits: {},
    lost: new Promise(() => {}),
    queue,
    pushErrorScope() { state.pushedScopes += 1; },
    async popErrorScope() { return null; },
    createBindGroup() { return {}; },
    createBuffer({ size }) {
      const mapped = new ArrayBuffer(size);
      return {
        async mapAsync() {},
        getMappedRange() { return mapped; },
        unmap() {},
        destroy() { state.destroyedBuffers += 1; }
      };
    },
    createCommandEncoder() {
      return {
        beginRenderPass() {
          return {
            draw() {},
            end() {},
            setBindGroup() {},
            setPipeline() {}
          };
        },
        copyTextureToBuffer() {},
        finish() { return {}; }
      };
    },
    createRenderPipelineAsync: async () => ({ getBindGroupLayout() { return {}; } }),
    createShaderModule() {
      return { async getCompilationInfo() { return { messages: [] }; } };
    },
    createTexture() {
      return {
        createView() { return {}; },
        destroy() { state.destroyedTextures += 1; }
      };
    }
  };
  const context = {
    configure() {},
    getCurrentTexture() { return { createView() { return {}; } }; }
  };
  const adapter = {
    features: new Set(),
    info: { vendor: "fake" },
    limits: {},
    async requestDevice() { return device; }
  };
  return {
    inputs: {
      canvas: { width: 640, height: 480, getContext() { return context; } },
      constants: {
        GPUBufferUsage: { COPY_DST: 1, MAP_READ: 2 },
        GPUMapMode: { READ: 1 },
        GPUTextureUsage: { COPY_DST: 2, COPY_SRC: 4, RENDER_ATTACHMENT: 8, TEXTURE_BINDING: 16 }
      },
      gpu: {
        getPreferredCanvasFormat() { return "bgra8unorm"; },
        async requestAdapter() { return adapter; }
      }
    },
    state
  };
}
