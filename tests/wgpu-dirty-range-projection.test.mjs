// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createWgpuDirtyRangeProjection,
  requestedWgpuDirtyRangeProjection,
} from "../src/wgpu-dirty-range-projection.js";
import { WGPU_UPLOAD_ROLE } from "../src/wgpu-upload-attribution.js";

test("dirty-range projection is explicit URL opt-in with requested/active state", () => {
  assert.equal(requestedWgpuDirtyRangeProjection(""), false);
  assert.equal(requestedWgpuDirtyRangeProjection("?wgpudirtyranges=0"), false);
  assert.equal(requestedWgpuDirtyRangeProjection("?wgpudirtyranges=1"), true);
  const snapshot = createWgpuDirtyRangeProjection().snapshot({
    requested: true,
    active: false,
  });
  assert.equal(snapshot.schema, "wasm-dolphin.wgpu-dirty-range-projection.v1");
  assert.equal(snapshot.requested, true);
  assert.equal(snapshot.active, false);
  assert.equal(snapshot.enabled, false);
  assert.equal(snapshot.projectionOnly, true);
  assert.deepEqual(snapshot.gapThresholds, [0, 64, 256, 1024, 4096]);
  assert.deepEqual(snapshot.raw, { uploads: 0, bytes: 0 });
  assert.deepEqual(snapshot.projection.intervalCopiesByGap, [0, 0, 0, 0, 0]);
  assert.equal(snapshot.roles.length, 7);
  assert.equal(snapshot.roleProjectionAdditive, false);
});

test("projection merges ranges only within each buffer and configured gap", () => {
  const metrics = createWgpuDirtyRangeProjection({ gapThresholds: [0, 16, 64] });
  metrics.recordUpload({ bufferId: 1, destinationOffset: 0, bytes: 16 });
  metrics.recordUpload({ bufferId: 1, destinationOffset: 32, bytes: 16 });
  metrics.recordUpload({ bufferId: 1, destinationOffset: 96, bytes: 16 });
  metrics.recordUpload({ bufferId: 2, destinationOffset: 0, bytes: 8 });
  metrics.recordSegmentBoundary({ kind: "end-pass" });

  const snapshot = metrics.snapshot();
  assert.deepEqual(snapshot.raw, { uploads: 4, bytes: 56 });
  assert.deepEqual(snapshot.projection.intervalCopiesByGap, [4, 3, 2]);
  assert.deepEqual(snapshot.projection.copiedBytesByGap, [56, 72, 120]);
  assert.equal(snapshot.segments.finalized, 1);
  assert.equal(snapshot.segments.boundaryKinds["end-pass"], 1);
});

test("raw bytes describe padded GPU dirty bytes for an unaligned source upload", () => {
  const metrics = createWgpuDirtyRangeProjection({ gapThresholds: [0] });
  const sourceBytes = 5;
  const gpuDirtyBytes = (sourceBytes + 3) & ~3;
  metrics.recordUpload({ bufferId: 1, destinationOffset: 0, bytes: gpuDirtyBytes });
  assert.deepEqual(metrics.snapshot().raw, { uploads: 1, bytes: 8 });
});

test("projection reports overlap versions without changing last-write ordering", () => {
  const metrics = createWgpuDirtyRangeProjection({ gapThresholds: [0] });
  metrics.recordUpload({
    bufferId: 7,
    destinationOffset: 0,
    bytes: 64,
    role: WGPU_UPLOAD_ROLE.UBO,
  });
  metrics.recordUpload({
    bufferId: 7,
    destinationOffset: 32,
    bytes: 64,
    role: WGPU_UPLOAD_ROLE.UBO,
  });
  metrics.recordUpload({
    bufferId: 7,
    destinationOffset: 48,
    bytes: 8,
    role: WGPU_UPLOAD_ROLE.VERTEX,
  });

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.hazards.overlapUploadCount, 2);
  assert.equal(snapshot.hazards.overlapIntervalCount, 2);
  assert.equal(snapshot.hazards.overlapBytes, 40);
  assert.deepEqual(snapshot.projection.intervalCopiesByGap, [1]);
  assert.deepEqual(snapshot.projection.copiedBytesByGap, [96]);
  assert.equal(snapshot.roles[WGPU_UPLOAD_ROLE.UBO].raw.uploads, 2);
  assert.deepEqual(
    snapshot.roles[WGPU_UPLOAD_ROLE.UBO].projection.copiedBytesByGap,
    [96]
  );
});

test("large sequential segments retain bounded overlap bookkeeping", () => {
  const metrics = createWgpuDirtyRangeProjection({ gapThresholds: [0, 64] });
  for (let index = 0; index < 20_000; index += 1) {
    metrics.recordUpload({
      bufferId: 1,
      destinationOffset: index * 32,
      bytes: 32,
      role: WGPU_UPLOAD_ROLE.VERTEX,
      recordIndex: index,
    });
  }
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.raw.uploads, 20_000);
  assert.equal(snapshot.hazards.overlapUploadCount, 0);
  assert.deepEqual(snapshot.projection.intervalCopiesByGap, [1, 1]);
  assert.deepEqual(snapshot.projection.copiedBytesByGap, [640_000, 640_000]);
});

test("source arena, destination, and record ordering hazards are classified", () => {
  const metrics = createWgpuDirtyRangeProjection({ gapThresholds: [0] });
  metrics.recordUpload({
    bufferId: 1, destinationOffset: 128, bytes: 16,
    sourcePointer: 1900, sourceArenaBase: 1000, sourceArenaSize: 1024,
    recordIndex: 0xffffffff,
  });
  metrics.recordUpload({
    bufferId: 1, destinationOffset: 64, bytes: 16,
    sourcePointer: 1100, sourceArenaBase: 1000, sourceArenaSize: 1024,
    recordIndex: 0,
  });
  metrics.recordUpload({
    bufferId: 1, destinationOffset: 80, bytes: 16,
    sourcePointer: 3000, sourceArenaBase: 1000, sourceArenaSize: 1024,
    recordIndex: 0,
  });

  const hazards = metrics.snapshot().hazards;
  assert.equal(hazards.destinationOrderRegressionCount, 1);
  assert.equal(hazards.sourceArenaWrapCount, 1);
  assert.equal(hazards.sourceOutOfArenaCount, 1);
  assert.equal(hazards.recordIndexWrapCount, 1);
  assert.equal(hazards.recordOrderHazardCount, 1);
});

test("source validation rejects an end-straddling padded GPU upload", () => {
  const metrics = createWgpuDirtyRangeProjection({ gapThresholds: [0] });
  metrics.recordUpload({
    bufferId: 1,
    destinationOffset: 0,
    bytes: 8,
    sourcePointer: 1018,
    sourceBytes: 8,
    sourceArenaBase: 1000,
    sourceArenaSize: 24,
  });
  assert.equal(metrics.snapshot().hazards.sourceOutOfArenaCount, 1);
});

test("cross-role gap merging is global while role rows remain non-additive", () => {
  const metrics = createWgpuDirtyRangeProjection({ gapThresholds: [16] });
  metrics.recordUpload({
    bufferId: 1, destinationOffset: 0, bytes: 16, role: WGPU_UPLOAD_ROLE.UBO,
  });
  metrics.recordUpload({
    bufferId: 1, destinationOffset: 32, bytes: 16, role: WGPU_UPLOAD_ROLE.VERTEX,
  });
  const snapshot = metrics.snapshot();
  assert.deepEqual(snapshot.projection.intervalCopiesByGap, [1]);
  assert.deepEqual(snapshot.projection.copiedBytesByGap, [48]);
  assert.equal(snapshot.roles[WGPU_UPLOAD_ROLE.UBO].projection.copiedBytesByGap[0], 16);
  assert.equal(snapshot.roles[WGPU_UPLOAD_ROLE.VERTEX].projection.copiedBytesByGap[0], 16);
  assert.equal(snapshot.roleProjectionAdditive, false);
});

test("incomplete boundaries finalize the current projection and reset hazards' ordering window", () => {
  const metrics = createWgpuDirtyRangeProjection({ gapThresholds: [0] });
  metrics.recordUpload({ bufferId: 1, destinationOffset: 100, bytes: 20 });
  assert.equal(metrics.recordSegmentBoundary({ kind: "load-fence", complete: false }), true);
  assert.equal(metrics.recordSegmentBoundary({ kind: "empty", complete: false }), false);
  metrics.recordUpload({ bufferId: 1, destinationOffset: 0, bytes: 10 });

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.segments.finalized, 1);
  assert.equal(snapshot.segments.incomplete, 1);
  assert.equal(snapshot.segments.emptyBoundaries, 1);
  assert.equal(snapshot.segments.currentUploads, 1);
  assert.equal(snapshot.hazards.destinationOrderRegressionCount, 0);
  assert.deepEqual(snapshot.projection.intervalCopiesByGap, [2]);
});

test("present finalizes uploads even when no render pass is open", () => {
  const metrics = createWgpuDirtyRangeProjection({ gapThresholds: [0] });
  metrics.recordUpload({ bufferId: 1, destinationOffset: 0, bytes: 16 });
  assert.equal(metrics.recordSegmentBoundary({ kind: "submit-present" }), true);
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.segments.finalized, 1);
  assert.equal(snapshot.segments.currentUploads, 0);
  assert.equal(snapshot.segments.boundaryKinds["submit-present"], 1);
});

test("finalized counters ignore a reshaping open segment until its boundary", () => {
  const metrics = createWgpuDirtyRangeProjection({ gapThresholds: [0] });
  metrics.recordUpload({ bufferId: 1, destinationOffset: 0, bytes: 16 });
  metrics.recordUpload({ bufferId: 1, destinationOffset: 64, bytes: 16 });

  const beforeBridge = metrics.snapshot();
  assert.deepEqual(beforeBridge.projection.intervalCopiesByGap, [2]);
  assert.deepEqual(beforeBridge.finalized, {
    segmentCount: 0,
    raw: { uploads: 0, bytes: 0 },
    projection: { intervalCopiesByGap: [0], copiedBytesByGap: [0] },
    hazards: {
      overlapUploadCount: 0,
      overlapIntervalCount: 0,
      overlapBytes: 0,
      destinationOrderRegressionCount: 0,
      sourceArenaWrapCount: 0,
      sourceOutOfArenaCount: 0,
      recordIndexWrapCount: 0,
      recordOrderHazardCount: 0,
    },
  });

  metrics.recordUpload({ bufferId: 1, destinationOffset: 16, bytes: 48 });
  const bridged = metrics.snapshot();
  assert.deepEqual(bridged.projection.intervalCopiesByGap, [1]);
  assert.deepEqual(bridged.finalized, beforeBridge.finalized);

  metrics.recordSegmentBoundary({ kind: "end-pass" });
  const finalized = metrics.snapshot().finalized;
  assert.equal(finalized.segmentCount, 1);
  assert.deepEqual(finalized.raw, { uploads: 3, bytes: 80 });
  assert.deepEqual(finalized.projection.intervalCopiesByGap, [1]);
  assert.deepEqual(finalized.projection.copiedBytesByGap, [80]);
  assert.equal(finalized.hazards.destinationOrderRegressionCount, 1);
});

test("host plumbing is default-off and worker records only accepted padded uploads", async () => {
  const [host, adapter, worker] = await Promise.all([
    readFile(new URL("../src/core-host.js", import.meta.url), "utf8"),
    readFile(new URL("../src/upstream-worker-adapter.js", import.meta.url), "utf8"),
    readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8"),
  ]);
  assert.match(host, /requestedWgpuDirtyRangeProjection\(window\.location\.search\)/);
  assert.match(host, /wgpuDirtyRangeProjection: this\.wgpuDirtyRangeProjection/);
  assert.match(adapter, /wgpuDirtyRangeProjection = false/);
  assert.match(adapter, /wgpuDirtyRangeProjection: this\.wgpuDirtyRangeProjection/);
  assert.match(worker, /wgpuDirtyRangeProjectionRequested && causalMetricsEnabled/);
  assert.match(worker, /bytes: len,[\s\S]*?sourceBytes: len/);
  const failedStage = worker.indexOf("if (!staged.ok)");
  const acceptedProjection = worker.indexOf(
    "wgpuDirtyRangeProjection.recordUpload",
    failedStage
  );
  const capacityBreak = worker.indexOf("break;", failedStage);
  assert.ok(failedStage >= 0 && capacityBreak >= 0 && acceptedProjection > capacityBreak);
  assert.match(
    worker,
    /if \(!endPass\("submit-present", read\) && wgpuDirtyRangeProjectionActive\)/
  );
});
