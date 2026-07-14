// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import {
  WGPU_LEAF_EXEC_APPLIED,
  WGPU_LEAF_EXEC_CAUGHT_ERROR,
  WGPU_LEAF_EXEC_SKIPPED,
  WGPU_LEAF_EXEC_UNHANDLED,
  WGPU_LEAF_OP_DRAW,
  WGPU_LEAF_OP_DRAW_INDEXED,
  WGPU_LEAF_OP_SET_INDEX_BUFFER,
  WGPU_LEAF_OP_SET_SCISSOR,
  WGPU_LEAF_OP_SET_VERTEX_BUFFER,
  WGPU_LEAF_OP_SET_VIEWPORT,
  WgpuLeafReplayExecutor
} from "../src/wgpu-leaf-replay-executor.js";

function createFixture() {
  const calls = [];
  const vertexBuffer = { label: "vertex" };
  const indexBuffer = { label: "index" };
  const buffers = new Map([[7, vertexBuffer], [8, indexBuffer]]);
  const pass = {
    setVertexBuffer(...args) { calls.push(["set-vb", ...args]); },
    setIndexBuffer(...args) { calls.push(["set-ib", ...args]); },
    setViewport(...args) { calls.push(["viewport", ...args]); },
    setScissorRect(...args) { calls.push(["scissor", ...args]); },
    draw(...args) { calls.push(["draw", ...args]); },
    drawIndexed(...args) { calls.push(["draw-indexed", ...args]); }
  };
  const outside = [];
  const missing = [];
  const errors = [];
  const skipped = [];
  const appliedDraws = [];
  const viewportDepthState = [];
  const viewportState = [];
  const executor = new WgpuLeafReplayExecutor({
    buffers,
    onStateOutsidePass(op, recordIndex) { outside.push([op, recordIndex]); },
    onMissingResource(kind, id) { missing.push([kind, id]); },
    onRendererError(stage, error) { errors.push([stage, error]); },
    onViewportDepthState(...args) { viewportDepthState.push(args); },
    onViewport(...args) { viewportState.push(args); },
    onDraw(...args) { appliedDraws.push(args); },
    onDrawSkipped(indexed) { skipped.push(indexed); }
  });
  const words = new ArrayBuffer(32 * 4);
  return {
    executor,
    pass,
    calls,
    outside,
    missing,
    errors,
    skipped,
    appliedDraws,
    viewportDepthState,
    viewportState,
    u32: new Uint32Array(words),
    f32: new Float32Array(words),
    vertexBuffer,
    indexBuffer
  };
}

function enableDrawState(executor, needsVertexBuffer = true) {
  executor.setPipelineState(true, needsVertexBuffer);
  executor.setBindGroupValid(0, true);
  executor.setBindGroupValid(1, true);
  executor.setBindGroupValid(2, true);
}

test("leaf executor applies buffers and draws in record order", () => {
  const f = createFixture();
  f.executor.beginPass(f.pass, 640, 480);
  enableDrawState(f.executor);

  f.u32[1] = 0;
  f.u32[2] = 7;
  f.u32[3] = 64;
  assert.equal(
    f.executor.execute(WGPU_LEAF_OP_SET_VERTEX_BUFFER, f.u32, f.f32, 0, 10),
    WGPU_LEAF_EXEC_APPLIED
  );

  f.u32[1] = 8;
  f.u32[2] = 1;
  f.u32[3] = 12;
  assert.equal(
    f.executor.execute(WGPU_LEAF_OP_SET_INDEX_BUFFER, f.u32, f.f32, 0, 11),
    WGPU_LEAF_EXEC_APPLIED
  );

  f.u32[1] = 36;
  f.u32[2] = 2;
  f.u32[3] = 4;
  f.u32[4] = 9;
  assert.equal(
    f.executor.execute(WGPU_LEAF_OP_DRAW_INDEXED, f.u32, f.f32, 0, 12),
    WGPU_LEAF_EXEC_APPLIED
  );
  assert.deepEqual(f.calls, [
    ["set-vb", 0, f.vertexBuffer, 64],
    ["set-ib", f.indexBuffer, "uint32", 12],
    ["draw-indexed", 36, 2, 4, 9, 0]
  ]);
  assert.deepEqual(f.appliedDraws, [[true, 36, 2, 4, 9, 0]]);
});

test("draw gates require pipeline, all three groups, and required buffers", () => {
  const f = createFixture();
  f.executor.beginPass(f.pass, 640, 480);
  f.u32[1] = 3;
  f.u32[2] = 1;
  f.u32[3] = 2;

  assert.equal(
    f.executor.execute(WGPU_LEAF_OP_DRAW, f.u32, f.f32, 0, 1),
    WGPU_LEAF_EXEC_SKIPPED
  );
  enableDrawState(f.executor, true);
  assert.equal(
    f.executor.execute(WGPU_LEAF_OP_DRAW, f.u32, f.f32, 0, 2),
    WGPU_LEAF_EXEC_SKIPPED
  );

  f.u32[1] = 0;
  f.u32[2] = 7;
  f.u32[3] = 0;
  f.executor.execute(WGPU_LEAF_OP_SET_VERTEX_BUFFER, f.u32, f.f32, 0, 3);
  f.u32[1] = 3;
  f.u32[2] = 1;
  f.u32[3] = 2;
  assert.equal(
    f.executor.execute(WGPU_LEAF_OP_DRAW, f.u32, f.f32, 0, 4),
    WGPU_LEAF_EXEC_APPLIED
  );
  assert.deepEqual(f.calls.at(-1), ["draw", 3, 1, 2, 0]);

  assert.equal(
    f.executor.execute(WGPU_LEAF_OP_DRAW_INDEXED, f.u32, f.f32, 0, 5),
    WGPU_LEAF_EXEC_SKIPPED
  );
  assert.deepEqual(f.skipped, [false, false, true]);
});

test("missing slot-zero vertex and index records invalidate stale bindings", () => {
  const f = createFixture();
  f.executor.beginPass(f.pass, 640, 480);
  enableDrawState(f.executor);
  f.executor.vertexBufferValid = true;
  f.executor.indexBufferValid = true;

  f.u32[1] = 0;
  f.u32[2] = 404;
  f.u32[3] = 0;
  assert.equal(
    f.executor.execute(WGPU_LEAF_OP_SET_VERTEX_BUFFER, f.u32, f.f32, 0, 20),
    WGPU_LEAF_EXEC_SKIPPED
  );
  assert.equal(f.executor.vertexBufferValid, false);
  assert.deepEqual(f.missing, [["vertex-buffer", 404]]);

  f.u32[1] = 405;
  f.u32[2] = 0;
  assert.equal(
    f.executor.execute(WGPU_LEAF_OP_SET_INDEX_BUFFER, f.u32, f.f32, 0, 21),
    WGPU_LEAF_EXEC_SKIPPED
  );
  assert.equal(f.executor.indexBufferValid, false);
  assert.deepEqual(f.missing.at(-1), ["index-buffer", 405]);
});

test("nonzero missing vertex slot does not invalidate slot zero", () => {
  const f = createFixture();
  f.executor.beginPass(f.pass, 640, 480);
  f.executor.vertexBufferValid = true;
  f.u32[1] = 2;
  f.u32[2] = 404;
  f.u32[3] = 0;
  f.executor.execute(WGPU_LEAF_OP_SET_VERTEX_BUFFER, f.u32, f.f32, 0, 22);
  assert.equal(f.executor.vertexBufferValid, true);
});

test("buffer apply failures are caught and leave stale validity cleared", () => {
  const f = createFixture();
  f.pass.setVertexBuffer = () => { throw new Error("bad vertex"); };
  f.pass.setIndexBuffer = () => { throw new Error("bad index"); };
  f.executor.beginPass(f.pass, 640, 480);
  f.executor.vertexBufferValid = true;
  f.executor.indexBufferValid = true;

  f.u32[1] = 0;
  f.u32[2] = 7;
  assert.equal(
    f.executor.execute(WGPU_LEAF_OP_SET_VERTEX_BUFFER, f.u32, f.f32, 0, 30),
    WGPU_LEAF_EXEC_CAUGHT_ERROR
  );
  f.u32[1] = 8;
  f.u32[2] = 0;
  assert.equal(
    f.executor.execute(WGPU_LEAF_OP_SET_INDEX_BUFFER, f.u32, f.f32, 0, 31),
    WGPU_LEAF_EXEC_CAUGHT_ERROR
  );
  assert.equal(f.executor.vertexBufferValid, false);
  assert.equal(f.executor.indexBufferValid, false);
  assert.deepEqual(f.errors, [
    ["set-vertex-buffer", "bad vertex"],
    ["set-index-buffer", "bad index"]
  ]);
});

test("state cache preserves application and failure ordering", () => {
  const f = createFixture();
  const cacheCalls = [];
  const cache = {
    vertexBufferNeedsApply(...args) {
      cacheCalls.push(["vb-needs", ...args]);
      return true;
    },
    recordVertexBufferApplied(...args) {
      cacheCalls.push(["vb-applied", ...args]);
    },
    recordVertexBufferApplyFailed(...args) {
      cacheCalls.push(["vb-failed", ...args]);
    },
    indexBufferNeedsApply(...args) {
      cacheCalls.push(["ib-needs", ...args]);
      return false;
    },
    recordIndexBufferApplied(...args) {
      cacheCalls.push(["ib-applied", ...args]);
    },
    recordIndexBufferApplyFailed(...args) {
      cacheCalls.push(["ib-failed", ...args]);
    }
  };
  f.executor.stateCache = cache;
  f.executor.setStateCacheEnabled(true);
  f.executor.beginPass(f.pass, 640, 480);

  f.u32[1] = 0;
  f.u32[2] = 7;
  f.u32[3] = 16;
  f.executor.execute(WGPU_LEAF_OP_SET_VERTEX_BUFFER, f.u32, f.f32, 0, 1);
  f.u32[1] = 8;
  f.u32[2] = 0;
  f.u32[3] = 20;
  f.executor.execute(WGPU_LEAF_OP_SET_INDEX_BUFFER, f.u32, f.f32, 0, 2);

  assert.deepEqual(cacheCalls, [
    ["vb-needs", 0, f.vertexBuffer, 16],
    ["vb-applied", 0, f.vertexBuffer, 16],
    ["ib-needs", f.indexBuffer, "uint16", 20]
  ]);
  assert.deepEqual(f.calls, [["set-vb", 0, f.vertexBuffer, 16]]);
  assert.equal(f.executor.indexBufferValid, true);
});

test("viewport and scissor preserve inline clamp and ordering semantics", () => {
  const f = createFixture();
  f.executor.beginPass(f.pass, 640, 480);
  f.f32[1] = -10;
  f.f32[2] = -20;
  f.f32[3] = 700;
  f.f32[4] = 600;
  f.f32[5] = 1.25;
  f.f32[6] = -0.25;
  assert.equal(
    f.executor.execute(WGPU_LEAF_OP_SET_VIEWPORT, f.u32, f.f32, 0, 40),
    WGPU_LEAF_EXEC_APPLIED
  );
  assert.deepEqual(f.calls[0], ["viewport", 0, 0, 640, 480, 0, 1]);
  assert.deepEqual(f.viewportDepthState[0], [true, 1.25, -0.25]);
  assert.deepEqual(f.viewportState[0], [0, 0, 640, 480, 0, 1]);

  f.u32[1] = 700;
  f.u32[2] = 500;
  f.u32[3] = 100;
  f.u32[4] = 100;
  assert.equal(
    f.executor.execute(WGPU_LEAF_OP_SET_SCISSOR, f.u32, f.f32, 0, 41),
    WGPU_LEAF_EXEC_APPLIED
  );
  assert.deepEqual(f.calls[1], ["scissor", 640, 480, 0, 0]);
});

test("viewport, scissor, and draw WebGPU exceptions propagate", () => {
  const f = createFixture();
  f.executor.beginPass(f.pass, 640, 480);
  enableDrawState(f.executor, false);

  f.pass.setViewport = () => { throw new Error("viewport rejected"); };
  assert.throws(
    () => f.executor.execute(WGPU_LEAF_OP_SET_VIEWPORT, f.u32, f.f32, 0, 1),
    /viewport rejected/
  );
  f.pass.setScissorRect = () => { throw new Error("scissor rejected"); };
  assert.throws(
    () => f.executor.execute(WGPU_LEAF_OP_SET_SCISSOR, f.u32, f.f32, 0, 2),
    /scissor rejected/
  );
  f.pass.draw = () => { throw new Error("draw rejected"); };
  assert.throws(
    () => f.executor.execute(WGPU_LEAF_OP_DRAW, f.u32, f.f32, 0, 3),
    /draw rejected/
  );
});

test("outside-pass records classify without throwing and unknown ops are unhandled", () => {
  const f = createFixture();
  f.u32[1] = 8;
  assert.equal(
    f.executor.execute(WGPU_LEAF_OP_SET_INDEX_BUFFER, f.u32, f.f32, 0, 77),
    WGPU_LEAF_EXEC_SKIPPED
  );
  assert.equal(
    f.executor.execute(WGPU_LEAF_OP_DRAW_INDEXED, f.u32, f.f32, 0, 78),
    WGPU_LEAF_EXEC_SKIPPED
  );
  assert.deepEqual(f.outside, [
    ["set-index-buffer", 77],
    ["draw-indexed", 78]
  ]);
  assert.equal(f.executor.execute(999, f.u32, f.f32, 0, 79), WGPU_LEAF_EXEC_UNHANDLED);
});
