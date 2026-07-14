import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const gateUrl = new URL("../tools/perf-regression-gate.mjs", import.meta.url);
const workerUrl = new URL("../src/upstream-discio-worker.js", import.meta.url);

test("every fixed-work benchmark reloads and fences the exact battle scene", async () => {
  const source = await readFile(gateUrl, "utf8");

  assert.match(source, /async function establishFixedSceneMeasurementBoundary\(/);
  assert.match(
    source,
    /if \(fixedWorkEnabled \|\| uploadProbeMode\) \{\s+fixedSceneMeasurementBoundary = await establishFixedSceneMeasurementBoundary\(/
  );
  assert.match(source, /fixedSceneMeasurementBoundary\.checkpoint/);
  assert.match(source, /fixedSceneMeasurementBoundary\.signature/);
  assert.match(source, /fixedWorkObservation\(fixedSceneMeasurementBoundary\.progress\)/);
  assert.match(source, /progress\.observedAtMs = Number\(resumed\.transitionAtMs\)/);
  assert.doesNotMatch(source, /fixedWorkEnabled && !fixedWorkBaseline/);
  assert.match(source, /liveWorkerProgress: fixedWorkEnabled/);
});

test("the paused worker progress fence exposes exact loaded checkpoint identity", async () => {
  const source = await readFile(workerUrl, "utf8");
  const handler = /case "validationReadCoreProgress":([\s\S]*?)case "validationFinalizeWgpuRendererProbe":/.exec(source)?.[1] || "";

  assert.match(handler, /ppcPc:/);
  assert.match(handler, /loadedCheckpointGeneration:/);
  assert.match(handler, /loadedCheckpointTicks:/);
  assert.match(handler, /loadedCheckpointPpcPc:/);
  assert.match(handler, /observedAtMs: performance\.now\(\)/);
});
