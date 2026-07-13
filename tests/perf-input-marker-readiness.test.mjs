import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../tools/perf-regression-gate.mjs", import.meta.url),
  "utf8"
);

test("perf gate waits for input-marker telemetry before starting timed input", () => {
  const readiness = source.indexOf("await waitForInputMarkerReady(page");
  const timingStart = source.indexOf("manifest.benchmark.timingStartedAt");
  const dispatch = source.indexOf("const markerBaseline = await readInputMarkerBarrierState(page)");

  assert.ok(readiness >= 0, "missing input-marker readiness barrier");
  assert.ok(timingStart > readiness, "timing must start after marker readiness");
  assert.ok(dispatch > timingStart, "scripted input must start after the timed boundary");
  assert.match(source, /if \(!inputMarkerReadiness\.ready\)[\s\S]*?throw new Error/);
});

test("perf gate preserves raw input barrier evidence per run", () => {
  assert.match(source, /inputEventsFile: "input-events\.json"/);
  assert.match(
    source,
    /writeFile\(path\.join\(scenarioDir, "input-events\.json"\), JSON\.stringify\(\{[\s\S]*?markerReadiness:[\s\S]*?events: inputEvents/
  );
});
