// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import {
  WGPU_UPLOAD_ROLE,
  WGPU_UPLOAD_ROLE_NAMES,
  WGPU_UPLOAD_SIZE_BUCKET_LABELS,
  createWgpuUploadAttribution,
} from "../src/wgpu-upload-attribution.js";

test("WGPU upload attribution starts with a fixed zero-filled v3 schema", () => {
  const snapshot = createWgpuUploadAttribution().snapshot({ enabled: false });

  assert.equal(snapshot.schema, "wasm-dolphin.wgpu-upload-attribution.v3");
  assert.equal(snapshot.enabled, false);
  assert.deepEqual(snapshot.roleOrder, [
    "unknown",
    "ubo",
    "utility-uniform",
    "vertex",
    "index",
    "texture-adjacent",
    "geometry",
    "ubo-compute-package",
  ]);
  assert.deepEqual(snapshot.sizeBucketLabels, [
    "<=64", "<=256", "<=1024", "<=4096", "<=16384", "<=65536", ">65536",
  ]);
  assert.equal(snapshot.callsByRole.length, WGPU_UPLOAD_ROLE_NAMES.length);
  assert.equal(snapshot.bucketCallsByRole.length, WGPU_UPLOAD_ROLE_NAMES.length);
  assert.ok(snapshot.callsByRole.every((value) => value === 0));
  assert.ok(snapshot.bytesByRole.every((value) => value === 0));
  assert.ok(snapshot.maxBytesByRole.every((value) => value === 0));
  assert.ok(snapshot.bucketCallsByRole.every(
    (row) => row.length === WGPU_UPLOAD_SIZE_BUCKET_LABELS.length &&
      row.every((value) => value === 0)
  ));
  assert.equal(snapshot.passAssociation.completedPassCount, 0);
  assert.equal(snapshot.passAssociation.currentPassOpen, false);
});

test("packed geometry uploads retain their own stable producer role", () => {
  const metrics = createWgpuUploadAttribution();
  metrics.recordUpload(WGPU_UPLOAD_ROLE.GEOMETRY, 320, 4096);
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.callsByRole[WGPU_UPLOAD_ROLE.GEOMETRY], 1);
  assert.equal(snapshot.bytesByRole[WGPU_UPLOAD_ROLE.GEOMETRY], 320);
});

test("queue.writeBuffer CPU time is attributed by role with bounded slow evidence", () => {
  const metrics = createWgpuUploadAttribution();
  metrics.recordQueueWrite(WGPU_UPLOAD_ROLE.UBO, 1536, 1700, {
    backlogRecords: 912,
    submissionCount: 17,
    passDepth: 0,
    staged: true,
  });
  metrics.recordQueueWrite(WGPU_UPLOAD_ROLE.VERTEX, 4096, 4.5, {
    backlogRecords: 64,
    submissionCount: 18,
    passDepth: 1,
  });

  const queueWrite = metrics.snapshot().queueWrite;
  assert.equal(queueWrite.totalCalls, 2);
  assert.equal(queueWrite.totalMs, 1704.5);
  assert.equal(queueWrite.maxMs, 1700);
  assert.equal(queueWrite.callsByRole[WGPU_UPLOAD_ROLE.UBO], 1);
  assert.equal(queueWrite.totalMsByRole[WGPU_UPLOAD_ROLE.UBO], 1700);
  assert.equal(queueWrite.maxMsByRole[WGPU_UPLOAD_ROLE.VERTEX], 4.5);
  assert.equal(queueWrite.slowEventObservedCount, 1);
  assert.deepEqual(queueWrite.slowEvents[0], {
    sequence: 1,
    role: WGPU_UPLOAD_ROLE.UBO,
    roleName: "ubo",
    bytes: 1536,
    durationMs: 1700,
    backlogRecords: 912,
    submissionCount: 17,
    passDepth: 0,
    staged: true,
  });
});

test("mapped capacity waits retain the blocked upload role", () => {
  const metrics = createWgpuUploadAttribution();
  metrics.recordCapacityWaitAttempt(WGPU_UPLOAD_ROLE.UBO);
  metrics.recordCapacityWaitAttempt(WGPU_UPLOAD_ROLE.UBO);
  metrics.beginCapacityWait(WGPU_UPLOAD_ROLE.UBO);
  metrics.recordCapacityWaitDuration(WGPU_UPLOAD_ROLE.UBO, 23.5);
  metrics.recordCapacityWaitAttempt(999);
  metrics.beginCapacityWait(999);
  metrics.recordCapacityWaitDuration(999, 4);

  const wait = metrics.snapshot().capacityWait;
  assert.equal(wait.totalAttempts, 3);
  assert.equal(wait.totalEpisodes, 2);
  assert.equal(wait.completedEpisodes, 2);
  assert.equal(wait.totalMs, 27.5);
  assert.equal(wait.maxMs, 23.5);
  assert.equal(wait.attemptsByRole[WGPU_UPLOAD_ROLE.UBO], 2);
  assert.equal(wait.episodesByRole[WGPU_UPLOAD_ROLE.UBO], 1);
  assert.equal(wait.completedByRole[WGPU_UPLOAD_ROLE.UBO], 1);
  assert.equal(wait.totalMsByRole[WGPU_UPLOAD_ROLE.UBO], 23.5);
  assert.equal(wait.maxMsByRole[WGPU_UPLOAD_ROLE.UBO], 23.5);
  assert.equal(wait.attemptsByRole[WGPU_UPLOAD_ROLE.UNKNOWN], 1);
  assert.equal(wait.totalMsByRole[WGPU_UPLOAD_ROLE.UNKNOWN], 4);
});

test("mapped staging timing samples independently by role without unsampled clocks", () => {
  let clockCalls = 0;
  const metrics = createWgpuUploadAttribution({
    mappedStageTimingStride: 64,
    now: () => clockCalls++,
  });
  for (let index = 0; index < 129; index += 1) {
    const startedAt = metrics.beginMappedStageTiming(WGPU_UPLOAD_ROLE.UBO);
    metrics.finishMappedStageTiming(WGPU_UPLOAD_ROLE.UBO, startedAt, 64);
  }
  for (let index = 0; index < 2; index += 1) {
    const startedAt = metrics.beginMappedStageTiming(WGPU_UPLOAD_ROLE.TEXTURE_ADJACENT);
    metrics.finishMappedStageTiming(
      WGPU_UPLOAD_ROLE.TEXTURE_ADJACENT, startedAt, 256
    );
  }

  const timing = metrics.snapshot().mappedStageTiming;
  assert.equal(clockCalls, 8);
  assert.equal(timing.mode, "per-role-periodic-sample");
  assert.equal(timing.stride, 64);
  assert.equal(timing.eligibleCalls, 131);
  assert.equal(timing.sampleCount, 4);
  assert.equal(timing.sampleCountsByRole[WGPU_UPLOAD_ROLE.UBO], 3);
  assert.equal(timing.sampleCountsByRole[WGPU_UPLOAD_ROLE.TEXTURE_ADJACENT], 1);
  assert.equal(timing.sampleBytes, 448);
  assert.equal(timing.sampleTotalMs, 4);
});

test("exact mapped staging timing accepts a zero-valued start clock", () => {
  const readings = [0, 2.5];
  const metrics = createWgpuUploadAttribution({
    mappedStageTimingStride: 1,
    now: () => readings.shift(),
  });
  const startedAt = metrics.beginMappedStageTiming(WGPU_UPLOAD_ROLE.VERTEX);
  assert.equal(startedAt, 0);
  assert.equal(
    metrics.finishMappedStageTiming(WGPU_UPLOAD_ROLE.VERTEX, startedAt, 1024),
    2.5
  );
  const timing = metrics.snapshot().mappedStageTiming;
  assert.equal(timing.mode, "exact");
  assert.equal(timing.eligibleCalls, 1);
  assert.equal(timing.sampleCount, 1);
  assert.equal(timing.sampleTotalMs, 2.5);
});

test("queue.writeBuffer retains only the 32 longest >20ms events", () => {
  const metrics = createWgpuUploadAttribution();
  for (let index = 0; index < 40; index += 1) {
    metrics.recordQueueWrite(WGPU_UPLOAD_ROLE.UBO, 256, 21 + index);
  }
  metrics.recordQueueWrite(WGPU_UPLOAD_ROLE.UBO, 256, 20);

  const queueWrite = metrics.snapshot().queueWrite;
  assert.equal(queueWrite.slowEventObservedCount, 40);
  assert.equal(queueWrite.slowEvents.length, 32);
  assert.equal(queueWrite.slowEvents[0].durationMs, 60);
  assert.equal(queueWrite.slowEvents.at(-1).durationMs, 29);
});

test("WGPU upload attribution records roles, byte maxima, and exact bucket edges", () => {
  const metrics = createWgpuUploadAttribution();
  const sizes = [64, 65, 256, 257, 1024, 1025, 4096, 4097, 16384, 16385, 65536, 65537];
  for (const size of sizes) metrics.recordUpload(WGPU_UPLOAD_ROLE.VERTEX, size, 0);
  metrics.recordUpload(999, 32, 0);

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.totalCalls, 13);
  assert.equal(snapshot.totalBytes, sizes.reduce((sum, value) => sum + value, 32));
  assert.equal(snapshot.maxBytes, 65537);
  assert.equal(snapshot.callsByRole[WGPU_UPLOAD_ROLE.VERTEX], 12);
  assert.equal(snapshot.callsByRole[WGPU_UPLOAD_ROLE.UNKNOWN], 1);
  assert.equal(snapshot.maxBytesByRole[WGPU_UPLOAD_ROLE.VERTEX], 65537);
  assert.deepEqual(snapshot.bucketCallsByRole[WGPU_UPLOAD_ROLE.VERTEX], [1, 2, 2, 2, 2, 2, 1]);
  assert.deepEqual(snapshot.bucketCallsByRole[WGPU_UPLOAD_ROLE.UNKNOWN], [1, 0, 0, 0, 0, 0, 0]);
});

test("pre-BEGIN uploads fold into the following completed pass", () => {
  const metrics = createWgpuUploadAttribution();
  metrics.recordUpload(WGPU_UPLOAD_ROLE.VERTEX, 128, 1000);
  metrics.recordUpload(WGPU_UPLOAD_ROLE.INDEX, 32, 200);
  metrics.recordPassBegin();
  metrics.recordUpload(WGPU_UPLOAD_ROLE.UBO, 64, 256);
  assert.equal(metrics.recordPassEnd(), true);

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.passAssociation.completedPassCount, 1);
  assert.equal(snapshot.passAssociation.maxCalls, 3);
  assert.equal(snapshot.passAssociation.maxBytes, 224);
  assert.equal(snapshot.passAssociation.maxDestinationSpanBytes, 128);
  assert.equal(
    snapshot.passAssociation.maxDestinationSpanBytesByRole[WGPU_UPLOAD_ROLE.VERTEX],
    128
  );
  assert.equal(snapshot.passAssociation.currentWindowCalls, 0);
});

test("pass aborts and incomplete boundaries discard windows without losing cumulative totals", () => {
  const metrics = createWgpuUploadAttribution();
  metrics.recordUpload(WGPU_UPLOAD_ROLE.UTILITY_UNIFORM, 48, 0);
  metrics.recordPassBegin();
  assert.equal(metrics.recordPassAbort(), true);
  assert.equal(metrics.recordPassAbort(), false);

  metrics.recordUpload(WGPU_UPLOAD_ROLE.TEXTURE_ADJACENT, 512, 64);
  assert.equal(metrics.recordIncompletePass(), true);
  metrics.recordPassBegin();
  metrics.recordUpload(WGPU_UPLOAD_ROLE.INDEX, 16, 80);
  metrics.recordPassBegin();

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.totalCalls, 3);
  assert.equal(snapshot.passAssociation.abortedPassCount, 1);
  assert.equal(snapshot.passAssociation.incompletePassCount, 2);
  assert.equal(snapshot.passAssociation.completedPassCount, 0);
  assert.equal(snapshot.passAssociation.currentPassOpen, true);
  assert.equal(snapshot.passAssociation.currentWindowCalls, 0);
});

test("reset restores all counters, buckets, pass state, and maxima", () => {
  const metrics = createWgpuUploadAttribution();
  metrics.recordUpload(WGPU_UPLOAD_ROLE.VERTEX, 4096, 128);
  metrics.recordPassBegin();
  metrics.recordPassEnd();
  metrics.recordCapacityWaitAttempt(WGPU_UPLOAD_ROLE.GEOMETRY);
  metrics.beginCapacityWait(WGPU_UPLOAD_ROLE.GEOMETRY);
  metrics.recordCapacityWaitDuration(WGPU_UPLOAD_ROLE.GEOMETRY, 8);
  metrics.reset();

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.totalCalls, 0);
  assert.equal(snapshot.totalBytes, 0);
  assert.equal(snapshot.maxBytes, 0);
  assert.ok(snapshot.callsByRole.every((value) => value === 0));
  assert.ok(snapshot.bucketBytesByRole.flat().every((value) => value === 0));
  assert.equal(snapshot.capacityWait.totalAttempts, 0);
  assert.equal(snapshot.capacityWait.totalMs, 0);
  assert.ok(snapshot.capacityWait.attemptsByRole.every((value) => value === 0));
  assert.equal(snapshot.mappedStageTiming.eligibleCalls, 0);
  assert.equal(snapshot.mappedStageTiming.sampleCount, 0);
  assert.deepEqual(snapshot.passAssociation, {
    definition: "uploads-after-previous-boundary-through-following-end-pass",
    preBeginUploadsFoldIntoFollowingPass: true,
    completedPassCount: 0,
    abortedPassCount: 0,
    incompletePassCount: 0,
    currentPassOpen: false,
    currentWindowCalls: 0,
    currentWindowBytes: 0,
    maxCalls: 0,
    maxBytes: 0,
    maxDestinationSpanBytes: 0,
    maxDestinationSpanBytesByRole: [0, 0, 0, 0, 0, 0, 0, 0],
  });
});
