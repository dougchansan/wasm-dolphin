// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const worker = await readFile(
  new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8"
);
const start = worker.indexOf("case WGPU_CMD_OP_CLEAR_RECT: {");
const end = worker.indexOf("case WGPU_CMD_OP_SET_SCISSOR:", start);
assert.ok(start >= 0 && end > start, "worker ClearRect execution seam exists");
const clearCase = worker.slice(start, end);

function clearRect(viewport, scissor = [4, 4, 4, 4], flags = 3, onPipeline = () => {}) {
  const events = [];
  const errors = [];
  const pipeline = {};
  const pass = {
    setViewport(...args) { events.push(["viewport", ...args]); },
    setScissorRect(...args) { events.push(["scissor", ...args]); },
    setPipeline(value) { assert.equal(value, pipeline); events.push(["pipeline"]); },
    draw(...args) { events.push(["draw", ...args]); },
  };
  const u32 = new Uint32Array([25, 0, 0, 2, 2, 0xc86432ff, 0, flags]);
  const f32 = new Float32Array(u32.buffer);
  f32[6] = 0.25;
  const self = { _wgCurPipe: 42 };
  const replay = vm.runInNewContext(
    `(function () {
      let passHasPipe = true, passNeedsVertexBuffer = true;
      switch (25) { ${clearCase} }
      return { passHasPipe, passNeedsVertexBuffer };
    })`,
    {
      pass, passW: 8, passH: 8, passColorFmt: "rgba8unorm", passDepthFmt: "depth32float",
      u32, f32, recWord: 0, WGPU_CMD_OP_CLEAR_RECT: 25,
      dev: {}, ensureClearPipeline: (...args) => { onPipeline(args); return pipeline; },
      GX_NATIVE_DEPTH: false, CLEARRECT_FULL_VIEWPORT: true,
      DIAG_DEPTH_TRACE: false, vpDiagDone: true,
      lastAppliedViewport: viewport, lastAppliedScissor: scissor, self,
      recordRendererError: (...args) => errors.push(args),
    }
  );
  const state = replay();
  assert.deepEqual(errors, [], "clear does not swallow an execution error");
  assert.equal(state.passHasPipe, false, "next game draw must bind its own pipeline");
  assert.equal(state.passNeedsVertexBuffer, false);
  assert.equal(self._wgCurPipe, 0);
  assert.equal(self._wgClearRectN, 1);
  return events;
}

for (const [name, viewport] of [
  ["partial viewport with the full depth range", [4, 4, 4, 4, 0, 1]],
  ["partial viewport with a compressed depth range", [4, 4, 4, 4, 0.89, 0.99]],
  ["full attachment viewport with a compressed depth range", [0, 0, 8, 8, 0.89, 0.99]],
]) {
  test(`ClearRect uses full attachment coverage under ${name}`, () => {
    const before = viewport.slice();
    const scissor = [4, 4, 4, 4];
    assert.deepEqual(clearRect(viewport, scissor), [
      ["viewport", 0, 0, 8, 8, 0, 1],
      ["scissor", 0, 0, 2, 2],
      ["pipeline"],
      ["draw", 3, 1, 0, 0],
      ["viewport", ...viewport],
      ["scissor", ...scissor],
    ]);
    assert.deepEqual(viewport, before, "cached game viewport remains unchanged");
    assert.deepEqual(scissor, [4, 4, 4, 4], "cached game scissor remains unchanged");
  });
}

test("ClearRect skips redundant viewport calls when the game already uses the full attachment and depth range", () => {
  assert.deepEqual(clearRect([0, 0, 8, 8, 0, 1], [1, 1, 6, 6]), [
    ["scissor", 0, 0, 2, 2],
    ["pipeline"],
    ["draw", 3, 1, 0, 0],
    ["scissor", 1, 1, 6, 6],
  ]);
});

test("ClearRect preserves the implicit full attachment viewport and restores the default scissor", () => {
  assert.deepEqual(clearRect(null, null), [
    ["scissor", 0, 0, 2, 2],
    ["pipeline"],
    ["draw", 3, 1, 0, 0],
    ["scissor", 0, 0, 8, 8],
  ]);
});

for (const [name, flags, colorWriteMask, writeDepth] of [
  ["independent alpha-only", 12, 8, false],
  ["independent RGB-only", 9, 7, false],
  ["independent RGBA and depth", 15, 15, true],
  ["legacy RGBA", 1, 15, false],
  ["legacy depth-only", 2, 0, true],
]) {
  test(`ClearRect preserves ${name} channel enables`, () => {
    let pipelineCalls = 0;
    clearRect([0, 0, 8, 8, 0, 1], null, flags, (args) => {
      pipelineCalls++;
      assert.equal(args[3], colorWriteMask, "exact GPU color write mask");
      assert.equal(args[4], writeDepth, "depth writes stay independent of alpha");
    });
    assert.equal(pipelineCalls, 1);
  });
}

test("clear pipelines preserve channel masks in GPU descriptors and cache identities", () => {
  const pipelineStart = worker.indexOf("function ensureClearPipeline(");
  const pipelineEnd = worker.indexOf("\nfunction ", pipelineStart);
  assert.ok(pipelineStart >= 0 && pipelineEnd > pipelineStart);
  const cache = new Map();
  const errors = [];
  const descriptors = [];
  const dev = {
    createShaderModule(descriptor) { return { descriptor }; },
    createRenderPipeline(descriptor) {
      descriptors.push(descriptor);
      return { descriptor };
    },
  };
  const ensureClearPipeline = vm.runInNewContext(
    `(${worker.slice(pipelineStart, pipelineEnd)})`,
    {
      WGPU_CLEAR_PIPELINES: cache,
      WGPU_CLEAR_PIPELINE_CAP: 64,
      recordRendererError: (...args) => errors.push(args),
    }
  );
  const pipelines = [];
  for (const colorWriteMask of [0, 7, 8, 15]) {
    const pipeline = ensureClearPipeline(
      dev, "rgba8unorm", "depth32float", colorWriteMask, false, 0xc86432ff, 0
    );
    assert.ok(pipeline);
    assert.equal(pipeline.descriptor.fragment.targets[0].writeMask, colorWriteMask);
    assert.equal(pipeline.descriptor.depthStencil.depthWriteEnabled, false);
    assert.equal(ensureClearPipeline(
      dev, "rgba8unorm", "depth32float", colorWriteMask, false, 0xc86432ff, 0
    ), pipeline, "identical channel masks reuse a pipeline");
    pipelines.push(pipeline);
  }
  assert.equal(new Set(pipelines).size, 4, "different masks cannot share a cached pipeline");
  assert.equal(cache.size, 4);
  assert.equal(descriptors.length, 4);
  assert.deepEqual(errors, []);
});
