// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import {
  awaitWgpuQueueCompletion,
  createWgpuReplayStabilityTracker,
  isWgpuReplaySnapshotEmpty,
  requireWgpuReplayRing,
  validatePostCompletionReplaySnapshot,
} from "../src/wgpu-replay-quiescence.js";

const emptySnapshot = (overrides = {}) => ({
  registered: true,
  writeIndex: 12,
  readIndex: 12,
  publishedReadIndex: 12,
  backlog: 0,
  stagedUploads: 0,
  heldReplay: false,
  loadFenceActive: false,
  pendingMappedUploads: 0,
  activeMappedBatches: 0,
  pendingRemaps: 0,
  capacityBlocked: false,
  mappedDrainTimerPending: false,
  fatal: null,
  ...overrides,
});

test("late writes and mapped work reset replay stability", () => {
  const tracker = createWgpuReplayStabilityTracker();
  assert.equal(tracker.observe(emptySnapshot(), 0).ready, false);
  assert.equal(tracker.observe(emptySnapshot(), 50).ready, true);

  const lateWrite = tracker.observe(emptySnapshot({ writeIndex: 13 }), 51);
  assert.equal(lateWrite.ready, false);
  assert.equal(lateWrite.stableEmptyObservations, 1);
  assert.equal(lateWrite.stableEmptyMs, 0);

  const mapped = emptySnapshot({
    writeIndex: 13,
    pendingMappedUploads: 1,
    pendingRemaps: 1,
  });
  assert.equal(isWgpuReplaySnapshotEmpty(mapped), false);
  assert.equal(tracker.observe(mapped, 120).stableEmptyObservations, 0);
});

test("required ring and GPU completion support fail closed", async () => {
  assert.throws(
    () => requireWgpuReplayRing(emptySnapshot({ registered: false }), true),
    /registered command ring/
  );
  await assert.rejects(
    awaitWgpuQueueCompletion(null, { required: true, deadlineAtMs: 10 }),
    /GPU completion support/
  );
});

test("GPU completion rejection and timeout are retained", async () => {
  const failure = new Error("device lost");
  await assert.rejects(
    awaitWgpuQueueCompletion(
      { onSubmittedWorkDone: () => Promise.reject(failure) },
      { deadlineAtMs: 10, now: () => 0 }
    ),
    failure
  );
  await assert.rejects(
    awaitWgpuQueueCompletion(
      { onSubmittedWorkDone: () => new Promise(() => {}) },
      {
        deadlineAtMs: 10,
        now: () => 0,
        setTimeoutFn: (callback) => {
          queueMicrotask(callback);
          return 1;
        },
        clearTimeoutFn: () => {},
      }
    ),
    /GPU completion timed out/
  );
});

test("post-completion writes invalidate an otherwise empty fence", () => {
  assert.doesNotThrow(() => validatePostCompletionReplaySnapshot(emptySnapshot(), 12));
  assert.throws(
    () => validatePostCompletionReplaySnapshot(emptySnapshot({ writeIndex: 13 }), 12),
    /changed during GPU completion/
  );
});
