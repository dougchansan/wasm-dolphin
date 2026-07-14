// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  WGPU_UPLOAD_RUN_PROJECTION_SCHEMA,
  createWgpuUploadRunProjection,
  requestedWgpuUploadRunProjection,
} from "../src/wgpu-upload-run-projection.js";

const UPLOAD_BUFFER = 6;
const DRAW = 19;

function upload(projection, {
  recordIndex,
  sourcePointer,
  logicalBytes = 4,
  alignedBytes = logicalBytes,
  sourceArenaBase = 1024,
  sourceArenaSize = 64,
  hasDestination = true,
  retained = false,
  semanticCapture = false,
} = {}) {
  projection.observeAcceptedRecord({
    op: UPLOAD_BUFFER,
    recordIndex,
    sourcePointer,
    logicalBytes,
    alignedBytes,
    sourceArenaBase,
    sourceArenaSize,
    hasDestination,
    retained,
    semanticCapture,
  });
}

test("upload-run projection request is exact and default-off", () => {
  assert.equal(requestedWgpuUploadRunProjection(""), false);
  assert.equal(requestedWgpuUploadRunProjection("?wgpuuploadrunprojection=0"), false);
  assert.equal(requestedWgpuUploadRunProjection("?wgpuuploadrunprojection=1"), true);
  assert.equal(requestedWgpuUploadRunProjection("?wgpuuploadrunprojection=true"), false);
  const snapshot = createWgpuUploadRunProjection().snapshot();
  assert.equal(snapshot.schema, WGPU_UPLOAD_RUN_PROJECTION_SCHEMA);
  assert.equal(snapshot.requested, false);
  assert.equal(snapshot.active, false);
  assert.equal(snapshot.projectionOnly, true);
  assert.equal(snapshot.replayBehaviorChanged, false);
  assert.equal(snapshot.runtimeEligible, false);
});

test("contiguous uploads project one set while preserving scatter records", () => {
  const projection = createWgpuUploadRunProjection();
  upload(projection, { recordIndex: 10, sourcePointer: 1024 });
  upload(projection, { recordIndex: 11, sourcePointer: 1028 });
  upload(projection, {
    recordIndex: 12,
    sourcePointer: 1036,
    logicalBytes: 3,
    alignedBytes: 4,
  });
  projection.boundary("drain");

  const snapshot = projection.snapshot({ requested: true, active: true });
  assert.deepEqual(snapshot.uploads, {
    logical: 3,
    eligible: 3,
    fallback: 0,
    currentScalarSetCalls: 3,
  });
  assert.equal(snapshot.projected.runs, 1);
  assert.equal(snapshot.projected.setCalls, 1);
  assert.equal(snapshot.projected.setCallReduction, 2);
  assert.equal(snapshot.projected.scatterCopyCommands, 3);
  assert.deepEqual(snapshot.bytes, {
    logicalPayload: 11,
    eligibleLogicalPayload: 11,
    fallbackLogicalPayload: 0,
    alignedCopy: 12,
    eligibleAlignedCopy: 12,
    fallbackAlignedCopy: 0,
    alignmentPadding: 1,
    envelope: 16,
    gap: 4,
    gapInflationRatio: 1 / 3,
  });
  assert.equal(snapshot.runLength.min, 3);
  assert.equal(snapshot.runLength.max, 3);
  assert.equal(snapshot.runLength.average, 3);
  assert.equal(snapshot.runLength.p50UpperBound, 4);
  assert.equal(snapshot.runLength.p95UpperBound, 4);
});

test("source-arena wrap and slot capacity split runs without losing eligibility", () => {
  const wrapProjection = createWgpuUploadRunProjection({ maxEnvelopeBytes: 32 });
  upload(wrapProjection, {
    recordIndex: 0,
    sourcePointer: 1048,
    logicalBytes: 8,
    sourceArenaSize: 32,
  });
  upload(wrapProjection, {
    recordIndex: 1,
    sourcePointer: 1024,
    logicalBytes: 8,
    sourceArenaSize: 32,
  });
  wrapProjection.boundary("drain");
  const wrapped = wrapProjection.snapshot();
  assert.equal(wrapped.wraps.sourceArena, 1);
  assert.equal(wrapped.projected.runs, 2);
  assert.equal(wrapped.splits.reasons.sourceArenaWrap, 1);
  assert.equal(wrapped.hazards.ownershipOrder, 0);

  const capacityProjection = createWgpuUploadRunProjection({ maxEnvelopeBytes: 12 });
  upload(capacityProjection, { recordIndex: 0, sourcePointer: 1024, logicalBytes: 8 });
  upload(capacityProjection, { recordIndex: 1, sourcePointer: 1032, logicalBytes: 8 });
  capacityProjection.boundary("drain");
  const capacity = capacityProjection.snapshot();
  assert.equal(capacity.projected.runs, 2);
  assert.equal(capacity.splits.reasons.capacity, 1);
  assert.equal(capacity.uploads.eligible, 2);
});

test("fallbacks remain scalar and publish explicit split reasons", () => {
  const projection = createWgpuUploadRunProjection({ maxEnvelopeBytes: 16 });
  upload(projection, { recordIndex: 0, sourcePointer: 1024, hasDestination: false });
  upload(projection, { recordIndex: 1, sourcePointer: 1028, retained: true });
  upload(projection, { recordIndex: 2, sourcePointer: 1032, semanticCapture: true });
  upload(projection, { recordIndex: 3, sourcePointer: 2048 });
  upload(projection, {
    recordIndex: 4,
    sourcePointer: 1084,
    logicalBytes: 8,
    sourceArenaSize: 64,
  });
  upload(projection, { recordIndex: 5, sourcePointer: 1040, logicalBytes: 20 });
  upload(projection, { recordIndex: 6, sourcePointer: 1044, logicalBytes: 0 });
  projection.observeAcceptedRecord({ op: DRAW, recordIndex: 7 });

  const snapshot = projection.snapshot();
  assert.equal(snapshot.uploads.logical, 7);
  assert.equal(snapshot.uploads.eligible, 0);
  assert.equal(snapshot.uploads.fallback, 7);
  assert.equal(snapshot.uploads.currentScalarSetCalls, 5);
  assert.deepEqual(snapshot.fallbacks.reasons, {
    missingDestination: 1,
    retainedUpload: 1,
    semanticCapture: 1,
    outsideArena: 1,
    physicalRangeWrap: 1,
    payloadTooLarge: 1,
    invalidLength: 1,
  });
  assert.equal(snapshot.hazards.ownershipOrder, 1);
  assert.equal(snapshot.wraps.physicalRange, 1);
  assert.equal(snapshot.projected.setCalls, 5);
  assert.equal(snapshot.projected.setCallReduction, 0);
});

test("overlap and record discontinuity are counted as ordering hazards", () => {
  const projection = createWgpuUploadRunProjection();
  upload(projection, { recordIndex: 5, sourcePointer: 1024, logicalBytes: 8 });
  upload(projection, { recordIndex: 6, sourcePointer: 1028, logicalBytes: 4 });
  upload(projection, { recordIndex: 9, sourcePointer: 1032, logicalBytes: 4 });
  projection.boundary("drain");
  const snapshot = projection.snapshot();
  assert.equal(snapshot.hazards.ownershipOrder, 2);
  assert.equal(snapshot.fallbacks.reasons.sourceOverlap, 1);
  assert.equal(snapshot.splits.reasons.recordDiscontinuity, 1);
  assert.equal(snapshot.uploads.eligible, 2);
  assert.equal(snapshot.uploads.fallback, 1);
});

test("observer source is passive and owns no renderer, synchronization, or payload bytes", async () => {
  const source = await readFile(
    new URL("../src/wgpu-upload-run-projection.js", import.meta.url),
    "utf8"
  );
  for (const forbidden of [
    /navigator\.gpu/,
    /queue\.writeBuffer/,
    /copyBufferToBuffer/,
    /Atomics\./,
    /SharedArrayBuffer/,
    /postMessage/,
    /Uint8Array/,
  ]) {
    assert.doesNotMatch(source, forbidden);
  }
});

test("host-worker-tool plumbing is complete and observation stays on accepted records", async () => {
  const [host, adapter, worker, menu, gate] = await Promise.all([
    readFile(new URL("../src/core-host.js", import.meta.url), "utf8"),
    readFile(new URL("../src/upstream-worker-adapter.js", import.meta.url), "utf8"),
    readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8"),
    readFile(new URL("../tools/menu-progress-validate.mjs", import.meta.url), "utf8"),
    readFile(new URL("../tools/perf-regression-gate.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(host, /requestedWgpuUploadRunProjection\(window\.location\.search\)/);
  assert.match(host, /wgpuUploadRunProjection: this\.wgpuUploadRunProjection/);
  assert.match(adapter, /wgpuUploadRunProjection = false/);
  assert.match(adapter, /wgpuUploadRunProjection: this\.wgpuUploadRunProjection/);
  assert.match(worker, /wgpuuploadrunprojection=1 requires metrics=1/);
  assert.match(worker, /wgpuuploadrunprojection=1 requires video=wgpu/);
  assert.match(worker, /wgpuuploadrunprojection=1 requires wgpuuploadtransport=mapped/);
  assert.match(worker, /wgpuUploadRunProjection\.reset\("device-lost"\)/);
  assert.match(worker, /wgpuUploadRunProjection\.boundary\("drain"\)/);
  const observe = worker.indexOf("wgpuUploadRunProjection.observeAcceptedRecord");
  const mappedHold = worker.lastIndexOf("if (mappedCapacityHold)", observe);
  const advance = worker.indexOf("read = (read + 1) >>> 0;", observe);
  assert.ok(observe > mappedHold && advance > observe);
  assert.match(menu, /WGPUUPLOADRUNPROJECTION/);
  assert.match(gate, /wgpuuploadrunprojection/);
});
