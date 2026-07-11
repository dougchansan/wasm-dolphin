import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  WGPU_QUEUE_RELIEF_UPLOAD_BYTES,
  WGPU_QUEUE_RELIEF_UPLOAD_CALLS,
  createWgpuQueueRelief,
  requestedWgpuQueueRelief,
} from "../src/wgpu-queue-relief.js";

test("queue relief request is literal and default-off", () => {
  assert.equal(requestedWgpuQueueRelief(""), false);
  assert.equal(requestedWgpuQueueRelief("?wgpuqueuewait=1"), true);
  assert.equal(requestedWgpuQueueRelief("?wgpuqueuewait=true"), false);
  assert.equal(WGPU_QUEUE_RELIEF_UPLOAD_CALLS, 8192);
  assert.equal(WGPU_QUEUE_RELIEF_UPLOAD_BYTES, 16 * 1024 * 1024);
});

test("disabled helper preserves the inert path", () => {
  const relief = createWgpuQueueRelief();
  relief.recordSuccessfulUpload(99_000_000);
  relief.beginPass();
  assert.equal(relief.shouldRelieveAtBoundary("end-pass"), false);
  assert.equal(relief.beginWait(), null);
  const snapshot = relief.snapshot();
  assert.equal(snapshot.requested, false);
  assert.equal(snapshot.enabled, false);
  assert.equal(snapshot.intervalCalls, 0);
  assert.equal(snapshot.intervalBytes, 0);
  assert.equal(snapshot.passDepth, 0);
});

test("call pressure waits for a safe completed-pass boundary", () => {
  let clock = 10;
  const relief = createWgpuQueueRelief({
    enabled: true,
    uploadCallThreshold: 2,
    uploadByteThreshold: 1_000_000,
    now: () => clock,
  });
  relief.beginPass();
  relief.recordSuccessfulUpload(4, { backlog: 8, watermark: 12, stagedBytes: 16 });
  relief.recordSuccessfulUpload(4, { backlog: 9, watermark: 13, stagedBytes: 17 });
  assert.equal(relief.shouldRelieveAtBoundary("end-pass"), false);
  relief.endPass();
  assert.equal(relief.shouldRelieveAtBoundary("end-pass"), true);
  const token = relief.beginWait({ activity: { audio: 2, input: 3, host: 4 } });
  assert.ok(token);
  assert.equal(relief.suppress("pump"), true);
  assert.equal(relief.suppress("presentation"), true);
  clock = 17;
  assert.deepEqual(relief.settle(token, {
    ok: true,
    sample: {
      backlog: 1,
      watermark: 20,
      stagedBytes: 0,
      activity: { audio: 7, input: 5, host: 10 },
    },
  }), { stale: false, resume: true, disabled: false });
  const snapshot = relief.snapshot();
  assert.equal(snapshot.triggerCallThresholdCount, 1);
  assert.equal(snapshot.completionCompletedCount, 1);
  assert.equal(snapshot.waitLastMs, 7);
  assert.equal(snapshot.waitAudioActivityTotal, 5);
  assert.equal(snapshot.waitInputActivityTotal, 2);
  assert.equal(snapshot.waitHostActivityTotal, 6);
  assert.equal(snapshot.suppressedPumpDrainCount, 1);
  assert.equal(snapshot.suppressedPresentationDrainCount, 1);
  assert.equal(snapshot.phase, "idle");
});

test("byte pressure records overshoot and submit boundary", () => {
  const relief = createWgpuQueueRelief({
    enabled: true,
    uploadCallThreshold: 99,
    uploadByteThreshold: 16,
  });
  relief.recordSuccessfulUpload(20);
  assert.equal(relief.shouldRelieveAtBoundary("other"), false);
  assert.equal(relief.shouldRelieveAtBoundary("submit-present"), true);
  const snapshot = relief.snapshot();
  assert.equal(snapshot.triggerByteThresholdCount, 1);
  assert.equal(snapshot.byteOvershootLast, 4);
});

test("rejection disables but resumes and reset makes old completion stale", () => {
  const relief = createWgpuQueueRelief({
    enabled: true,
    uploadCallThreshold: 1,
    uploadByteThreshold: 999,
  });
  relief.recordSuccessfulUpload(1);
  const rejected = relief.beginWait();
  assert.deepEqual(relief.settle(rejected, { ok: false }), {
    stale: false,
    resume: true,
    disabled: true,
  });
  assert.equal(relief.snapshot().phase, "disabled");
  relief.reset({ enabled: true });
  relief.recordSuccessfulUpload(1);
  const stale = relief.beginWait();
  relief.reset({ enabled: true });
  assert.equal(relief.settle(stale, { ok: true }).stale, true);
  assert.equal(relief.snapshot().completionStaleCount, 1);
});

test("queue relief is query-gated, pump-dependent, and exported to benchmark artifacts", async () => {
  const [host, adapter, worker, menu, gate, telemetry] = await Promise.all([
    readFile(new URL("../src/core-host.js", import.meta.url), "utf8"),
    readFile(new URL("../src/upstream-worker-adapter.js", import.meta.url), "utf8"),
    readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8"),
    readFile(new URL("../tools/menu-progress-validate.mjs", import.meta.url), "utf8"),
    readFile(new URL("../tools/perf-regression-gate.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/causal-telemetry.js", import.meta.url), "utf8"),
  ]);
  assert.match(host, /requestedWgpuQueueRelief\(window\.location\.search\)/);
  assert.match(adapter, /wgpuQueueRelief: this\.wgpuQueueRelief/);
  assert.match(worker, /Boolean\(requestedWgpuQueueRelief\)[\s\S]*?wgpuReplayPumpEnabled/);
  assert.match(worker, /shouldRelieveAtBoundary/);
  assert.match(worker, /publishWgpuReadIndex\(ring, read\)[\s\S]*?beginWgpuQueueReliefWait/);
  assert.match(worker, /!queueReliefYielded[\s\S]*?stageHeldWgpuUploads/);
  assert.match(worker, /Promise\.resolve\(completion\)/);
  assert.match(menu, /WGPUQUEUEWAIT[\s\S]*?wgpuqueuewait/);
  assert.match(gate, /"wgpuqueuewait"/);
  assert.match(telemetry, /causalWgpuQueueReliefWaitP95Ms/);
});
