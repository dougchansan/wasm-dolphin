import assert from "node:assert/strict";
import test from "node:test";

import {
  WGPU_MAPPED_DRAIN_FORCE_REASONS,
  WGPU_MAPPED_DRAIN_MAX_AGE_MS,
  WGPU_MAPPED_DRAIN_MAX_BYTES,
  WGPU_MAPPED_DRAIN_MAX_RECORDS,
  createWgpuMappedDrainCoalescer,
} from "../src/wgpu-mapped-drain-coalescer.js";

const pending = {
  pending: true,
  pendingBytes: 460 * 1024,
  pendingRecords: 297,
  pendingAgeMs: 1,
};

test("coalescing is default-off and preserves the existing flush behavior", () => {
  const coalescer = createWgpuMappedDrainCoalescer();
  const decision = coalescer.atBoundary(pending);

  assert.equal(decision.action, "flush");
  assert.equal(decision.reason, "disabled");
  assert.equal(decision.cancelledTimerToken, null);
  assert.equal(coalescer.snapshot().state.deferred, false);
});

test("the first eligible boundary defers and the second boundary flushes", () => {
  const coalescer = createWgpuMappedDrainCoalescer({ enabled: true, generation: 7 });
  const first = coalescer.atBoundary({ ...pending, generation: 7 });

  assert.equal(first.action, "defer");
  assert.equal(first.reason, "first-boundary");
  assert.equal(first.delayMs, WGPU_MAPPED_DRAIN_MAX_AGE_MS - pending.pendingAgeMs);
  assert.deepEqual(first.timerToken, { generation: 7, sequence: 1 });

  const second = coalescer.atBoundary({ ...pending, generation: 7 });
  assert.equal(second.action, "flush");
  assert.equal(second.reason, "second-boundary");
  assert.equal(second.cancelledTimerToken, first.timerToken);

  const snapshot = coalescer.snapshot();
  assert.equal(snapshot.state.deferred, false);
  assert.equal(snapshot.telemetry.deferredBoundaries, 1);
  assert.equal(snapshot.telemetry.flushReasons["second-boundary"], 1);
  assert.equal(snapshot.telemetry.timerCancelled, 1);
});

test("age, byte, and record limits fail closed at their exact caps", () => {
  const cases = [
    [{ ...pending, pendingAgeMs: WGPU_MAPPED_DRAIN_MAX_AGE_MS }, "age-cap"],
    [{ ...pending, pendingBytes: WGPU_MAPPED_DRAIN_MAX_BYTES }, "byte-cap"],
    [{ ...pending, pendingRecords: WGPU_MAPPED_DRAIN_MAX_RECORDS }, "record-cap"],
  ];

  for (const [input, reason] of cases) {
    const coalescer = createWgpuMappedDrainCoalescer({ enabled: true });
    assert.deepEqual(
      coalescer.atBoundary(input),
      { action: "flush", reason, generation: 0, cancelledTimerToken: null }
    );
  }
});

test("invalid metrics and retained render state cannot be deferred", () => {
  for (const input of [
    { ...pending, pendingBytes: Number.NaN },
    { ...pending, pendingRecords: -1 },
    { ...pending, pendingAgeMs: Number.POSITIVE_INFINITY },
  ]) {
    const coalescer = createWgpuMappedDrainCoalescer({ enabled: true });
    assert.equal(coalescer.atBoundary(input).reason, "invalid-pending-metrics");
  }

  const pass = createWgpuMappedDrainCoalescer({ enabled: true });
  assert.equal(pass.atBoundary({ ...pending, hasOpenPass: true }).reason, "pass");
  const encoder = createWgpuMappedDrainCoalescer({ enabled: true });
  assert.equal(encoder.atBoundary({ ...pending, hasRenderEncoder: true }).reason, "render");
});

test("all dependency and lifecycle fences produce explicit flush reasons", () => {
  for (const reason of Object.values(WGPU_MAPPED_DRAIN_FORCE_REASONS)) {
    const coalescer = createWgpuMappedDrainCoalescer({ enabled: true });
    const deferred = coalescer.atBoundary(pending);
    const forced = coalescer.force(reason);

    assert.equal(forced.action, "flush", reason);
    assert.equal(forced.reason, reason);
    assert.equal(forced.cancelledTimerToken, deferred.timerToken);
    assert.equal(coalescer.snapshot().telemetry.flushReasons[reason], 1);
  }
});

test("the deadline timer flushes once and duplicate callbacks are stale", () => {
  const coalescer = createWgpuMappedDrainCoalescer({ enabled: true, generation: 3 });
  const { timerToken } = coalescer.atBoundary({ ...pending, generation: 3 });

  const fired = coalescer.onTimer(timerToken, {
    generation: 3,
    pendingBytes: pending.pendingBytes,
    pendingRecords: pending.pendingRecords,
    pendingAgeMs: 6.5,
  });
  assert.equal(fired.action, "flush");
  assert.equal(fired.reason, "timer-deadline");
  coalescer.recordSubmission(7.25);

  const duplicate = coalescer.onTimer(timerToken, { generation: 3 });
  assert.equal(duplicate.action, "none");
  assert.equal(duplicate.reason, "stale-timer");

  const telemetry = coalescer.snapshot().telemetry;
  assert.equal(telemetry.timerFired, 1);
  assert.equal(telemetry.timerStale, 1);
  assert.equal(telemetry.timerCancelled, 0);
  assert.equal(telemetry.actualSubmissions, 1);
  assert.equal(telemetry.actualSubmissionAgeMaxMs, 7.25);
  assert.equal(telemetry.actualDeadlineOverrunMaxMs, 3.25);
  assert.equal(telemetry.maxPendingAgeMs, 6.5);
  assert.equal(telemetry.deadlineOverrunMaxMs, 2.5);
});

test("actual submission age includes work after the flush decision", () => {
  const coalescer = createWgpuMappedDrainCoalescer({ enabled: true });
  coalescer.atBoundary({ ...pending, pendingAgeMs: 5 });
  coalescer.recordSubmission(9.5);

  const telemetry = coalescer.snapshot().telemetry;
  assert.equal(telemetry.deadlineOverrunMaxMs, 1);
  assert.equal(telemetry.actualSubmissionAgeMaxMs, 9.5);
  assert.equal(telemetry.actualDeadlineOverrunMaxMs, 5.5);
  assert.throws(() => coalescer.recordSubmission(-1), /pendingAgeMs/);
});

test("reset invalidates the active timer token across generations", () => {
  const coalescer = createWgpuMappedDrainCoalescer({ enabled: true, generation: 10 });
  const { timerToken } = coalescer.atBoundary({ ...pending, generation: 10 });
  const reset = coalescer.reset({ generation: 11, reason: "device-replacement" });

  assert.equal(reset.cancelledTimerToken, timerToken);
  assert.equal(coalescer.onTimer(timerToken, { generation: 10 }).reason, "stale-timer");
  assert.deepEqual(coalescer.snapshot().state, {
    generation: 11,
    deferred: false,
    activeTimerToken: null,
  });
  assert.equal(coalescer.snapshot().telemetry.resetReasons["device-replacement"], 1);
});

test("stale boundaries cannot cancel deferred work from a replacement generation", () => {
  const coalescer = createWgpuMappedDrainCoalescer({ enabled: true, generation: 4 });
  const { timerToken } = coalescer.atBoundary({ ...pending, generation: 4 });
  coalescer.reset({ generation: 5 });
  const replacement = coalescer.atBoundary({ ...pending, generation: 5 });

  const stale = coalescer.atBoundary({ ...pending, generation: 4 });
  assert.equal(stale.action, "none");
  assert.equal(stale.reason, "stale-generation");
  assert.equal(coalescer.snapshot().state.activeTimerToken, replacement.timerToken);
  assert.notEqual(replacement.timerToken, timerToken);
  assert.equal(coalescer.snapshot().telemetry.generationMismatches, 1);
});

test("no-pending boundaries cancel deferred state without requesting a submit", () => {
  const coalescer = createWgpuMappedDrainCoalescer({ enabled: true });
  const { timerToken } = coalescer.atBoundary(pending);
  const decision = coalescer.atBoundary({ pending: false });

  assert.equal(decision.action, "none");
  assert.equal(decision.reason, "no-pending");
  assert.equal(decision.cancelledTimerToken, timerToken);
  assert.equal(coalescer.snapshot().state.deferred, false);
});

test("snapshot telemetry is copied and can be reset independently of policy state", () => {
  const coalescer = createWgpuMappedDrainCoalescer({ enabled: true });
  coalescer.atBoundary(pending);
  const snapshot = coalescer.snapshot();

  assert.equal(snapshot.telemetry.maxPendingBytes, pending.pendingBytes);
  assert.equal(snapshot.telemetry.maxPendingRecords, pending.pendingRecords);
  assert.equal(snapshot.telemetry.maxPendingAgeMs, pending.pendingAgeMs);
  snapshot.telemetry.flushReasons.externalMutation = 99;
  assert.equal(coalescer.snapshot().telemetry.flushReasons.externalMutation, undefined);

  coalescer.resetTelemetry();
  const reset = coalescer.snapshot();
  assert.equal(reset.state.deferred, true);
  assert.equal(reset.telemetry.boundaryCalls, 0);
  assert.equal(reset.telemetry.timerArmed, 0);
});

test("unknown force reasons and invalid configuration are rejected", () => {
  const coalescer = createWgpuMappedDrainCoalescer({ enabled: true });
  assert.throws(() => coalescer.force("maybe"), /unknown mapped-drain force reason/);
  assert.throws(
    () => createWgpuMappedDrainCoalescer({ maxAgeMs: 0 }),
    /maxAgeMs must be a positive finite number/
  );
});
