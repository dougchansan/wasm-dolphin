export const CAUSAL_TELEMETRY_SCHEMA_VERSION = 1;

const finite = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const nullable = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);

export function createCausalTelemetry(overrides = {}) {
  return deepMerge(
    {
      schemaVersion: CAUSAL_TELEMETRY_SCHEMA_VERSION,
      enabled: false,
      capturedAtMs: 0,
      core: {
        frame: 0,
        ticks: 0,
        ticksPerSecond: 0,
        ppcPc: 0,
        loadedCheckpointGeneration: 0,
        loadedCheckpointTicks: null,
        loadedCheckpointPpcPc: null,
      },
      softwareRaster: {
        sourceXfbCount: 0,
        sourceWidth: 0,
        sourceHeight: 0,
        sourceStrideBytes: 0,
        sourceHash: null,
        sourceNonZeroPixels: 0,
        xfbIntervalLastMs: null,
        xfbIntervalAverageMs: null,
        xfbIntervalMaxMs: null,
        xfbDecodeLastMs: null,
        xfbDecodeAverageMs: null,
        xfbDecodeMaxMs: null,
        outputSyncLastMs: null,
        outputSyncMaxMs: null,
        outputPublishLastMs: null,
        outputPublishMaxMs: null,
        outputTotalLastMs: null,
        outputTotalMaxMs: null,
        encodeTotalMs: null,
        encodeConvertMs: null,
        encodeCopyMs: null,
      },
      presentation: {
        backend: "none",
        pacingMode: "unknown",
        presentedFrames: 0,
        fps: 0,
        rawFps: 0,
        loopFps: 0,
        visualFps: 0,
        queueDepth: 0,
        queueTarget: 0,
        queueLimit: 0,
        queueAgeMs: 0,
        frameLag: 0,
        underrunCount: 0,
        droppedFrameCount: 0,
        intervalAverageMs: 0,
        intervalP95Ms: 0,
        intervalMaxMs: 0,
        intervalLifetimeMaxMs: 0,
        intervalLongFrameCount: 0,
        js: emptyStageWindow(),
      },
      webgpu: {
        registered: false,
        drainCount: 0,
        emptyDrainCount: 0,
        commandsProcessed: 0,
        drainLastMs: 0,
        drainTotalMs: 0,
        drainMaxMs: 0,
        backlogLast: 0,
        backlogHighWater: 0,
        deferredBeginPassCount: 0,
        errorCount: 0,
      },
      workerTraffic: {
        mainToWorker: emptyTrafficDirection(),
        workerToMain: emptyTrafficDirection(),
      },
      audio: {
        workerMixCount: 0,
        workerRequestedFrames: 0,
        workerReturnedFrames: 0,
        workerEmptyMixCount: 0,
        workerMixLastMs: 0,
        workerMixTotalMs: 0,
        workerMixMaxMs: 0,
        pumpCount: 0,
        pumpPendingSkipCount: 0,
        pumpMissCount: 0,
        pumpGapLastMs: 0,
        pumpGapAverageMs: 0,
        pumpGapMaxMs: 0,
        mixRoundTripAverageMs: 0,
        mixRoundTripMaxMs: 0,
        underrunCount: 0,
        overrunCount: 0,
        scheduleLeadSeconds: 0,
        scheduleDriftSeconds: 0,
      },
      input: {
        mainStateChangeCount: 0,
        mainPostCount: 0,
        mainSabWriteCount: 0,
        mainSabGeneration: 0,
        workerPostApplyCount: 0,
        workerSabApplyCount: 0,
        workerSabGeneration: 0,
        ageLastMs: 0,
        ageAverageMs: 0,
        ageMaxMs: 0,
      },
      host: {
        rafLoopCount: 0,
        rafLoopLastMs: 0,
        rafLoopAverageMs: 0,
        rafLoopMaxMs: 0,
        renderLastMs: 0,
        publishLastMs: 0,
        rgbaCopyLastMs: 0,
        putImageDataLastMs: 0,
        drawImageLastMs: 0,
      },
    },
    overrides
  );
}

export function emptyStageWindow() {
  return {
    elapsedMs: 0,
    capture: emptyStage(),
    copy: emptyStage(),
    draw: emptyStage(),
    hash: emptyStage(),
    present: emptyStage(),
    paced: emptyStage(),
    loop: emptyStage(),
    pump: emptyStage(),
    run: emptyStage(),
    api: emptyStage(),
    copyBytes: 0,
    copyMegabytesPerSecond: 0,
  };
}

export function stageWindowFromProfile(profile = {}, elapsedMs = 0) {
  const result = emptyStageWindow();
  result.elapsedMs = finite(elapsedMs);
  for (const name of ["capture", "copy", "draw", "hash", "present", "paced", "loop", "pump", "run", "api"]) {
    const count = finite(profile[`${name}Count`]);
    const totalMs = finite(profile[`${name}Ms`]);
    result[name] = { count, totalMs, averageMs: count > 0 ? totalMs / count : 0 };
  }
  result.copyBytes = finite(profile.copyBytes);
  result.copyMegabytesPerSecond =
    result.elapsedMs > 0 ? result.copyBytes / 1048576 / (result.elapsedMs / 1000) : 0;
  return result;
}

export function parseCoreProfileTelemetry(text = "") {
  const source = String(text || "");
  const xfb = /\bxfb:(\d+)(?:\s+(\d+)x(\d+))?/i.exec(source);
  const stride = /\bstride:(\d+)/i.exec(source);
  const hash = /\bhash:([0-9a-f]+)/i.exec(source);
  const nonZero = /\bnz:(\d+)/i.exec(source);
  const profile = /\bcoreprof\s+xfb_dt:([\d.]+)\s+avg:([\d.]+)\s+max:([\d.]+)\s+decode:([\d.]+)\s+avg:([\d.]+)\s+max:([\d.]+)\s+vo_sync:([\d.]+)\/max([\d.]+)\s+vo_pub:([\d.]+)\/max([\d.]+)\s+vo_total:([\d.]+)\/max([\d.]+)\s+swxfb:([\d.]+)\s+conv:([\d.]+)\s+copy:([\d.]+)/.exec(source);
  const number = (match, index) => nullable(match?.[index]);
  return {
    sourceXfbCount: finite(xfb?.[1]),
    sourceWidth: finite(xfb?.[2]),
    sourceHeight: finite(xfb?.[3]),
    sourceStrideBytes: finite(stride?.[1]),
    sourceHash: hash?.[1] ?? null,
    sourceNonZeroPixels: finite(nonZero?.[1]),
    xfbIntervalLastMs: number(profile, 1),
    xfbIntervalAverageMs: number(profile, 2),
    xfbIntervalMaxMs: number(profile, 3),
    xfbDecodeLastMs: number(profile, 4),
    xfbDecodeAverageMs: number(profile, 5),
    xfbDecodeMaxMs: number(profile, 6),
    outputSyncLastMs: number(profile, 7),
    outputSyncMaxMs: number(profile, 8),
    outputPublishLastMs: number(profile, 9),
    outputPublishMaxMs: number(profile, 10),
    outputTotalLastMs: number(profile, 11),
    outputTotalMaxMs: number(profile, 12),
    encodeTotalMs: number(profile, 13),
    encodeConvertMs: number(profile, 14),
    encodeCopyMs: number(profile, 15),
  };
}

export function countTransferBytes(values = []) {
  let total = 0;
  const seen = new Set();
  for (const value of values || []) {
    const buffer = value instanceof ArrayBuffer
      ? value
      : ArrayBuffer.isView(value)
        ? value.buffer
        : null;
    if (buffer && !seen.has(buffer)) {
      seen.add(buffer);
      total += buffer.byteLength;
    }
  }
  return total;
}

export function estimateMessageBytes(value, seen = new Set()) {
  if (value == null || typeof value === "boolean") return 0;
  if (typeof value === "number") return 8;
  if (typeof value === "string") return value.length * 2;
  if (typeof value !== "object" || seen.has(value)) return 0;
  seen.add(value);
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  let total = 0;
  for (const [key, child] of Object.entries(value)) total += key.length * 2 + estimateMessageBytes(child, seen);
  return total;
}

export function flattenCausalTelemetry(value) {
  const valid = value?.schemaVersion === CAUSAL_TELEMETRY_SCHEMA_VERSION;
  const telemetry = valid ? value : createCausalTelemetry();
  const flattened = {
    causalTelemetrySchemaVersion: telemetry.schemaVersion,
    causalCoreTicks: telemetry.core.ticks,
    causalLoadedCheckpointGeneration: telemetry.core.loadedCheckpointGeneration,
    causalLoadedCheckpointTicks: telemetry.core.loadedCheckpointTicks,
    causalLoadedCheckpointPpcPc: telemetry.core.loadedCheckpointPpcPc,
    causalSourceXfbCount: telemetry.softwareRaster.sourceXfbCount,
    causalSoftwareEncodeMs: telemetry.softwareRaster.encodeTotalMs,
    causalXfbDecodeMs: telemetry.softwareRaster.xfbDecodeLastMs,
    causalJsCaptureMs: telemetry.presentation.js.capture.averageMs,
    causalJsCopyMs: telemetry.presentation.js.copy.averageMs,
    causalJsDrawMs: telemetry.presentation.js.draw.averageMs,
    causalJsHashMs: telemetry.presentation.js.hash.averageMs,
    causalJsPresentMs: telemetry.presentation.js.present.averageMs,
    causalPresentationQueueDepth: telemetry.presentation.queueDepth,
    causalPresentationQueueAgeMs: telemetry.presentation.queueAgeMs,
    causalWgpuDrainMs: telemetry.webgpu.drainLastMs,
    causalWgpuBacklog: telemetry.webgpu.backlogLast,
    causalWorkerRequestCount: telemetry.workerTraffic.mainToWorker.requestCount,
    causalWorkerPostCount: telemetry.workerTraffic.mainToWorker.oneWayCount,
    causalWorkerTransferOutBytes: telemetry.workerTraffic.mainToWorker.transferBytes,
    causalWorkerTransferInBytes: telemetry.workerTraffic.workerToMain.transferBytes,
    causalAudioMixMs: telemetry.audio.workerMixLastMs,
    causalAudioPumpGapMs: telemetry.audio.pumpGapLastMs,
    causalAudioUnderruns: telemetry.audio.underrunCount,
    causalInputAgeMs: telemetry.input.ageLastMs,
    causalInputPostCount: telemetry.input.mainPostCount,
    causalInputSabGeneration: telemetry.input.mainSabGeneration,
  };
  return valid
    ? flattened
    : Object.fromEntries(Object.keys(flattened).map((key) => [key, null]));
}

export function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override === undefined ? base : override;
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] = isPlainObject(value) && isPlainObject(base[key])
      ? deepMerge(base[key], value)
      : value;
  }
  return result;
}

function emptyStage() {
  return { count: 0, totalMs: 0, averageMs: 0 };
}

function emptyTrafficDirection() {
  return {
    requestCount: 0,
    oneWayCount: 0,
    responseCount: 0,
    notificationCount: 0,
    transferBytes: 0,
    estimatedPayloadBytes: 0,
    byType: {},
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    !(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value);
}
