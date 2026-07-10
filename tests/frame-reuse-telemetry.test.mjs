import assert from "node:assert/strict";
import test from "node:test";

import {
  createFrameReuseTelemetry,
  frameReuseTelemetryPayload,
  recordSampledSourceFrame,
} from "../src/frame-reuse-telemetry.js";

test("sampled frame reuse distinguishes changed source frames from stale output", () => {
  const state = createFrameReuseTelemetry();
  for (const hash of [0x11, 0x11, 0x11, 0x22, 0x22, 0x33]) {
    assert.equal(recordSampledSourceFrame(state, hash), true);
  }

  assert.deepEqual(frameReuseTelemetryPayload(state, 4), {
    sampledSourceFrameCount: 6,
    sampledUniqueFrameCount: 3,
    sampledStaleFrameCount: 3,
    sampledStaleFrameRatio: 0.5,
    sampledStaleFrameRunLast: 0,
    sampledStaleFrameRunMax: 2,
    staleRepaintCount: 4,
  });
});

test("invalid or empty hashes do not create fake source-frame samples", () => {
  const state = createFrameReuseTelemetry();
  assert.equal(recordSampledSourceFrame(state, 0), false);
  assert.equal(recordSampledSourceFrame(state, Number.NaN), false);
  assert.equal(recordSampledSourceFrame(state, null), false);
  assert.deepEqual(frameReuseTelemetryPayload(state, 0), {
    sampledSourceFrameCount: 0,
    sampledUniqueFrameCount: 0,
    sampledStaleFrameCount: 0,
    sampledStaleFrameRatio: 0,
    sampledStaleFrameRunLast: 0,
    sampledStaleFrameRunMax: 0,
    staleRepaintCount: 0,
  });
});
