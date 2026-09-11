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

function clearRect(viewport, scissor = [4, 4, 4, 4], flags = 3, onPipeline = () => {}, havePipeline = true) {
  const events = [];
  const errors = [];
  const pipeline = {};
  const gamePipeline = {};
  let currentPipeline = havePipeline ? gamePipeline : null;
  let cachedPipeline = currentPipeline;
  const pass = {
    setViewport(...args) { events.push(["viewport", ...args]); },
    setScissorRect(...args) { events.push(["scissor", ...args]); },
    setPipeline(value) {
      assert.ok(value === pipeline || value === gamePipeline);
      currentPipeline = value;
      events.push([value === pipeline ? "pipeline" : "restore-pipeline"]);
    },
    draw(...args) { events.push(["draw", ...args]); },
  };
  const u32 = new Uint32Array([25, 0, 0, 2, 2, 0xc86432ff, 0, flags]);
  const f32 = new Float32Array(u32.buffer);
  f32[6] = 0.25;
  const self = { _wgCurPipe: havePipeline ? 42 : 0 };
  const replay = vm.runInNewContext(
    `(function () {
      let passHasPipe = ${havePipeline}, passNeedsVertexBuffer = ${havePipeline};
      switch (25) { ${clearCase} }
      return { passHasPipe, passNeedsVertexBuffer };
    })`,
    {
      pass, passW: 8, passH: 8, passColorFmt: "rgba8unorm", passDepthFmt: "depth32float",
      u32, f32, recWord: 0, WGPU_CMD_OP_CLEAR_RECT: 25,
      dev: {}, ensureClearPipeline: (...args) => { onPipeline(args); return pipeline; },
      GX_NATIVE_DEPTH: false, CLEARRECT_FULL_VIEWPORT: true,
      dtLastPipe: havePipeline ? gamePipeline : null,
      wgpuConsumerStateCacheEnabled: true,
      wgpuPassStateCache: {
        recordPipelineApplied(value) { cachedPipeline = value; },
        recordPipelineApplyFailed() { cachedPipeline = null; },
      },
      DIAG_DEPTH_TRACE: false, vpDiagEnabled: false, vpDiagDone: true,
      lastAppliedViewport: viewport, lastAppliedScissor: scissor, self,
      recordRendererError: (...args) => errors.push(args),
    }
  );
  const state = replay();
  assert.deepEqual(errors, [], "clear does not swallow an execution error");
  assert.equal(state.passHasPipe, havePipeline, "producer may elide an unchanged SET_PIPELINE");
  assert.equal(state.passNeedsVertexBuffer, havePipeline);
  assert.equal(self._wgCurPipe, havePipeline ? 42 : 0);
  if (havePipeline) assert.equal(currentPipeline, gamePipeline, "following draws use the game pipeline");
  assert.equal(cachedPipeline, havePipeline ? gamePipeline : null);
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
      ["restore-pipeline"],
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
    ["restore-pipeline"],
  ]);
});

test("ClearRect preserves the implicit full attachment viewport and restores the default scissor", () => {
  assert.deepEqual(clearRect(null, null), [
    ["scissor", 0, 0, 2, 2],
    ["pipeline"],
    ["draw", 3, 1, 0, 0],
    ["scissor", 0, 0, 8, 8],
    ["restore-pipeline"],
  ]);
});

test("ClearRect does not make game drawing valid when no pipeline was bound before the clear", () => {
  assert.deepEqual(clearRect(null, null, 3, () => {}, false), [
    ["scissor", 0, 0, 2, 2], ["pipeline"], ["draw", 3, 1, 0, 0],
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

function clearPipelineCacheFixture() {
  const pipelineStart = worker.indexOf("function ensureClearPipeline(");
  const pipelineEnd = worker.indexOf("\nfunction ", pipelineStart);
  const cache = new Map();
  const errors = [];
  let failNext = false;
  const dev = {
    createShaderModule(descriptor) { return { descriptor }; },
    createRenderPipeline(descriptor) {
      if (failNext) { failNext = false; throw new Error("test pipeline failure"); }
      return { descriptor };
    },
  };
  const ensure = vm.runInNewContext(`(${worker.slice(pipelineStart, pipelineEnd)})`, {
    WGPU_CLEAR_PIPELINES: cache,
    WGPU_CLEAR_PIPELINE_CAP: 64,
    recordRendererError: (...args) => errors.push(args),
  });
  return {
    cache, errors,
    failNext() { failNext = true; },
    get: (rgba) => ensure(dev, "rgba8unorm", "depth32float", 15, true, rgba, 0),
  };
}

test("clear cache eviction never suppresses a new or previously evicted clear", () => {
  const fixture = clearPipelineCacheFixture();
  const heldPipelines = [];
  for (let value = 0; value < 130; value++) {
    const rgba = (value * 0x1000000 + 0xff) >>> 0;
    const pipeline = fixture.get(rgba);
    assert.ok(pipeline, `clear ${value} must still draw after cache capacity`);
    assert.equal(fixture.get(rgba), pipeline, "a cache hit does not rebuild a pipeline");
    assert.ok(fixture.cache.size <= 64, "cache remains bounded");
    heldPipelines.push(pipeline);
  }
  assert.equal(fixture.cache.size, 64);
  assert.ok(![...fixture.cache.values()].includes(heldPipelines[0]));
  assert.equal(heldPipelines[0].descriptor.fragment.targets[0].writeMask, 15,
    "eviction leaves pipeline references held by pending command buffers usable");
  const recreated = fixture.get(0xff);
  assert.ok(recreated, "returning to an evicted clear must not be dropped");
  assert.notEqual(recreated, heldPipelines[0]);
  assert.equal(fixture.cache.size, 64);
  assert.deepEqual(fixture.errors, []);
});

test("failed clear pipeline creation does not consume capacity or evict a working entry", () => {
  const fixture = clearPipelineCacheFixture();
  for (let value = 0; value < 64; value++) fixture.get(value);
  const before = [...fixture.cache.values()];
  fixture.failNext();
  assert.equal(fixture.get(0x12345678), null);
  assert.deepEqual([...fixture.cache.values()], before);
  assert.equal(fixture.errors.length, 1);
  assert.ok(fixture.get(0x12345678), "a failed creation remains retryable");
  assert.equal(fixture.cache.size, 64);
});
