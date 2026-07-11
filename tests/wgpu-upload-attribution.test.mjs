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

test("WGPU upload attribution starts with a fixed zero-filled v2 schema", () => {
  const snapshot = createWgpuUploadAttribution().snapshot({ enabled: false });

  assert.equal(snapshot.schema, "wasm-dolphin.wgpu-upload-attribution.v2");
  assert.equal(snapshot.enabled, false);
  assert.deepEqual(snapshot.roleOrder, [
    "unknown",
    "ubo",
    "utility-uniform",
    "vertex",
    "index",
    "texture-adjacent",
    "geometry",
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
  metrics.reset();

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.totalCalls, 0);
  assert.equal(snapshot.totalBytes, 0);
  assert.equal(snapshot.maxBytes, 0);
  assert.ok(snapshot.callsByRole.every((value) => value === 0));
  assert.ok(snapshot.bucketBytesByRole.flat().every((value) => value === 0));
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
    maxDestinationSpanBytesByRole: [0, 0, 0, 0, 0, 0, 0],
  });
});
