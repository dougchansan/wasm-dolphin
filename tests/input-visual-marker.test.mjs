import assert from "node:assert/strict";
import test from "node:test";

import {
  INPUT_VISUAL_MARKER_SIZE,
  applyInputMarkerRgba,
  createInputVisualMarkerTracker,
  inputMarkerPixelMatches,
  inputMarkerRgba
} from "../src/input-visual-marker.js";

test("input marker exposes a sensor-visible square size", () => {
  assert.equal(INPUT_VISUAL_MARKER_SIZE, 32);
});

test("input marker encodes a generation-specific opaque RGBA square", () => {
  const bytes = new Uint8Array(4 * 4 * 4);
  assert.equal(applyInputMarkerRgba(bytes, 4, 4, 0x12345, { markerSize: 2 }), true);
  assert.deepEqual([...bytes.subarray(0, 4)], inputMarkerRgba(0x12345));
  assert.equal(inputMarkerPixelMatches(bytes, 0x12345), true);
  assert.equal(inputMarkerPixelMatches(bytes, 0x12346), false);
  assert.deepEqual([...bytes.subarray(8, 12)], [0, 0, 0, 0]);
  assert.equal(inputMarkerPixelMatches(bytes, 0x12345, 4 * 4), true);
});

test("marker tracker requires the exact core-polled generation", () => {
  let now = 1000;
  const tracker = createInputVisualMarkerTracker({ enabled: true, now: () => now });
  tracker.recordApplied({
    generation: 7,
    inputMask: 0x101,
    sentAtEpochMs: 900,
    baselinePollCount: 10
  });

  now = 1010;
  assert.equal(tracker.recordCorePoll({
    pollCount: 11,
    inputMask: 0x101,
    inputGeneration: 0,
    coreFrame: 40
  }), 0);
  assert.equal(tracker.snapshot().generationUnavailableCount, 1);

  now = 1020;
  assert.equal(tracker.recordCorePoll({
    pollCount: 12,
    inputMask: 0x101,
    inputGeneration: 6,
    coreFrame: 41
  }), 0);
  assert.equal(tracker.snapshot().generationMismatchCount, 1);

  now = 1030;
  assert.equal(tracker.recordCorePoll({
    pollCount: 13,
    inputMask: 0x101,
    inputGeneration: 7,
    coreFrame: 42
  }), 7);
  assert.equal(tracker.currentMarker().generation, 7);
  assert.equal(tracker.currentMarker().needsSubmission, true);
});

test("marker tracker holds completion long enough to observe, then expires", () => {
  let now = 200;
  const tracker = createInputVisualMarkerTracker({
    enabled: true,
    markerHoldMs: 250,
    now: () => now
  });
  tracker.recordApplied({ generation: 3, inputMask: 1, sentAtEpochMs: 180, baselinePollCount: 4 });
  now = 210;
  tracker.recordCorePoll({ pollCount: 5, inputMask: 1, inputGeneration: 3, coreFrame: 9 });
  now = 220;
  assert.equal(tracker.recordMarkerSubmitted({
    generation: 3,
    coreFrame: 10,
    source: "software-webgpu"
  }), true);
  assert.equal(tracker.recordMarkerSubmitted({ generation: 3 }), false);
  now = 235;
  assert.equal(tracker.recordMarkerCompleted({
    generation: 3,
    coreFrame: 10,
    source: "software-webgpu",
    completionKind: "gpu-queue"
  }), true);

  const snapshot = tracker.snapshot();
  assert.equal(snapshot.causalVisualAttribution, true);
  assert.equal(snapshot.markerCompletedCount, 1);
  assert.equal(snapshot.completionAgeLastMs, 55);
  assert.equal(snapshot.pollToCompletionLastMs, 25);
  assert.equal(snapshot.lastCompletedGeneration, 3);
  assert.equal(snapshot.lastCompletionKind, "gpu-queue");
  assert.deepEqual(snapshot.samples[0], {
    generation: 3,
    coreFrame: 10,
    source: "software-webgpu",
    completionKind: "gpu-queue",
    sentAtEpochMs: 180,
    appliedAtEpochMs: 200,
    polledAtEpochMs: 210,
    submittedAtEpochMs: 220,
    completedAtEpochMs: 235,
    completionAgeMs: 55,
    pollToCompletionMs: 25
  });
  assert.equal(tracker.currentMarker().generation, 3, "marker persists for optical observation");
  assert.equal(tracker.currentMarker().needsSubmission, false);
  now = 484;
  assert.equal(tracker.currentMarker().generation, 3);
  now = 486;
  assert.equal(tracker.currentMarker(), null);
  assert.equal(tracker.snapshot().retiredCompletedMarkerCount, 1);
  assert.equal(tracker.snapshot().expiredMarkerCount, 0);
});

test("marker maximum lifetime bounds a hung GPU submission", () => {
  let now = 100;
  const tracker = createInputVisualMarkerTracker({
    enabled: true,
    markerMaxLifetimeMs: 500,
    now: () => now
  });
  tracker.recordApplied({ generation: 4, inputMask: 1, baselinePollCount: 0 });
  tracker.recordCorePoll({ pollCount: 1, inputMask: 1, inputGeneration: 4 });
  tracker.recordMarkerSubmitted({ generation: 4, source: "hung-gpu" });
  now = 601;
  assert.equal(tracker.currentMarker(), null);
  assert.equal(tracker.snapshot().expiredMarkerCount, 1);
  assert.equal(tracker.snapshot().expiredInFlightCount, 1);
});

test("new polled generations supersede unsubmitted markers and bound hung submissions", () => {
  let now = 1;
  const tracker = createInputVisualMarkerTracker({
    enabled: true,
    maxSamples: 4,
    now: () => now++
  });
  for (let generation = 1; generation <= 10; generation += 1) {
    tracker.recordApplied({
      generation,
      inputMask: generation,
      baselinePollCount: generation - 1
    });
    tracker.recordCorePoll({
      pollCount: generation,
      inputMask: generation,
      inputGeneration: generation,
      coreFrame: generation
    });
    if ((generation & 1) === 0) {
      tracker.recordMarkerSubmitted({ generation, source: "hung-gpu" });
    }
  }

  const snapshot = tracker.snapshot();
  assert.equal(snapshot.activeGeneration, 10);
  assert.ok(snapshot.supersededArmedCount > 0);
  assert.ok(snapshot.droppedInFlightCount > 0);
  assert.ok(snapshot.inFlightCount <= 4);
});

test("new applied input supersedes only an unpolled generation", () => {
  const tracker = createInputVisualMarkerTracker({ enabled: true, now: () => 10 });
  tracker.recordApplied({ generation: 1, inputMask: 1, baselinePollCount: 0 });
  tracker.recordApplied({ generation: 2, inputMask: 2, baselinePollCount: 0 });
  tracker.recordApplied({ generation: 2, inputMask: 2, baselinePollCount: 0 });
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.supersededCount, 1);
  assert.equal(snapshot.duplicateApplyCount, 1);
  assert.equal(snapshot.pendingGeneration, 2);
});

test("disabled marker tracker is inert", () => {
  const tracker = createInputVisualMarkerTracker({ enabled: false });
  assert.equal(tracker.recordApplied({ generation: 1, inputMask: 1 }), false);
  assert.equal(tracker.recordCorePoll({ pollCount: 1, inputMask: 1, inputGeneration: 1 }), 0);
  assert.equal(tracker.currentMarker(), null);
  assert.equal(tracker.snapshot().markerCompletedCount, 0);
});
