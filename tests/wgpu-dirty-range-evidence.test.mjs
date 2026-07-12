// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  evaluateWgpuDirtyRangeProjection,
  flattenWgpuDirtyRangeProjection,
} from "../tools/perf-artifacts.mjs";

const HAZARDS = Object.freeze({
  overlapUploadCount: 5,
  overlapIntervalCount: 5,
  overlapBytes: 64,
  destinationOrderRegressionCount: 0,
  sourceArenaWrapCount: 2,
  sourceOutOfArenaCount: 0,
  recordIndexWrapCount: 1,
  recordOrderHazardCount: 0,
});

function snapshot({
  uploads,
  bytes,
  copies,
  projectedBytes,
  hazards = HAZARDS,
  requested = true,
  active = true,
  segmentCount = uploads,
  totalCopies = copies,
  totalProjectedBytes = projectedBytes,
} = {}) {
  return {
    schema: "wasm-dolphin.wgpu-dirty-range-projection.v1",
    requested,
    active,
    enabled: active,
    projectionOnly: true,
    gapThresholds: [0, 64],
    raw: { uploads, bytes },
    hazards: { ...hazards },
    projection: {
      intervalCopiesByGap: [...totalCopies],
      copiedBytesByGap: [...totalProjectedBytes],
    },
    finalized: {
      segmentCount,
      raw: { uploads, bytes },
      hazards: { ...hazards },
      projection: {
        intervalCopiesByGap: [...copies],
        copiedBytesByGap: [...projectedBytes],
      },
    },
  };
}

function sample(projection) {
  return { causalTelemetry: { webgpu: { dirtyRangeProjection: projection } } };
}

test("dirty-range evidence flattens cumulative snapshots into causal CSV columns", () => {
  const flattened = flattenWgpuDirtyRangeProjection(snapshot({
    uploads: 100,
    bytes: 1_000,
    copies: [20, 18],
    projectedBytes: [900, 950],
  }));
  assert.equal(flattened.causalWgpuDirtyRangeRequested, true);
  assert.equal(flattened.causalWgpuDirtyRangeActive, true);
  assert.equal(flattened.causalWgpuDirtyRangeRawUploads, 100);
  assert.equal(flattened.causalWgpuDirtyRangeRawBytes, 1_000);
  assert.equal(flattened.causalWgpuDirtyRangeFinalizedSegmentCount, 100);
  assert.deepEqual(flattened.causalWgpuDirtyRangeGapThresholds, [0, 64]);
  assert.equal(flattened.causalWgpuDirtyRangeProjectedCopiesGap0, 20);
  assert.equal(flattened.causalWgpuDirtyRangeProjectedBytesGap64, 950);
  assert.equal(flattened.causalWgpuDirtyRangeHazardOverlapUploadCount, 5);
});

test("dirty-range evaluator uses monotonic finalized counters when an open projection shrinks", () => {
  const first = snapshot({
    uploads: 100,
    bytes: 1_000,
    copies: [20, 18],
    projectedBytes: [900, 950],
    totalCopies: [30, 28],
    totalProjectedBytes: [1_400, 1_450],
  });
  const bridgedOpenRange = snapshot({
    uploads: 110,
    bytes: 1_500,
    copies: [22, 20],
    projectedBytes: [1_400, 1_499],
    totalCopies: [25, 23],
    totalProjectedBytes: [1_700, 1_799],
  });
  const final = snapshot({
    uploads: 120,
    bytes: 2_000,
    copies: [24, 21],
    projectedBytes: [2_000, 2_149],
  });
  const result = evaluateWgpuDirtyRangeProjection([
    sample({ requested: false }),
    sample(first),
    sample(bridgedOpenRange),
    sample(final),
  ]);

  assert.equal(result.valid, true, result.failures.join("; "));
  assert.equal(result.firstValidSampleIndex, 1);
  assert.equal(result.finalSampleIndex, 3);
  assert.equal(result.finalizedSegmentCount, 20);
  assert.deepEqual(result.raw, { uploads: 20, bytes: 1_000 });
  assert.equal(result.zeroUnresolvedHazards, true);
  assert.deepEqual(result.qualifyingGapThresholds, [0, 64]);
  assert.equal(result.selectedQualifyingGapThreshold, 0);
  assert.deepEqual(result.projections[0], {
    gapThresholdBytes: 0,
    projectedCopies: 4,
    projectedBytes: 1_100,
    copyReductionRatio: 0.8,
    byteInflationRatio: 0.10000000000000009,
    copyReductionAtLeast80Percent: true,
    byteInflationAtMost20Percent: true,
    zeroUnresolvedHazards: true,
    qualifies: true,
  });
});

test("dirty-range evaluator rejects reset counters, zero denominators, and hazards", () => {
  const first = snapshot({
    uploads: 100,
    bytes: 1_000,
    copies: [20, 18],
    projectedBytes: [900, 950],
  });
  const reset = snapshot({
    uploads: 90,
    bytes: 900,
    copies: [19, 17],
    projectedBytes: [800, 850],
  });
  const resetResult = evaluateWgpuDirtyRangeProjection([sample(first), sample(reset)]);
  assert.equal(resetResult.valid, false);
  assert.match(resetResult.failures.join(" | "), /raw\.uploads regressed/);
  assert.match(resetResult.failures.join(" | "), /raw upload delta must be positive/);

  const hazardResult = evaluateWgpuDirtyRangeProjection([
    sample(first),
    sample(snapshot({
      uploads: 120,
      bytes: 2_000,
      copies: [24, 21],
      projectedBytes: [2_000, 2_149],
      hazards: { ...HAZARDS, recordOrderHazardCount: 1 },
    })),
  ]);
  assert.equal(hazardResult.valid, true);
  assert.equal(hazardResult.zeroUnresolvedHazards, false);
  assert.deepEqual(hazardResult.qualifyingGapThresholds, []);
});

test("dirty-range evaluator rejects missing and malformed finalized contracts", () => {
  const valid = snapshot({
    uploads: 100,
    bytes: 1_000,
    copies: [20, 18],
    projectedBytes: [900, 950],
  });
  const missing = structuredClone(valid);
  delete missing.finalized;
  const missingResult = evaluateWgpuDirtyRangeProjection([sample(missing)]);
  assert.equal(missingResult.valid, false);
  assert.match(missingResult.failures.join(" | "), /finalized contract is missing/);

  const malformed = structuredClone(valid);
  malformed.finalized.segmentCount = 0.5;
  const malformedResult = evaluateWgpuDirtyRangeProjection([sample(malformed)]);
  assert.equal(malformedResult.valid, false);
  assert.match(malformedResult.failures.join(" | "), /finalized\.segmentCount/);
});

test("perf gate passes wgpudirtyranges through and fails closed on activation", async () => {
  const source = await readFile(
    new URL("../tools/perf-regression-gate.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /"wgpudirtyranges"/);
  assert.match(source, /flattenWgpuDirtyRangeProjection/);
  assert.match(source, /WGPU dirty-range projection mismatch/);
  assert.match(source, /snapshot\?\.enabled !== expectedActive/);
  assert.match(source, /failures\.push\(\.\.\.dirtyRangeProjection\.failures\)/);
});
