export const WGPU_QUEUE_RELIEF_UPLOAD_CALLS = 8192;
export const WGPU_QUEUE_RELIEF_UPLOAD_BYTES = 16 * 1024 * 1024;

export function requestedWgpuQueueRelief(
  search = globalThis.location?.search ?? ""
) {
  return new URLSearchParams(search).get("wgpuqueuewait") === "1";
}

function count(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

function pressure(sample = {}) {
  return {
    backlog: count(sample.backlog),
    watermark: count(sample.watermark),
    stagedBytes: count(sample.stagedBytes),
  };
}

function activity(sample = {}) {
  return {
    audio: count(sample?.audio),
    input: count(sample?.input),
    host: count(sample?.host),
  };
}

function percentile95(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

export function createWgpuQueueRelief({
  enabled = false,
  uploadCallThreshold = WGPU_QUEUE_RELIEF_UPLOAD_CALLS,
  uploadByteThreshold = WGPU_QUEUE_RELIEF_UPLOAD_BYTES,
  maxWaitSamples = 64,
  now = () => performance.now(),
} = {}) {
  const requested = Boolean(enabled);
  const callThreshold = Math.max(1, count(uploadCallThreshold));
  const byteThreshold = Math.max(1, count(uploadByteThreshold));
  const sampleCapacity = Math.max(1, count(maxWaitSamples));
  const waitSamples = [];
  let active = requested;
  let generation = 1;
  let phase = active ? "idle" : "disabled";
  let passDepth = 0;
  let intervalCalls = 0;
  let intervalBytes = 0;
  let waitStartedAt = 0;
  let waitActivity = activity();
  const stats = {
    triggerCount: 0,
    triggerCallThresholdCount: 0,
    triggerByteThresholdCount: 0,
    maxIntervalCalls: 0,
    maxIntervalBytes: 0,
    callOvershootLast: 0,
    callOvershootMax: 0,
    byteOvershootLast: 0,
    byteOvershootMax: 0,
    completionRequestedCount: 0,
    completionCompletedCount: 0,
    completionFailedCount: 0,
    completionStaleCount: 0,
    waitLastMs: 0,
    waitTotalMs: 0,
    waitMaxMs: 0,
    armBacklogLast: 0,
    armBacklogMax: 0,
    armWatermarkLast: 0,
    armStagedBytesLast: 0,
    resumeBacklogLast: 0,
    resumeWatermarkLast: 0,
    resumeStagedBytesLast: 0,
    suppressedPresentationDrainCount: 0,
    suppressedPumpDrainCount: 0,
    maxPassDepth: 0,
    waitAudioActivityTotal: 0,
    waitAudioActivityMax: 0,
    waitInputActivityTotal: 0,
    waitInputActivityMax: 0,
    waitHostActivityTotal: 0,
    waitHostActivityMax: 0,
    resetCount: 0,
  };

  function recordSuccessfulUpload(bytes = 0, sample = {}) {
    if (!active || phase === "waiting") return false;
    intervalCalls += 1;
    intervalBytes += count(bytes);
    stats.maxIntervalCalls = Math.max(stats.maxIntervalCalls, intervalCalls);
    stats.maxIntervalBytes = Math.max(stats.maxIntervalBytes, intervalBytes);
    if (phase !== "idle") return false;
    const callsReached = intervalCalls >= callThreshold;
    const bytesReached = intervalBytes >= byteThreshold;
    if (!callsReached && !bytesReached) return false;
    phase = "armed";
    stats.triggerCount += 1;
    if (callsReached) stats.triggerCallThresholdCount += 1;
    if (bytesReached) stats.triggerByteThresholdCount += 1;
    stats.callOvershootLast = Math.max(0, intervalCalls - callThreshold);
    stats.callOvershootMax = Math.max(stats.callOvershootMax, stats.callOvershootLast);
    stats.byteOvershootLast = Math.max(0, intervalBytes - byteThreshold);
    stats.byteOvershootMax = Math.max(stats.byteOvershootMax, stats.byteOvershootLast);
    const arm = pressure(sample);
    stats.armBacklogLast = arm.backlog;
    stats.armBacklogMax = Math.max(stats.armBacklogMax, arm.backlog);
    stats.armWatermarkLast = arm.watermark;
    stats.armStagedBytesLast = arm.stagedBytes;
    return true;
  }

  function beginPass() {
    if (!active) return;
    passDepth += 1;
    stats.maxPassDepth = Math.max(stats.maxPassDepth, passDepth);
  }

  function endPass() {
    if (!active) return;
    passDepth = Math.max(0, passDepth - 1);
  }

  function shouldRelieveAtBoundary(boundary) {
    return active && phase === "armed" && passDepth === 0 &&
      (boundary === "end-pass" || boundary === "submit-present");
  }

  function beginWait(sample = {}) {
    if (!active || phase !== "armed" || passDepth !== 0) return null;
    stats.callOvershootLast = Math.max(0, intervalCalls - callThreshold);
    stats.callOvershootMax = Math.max(stats.callOvershootMax, stats.callOvershootLast);
    stats.byteOvershootLast = Math.max(0, intervalBytes - byteThreshold);
    stats.byteOvershootMax = Math.max(stats.byteOvershootMax, stats.byteOvershootLast);
    phase = "waiting";
    stats.completionRequestedCount += 1;
    waitStartedAt = now();
    waitActivity = activity(sample.activity);
    return Object.freeze({ generation, request: stats.completionRequestedCount });
  }

  function settle(token, { ok, sample = {} } = {}) {
    if (!token || token.generation !== generation || phase !== "waiting") {
      stats.completionStaleCount += 1;
      return { stale: true, resume: false, disabled: !active };
    }
    const elapsed = Math.max(0, now() - waitStartedAt);
    stats.waitLastMs = elapsed;
    stats.waitTotalMs += elapsed;
    stats.waitMaxMs = Math.max(stats.waitMaxMs, elapsed);
    waitSamples.push(elapsed);
    if (waitSamples.length > sampleCapacity) waitSamples.shift();
    const resume = pressure(sample);
    stats.resumeBacklogLast = resume.backlog;
    stats.resumeWatermarkLast = resume.watermark;
    stats.resumeStagedBytesLast = resume.stagedBytes;
    const after = activity(sample.activity);
    for (const [field, key] of [["Audio", "audio"], ["Input", "input"], ["Host", "host"]]) {
      const delta = Math.max(0, after[key] - waitActivity[key]);
      stats[`wait${field}ActivityTotal`] += delta;
      stats[`wait${field}ActivityMax`] = Math.max(stats[`wait${field}ActivityMax`], delta);
    }
    waitStartedAt = 0;
    intervalCalls = 0;
    intervalBytes = 0;
    if (ok) {
      stats.completionCompletedCount += 1;
      phase = "idle";
      return { stale: false, resume: true, disabled: false };
    }
    stats.completionFailedCount += 1;
    active = false;
    phase = "disabled";
    return { stale: false, resume: true, disabled: true };
  }

  function suppress(source) {
    if (!active || phase !== "waiting") return false;
    if (source === "pump") stats.suppressedPumpDrainCount += 1;
    else stats.suppressedPresentationDrainCount += 1;
    return true;
  }

  function reset({ enabled: nextEnabled = requested } = {}) {
    generation += 1;
    active = Boolean(nextEnabled);
    phase = active ? "idle" : "disabled";
    passDepth = 0;
    intervalCalls = 0;
    intervalBytes = 0;
    waitStartedAt = 0;
    stats.resetCount += 1;
    return generation;
  }

  function snapshot() {
    const settledCount = stats.completionCompletedCount + stats.completionFailedCount;
    return {
      schema: "wasm-dolphin.wgpu-queue-relief.v1",
      requested,
      enabled: active,
      phase,
      generation,
      uploadCallThreshold: callThreshold,
      uploadByteThreshold: byteThreshold,
      intervalCalls,
      intervalBytes,
      passDepth,
      ...stats,
      waitAverageMs: settledCount > 0 ? stats.waitTotalMs / settledCount : 0,
      waitP95Ms: percentile95(waitSamples),
    };
  }

  return {
    recordSuccessfulUpload,
    beginPass,
    endPass,
    shouldRelieveAtBoundary,
    beginWait,
    settle,
    suppress,
    reset,
    snapshot,
  };
}
