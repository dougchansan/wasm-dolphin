// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import {
  WGPU_RENDERER_WORKER_CONTROL_INDEX as I,
  WGPU_RENDERER_WORKER_CONTROL_MAGIC,
  WGPU_RENDERER_WORKER_CONTROL_VERSION,
  WGPU_RENDERER_WORKER_CONTROL_WORDS,
  WGPU_RENDERER_WORKER_ERROR as ERROR,
  WGPU_RENDERER_WORKER_OWNER as OWNER,
  WGPU_RENDERER_WORKER_STATE as STATE,
  attachWgpuRendererWorkerControl,
  beginNextWgpuRendererWorkerGeneration,
  createWgpuRendererWorkerControl,
  failWgpuRendererWorkerControl,
  markWgpuRendererWorkerBootReady,
  markWgpuRendererWorkerQuiescent,
  markWgpuRendererWorkerRingAttached,
  readWgpuRendererWorkerError,
  readWgpuRendererWorkerGeneration,
  readWgpuRendererWorkerOwner,
  readWgpuRendererWorkerState,
  requestWgpuRendererWorkerQuiesce,
  snapshotWgpuRendererWorkerControl,
  tryTransferWgpuRendererWorkerOwnership,
} from "../src/wgpu-renderer-worker-control.js";

test("control buffers publish the exact WRC1 schema", () => {
  const control = createWgpuRendererWorkerControl({
    owner: OWNER.COORDINATOR,
    session: 7,
    epoch: 11,
    generation: 13,
  });
  assert.equal(control.length, WGPU_RENDERER_WORKER_CONTROL_WORDS);
  assert.equal(control.buffer.byteLength, WGPU_RENDERER_WORKER_CONTROL_WORDS * 4);
  assert.equal(Atomics.load(control, I.MAGIC), WGPU_RENDERER_WORKER_CONTROL_MAGIC);
  assert.equal(Atomics.load(control, I.VERSION), WGPU_RENDERER_WORKER_CONTROL_VERSION);
  assert.equal(Atomics.load(control, I.WORDS), WGPU_RENDERER_WORKER_CONTROL_WORDS);
  assert.strictEqual(
    attachWgpuRendererWorkerControl(control.buffer, {
      session: 7,
      epoch: 11,
      generation: 13,
    }).buffer,
    control.buffer
  );
});

test("attachment rejects non-shared, oversized, corrupt, and stale controls", () => {
  assert.throws(
    () => attachWgpuRendererWorkerControl(new ArrayBuffer(36)),
    /requires a SharedArrayBuffer/
  );
  assert.throws(
    () => attachWgpuRendererWorkerControl(new SharedArrayBuffer(40)),
    /exactly 36 bytes/
  );

  const corrupt = createWgpuRendererWorkerControl();
  Atomics.store(corrupt, I.MAGIC, 0);
  assert.throws(() => attachWgpuRendererWorkerControl(corrupt.buffer), /magic is invalid/);

  const stale = createWgpuRendererWorkerControl({ session: 2, epoch: 3, generation: 4 });
  assert.throws(
    () => attachWgpuRendererWorkerControl(stale.buffer, { generation: 3 }),
    /generation mismatch/
  );
});

test("ownership transfer is a compare-and-swap scoped to one generation", () => {
  const control = createWgpuRendererWorkerControl({ owner: OWNER.COORDINATOR });
  assert.equal(
    tryTransferWgpuRendererWorkerOwnership(
      control,
      OWNER.COORDINATOR,
      OWNER.RENDERER,
      1
    ),
    true
  );
  assert.equal(readWgpuRendererWorkerOwner(control), OWNER.RENDERER);
  assert.equal(
    tryTransferWgpuRendererWorkerOwnership(
      control,
      OWNER.COORDINATOR,
      OWNER.NONE,
      1
    ),
    false
  );
  assert.equal(readWgpuRendererWorkerState(control), STATE.BOOTING);
});

test("the happy path reaches quiescence only through ordered owned transitions", () => {
  const control = createWgpuRendererWorkerControl({ owner: OWNER.RENDERER });
  assert.equal(markWgpuRendererWorkerBootReady(control, OWNER.RENDERER, 1), true);
  assert.equal(markWgpuRendererWorkerRingAttached(control, OWNER.RENDERER, 1), true);
  assert.equal(requestWgpuRendererWorkerQuiesce(control, OWNER.RENDERER, 1), true);
  assert.equal(markWgpuRendererWorkerQuiescent(control, OWNER.RENDERER, 1), true);
  assert.deepEqual(snapshotWgpuRendererWorkerControl(control), {
    state: STATE.QUIESCENT,
    owner: OWNER.RENDERER,
    session: 1,
    epoch: 1,
    generation: 1,
    error: ERROR.NONE,
  });
});

test("illegal state transitions fail closed and retain the first error", () => {
  const control = createWgpuRendererWorkerControl({ owner: OWNER.RENDERER });
  assert.throws(
    () => markWgpuRendererWorkerRingAttached(control, OWNER.RENDERER, 1),
    /transition 1->2 observed state 0/
  );
  assert.equal(readWgpuRendererWorkerState(control), STATE.FAILED);
  assert.equal(readWgpuRendererWorkerError(control), ERROR.INVALID_TRANSITION);
  assert.equal(failWgpuRendererWorkerControl(control, ERROR.REMOTE_FAILURE), false);
  assert.equal(readWgpuRendererWorkerError(control), ERROR.INVALID_TRANSITION);
});

test("stale generations and wrong owners cannot mutate state", () => {
  const stale = createWgpuRendererWorkerControl({
    owner: OWNER.RENDERER,
    generation: 4,
  });
  assert.throws(
    () => markWgpuRendererWorkerBootReady(stale, OWNER.RENDERER, 3),
    /generation mismatch/
  );
  assert.equal(readWgpuRendererWorkerError(stale), ERROR.STALE_GENERATION);

  const wrongOwner = createWgpuRendererWorkerControl({ owner: OWNER.COORDINATOR });
  assert.throws(
    () => markWgpuRendererWorkerBootReady(wrongOwner, OWNER.RENDERER, 1),
    /owner mismatch/
  );
  assert.equal(readWgpuRendererWorkerError(wrongOwner), ERROR.WRONG_OWNER);
});

test("quiescent controls can begin only the next monotonic epoch and generation", () => {
  const control = quiescentControl({ session: 5, epoch: 8, generation: 12 });
  assert.equal(
    beginNextWgpuRendererWorkerGeneration(control, OWNER.RENDERER, 12, {
      session: 6,
      epoch: 9,
      generation: 13,
    }),
    true
  );
  assert.deepEqual(snapshotWgpuRendererWorkerControl(control), {
    state: STATE.BOOTING,
    owner: OWNER.RENDERER,
    session: 6,
    epoch: 9,
    generation: 13,
    error: ERROR.NONE,
  });

  const sameSession = quiescentControl({ session: 5, epoch: 8, generation: 12 });
  assert.equal(
    beginNextWgpuRendererWorkerGeneration(sameSession, OWNER.RENDERER, 12, {
      session: 5,
      epoch: 9,
      generation: 13,
    }),
    true
  );
});

test("skipped or regressed session identity fails closed before publication", () => {
  for (const identity of [
    { session: 4, epoch: 9, generation: 13 },
    { session: 7, epoch: 9, generation: 13 },
    { session: 6, epoch: 10, generation: 13 },
    { session: 6, epoch: 9, generation: 14 },
  ]) {
    const control = quiescentControl({ session: 5, epoch: 8, generation: 12 });
    assert.throws(
      () => beginNextWgpuRendererWorkerGeneration(
        control,
        OWNER.RENDERER,
        12,
        identity
      ),
      /not the next monotonic value/
    );
    assert.equal(readWgpuRendererWorkerState(control), STATE.FAILED);
    assert.equal(readWgpuRendererWorkerError(control), ERROR.INVALID_SEQUENCE);
    assert.equal(readWgpuRendererWorkerGeneration(control), 12);
  }
});

function quiescentControl(identity) {
  const control = createWgpuRendererWorkerControl({
    owner: OWNER.RENDERER,
    ...identity,
  });
  markWgpuRendererWorkerBootReady(control, OWNER.RENDERER, identity.generation);
  markWgpuRendererWorkerRingAttached(control, OWNER.RENDERER, identity.generation);
  requestWgpuRendererWorkerQuiesce(control, OWNER.RENDERER, identity.generation);
  markWgpuRendererWorkerQuiescent(control, OWNER.RENDERER, identity.generation);
  return control;
}
