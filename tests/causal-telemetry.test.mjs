import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CAUSAL_TELEMETRY_SCHEMA_VERSION,
  countTransferBytes,
  createCausalTelemetry,
  deepMerge,
  flattenCausalTelemetry,
  parseCoreProfileTelemetry,
  stageWindowFromProfile,
} from "../src/causal-telemetry.js";

test("causal telemetry has a stable versioned shape", () => {
  const value = createCausalTelemetry({
    enabled: true,
    core: { ticks: 123 },
    presentation: { queueDepth: 2 },
  });
  assert.equal(value.schemaVersion, CAUSAL_TELEMETRY_SCHEMA_VERSION);
  assert.equal(value.enabled, true);
  assert.equal(value.core.ticks, 123);
  assert.equal(value.core.loadedCheckpointTicks, null);
  assert.equal(value.presentation.queueDepth, 2);
  assert.equal(value.presentation.freshFrameDelivery, "unknown");
  assert.equal(value.presentation.legacyTickQueue, false);
  assert.equal(value.presentation.immediateFreshFrameCount, 0);
  assert.equal(value.presentation.queuedFreshFrameCount, 0);
  assert.equal(value.presentation.tickRepaintCount, 0);
  assert.equal(value.presentation.queueDepthHighWater, 0);
  assert.equal(value.presentation.queueAgeAverageMs, 0);
  assert.equal(value.presentation.queueAgeMaxMs, 0);
  assert.equal(value.presentation.js.capture.count, 0);
  assert.equal(value.presentation.gpuCompletion.enabled, false);
  assert.equal(value.presentation.gpuCompletion.completedCount, 0);
  assert.equal(value.audio.underrunCount, 0);
  assert.equal(value.input.ageLastMs, 0);
  assert.equal(value.input.mainGeneration, 0);
  assert.equal(value.input.visible.enabled, false);
  assert.equal(value.input.visible.causalVisualAttribution, false);
});

test("core profile text is promoted without changing the compatibility string", () => {
  const source =
    "video xfb:77 640x480 stride:1280 present:320x240 hash:4b2d0a3b nz:2048 " +
    "coreprof xfb_dt:16.7 avg:17.1 max:41.2 decode:1.3 avg:1.4 max:2.8 " +
    "vo_sync:0.2/max0.6 vo_pub:0.3/max0.7 vo_total:0.5/max1.1 " +
    "swxfb:0.9 conv:0.8 copy:0.1";
  assert.deepEqual(parseCoreProfileTelemetry(source), {
    sourceXfbCount: 77,
    sourceWidth: 640,
    sourceHeight: 480,
    sourceStrideBytes: 1280,
    sourceHash: "4b2d0a3b",
    sourceNonZeroPixels: 2048,
    xfbIntervalLastMs: 16.7,
    xfbIntervalAverageMs: 17.1,
    xfbIntervalMaxMs: 41.2,
    xfbDecodeLastMs: 1.3,
    xfbDecodeAverageMs: 1.4,
    xfbDecodeMaxMs: 2.8,
    outputSyncLastMs: 0.2,
    outputSyncMaxMs: 0.6,
    outputPublishLastMs: 0.3,
    outputPublishMaxMs: 0.7,
    outputTotalLastMs: 0.5,
    outputTotalMaxMs: 1.1,
    encodeTotalMs: 0.9,
    encodeConvertMs: 0.8,
    encodeCopyMs: 0.1,
  });
});

test("profile windows retain counts, totals, averages, and copy throughput", () => {
  const value = stageWindowFromProfile({
    captureCount: 4,
    captureMs: 8,
    drawCount: 2,
    drawMs: 3,
    copyBytes: 1048576,
  }, 1000);
  assert.deepEqual(value.capture, { count: 4, totalMs: 8, averageMs: 2 });
  assert.deepEqual(value.draw, { count: 2, totalMs: 3, averageMs: 1.5 });
  assert.equal(value.copyMegabytesPerSecond, 1);
});

test("traffic byte accounting deduplicates views of the same transferred buffer", () => {
  const buffer = new ArrayBuffer(64);
  assert.equal(countTransferBytes([buffer, new Uint8Array(buffer)]), 64);
});

test("CSV flattening carries the exact causal schema and decision fields", () => {
  const value = createCausalTelemetry({
    core: { ticks: 55 },
    softwareRaster: { encodeTotalMs: 1.25 },
    presentation: {
      freshFrameDelivery: "immediate",
      legacyTickQueue: false,
      immediateFreshFrameCount: 9,
      queuedFreshFrameCount: 0,
      tickRepaintCount: 4,
      queueDepth: 0,
      queueDepthHighWater: 0,
      queueAgeMs: 0,
      queueAgeAverageMs: 0,
      queueAgeMaxMs: 0,
      gpuCompletion: {
        enabled: true,
        lastMs: 3.5,
        p95Ms: 4.5,
        inFlight: 1,
      },
    },
    webgpu: { backlogLast: 3 },
    input: {
      ageLastMs: 4,
      mainGeneration: 7,
      visible: {
        enabled: true,
        pollAgeLastMs: 5,
        visibleAgeLastMs: 18,
        pollToVisibleLastMs: 13,
      },
    },
  });
  const flat = flattenCausalTelemetry(value);
  assert.equal(flat.causalTelemetrySchemaVersion, CAUSAL_TELEMETRY_SCHEMA_VERSION);
  assert.equal(flat.causalCoreTicks, 55);
  assert.equal(flat.causalSoftwareEncodeMs, 1.25);
  assert.equal(flat.causalFreshFrameDelivery, "immediate");
  assert.equal(flat.causalLegacyTickQueue, false);
  assert.equal(flat.causalImmediateFreshFrameCount, 9);
  assert.equal(flat.causalQueuedFreshFrameCount, 0);
  assert.equal(flat.causalTickRepaintCount, 4);
  assert.equal(flat.causalPresentationQueueDepthHighWater, 0);
  assert.equal(flat.causalPresentationQueueAgeAverageMs, 0);
  assert.equal(flat.causalPresentationQueueAgeMaxMs, 0);
  assert.equal(flat.causalGpuCompletionEnabled, true);
  assert.equal(flat.causalGpuCompletionMs, 3.5);
  assert.equal(flat.causalGpuCompletionP95Ms, 4.5);
  assert.equal(flat.causalGpuCompletionInFlight, 1);
  assert.equal(flat.causalWgpuBacklog, 3);
  assert.equal(flat.causalInputAgeMs, 4);
  assert.equal(flat.causalInputGeneration, 7);
  assert.equal(flat.causalInputVisibleEnabled, true);
  assert.equal(flat.causalInputCorePollAgeMs, 5);
  assert.equal(flat.causalInputVisibleAgeMs, 18);
  assert.equal(flat.causalInputPollToVisibleMs, 13);
  assert.equal(flattenCausalTelemetry(null).causalTelemetrySchemaVersion, null);
});

test("rebuilt core exports CPU-thread checkpoint capture before renderer resync", async () => {
  const source = await readFile(new URL("../core/upstream/dolphin_web_core.cpp", import.meta.url), "utf8");
  const callback = source.indexOf("State::SetOnAfterLoadCallback");
  const capture = source.indexOf("s_last_loaded_ticks_low.store", callback);
  const resync = source.indexOf("fifo.EmulatorState(true)", callback);
  assert.ok(callback >= 0 && capture > callback && resync > capture);
  for (const name of [
    "GetLastLoadedCoreTicksLow",
    "GetLastLoadedCoreTicksHigh",
    "GetLastLoadedPPCPC",
    "GetLastLoadedCheckpointGeneration",
  ]) {
    assert.match(source, new RegExp(`std::uint32_t ${name}\\(\\)`));
  }
  const manifest = JSON.parse(
    await readFile(new URL("../provenance/dolphin-core-abi-v1.json", import.meta.url), "utf8")
  );
  assert.deepEqual(manifest.sourceOnlyExportsPendingRebuild, []);
  for (const name of [
    "_GetLastLoadedCheckpointGeneration",
    "_GetLastLoadedCoreTicksHigh",
    "_GetLastLoadedCoreTicksLow",
    "_GetLastLoadedPPCPC",
    "_SetXfbFastPaths",
  ]) {
    assert.ok(manifest.moduleExports.includes(name), `${name} must be present in the rebuilt core`);
  }
});

test("deep merge preserves untouched telemetry branches", () => {
  const merged = deepMerge(createCausalTelemetry(), { audio: { underrunCount: 2 } });
  assert.equal(merged.audio.underrunCount, 2);
  assert.equal(merged.audio.overrunCount, 0);
  assert.equal(merged.presentation.backend, "none");
});
