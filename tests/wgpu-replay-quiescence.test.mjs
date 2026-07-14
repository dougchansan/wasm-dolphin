// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readSource = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("validation can quiesce hardware replay before a fixed save-state load", async () => {
  const [worker, gate, quiescence, runtime] = await Promise.all([
    readSource("../src/upstream-discio-worker.js"),
    readSource("../tools/perf-regression-gate.mjs"),
    readSource("../src/wgpu-replay-quiescence.js"),
    readSource("../src/wgpu-renderer-runtime.js"),
  ]);

  assert.match(worker, /case "validationFinalizeWgpuReplay"/);
  assert.match(worker, /await finalizeWgpuReplayQuiescence/);
  assert.match(worker, /WGPU replay finalization requires a paused core/);
  assert.match(worker, /new WgpuRendererRuntime/);
  assert.match(worker, /drainWebGpuCmdRing\(source\)/);
  assert.match(worker, /finalizeWgpuMappedDrain\(timeoutMs\)/);
  assert.match(worker, /wgpuRendererRuntime\.quiesce/);
  assert.match(runtime, /writeIndex:/);
  assert.match(runtime, /readIndex:/);
  assert.match(runtime, /publishedReadIndex:/);
  assert.match(runtime, /backlog:/);
  assert.match(runtime, /createWgpuReplayStabilityTracker/);
  assert.match(runtime, /awaitWgpuQueueCompletion/);
  assert.match(quiescence, /minimumObservations = 2/);
  assert.match(quiescence, /minimumStableMs = 50/);
  assert.match(quiescence, /stableWriteIndex === snapshot\.writeIndex/);
  assert.match(quiescence, /requires a registered command ring/);

  const initialLoad = gate.slice(
    gate.indexOf("const readiness = await waitForCoreReady(page)"),
    gate.indexOf("renderer = withExpectedRendererIdentity", gate.indexOf("const readiness = await waitForCoreReady(page)"))
  );
  const initialPause = initialLoad.indexOf("await pauseForBattleCheckpoint(page)");
  const initialQuiescence = initialLoad.indexOf("await finalizeWgpuReplay(page");
  const initialReload = initialLoad.indexOf("await loadStateFileWithTimeout(page");
  assert.ok(initialPause >= 0, "initial pause is missing");
  assert.ok(initialQuiescence > initialPause, "initial replay fence must follow pause");
  assert.ok(initialReload > initialQuiescence, "initial save load must follow replay fence");

  const fixedBoundary = gate.slice(
    gate.indexOf("async function establishFixedSceneMeasurementBoundary"),
    gate.indexOf("async function resumeAfterBattleCheckpoint")
  );
  const fixedPause = fixedBoundary.indexOf("await pauseForBattleCheckpoint(page)");
  const fixedQuiescence = fixedBoundary.indexOf("await finalizeWgpuReplay(page");
  const fixedReload = fixedBoundary.indexOf("await loadStateFileWithTimeout(page");
  assert.ok(fixedPause >= 0, "fixed-boundary pause is missing");
  assert.ok(fixedQuiescence > fixedPause, "fixed-boundary replay fence must follow pause");
  assert.ok(fixedReload > fixedQuiescence, "fixed-boundary save load must follow replay fence");
  assert.match(fixedBoundary, /replayQuiescence/);
});

test("replay finalization fails closed unless ring and mapped work are empty", async () => {
  const [worker, quiescence, runtime] = await Promise.all([
    readSource("../src/upstream-discio-worker.js"),
    readSource("../src/wgpu-replay-quiescence.js"),
    readSource("../src/wgpu-renderer-runtime.js"),
  ]);
  const finalizer = worker.slice(
    worker.indexOf("async function finalizeWgpuReplayQuiescence"),
    worker.indexOf("function drainWgpuSemanticOwnership")
  );
  assert.match(quiescence, /snapshot\.backlog === 0/);
  assert.match(quiescence, /snapshot\.readIndex === snapshot\.publishedReadIndex/);
  assert.match(quiescence, /snapshot\.stagedUploads === 0/);
  assert.match(quiescence, /snapshot\.pendingMappedUploads === 0/);
  assert.match(quiescence, /snapshot\.pendingRemaps === 0/);
  assert.match(quiescence, /!snapshot\.mappedDrainTimerPending/);
  assert.match(quiescence, /!snapshot\.loadFenceActive/);
  assert.match(quiescence, /queue\.onSubmittedWorkDone/);
  assert.match(quiescence, /GPU completion timed out/);
  assert.match(finalizer, /wgpuRendererRuntime\.quiesce/);
  assert.match(runtime, /postCompletionSnapshot/);
  assert.match(runtime, /validatePostCompletionReplaySnapshot/);
  assert.match(runtime, /WGPU replay finalization timed out/);
});

test("hardware final screenshots are captured only after the timed replay backlog is quiescent", async () => {
  const gate = await readSource("../tools/perf-regression-gate.mjs");
  const finalization = gate.slice(
    gate.indexOf("const timedWindowEndedAt"),
    gate.indexOf("} catch (error)", gate.indexOf("const timedWindowEndedAt"))
  );

  const pause = finalization.indexOf('requestWorkerRpc(page, "validationSetCorePaused"');
  const quiescence = finalization.indexOf("finalizeWgpuReplay(page");
  const persist = finalization.indexOf("manifest.benchmark.postTimedReplayQuiescence");
  const screenshot = finalization.indexOf('saveScreenshot(page, scenarioDir, "final.png")');

  assert.match(finalization, /expectedDolphinVideoBackend\(scenario\.params\.video\) === "WebGPU-Real"/);
  assert.doesNotMatch(
    finalization,
    /hardwareWgpuRun\s*&&\s*!uploadProbeMode/,
    "upload-probe hardware runs must also await replay and GPU completion"
  );
  assert.ok(pause >= 0, "post-timed hardware pause is missing");
  assert.ok(quiescence > pause, "post-timed replay fence must follow the pause");
  assert.ok(persist > quiescence, "post-timed replay evidence must be persisted");
  assert.ok(screenshot > persist, "the final screenshot must follow persisted replay quiescence");
  assert.match(finalization, /timedMetricsFrozen: true/);
  assert.match(finalization, /await waitForAnimationFrames\(page, 2\)/);
  assert.match(gate, /Compositor settle timed out after/);
  assert.match(gate, /Hardware WGPU post-run correctness screenshot was not captured/);
  assert.match(gate, /summary\.postTimedReplayQuiescence/);
  assert.match(gate, /finalScreenshotSemantics/);
});

test("post-run finalization does not replace the final timed sample", async () => {
  const gate = await readSource("../tools/perf-regression-gate.mjs");
  const finalization = gate.slice(
    gate.indexOf("const mappedDrainFinalizationMode"),
    gate.indexOf("} catch (error)", gate.indexOf("const mappedDrainFinalizationMode"))
  );

  assert.doesNotMatch(finalization, /finalSample\.causalTelemetry\s*=/);
  assert.doesNotMatch(finalization, /Object\.assign\(\s*finalSample/);
  assert.match(finalization, /postRunFinalizedTelemetry/);
  assert.match(gate, /timedWindowEndedAt/);
});
