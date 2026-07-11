import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("inputphoton opt-in crosses host, adapter, and worker without changing defaults", async () => {
  const [host, adapter, worker] = await Promise.all([
    readFile(new URL("../src/core-host.js", import.meta.url), "utf8"),
    readFile(new URL("../src/upstream-worker-adapter.js", import.meta.url), "utf8"),
    readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8")
  ]);

  assert.match(host, /requestedInputPhotonMarkerConfig\(window\.location\.search\)/);
  assert.match(
    host,
    /requestedInputLatencyDiagnostics\(window\.location\.search\) \|\| this\.inputPhotonMarker\.enabled/
  );
  assert.match(host, /inputPhotonDiagnostics: this\.inputPhotonMarker\.enabled/);
  assert.match(adapter, /inputPhotonDiagnostics = false/);
  assert.match(adapter, /inputPhotonMarker = null/);
  assert.match(adapter, /inputPhotonDiagnostics: this\.inputPhotonDiagnostics/);
  assert.match(worker, /payload\.inputLatencyDiagnostics \|\| inputPhotonDiagnostics/);
  assert.match(worker, /mode: inputPhotonDiagnostics[\s\S]*?INPUT_VISUAL_MARKER_MODE_PHOTON/);
});

test("software and hardware presenters both apply the persistent optical marker", async () => {
  const worker = await readFile(
    new URL("../src/upstream-discio-worker.js", import.meta.url),
    "utf8"
  );
  assert.match(worker, /applyInputVisualMarkerRgba\(marked, width, height, marker\)/);
  assert.match(worker, /dolphin-input-marker-optical-roi/);
  assert.match(worker, /dolphin-input-marker-generation-barcode/);
  assert.match(worker, /resolveInputPhotonMarkerGeometry\(\s*texture\.width/);
});

test("persistent optical repaint avoids full video-stat parsing without a pending input", async () => {
  const worker = await readFile(
    new URL("../src/upstream-discio-worker.js", import.meta.url),
    "utf8"
  );
  assert.match(
    worker,
    /inputVisualMarkerTracker\.hasPendingInput\(\)[\s\S]*?\? currentPadPollStats\(\)[\s\S]*?: null/
  );
});

test("inputphoton self-overhead accounting is metrics-gated and exported raw", async () => {
  const [worker, harness, docs] = await Promise.all([
    readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8"),
    readFile(new URL("../tools/menu-progress-validate.mjs", import.meta.url), "utf8"),
    readFile(new URL("../docs/input-to-photon-validation.md", import.meta.url), "utf8")
  ]);

  assert.match(
    worker,
    /createInputPhotonOverheadDiagnostics\(\s*inputPhotonDiagnostics && collectMetrics\s*\)/
  );
  assert.match(
    worker,
    /const collectOverhead = inputPhotonOverheadDiagnostics\.enabled &&\s*marker\.mode === INPUT_VISUAL_MARKER_MODE_PHOTON;[\s\S]*?collectOverhead \? performance\.now\(\) : 0/
  );
  assert.match(
    worker,
    /if \(!inputPhotonOverheadDiagnostics\.enabled\) \{[\s\S]*?return parsePadPollStats\(api\.getVideoStats\(\)\);[\s\S]*?const startedAt = performance\.now\(\);/
  );
  assert.match(worker, /overhead: inputPhotonOverheadDiagnosticsPayload\(\)/);
  assert.match(harness, /inputPhotonFrameCopyPaintTotalMs/);
  assert.match(harness, /inputPhotonPadStatsPollParseTotalMs/);
  assert.match(harness, /overheadRawOutputs: \["samples\.json", "samples\.csv"\]/);
  assert.match(docs, /causalTelemetry\.input\.marker\.overhead/);
  assert.match(docs, /INPUTPHOTON=0/);
});

test("headed harness forwards optical options and keeps canvas observation separately gated", async () => {
  const [source, perfGate] = await Promise.all([
    readFile(new URL("../tools/menu-progress-validate.mjs", import.meta.url), "utf8"),
    readFile(new URL("../tools/perf-regression-gate.mjs", import.meta.url), "utf8"),
  ]);
  for (const [envName, parameter] of [
    ["INPUTPHOTON", "inputphoton"],
    ["INPUTPHOTONSIZE", "inputphotonsize"],
    ["INPUTPHOTONX", "inputphotonx"],
    ["INPUTPHOTONY", "inputphotony"],
  ]) {
    assert.match(source, new RegExp(`\\["${envName}", "${parameter}"\\]`));
    assert.match(perfGate, new RegExp(`"${parameter}"`));
  }
  assert.match(
    source,
    /process\.env\.INPUTLATENCY === "1" && process\.env\.INPUTMARKEROBSERVE !== "0"/
  );
  assert.match(source, /physicalPhotonTimestampCapturedByHarness: false/);
});
