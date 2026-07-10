import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createInputVisibleLatencyTracker,
  parsePadPollStats,
  requestedInputLatencyDiagnostics
} from "../src/input-latency-telemetry.js";
import { UpstreamWorkerAdapter } from "../src/upstream-worker-adapter.js";

test("input-to-visible diagnostics are explicit URL opt-in", () => {
  assert.equal(requestedInputLatencyDiagnostics(""), false);
  assert.equal(requestedInputLatencyDiagnostics("?inputlatency=0"), false);
  assert.equal(requestedInputLatencyDiagnostics("?inputlatency=1"), true);
});

test("pad poll stats parser extracts decimal polls and hexadecimal input", () => {
  assert.deepEqual(
    parsePadPollStats("video xfb:10 pad polls:154 updates:4 input:101 buttons:0"),
    { pollCount: 154, inputMask: 0x101 }
  );
  assert.equal(parsePadPollStats("xfb:0"), null);
});

test("input tracker correlates apply, core poll, and next distinct frame", () => {
  let now = 1000;
  const tracker = createInputVisibleLatencyTracker({ enabled: true, now: () => now });

  tracker.recordApplied({
    generation: 7,
    inputMask: 0x101,
    sentAtEpochMs: 900,
    baselinePollCount: 10,
    baselineVisualHash: 0xaaaa,
    source: "sab"
  });
  assert.equal(tracker.snapshot().applyAgeLastMs, 100);

  now = 1010;
  tracker.recordObservation({ pollCount: 10, inputMask: 0x101, visualHash: 0xaaaa, coreFrame: 40 });
  assert.equal(tracker.snapshot().corePollCount, 0);

  now = 1020;
  tracker.recordObservation({ pollCount: 11, inputMask: 0x101, visualHash: 0xaaaa, coreFrame: 41 });
  assert.equal(tracker.snapshot().corePollCount, 1);
  assert.equal(tracker.snapshot().visibleCount, 0);

  now = 1035;
  tracker.recordObservation({ pollCount: 12, inputMask: 0x101, visualHash: 0xbbbb, coreFrame: 42 });
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.visibleCount, 1);
  assert.equal(snapshot.visibleAgeLastMs, 135);
  assert.equal(snapshot.pollToVisibleLastMs, 15);
  assert.equal(snapshot.lastCompletedGeneration, 7);
  assert.equal(snapshot.lastCompletedCoreFrame, 42);
  assert.equal(snapshot.pendingGeneration, 0);
});

test("duplicate transports do not replace the same pending generation", () => {
  let now = 50;
  const tracker = createInputVisibleLatencyTracker({ enabled: true, now: () => now });
  tracker.recordApplied({ generation: 2, inputMask: 1, sentAtEpochMs: 40, source: "post" });
  now = 55;
  tracker.recordApplied({ generation: 2, inputMask: 1, sentAtEpochMs: 40, source: "sab" });

  const snapshot = tracker.snapshot();
  assert.equal(snapshot.appliedCount, 1);
  assert.equal(snapshot.duplicateApplyCount, 1);
  assert.equal(snapshot.pendingGeneration, 2);
});

test("a late hardware baseline cannot masquerade as input-caused motion", () => {
  let now = 100;
  const tracker = createInputVisibleLatencyTracker({ enabled: true, now: () => now });
  tracker.recordApplied({
    generation: 3,
    inputMask: 1,
    sentAtEpochMs: 90,
    baselinePollCount: 4,
    baselineVisualHash: 0x1111,
    source: "sab"
  });

  assert.equal(tracker.updatePendingVisualBaseline(0x2222), true);
  now = 110;
  tracker.recordObservation({ pollCount: 5, inputMask: 1, visualHash: 0x2222, coreFrame: 10 });
  assert.equal(tracker.snapshot().visibleCount, 0);
  now = 120;
  tracker.recordObservation({ pollCount: 6, inputMask: 1, visualHash: 0x3333, coreFrame: 11 });
  assert.equal(tracker.snapshot().visibleCount, 1);
});

test("worker gates WGPU readback latency sampling behind the diagnostic flag", async () => {
  const source = await readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
  assert.match(
    source,
    /const _inputBackbufferOk = inputLatencyDiagnostics[\s\S]*?inputVisibleLatencyTracker\.hasPending\(\)/,
  );
  assert.match(source, /inputVisibleLatencyTracker\.updatePendingVisualBaseline\(hash\)/);
  assert.match(source, /visualSampleSource = "wgpu-readback"/);
  assert.match(source, /recordVisualFrameHash\(hash\)/);
  assert.equal(
    (source.match(/\(wgpuReplayClassifier \|\| inputLatencyDiagnostics\) \? textureUsage\.COPY_SRC : 0/g) || []).length,
    2,
    "both initial and resize context.configure calls must permit diagnostic readback",
  );
});

test("disabled input tracker records no diagnostic samples", () => {
  const tracker = createInputVisibleLatencyTracker({ enabled: false });
  tracker.recordApplied({ generation: 1, inputMask: 1, sentAtEpochMs: Date.now() });
  tracker.recordObservation({ pollCount: 1, inputMask: 1, visualHash: 2, coreFrame: 1 });
  assert.equal(tracker.snapshot().appliedCount, 0);
  assert.equal(tracker.snapshot().visibleCount, 0);
});

test("worker adapter sends one generation through SAB and postMessage", () => {
  const adapter = new UpstreamWorkerAdapter({ inputLatencyDiagnostics: true });
  const posted = [];
  adapter.loaded = true;
  adapter.post = (type, payload) => posted.push({ type, payload });

  adapter.setInputState({
    mask: 1,
    stickX: 128,
    stickY: 128,
    cStickX: 128,
    cStickY: 128,
    triggerLeft: 0,
    triggerRight: 0,
    analogA: 255,
    analogB: 0
  });

  assert.equal(adapter.inputTelemetry.mainGeneration, 1);
  assert.equal(adapter.inputTelemetry.mainSabGeneration, adapter.inputStateView ? 1 : 0);
  if (adapter.inputStateView) assert.equal(Atomics.load(adapter.inputStateView, 9), 1);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].type, "setInputState");
  assert.equal(posted[0].payload.inputGeneration, 1);
});

test("direct-save headed harness preserves causal input evidence in raw samples", async () => {
  const source = await readFile(new URL("../tools/menu-progress-validate.mjs", import.meta.url), "utf8");
  assert.match(source, /url\.searchParams\.set\("inputlatency", process\.env\.INPUTLATENCY\)/);
  assert.match(source, /causalTelemetry: info\.causalTelemetry \|\| window\.__causalTelemetry \|\| null/);
});
