import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const harnessUrl = new URL("../tools/menu-progress-validate.mjs", import.meta.url);

test("headed harness independently gates marker canvas readback", async () => {
  const source = await readFile(harnessUrl, "utf8");

  assert.match(
    source,
    /const inputMarkerCanvasObservationEnabled =\s+process\.env\.INPUTLATENCY === "1" && process\.env\.INPUTMARKEROBSERVE !== "0";/
  );
  assert.match(
    source,
    /if \(inputMarkerCanvasObservationEnabled\) \{\s+await page\.evaluate\(installInputMarkerCanvasObserver\);\s+\}/
  );
  assert.match(source, /if \(inputMarkerCanvasObservationEnabled\) \{[\s\S]*?__menuProgressInputMarkerObserver/);
});

test("marker observer samples and validates the complete top-left 8x8 marker at rAF cadence", async () => {
  const source = await readFile(harnessUrl, "utf8");

  assert.match(source, /const MARKER_SIZE = 8;/);
  assert.match(source, /const RENDERED_MARKER_SIZE = 32;/);
  assert.match(source, /requestAnimationFrame\(observe\)/);
  assert.match(source, /context\.drawImage\(\s*screen,[\s\S]*?MARKER_SIZE/);
  assert.match(source, /uniformPixelCount === MARKER_SIZE \* MARKER_SIZE/);
  assert.match(source, /\(rgba\[0\] & 0xc0\) === 0x40/);
  assert.match(source, /\(rgba\[1\] & 0xc0\) === 0x80/);
  assert.match(source, /\(rgba\[2\] & 0xc0\) === 0xc0/);
  assert.match(source, /decodedGeneration/);
  assert.match(source, /workerValidated/);
});

test("marker observations are raw artifacts and canvas-visible latency excludes scanout", async () => {
  const source = await readFile(harnessUrl, "utf8");

  assert.match(source, /input-marker-observations\.json/);
  assert.match(source, /rawObservations: \[\]/);
  assert.match(source, /provisionalGenerations: \[\]/);
  assert.match(source, /adapterToBrowserCanvasVisibleMs/);
  assert.match(source, /workerSentToBrowserCanvasVisibleMs/);
  assert.match(source, /adapterFinishedToWorkerAppliedMs/);
  assert.match(source, /workerAppliedToCorePollMs/);
  assert.match(source, /markerSubmitToGpuCompleteMs/);
  assert.match(source, /gpuCompleteToBrowserCanvasVisibleMs/);
  assert.match(source, /appliedAtEpochMs/);
  assert.match(source, /workerTimestamps: worker\?\.timestamps \?\? null/);
  assert.match(source, /scanoutIncluded: false/);
  assert.match(source, /compositor-to-panel scanout is excluded/);
  assert.match(source, /perturbsRendering: true/);
  assert.match(source, /canvasReadAverageMs/);
  assert.match(source, /legacyBackbufferReadbackEnabled/);
  assert.match(source, /expected-generation-count-below-six/);
  assert.match(source, /inputreadback-must-be-disabled/);
  assert.match(source, /physicalPhotonBoundaryIncluded: false/);
});

test("stop joins completed worker samples that arrived after their canvas marker expired", async () => {
  const source = await readFile(harnessUrl, "utf8");
  const functionStart = source.indexOf("function installInputMarkerCanvasObserver()");
  const functionEnd = source.indexOf("\nasync function importPlaywright", functionStart);
  assert.ok(functionStart >= 0 && functionEnd > functionStart);

  let markerVisible = false;
  let epochMs = 100_000;
  let performanceMs = 0;
  let nextRaf = null;
  const listeners = new Map();
  const adapter = {
    inputTelemetry: { mainGeneration: 0 },
    setInputState() {
      this.inputTelemetry.mainGeneration += 1;
    },
  };
  const markerBytes = new Uint8ClampedArray(8 * 8 * 4);
  for (let offset = 0; offset < markerBytes.length; offset += 4) {
    markerBytes.set([0x41, 0x80, 0xc0, 0xff], offset);
  }
  const ordinaryBytes = new Uint8ClampedArray(8 * 8 * 4);
  const context = {
    drawImage() {},
    getImageData() {
      return { data: markerVisible ? markerBytes : ordinaryBytes };
    },
  };
  const screen = { width: 640, height: 528 };
  const window = { __host: { adapter }, __lastFrameInfo: { causalTelemetry: null } };
  const sandbox = {
    Date: { now: () => epochMs },
    Uint8ClampedArray,
    cancelAnimationFrame() {},
    document: {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => context,
      }),
      querySelector: () => screen,
      addEventListener(type, listener) {
        listeners.set(type, listener);
      },
      removeEventListener(type) {
        listeners.delete(type);
      },
    },
    performance: {
      timeOrigin: 100_000,
      now: () => performanceMs,
    },
    location: { search: "?inputlatency=1" },
    requestAnimationFrame(callback) {
      nextRaf = callback;
      return 1;
    },
    window,
  };
  const installer = vm.runInNewContext(
    `${source.slice(functionStart, functionEnd)}\ninstallInputMarkerCanvasObserver`,
    sandbox
  );

  installer();
  const firstRaf = nextRaf;
  performanceMs = 10;
  firstRaf(10); // installs the adapter wrapper; no marker is visible yet
  listeners.get("keydown")({ type: "keydown", code: "KeyX", key: "x", timeStamp: 15 });
  epochMs = 100_015;
  adapter.setInputState({ mask: 1 });
  markerVisible = true;
  performanceMs = 30;
  nextRaf(30); // adapter-only observation is retained as provisional evidence

  for (let generation = 2; generation <= 6; generation += 1) {
    const eventAtMs = generation * 20;
    listeners.get("keydown")({
      type: "keydown",
      code: "KeyX",
      key: "x",
      timeStamp: eventAtMs,
    });
    epochMs = 100_000 + eventAtMs;
    adapter.setInputState({ mask: generation });
    fillMarker(generation);
    if ((generation & 1) === 0) {
      window.__lastFrameInfo.causalTelemetry = markerTelemetry(
        generation,
        100_000 + eventAtMs
      );
    }
    performanceMs = eventAtMs + 10;
    nextRaf(performanceMs);
  }

  // The worker publishes metrics every 500 ms, after generations 1/3/5 are no
  // longer visible. stop() must join these exact completed samples to the first
  // browser observation retained in provisionalGenerations.
  window.__lastFrameInfo.causalTelemetry = markerTelemetry(
    6,
    100_120,
    Array.from({ length: 6 }, (_, index) => {
      const generation = index + 1;
      return markerSample(
        generation,
        generation === 1 ? 100_015 : 100_000 + generation * 20
      );
    })
  );
  const snapshot = window.__menuProgressInputMarkerObserver.stop();
  assert.equal(snapshot.provisionalGenerations.length, 6);
  assert.equal(snapshot.provisionalGenerations[0].promotedToWorkerValidated, true);
  assert.equal(snapshot.finalJoinPromotionCount, 3);
  assert.equal(snapshot.validatedGenerations.length, 6);
  const firstGeneration = snapshot.validatedGenerations.find((sample) => sample.generation === 1);
  assert.equal(firstGeneration.joinedAtStop, true);
  assert.equal(firstGeneration.adapterToBrowserCanvasVisibleMs, 15);
  assert.equal(firstGeneration.inputEventToBrowserCanvasVisibleMs, 15);
  assert.equal(firstGeneration.workerSentToBrowserCanvasVisibleMs, 15);
  assert.equal(firstGeneration.appliedAtEpochMs, 100_017);
  assert.deepEqual(
    { ...firstGeneration.stageDeltas },
    {
      inputEventToAdapterStartMs: 0,
      adapterCallDurationMs: 0,
      adapterFinishedToWorkerAppliedMs: 2,
      workerSentToAppliedMs: 2,
      workerAppliedToCorePollMs: 3,
      corePollToMarkerSubmitMs: 2,
      markerSubmitToGpuCompleteMs: 3,
      gpuCompleteToBrowserCanvasVisibleMs: 5,
      inputEventToBrowserCanvasVisibleMs: 15,
    }
  );
  assert.equal(snapshot.summary.workerValidatedGenerationCount, 6);
  assert.equal(snapshot.summary.workerTimestampJoinCount, 6);
  assert.equal(snapshot.summary.monotonicTimestampCount, 6);
  assert.equal(snapshot.summary.acceptance.passed, true);
  assert.deepEqual({ ...snapshot.summary.acceptance.parityCounts }, {
    expected: 6,
    applied: 6,
    polled: 6,
    submitted: 6,
    completed: 6,
    browserCanvasVisible: 6,
  });
  assert.equal(snapshot.summary.stageLatency.workerAppliedToCorePollMs.sampleCount, 6);
  assert.equal(snapshot.summary.scanoutIncluded, false);
  assert.equal(snapshot.summary.physicalPhotonBoundaryIncluded, false);
  assert.equal(snapshot.summary.perturbsRendering, true);
  assert.equal(snapshot.summary.legacyBackbufferReadbackEnabled, false);

  function fillMarker(generation) {
    const rgba = [
      0x40 | (generation & 0x3f),
      0x80 | ((generation >>> 6) & 0x3f),
      0xc0 | ((generation >>> 12) & 0x3f),
      0xff,
    ];
    for (let offset = 0; offset < markerBytes.length; offset += 4) {
      markerBytes.set(rgba, offset);
    }
  }

  function markerTelemetry(
    generation,
    sentAtEpochMs,
    samples = [markerSample(generation, sentAtEpochMs)]
  ) {
    return {
      capturedAtMs: generation * 10,
      input: {
        marker: {
          enabled: true,
          activeGeneration: generation,
          lastCompletedGeneration: generation,
          appliedCount: generation,
          exactCorePollCount: generation,
          markerSubmittedCount: generation,
          markerCompletedCount: generation,
          expiredMarkerCount: 0,
          expiredInFlightCount: 0,
          generationMismatchCount: 0,
          generationUnavailableCount: 0,
          samples,
        },
      },
    };
  }

  function markerSample(generation, sentAtEpochMs) {
    return {
      generation,
      sentAtEpochMs,
      appliedAtEpochMs: sentAtEpochMs + 2,
      polledAtEpochMs: sentAtEpochMs + 5,
      submittedAtEpochMs: sentAtEpochMs + 7,
      completedAtEpochMs: sentAtEpochMs + 10,
    };
  }
});
