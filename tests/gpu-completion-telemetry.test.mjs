import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createGpuCompletionTracker,
  requestedGpuCompletionDiagnostics
} from "../src/gpu-completion-telemetry.js";

test("GPU completion diagnostics are explicit URL opt-in", () => {
  assert.equal(requestedGpuCompletionDiagnostics(""), false);
  assert.equal(requestedGpuCompletionDiagnostics("?gpucomplete=0"), false);
  assert.equal(requestedGpuCompletionDiagnostics("?gpucomplete=1"), true);
});

test("GPU completion tracker samples submitted work without awaiting it", async () => {
  let now = 100;
  let resolveWork;
  let completionRequests = 0;
  const queue = {
    onSubmittedWorkDone() {
      completionRequests += 1;
      return new Promise((resolve) => {
        resolveWork = resolve;
      });
    }
  };
  const tracker = createGpuCompletionTracker({
    enabled: true,
    sampleEvery: 2,
    now: () => now
  });

  assert.equal(tracker.recordSubmittedWork(queue, "software-present"), false);
  assert.equal(tracker.recordSubmittedWork(queue, "software-present"), true);
  assert.equal(completionRequests, 1);
  assert.equal(tracker.snapshot().inFlight, 1);

  now = 108;
  resolveWork();
  await Promise.resolve();
  await Promise.resolve();

  const snapshot = tracker.snapshot();
  assert.equal(snapshot.submitCount, 2);
  assert.equal(snapshot.sampleRequestCount, 1);
  assert.equal(snapshot.completedCount, 1);
  assert.equal(snapshot.failedCount, 0);
  assert.equal(snapshot.inFlight, 0);
  assert.equal(snapshot.inFlightHighWater, 1);
  assert.equal(snapshot.lastMs, 8);
  assert.equal(snapshot.averageMs, 8);
  assert.equal(snapshot.p95Ms, 8);
  assert.equal(snapshot.byRoute["software-present"].completedCount, 1);
});

test("disabled GPU completion tracking never asks the queue for completion", () => {
  let calls = 0;
  const tracker = createGpuCompletionTracker({ enabled: false });
  const queue = {
    onSubmittedWorkDone() {
      calls += 1;
      return Promise.resolve();
    }
  };

  assert.equal(tracker.recordSubmittedWork(queue, "hardware-replay"), false);
  assert.equal(calls, 0);
  assert.equal(tracker.snapshot().submitCount, 0);
});

test("GPU completion rejection is retained as bounded evidence", async () => {
  let now = 10;
  const tracker = createGpuCompletionTracker({
    enabled: true,
    sampleEvery: 1,
    now: () => now
  });
  const queue = {
    onSubmittedWorkDone() {
      return Promise.reject(new Error("device lost"));
    }
  };

  tracker.recordSubmittedWork(queue, "hardware-replay");
  now = 12;
  await Promise.resolve();
  await Promise.resolve();

  const snapshot = tracker.snapshot();
  assert.equal(snapshot.failedCount, 1);
  assert.equal(snapshot.inFlight, 0);
  assert.match(snapshot.lastError, /device lost/);
});

test("host, worker, and perf harness plumb opt-in GPU completion evidence", async () => {
  const [host, adapter, worker, gate] = await Promise.all([
    readFile(new URL("../src/core-host.js", import.meta.url), "utf8"),
    readFile(new URL("../src/upstream-worker-adapter.js", import.meta.url), "utf8"),
    readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8"),
    readFile(new URL("../tools/perf-regression-gate.mjs", import.meta.url), "utf8")
  ]);
  assert.match(host, /requestedGpuCompletionDiagnostics\(window\.location\.search\)/);
  assert.match(adapter, /gpuCompletionDiagnostics: this\.gpuCompletionDiagnostics/);
  assert.match(worker, /recordSubmittedWork\(gpu\.device\.queue, "software-present"\)/);
  assert.match(worker, /recordSubmittedWork\(q, "hardware-replay"\)/);
  assert.match(worker, /gpuCompletion: gpuCompletionTracker\.snapshot\(\)/);
  assert.match(gate, /"gpucomplete"/);
});
