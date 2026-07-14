import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { evaluateJitCacheReadiness } from "../tools/perf-artifacts.mjs";

const ready = {
  enabled: true,
  bootLoadComplete: true,
  lazyFillStarted: true,
  lazyFillActive: false,
  lazyFillCompleted: true,
  cacheSize: 12000,
  newCompileCount: 0,
  verificationPending: 0,
  compilePending: 0,
  idbWritesPending: 0,
  pthreadWorkerCount: 16,
  pthreadBarrierExpected: 16,
  pthreadBarrierAcked: 16,
  pthreadRequiredWorkerCount: 4,
  pthreadRequiredBarrierAcked: 4,
  pthreadInstallPostFailures: 0,
  pthreadBarrierInvalidAcks: 0,
  lazyFillTerminalReason: "complete",
  lazyFillFailureCount: 0,
};

test("JIT cache readiness fails closed until all asynchronous work is complete", () => {
  assert.deepEqual(evaluateJitCacheReadiness(ready).invalidReasons, []);
  for (const [field, value] of [
    ["bootLoadComplete", false],
    ["lazyFillStarted", false],
    ["lazyFillActive", true],
    ["lazyFillCompleted", false],
    ["verificationPending", 1],
    ["compilePending", 1],
    ["idbWritesPending", 1],
    ["pthreadRequiredBarrierAcked", 3],
    ["pthreadInstallPostFailures", 1],
    ["pthreadBarrierInvalidAcks", 1],
    ["lazyFillFailureCount", 1],
  ]) {
    const result = evaluateJitCacheReadiness({ ...ready, [field]: value });
    assert.equal(result.ready, false, field);
    assert.match(result.invalidReasons.join("\n"), new RegExp(field));
  }
});

test("disabled persistent cache is explicitly ready without population work", () => {
  assert.deepEqual(evaluateJitCacheReadiness({ enabled: false }), {
    ready: true,
    invalidReasons: [],
  });
});

test("worker exposes validation-only JIT cache readiness telemetry", async () => {
  const source = await readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
  const handler = source.slice(
    source.indexOf('case "validationReadJitCacheReadiness"'),
    source.indexOf('case "validationFinalizeWgpuRendererProbe"')
  );
  assert.match(handler, /bootLoadComplete:/);
  assert.match(handler, /lazyFillStarted:/);
  assert.match(handler, /lazyFillActive:/);
  assert.match(handler, /lazyFillCompleted:/);
  assert.match(handler, /verificationPending:/);
  assert.match(handler, /compilePending:/);
  assert.match(handler, /idbWritesPending:/);
  assert.match(handler, /pthreadBarrierExpected:/);
  assert.match(handler, /pthreadBarrierAcked:/);
  assert.match(handler, /pthreadRequiredWorkerCount:/);
  assert.match(handler, /pthreadRequiredBarrierAcked:/);
  assert.match(handler, /pthreadInstallPostFailures:/);
  assert.match(handler, /pthreadBarrierInvalidAcks:/);
  assert.match(handler, /lazyFillTerminalReason:/);
  assert.match(handler, /lazyFillFailureCount:/);
  assert.match(handler, /observedAtMs:/);
});

test("pthread acknowledges the terminal cache delivery barrier", async () => {
  const preJs = await readFile(new URL("../tools/jit-cache-prejs.js", import.meta.url), "utf8");
  assert.match(preJs, /dolphin-jit-cache-barrier/);
  assert.match(preJs, /dolphin-jit-cache-barrier-ack/);
  assert.match(preJs, /generation: data\.generation/);
});

test("fixed-work gate observes the pre-boot pthread fence, then pauses before exact scene reload", async () => {
  const source = await readFile(new URL("../tools/perf-regression-gate.mjs", import.meta.url), "utf8");
  const boundary = source.slice(
    source.indexOf("async function establishFixedSceneMeasurementBoundary"),
    source.indexOf("async function resumeAfterBattleCheckpoint")
  );
  const pauseIndex = boundary.indexOf("await pauseForBattleCheckpoint(");
  const waitIndex = boundary.indexOf("await waitForStableJitCacheReadiness(");
  const reloadIndex = boundary.indexOf("await loadStateFileWithTimeout(");
  assert.ok(waitIndex >= 0, "pre-boot cache readiness wait missing");
  assert.ok(pauseIndex > waitIndex, "pause must follow the pre-boot pthread acknowledgement");
  assert.ok(reloadIndex > pauseIndex, "fixed-scene reload must follow pause");
  assert.match(boundary, /pausedJitCacheReadiness/);
  assert.match(boundary, /jitCacheReadinessSignature/);
  assert.match(source, /manifest\.benchmark\.jitCacheReadiness/);
});

test("persistent-profile failures preserve the underlying error and screenshot", async () => {
  const source = await readFile(new URL("../tools/perf-regression-gate.mjs", import.meta.url), "utf8");
  assert.match(source, /typeof browser\.contexts === "function"/);
  assert.match(source, /typeof browser\.pages === "function"/);
});
