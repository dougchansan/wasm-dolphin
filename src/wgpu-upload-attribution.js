// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

export const WGPU_UPLOAD_ROLE_NAMES = Object.freeze([
  "unknown",
  "ubo",
  "utility-uniform",
  "vertex",
  "index",
  "texture-adjacent",
  "geometry",
]);

export const WGPU_UPLOAD_ROLE = Object.freeze({
  UNKNOWN: 0,
  UBO: 1,
  UTILITY_UNIFORM: 2,
  VERTEX: 3,
  INDEX: 4,
  TEXTURE_ADJACENT: 5,
  GEOMETRY: 6,
});

export const WGPU_UPLOAD_SIZE_BUCKET_LABELS = Object.freeze([
  "<=64",
  "<=256",
  "<=1024",
  "<=4096",
  "<=16384",
  "<=65536",
  ">65536",
]);

const SIZE_BUCKET_UPPER_BOUNDS = Object.freeze([
  64,
  256,
  1024,
  4096,
  16384,
  65536,
  null,
]);

const ROLE_COUNT = WGPU_UPLOAD_ROLE_NAMES.length;
const BUCKET_COUNT = WGPU_UPLOAD_SIZE_BUCKET_LABELS.length;

// Uploads are commonly published before BEGIN_PASS. A window therefore starts
// immediately after the previous END/abort/incomplete boundary. Pre-BEGIN
// uploads remain in that window and are finalized by the following END_PASS.
export function createWgpuUploadAttribution() {
  const callsByRole = new Float64Array(ROLE_COUNT);
  const bytesByRole = new Float64Array(ROLE_COUNT);
  const maxBytesByRole = new Float64Array(ROLE_COUNT);
  const bucketCallsByRole = new Float64Array(ROLE_COUNT * BUCKET_COUNT);
  const bucketBytesByRole = new Float64Array(ROLE_COUNT * BUCKET_COUNT);

  const windowMinDestinationByRole = new Float64Array(ROLE_COUNT);
  const windowMaxDestinationEndByRole = new Float64Array(ROLE_COUNT);
  const maxDestinationSpanBytesByRole = new Float64Array(ROLE_COUNT);

  let totalCalls = 0;
  let totalBytes = 0;
  let maxBytes = 0;
  let passOpen = false;
  let windowCalls = 0;
  let windowBytes = 0;
  let completedPassCount = 0;
  let abortedPassCount = 0;
  let incompletePassCount = 0;
  let maxPassCalls = 0;
  let maxPassBytes = 0;
  let maxDestinationSpanBytes = 0;

  resetWindow();

  function recordUpload(role, bytes, destinationOffset = 0) {
    const roleIndex = validRole(role) ? role : WGPU_UPLOAD_ROLE.UNKNOWN;
    const byteCount = finiteNonnegative(bytes);
    const offset = finiteNonnegative(destinationOffset);
    const bucketIndex = sizeBucket(byteCount);
    const bucketSlot = roleIndex * BUCKET_COUNT + bucketIndex;

    totalCalls += 1;
    totalBytes += byteCount;
    maxBytes = Math.max(maxBytes, byteCount);
    callsByRole[roleIndex] += 1;
    bytesByRole[roleIndex] += byteCount;
    maxBytesByRole[roleIndex] = Math.max(maxBytesByRole[roleIndex], byteCount);
    bucketCallsByRole[bucketSlot] += 1;
    bucketBytesByRole[bucketSlot] += byteCount;

    windowCalls += 1;
    windowBytes += byteCount;
    windowMinDestinationByRole[roleIndex] = Math.min(
      windowMinDestinationByRole[roleIndex],
      offset
    );
    windowMaxDestinationEndByRole[roleIndex] = Math.max(
      windowMaxDestinationEndByRole[roleIndex],
      offset + byteCount
    );
    return roleIndex;
  }

  function recordPassBegin() {
    if (passOpen) {
      incompletePassCount += 1;
      resetWindow();
    }
    passOpen = true;
  }

  function recordPassEnd() {
    if (!passOpen) {
      incompletePassCount += 1;
      resetWindow();
      return false;
    }
    completedPassCount += 1;
    maxPassCalls = Math.max(maxPassCalls, windowCalls);
    maxPassBytes = Math.max(maxPassBytes, windowBytes);
    for (let role = 0; role < ROLE_COUNT; role += 1) {
      const minimum = windowMinDestinationByRole[role];
      if (minimum === Number.POSITIVE_INFINITY) continue;
      const span = Math.max(0, windowMaxDestinationEndByRole[role] - minimum);
      maxDestinationSpanBytesByRole[role] = Math.max(
        maxDestinationSpanBytesByRole[role],
        span
      );
      maxDestinationSpanBytes = Math.max(maxDestinationSpanBytes, span);
    }
    resetWindow();
    return true;
  }

  function recordPassAbort() {
    if (!passOpen && windowCalls === 0) return false;
    abortedPassCount += 1;
    resetWindow();
    return true;
  }

  function recordIncompletePass() {
    if (!passOpen && windowCalls === 0) return false;
    incompletePassCount += 1;
    resetWindow();
    return true;
  }

  function reset() {
    callsByRole.fill(0);
    bytesByRole.fill(0);
    maxBytesByRole.fill(0);
    bucketCallsByRole.fill(0);
    bucketBytesByRole.fill(0);
    maxDestinationSpanBytesByRole.fill(0);
    totalCalls = 0;
    totalBytes = 0;
    maxBytes = 0;
    completedPassCount = 0;
    abortedPassCount = 0;
    incompletePassCount = 0;
    maxPassCalls = 0;
    maxPassBytes = 0;
    maxDestinationSpanBytes = 0;
    resetWindow();
  }

  function snapshot({ enabled = true } = {}) {
    return {
      schema: "wasm-dolphin.wgpu-upload-attribution.v2",
      enabled: Boolean(enabled),
      roleOrder: [...WGPU_UPLOAD_ROLE_NAMES],
      sizeBucketLabels: [...WGPU_UPLOAD_SIZE_BUCKET_LABELS],
      sizeBucketUpperBounds: [...SIZE_BUCKET_UPPER_BOUNDS],
      totalCalls,
      totalBytes,
      maxBytes,
      callsByRole: Array.from(callsByRole),
      bytesByRole: Array.from(bytesByRole),
      maxBytesByRole: Array.from(maxBytesByRole),
      bucketCallsByRole: snapshotBuckets(bucketCallsByRole),
      bucketBytesByRole: snapshotBuckets(bucketBytesByRole),
      passAssociation: {
        definition: "uploads-after-previous-boundary-through-following-end-pass",
        preBeginUploadsFoldIntoFollowingPass: true,
        completedPassCount,
        abortedPassCount,
        incompletePassCount,
        currentPassOpen: passOpen,
        currentWindowCalls: windowCalls,
        currentWindowBytes: windowBytes,
        maxCalls: maxPassCalls,
        maxBytes: maxPassBytes,
        maxDestinationSpanBytes,
        maxDestinationSpanBytesByRole: Array.from(maxDestinationSpanBytesByRole),
      },
    };
  }

  function resetWindow() {
    passOpen = false;
    windowCalls = 0;
    windowBytes = 0;
    windowMinDestinationByRole.fill(Number.POSITIVE_INFINITY);
    windowMaxDestinationEndByRole.fill(0);
  }

  return {
    recordUpload,
    recordPassBegin,
    recordPassEnd,
    recordPassAbort,
    recordIncompletePass,
    reset,
    snapshot,
  };
}

function validRole(role) {
  return Number.isInteger(role) && role >= 0 && role < ROLE_COUNT;
}

function finiteNonnegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function sizeBucket(bytes) {
  if (bytes <= 64) return 0;
  if (bytes <= 256) return 1;
  if (bytes <= 1024) return 2;
  if (bytes <= 4096) return 3;
  if (bytes <= 16384) return 4;
  if (bytes <= 65536) return 5;
  return 6;
}

function snapshotBuckets(values) {
  const result = new Array(ROLE_COUNT);
  for (let role = 0; role < ROLE_COUNT; role += 1) {
    const start = role * BUCKET_COUNT;
    result[role] = Array.from(values.subarray(start, start + BUCKET_COUNT));
  }
  return result;
}
