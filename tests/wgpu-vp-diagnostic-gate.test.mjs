// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const worker = (await readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8"))
  .replace(/\r\n/g, "\n");
function between(first, last) {
  const start = worker.indexOf(first);
  const end = worker.indexOf(last, start + first.length);
  assert.ok(start >= 0 && end > start, first);
  return worker.slice(start, end);
}
const diagnostics = between("const VPDIAG_EVERY", "let diagEfbDrawsThisFrame");
const activation = between("  vpDiagEnabled = wgpuDeepReplayDiagnostics", "  wgpuDetachedPresenter");
const bufferObservations = between("            vpDiagNoteUpload(uploadSource, len);", "            const bid =");

function harness(enabled = false) {
  const logs = [];
  const context = vm.createContext({
    self: { _wgPresentCount: 1, _wgEfbColorId: 10, _wgCurPipe: 20 },
    webGpuObjects: { pipeTpl: new Map(), textures: new Map() },
    console: { log: (...args) => logs.push(args) },
    wgpuDeepReplayDiagnostics: enabled, frameCap: 0, efbDiag: 0,
    DIAG_EFB_TO_CANVAS: 0, DIAG_DEPTH_TRACE: false, DIAG_DEPTH_READBACK: false,
    DIAG_TEX_READBACK: false, DIAG_ISOLATE_DRAW: false,
    DIAG_SKIP_EMPTY_TEX: false, DIAG_ONLY_OPAQUE: false,
    vpDiagIsolateSeen: 0, vpDiagIsolateIdx: 0, vpDiagLastPicks: [],
  });
  vm.runInContext(diagnostics + "\n" + activation, context);
  const state = () => JSON.parse(vm.runInContext(`JSON.stringify({
    enabled: vpDiagEnabled, done: vpDiagDone, draws: vpDiagDraws,
    projections: vpDiagProj.size, tev: vpDiagTev.size, vertices: vpDiagVtx.size,
    indexUploads: vpDiagIdxUploads.length, indexTallies: vpDiagIdxTally.size,
    textureUploads: vpDiagTexData.size, textures: vpDiagTexBind.size,
    vertexSnapshotBytes: vpDiagLastVtxBytes?.byteLength || 0,
    tally: vpDiagTally.size
  })`, context));
  return { context, logs, state };
}

test("ordinary replay skips all diagnostic payload access and vertex/index copies", () => {
  const h = harness();
  const poison = new Proxy({}, { get() { throw new Error("diagnostic accessed payload while off"); } });
  h.context.uploadSource = poison;
  h.context.u32 = poison;
  h.context.webGpuObjects = poison;
  vm.runInContext(`
    for (const uploadRole of [1, 3, 4]) {
      const len = 4112, recWord = 0;
      ${bufferObservations}
    }
    vpDiagNotePsUpload(uploadSource, 1536);
    vpDiagNoteTexUpload(30, uploadSource, 8192);
    vpDiagCheckVertex(20);
    vpDiagNoteDraw(10, 20);
    vpDiagNoteIndexedDraw(3, 0, 0);
    vpDiagNoteViewport(uploadSource, uploadSource);
    vpDiagNoteRect(...Array(10).fill(uploadSource));
    vpDiagNoteScissor(...Array(8).fill(uploadSource));
    vpDiagPresent();
  `, h.context);
  assert.deepEqual(h.state(), {
    enabled: false, done: false, draws: 0, projections: 0, tev: 0, vertices: 0,
    indexUploads: 0, indexTallies: 0, textureUploads: 0, textures: 0,
    vertexSnapshotBytes: 0, tally: 0,
  });
  assert.equal(h.logs.length, 0);
});

test("enabled diagnostics inspect real uniforms, retain upload copies, and tally draws", () => {
  const h = harness(true);
  const vertices = new Uint8Array(new Float32Array(16).fill(1).buffer);
  let copies = 0;
  vertices.slice = (...args) => { copies++; return Uint8Array.prototype.slice.apply(vertices, args); };
  h.context.uploadSource = vertices;
  h.context.u32 = new Uint32Array(8);
  h.context.uniforms = new Uint8Array(new Float32Array(1028).fill(1).buffer);
  h.context.pixelUniforms = new Uint8Array(new Int32Array(384).fill(1).buffer);
  h.context.indices = new Uint8Array(new Uint16Array([0, 1, 2]).buffer);
  h.context.texels = new Uint8Array(8192).fill(255);
  vm.runInContext(`
    vpDiagPipeVtx.set(20, { stride: 16, fsId: 40,
      pos: { format: "float32x3", offset: 0 }, col0: null, tc0: null });
    webGpuObjects.pipeTpl.set(20, { depthBase: { depthCompare: "less" } });
    { const uploadRole = 3, len = uploadSource.byteLength, recWord = 0;
      ${bufferObservations}
    }
    vpDiagNoteUpload(uniforms, uniforms.byteLength);
    vpDiagNotePsUpload(pixelUniforms, pixelUniforms.byteLength);
    vpDiagNoteIndexUpload(indices, indices.byteLength, 0);
    vpDiagNoteIndexedDraw(3, 0, 0);
    vpDiagNoteTexUpload(30, texels, texels.byteLength);
    vpDiagNoteViewport(0, 1);
    vpDiagNoteRect(0, 0, 640, 480, 0, 0, 640, 480, 640, 480);
    vpDiagNoteDraw(10, 20);
  `, h.context);
  assert.equal(copies, 1);
  const state = h.state();
  for (const key of ["draws", "projections", "tev", "vertices", "indexUploads", "indexTallies", "textureUploads", "tally"])
    assert.equal(state[key], 1, key);
  assert.equal(state.vertexSnapshotBytes, vertices.byteLength);
  assert.equal(vm.runInContext("vpDiagTexData.get(30).samples", h.context), h.context.texels.byteLength);
  vm.runInContext("vpDiagPresent()", h.context);
  assert.equal(h.state().draws, 0, "enabled per-frame collection still resets at present");
  assert.ok(h.logs.length > 0);
});

test("capture and render probes activate their metadata using the current load options", () => {
  const h = harness();
  for (const efbDiag of [1, 2, 0]) {
    // The previous load's resolved setting must never control this load.
    h.context.DIAG_EFB_TO_CANVAS = efbDiag === 0 ? 2 : 0;
    h.context.efbDiag = efbDiag;
    vm.runInContext(activation, h.context);
    assert.equal(h.state().enabled, efbDiag !== 0);
  }
  for (const option of ["frameCap", "DIAG_DEPTH_TRACE", "DIAG_DEPTH_READBACK", "DIAG_TEX_READBACK", "DIAG_ISOLATE_DRAW", "DIAG_SKIP_EMPTY_TEX", "DIAG_ONLY_OPAQUE"]) {
    h.context[option] = option === "frameCap" ? 1 : true;
    vm.runInContext(activation, h.context);
    assert.equal(h.state().enabled, true, option);
    h.context[option] = option === "frameCap" ? 0 : false;
    vm.runInContext(activation, h.context);
    assert.equal(h.state().enabled, false, `${option} disabled on next load`);
  }
});

test("disabled optional bind-group metadata preserves real bindings and presenter source", () => {
  const bind = between("function replayCreateBindGroup(", "// Day-33 grind:");
  for (const enabled of [false, true]) {
    const heap = new Uint32Array(16);
    heap.set([0x57424731, 1, 1, 0, 1, 42, 0, 0], 1);
    const view = { texture: 42 };
    const optional = new Map();
    const bindGroups = new Map();
    const self = {};
    const context = {
      renderGpu: { device: { createBindGroup: (descriptor) => descriptor } },
      webGpuObjects: { textures: new Map([[42, { tex: { width: 64, height: 32 },
        format: "rgba8unorm", view2dArray: view }]]),
        bindGroups, bindGroupSamplingMasks: new Map(), samplers: new Map(), buffers: new Map() },
      moduleInstance: { HEAPU8: new Uint8Array(heap.buffer) },
      getFixedLayouts: () => ({ l1: {}, dummyTexView: {}, dummySampler: {} }),
      FILTERABLE_TEX_FORMATS: new Set(["rgba8unorm"]), UNFILTERABLE_TEX_FORMATS: new Set(),
      wgpuReplayClassifier: null, vpDiagEnabled: enabled, vpDiagBgTexByBinding: optional,
      self, console: { log() {} },
    };
    vm.runInNewContext(`(${bind.trim()})(100, 4, 32)`, context);
    assert.equal(self._wgBgTex[100], 42, "production presenter source survives diagnostic gating");
    assert.equal(bindGroups.get(100).entries.find((entry) => entry.binding === 0).resource, view);
    assert.equal(bindGroups.get(100).entries.length, 16, "fixed-layout padding remains valid");
    assert.equal(optional.size, enabled ? 1 : 0);
    assert.equal(Boolean(self._wgBgAll), enabled);
  }
});

test("shader metadata is skipped without inspecting WGSL when diagnostics are off", () => {
  const metadata = between("    if (vpDiagEnabled) {\n      vpDiagShaderStage", "    // Force the texture-array");
  const poison = new Proxy({}, { get() { throw new Error("unexpected shader metadata scan"); } });
  const context = {
    vpDiagEnabled: false, wgsl: poison, stage: 2, id: 7, self: {},
    vpDiagShaderStage: {}, vpDiagShaderWithDiscard: 0,
    vpDiagFsSource: new Map(), vpDiagFsTexBinding: new Map(), console: { log() {} },
  };
  vm.runInNewContext(metadata, context);
  assert.equal(context.vpDiagFsSource.size, 0);
  context.vpDiagEnabled = true;
  context.wgsl = "@group(1) @binding(3) var tex: texture_2d_array<f32>; discard;";
  vm.runInNewContext(metadata, context);
  assert.equal(context.vpDiagFsSource.get(7), context.wgsl);
  assert.equal(context.vpDiagFsTexBinding.get(7), 3);
});

test("frame capture formats viewport records only for the requested frame", () => {
  const captureFunctions = between("let frameCapTarget =", "// Per-draw viewport depth range");
  const call = worker.match(/if \(frameCapActive\(\)\) frameCapPush\(`  VIEWPORT[\s\S]*?\);/);
  assert.ok(call);
  const context = vm.createContext({
    self: { _wgPresentCount: 2 }, console: { log() {} }, passFbId: 10, recWord: 0,
    f32: new Proxy({}, { get() { throw new Error("inactive capture formatted its arguments"); } }),
  });
  vm.runInContext(captureFunctions + "\n" + call[0], context);
  assert.equal(vm.runInContext("frameCapRows.length", context), 0);
  context.f32 = new Float32Array([0, 0, 0, 640, 480, 0, 1]);
  vm.runInContext("frameCapTarget = 2;\n" + call[0], context);
  assert.equal(vm.runInContext("frameCapRows.length", context), 1);
  assert.match(vm.runInContext("frameCapRows[0]", context), /VIEWPORT fb#10/);
});
