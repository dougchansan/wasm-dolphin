// Large enough for an external photodiode or high-speed-camera region while
// the browser observer samples only the uniform top-left 8x8 subset.
export const INPUT_VISUAL_MARKER_SIZE = 32;
const DEFAULT_MARKER_SIZE = INPUT_VISUAL_MARKER_SIZE;
const DEFAULT_MAX_SAMPLES = 64;
const DEFAULT_MARKER_HOLD_MS = 250;
const DEFAULT_MARKER_MAX_LIFETIME_MS = 2000;

export function inputMarkerRgba(generation) {
  const value = Number(generation) >>> 0;
  return [
    0x40 | (value & 0x3f),
    0x80 | ((value >>> 6) & 0x3f),
    0xc0 | ((value >>> 12) & 0x3f),
    0xff
  ];
}

export function applyInputMarkerRgba(
  bytes,
  width,
  height,
  generation,
  { bytesPerRow = Number(width) * 4, markerSize = DEFAULT_MARKER_SIZE } = {}
) {
  const frameWidth = Math.trunc(Number(width));
  const frameHeight = Math.trunc(Number(height));
  const stride = Math.trunc(Number(bytesPerRow));
  const size = Math.max(1, Math.trunc(Number(markerSize) || DEFAULT_MARKER_SIZE));
  if (
    !bytes ||
    frameWidth <= 0 ||
    frameHeight <= 0 ||
    stride < frameWidth * 4 ||
    bytes.byteLength < stride * frameHeight
  ) {
    return false;
  }

  const rgba = inputMarkerRgba(generation);
  const markerWidth = Math.min(size, frameWidth);
  const markerHeight = Math.min(size, frameHeight);
  for (let y = 0; y < markerHeight; y += 1) {
    const row = y * stride;
    for (let x = 0; x < markerWidth; x += 1) {
      const offset = row + x * 4;
      bytes[offset] = rgba[0];
      bytes[offset + 1] = rgba[1];
      bytes[offset + 2] = rgba[2];
      bytes[offset + 3] = rgba[3];
    }
  }
  return true;
}

export function inputMarkerPixelMatches(bytes, generation, offset = 0) {
  const index = Math.trunc(Number(offset));
  if (!bytes || index < 0 || index + 3 >= bytes.byteLength) return false;
  const rgba = inputMarkerRgba(generation);
  return rgba.every((value, channel) => bytes[index + channel] === value);
}

export function createInputVisualMarkerTracker({
  enabled = false,
  maxSamples = DEFAULT_MAX_SAMPLES,
  markerHoldMs = DEFAULT_MARKER_HOLD_MS,
  markerMaxLifetimeMs = DEFAULT_MARKER_MAX_LIFETIME_MS,
  now = () => Date.now()
} = {}) {
  const active = Boolean(enabled);
  const sampleLimit = Math.max(1, Math.trunc(Number(maxSamples) || DEFAULT_MAX_SAMPLES));
  const holdMs = Math.max(0, Math.trunc(Number(markerHoldMs) || 0));
  const maxLifetimeMs = Math.max(
    holdMs,
    Math.trunc(Number(markerMaxLifetimeMs) || DEFAULT_MARKER_MAX_LIFETIME_MS)
  );
  const completedSamples = [];
  const tokens = new Map();
  let pending = null;
  let activeGeneration = 0;
  let activeMarkerExpiresAtEpochMs = 0;
  let activeMarkerCompleted = false;
  const stats = {
    appliedCount: 0,
    duplicateApplyCount: 0,
    supersededCount: 0,
    supersededArmedCount: 0,
    droppedInFlightCount: 0,
    exactCorePollCount: 0,
    generationMismatchCount: 0,
    generationUnavailableCount: 0,
    markerArmedCount: 0,
    markerSubmittedCount: 0,
    markerCompletedCount: 0,
    duplicateSubmitCount: 0,
    duplicateCompleteCount: 0,
    retiredCompletedMarkerCount: 0,
    expiredMarkerCount: 0,
    expiredInFlightCount: 0,
    lastCompletedGeneration: 0,
    lastCompletedCoreFrame: 0,
    lastSource: "",
    lastCompletionKind: "",
    pollAgeLastMs: 0,
    submitAgeLastMs: 0,
    completionAgeLastMs: 0,
    pollToCompletionLastMs: 0
  };

  function recordApplied({
    generation,
    inputMask,
    sentAtEpochMs,
    baselinePollCount = 0
  } = {}) {
    if (!active) return false;
    const normalizedGeneration = Number(generation) >>> 0;
    if (!normalizedGeneration) return false;
    if (pending?.generation === normalizedGeneration || activeGeneration === normalizedGeneration) {
      stats.duplicateApplyCount += 1;
      return false;
    }
    if (pending) stats.supersededCount += 1;
    const appliedAtEpochMs = Number(now());
    const sentAt = Number(sentAtEpochMs);
    pending = {
      generation: normalizedGeneration,
      inputMask: Number(inputMask) >>> 0,
      sentAtEpochMs: Number.isFinite(sentAt) ? sentAt : appliedAtEpochMs,
      appliedAtEpochMs,
      baselinePollCount: Number(baselinePollCount) >>> 0
    };
    stats.appliedCount += 1;
    return true;
  }

  function recordCorePoll({ pollCount, inputMask, inputGeneration, coreFrame = 0 } = {}) {
    if (!active || !pending) return 0;
    const normalizedPollCount = Number(pollCount) >>> 0;
    const normalizedGeneration = Number(inputGeneration) >>> 0;
    if (normalizedPollCount <= pending.baselinePollCount ||
        (Number(inputMask) >>> 0) !== pending.inputMask) {
      return 0;
    }
    if (!normalizedGeneration) {
      stats.generationUnavailableCount += 1;
      return 0;
    }
    if (normalizedGeneration !== pending.generation) {
      stats.generationMismatchCount += 1;
      return 0;
    }

    const polledAtEpochMs = Number(now());
    const token = {
      generation: pending.generation,
      sentAtEpochMs: pending.sentAtEpochMs,
      appliedAtEpochMs: pending.appliedAtEpochMs,
      polledAtEpochMs,
      coreFrame: Number(coreFrame) >>> 0,
      submittedAtEpochMs: 0,
      completedAtEpochMs: 0,
      expiresAtEpochMs: polledAtEpochMs + maxLifetimeMs,
      source: ""
    };
    if (activeGeneration && activeGeneration !== token.generation) {
      const previous = tokens.get(activeGeneration);
      if (previous && !previous.submittedAtEpochMs) {
        tokens.delete(activeGeneration);
        stats.supersededArmedCount += 1;
      }
    }
    tokens.set(token.generation, token);
    while (tokens.size > sampleLimit) {
      const oldestGeneration = tokens.keys().next().value;
      if (oldestGeneration === token.generation && tokens.size === 1) break;
      tokens.delete(oldestGeneration);
      stats.droppedInFlightCount += 1;
    }
    activeGeneration = token.generation;
    activeMarkerExpiresAtEpochMs = token.expiresAtEpochMs;
    activeMarkerCompleted = false;
    pending = null;
    stats.exactCorePollCount += 1;
    stats.markerArmedCount += 1;
    const age = validAge(polledAtEpochMs, token.sentAtEpochMs);
    if (age !== null) stats.pollAgeLastMs = age;
    return token.generation;
  }

  function currentMarker() {
    if (!active || !activeGeneration) return null;
    if (expireActiveMarker()) return null;
    const token = tokens.get(activeGeneration);
    return {
      generation: activeGeneration,
      rgba: inputMarkerRgba(activeGeneration),
      needsSubmission: Boolean(token && !token.submittedAtEpochMs)
    };
  }

  function recordMarkerSubmitted({ generation, coreFrame = 0, source = "unknown" } = {}) {
    if (!active) return false;
    const normalizedGeneration = Number(generation) >>> 0;
    const token = tokens.get(normalizedGeneration);
    if (!token) return false;
    if (token.submittedAtEpochMs) {
      stats.duplicateSubmitCount += 1;
      return false;
    }
    token.submittedAtEpochMs = Number(now());
    token.coreFrame = Number(coreFrame) >>> 0;
    token.source = String(source || "unknown");
    stats.markerSubmittedCount += 1;
    stats.lastSource = token.source;
    const age = validAge(token.submittedAtEpochMs, token.sentAtEpochMs);
    if (age !== null) stats.submitAgeLastMs = age;
    return true;
  }

  function recordMarkerCompleted({
    generation,
    coreFrame = 0,
    source = "unknown",
    completionKind = "unknown"
  } = {}) {
    if (!active) return false;
    const normalizedGeneration = Number(generation) >>> 0;
    const token = tokens.get(normalizedGeneration);
    if (!token || !token.submittedAtEpochMs) return false;
    if (token.completedAtEpochMs) {
      stats.duplicateCompleteCount += 1;
      return false;
    }
    token.completedAtEpochMs = Number(now());
    if (activeGeneration === token.generation) {
      activeMarkerExpiresAtEpochMs = token.completedAtEpochMs + holdMs;
      activeMarkerCompleted = true;
    }
    token.coreFrame = Number(coreFrame) >>> 0;
    token.source = String(source || token.source || "unknown");
    const completionAgeMs = validAge(token.completedAtEpochMs, token.sentAtEpochMs);
    const pollToCompletionMs = validAge(token.completedAtEpochMs, token.polledAtEpochMs);
    const sample = {
      generation: token.generation,
      coreFrame: token.coreFrame,
      source: token.source,
      completionKind: String(completionKind || "unknown"),
      sentAtEpochMs: token.sentAtEpochMs,
      appliedAtEpochMs: token.appliedAtEpochMs,
      polledAtEpochMs: token.polledAtEpochMs,
      submittedAtEpochMs: token.submittedAtEpochMs,
      completedAtEpochMs: token.completedAtEpochMs,
      completionAgeMs: completionAgeMs ?? 0,
      pollToCompletionMs: pollToCompletionMs ?? 0
    };
    completedSamples.push(sample);
    if (completedSamples.length > sampleLimit) completedSamples.shift();
    stats.markerCompletedCount += 1;
    stats.lastCompletedGeneration = token.generation;
    stats.lastCompletedCoreFrame = token.coreFrame;
    stats.lastSource = token.source;
    stats.lastCompletionKind = sample.completionKind;
    if (completionAgeMs !== null) stats.completionAgeLastMs = completionAgeMs;
    if (pollToCompletionMs !== null) stats.pollToCompletionLastMs = pollToCompletionMs;
    tokens.delete(normalizedGeneration);
    return true;
  }

  function snapshot() {
    expireActiveMarker();
    const completionAges = completedSamples.map((sample) => sample.completionAgeMs);
    const pollToCompletion = completedSamples.map((sample) => sample.pollToCompletionMs);
    return {
      schema: "wasm-dolphin.input-visual-marker.v1",
      enabled: active,
      causalVisualAttribution: true,
      meaning: "host-input-to-core-polled-generation-to-deterministic-marker-completion",
      ...stats,
      pendingGeneration: pending?.generation ?? 0,
      activeGeneration,
      activeMarkerExpiresAtEpochMs,
      markerHoldMs: holdMs,
      markerMaxLifetimeMs: maxLifetimeMs,
      inFlightCount: tokens.size,
      completionAgeAverageMs: average(completionAges),
      completionAgeP95Ms: percentile(completionAges, 0.95),
      completionAgeMaxMs: maximum(completionAges),
      pollToCompletionAverageMs: average(pollToCompletion),
      pollToCompletionP95Ms: percentile(pollToCompletion, 0.95),
      samples: completedSamples.map((sample) => ({ ...sample }))
    };
  }

  function expireActiveMarker() {
    if (!activeGeneration || activeMarkerExpiresAtEpochMs <= 0 ||
        Number(now()) <= activeMarkerExpiresAtEpochMs) {
      return false;
    }
    const token = tokens.get(activeGeneration);
    if (activeMarkerCompleted) {
      stats.retiredCompletedMarkerCount += 1;
    } else {
      stats.expiredMarkerCount += 1;
    }
    if (token && !token.completedAtEpochMs) {
      tokens.delete(activeGeneration);
      stats.expiredInFlightCount += 1;
    }
    activeGeneration = 0;
    activeMarkerExpiresAtEpochMs = 0;
    activeMarkerCompleted = false;
    return true;
  }

  return {
    currentMarker,
    recordApplied,
    recordCorePoll,
    recordMarkerCompleted,
    recordMarkerSubmitted,
    snapshot
  };
}

function validAge(end, start) {
  const age = Number(end) - Number(start);
  return Number.isFinite(age) && age >= 0 && age <= 60000 ? age : null;
}

function average(values) {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function maximum(values) {
  return values.length > 0 ? Math.max(...values) : 0;
}

function percentile(values, quantile) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return sorted[index];
}
