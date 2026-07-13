// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import { decodeLegacyWgpuCommandRecord } from "./wgpu-legacy-semantic-decoder.js";
import { createWgpuOwnershipCommandCorrelator } from
  "./wgpu-ownership-command-correlator.js";
import { createWgpuSemanticParitySink } from "./wgpu-semantic-parity-sink.js";

export const WGPU_SEMANTIC_RUNTIME_SCHEMA =
  "wasm-dolphin.wgpu-semantic-runtime.v1";
export const DEFAULT_WGPU_SEMANTIC_MIN_COMMITTED_EVENTS = 128;

export function requestedWgpuSemanticRuntime(search = "") {
  return new URLSearchParams(search).get("wgpusemantic") === "1";
}

export function createWgpuSemanticRuntime({
  requested = false,
  active = false,
  initialConsumerResetAttestation = null,
  minimumCommittedEventCount = DEFAULT_WGPU_SEMANTIC_MIN_COMMITTED_EVENTS,
  now,
} = {}) {
  const enabled = Boolean(active);
  const minimumCommitted = positiveSafeInteger(
    minimumCommittedEventCount,
    "minimumCommittedEventCount"
  );
  const reasons = new Set();
  let failed = false;
  let preparedRecordCount = 0;
  let acceptedRecordCount = 0;
  let discardedPreparedRecordCount = 0;
  let retriedPreparedRecordCount = 0;
  let ownershipBatchCount = 0;
  let failureOwnershipRecords = Object.freeze([]);
  let capturePhase = enabled ? "capturing" : "off";
  let captureStopRequested = false;
  let nativeStopRequestSent = false;
  let frozenCompactSnapshot = null;
  let frozenDetailedSnapshot = null;

  const sink = enabled ? createWgpuSemanticParitySink({ now }) : null;
  const correlator = enabled ? createWgpuOwnershipCommandCorrelator({
    semanticSink: sink,
    initialConsumerResetAttestation,
  }) : null;

  function pushOwnership(records, health = {}) {
    if (!captureOpen()) return 0;
    ownershipBatchCount += 1;
    try {
      const paired = correlator.pushOwnership(records, health);
      const correlatorState = correlator.snapshot();
      if (correlatorState.failed && failureOwnershipRecords.length === 0) {
        failureOwnershipRecords = Object.freeze(
          records.slice(-64).map((record) => Object.freeze({ ...record }))
        );
      }
      absorbCorrelatorFailure(correlatorState);
      return paired;
    } catch (error) {
      invalidate(`ownership ingestion failed: ${error?.message || error}`);
      return 0;
    }
  }

  function prepareLegacy(record, heapBytes = null, options = {}) {
    if (!captureOpen()) return null;
    try {
      const decoded = decodeLegacyWgpuCommandRecord(record, heapBytes, options);
      preparedRecordCount += 1;
      return Object.freeze({
        ...decoded,
        args: Object.freeze([...decoded.args]),
        payloadBytes: Uint8Array.from(decoded.payloadBytes),
      });
    } catch (error) {
      invalidate(`legacy preparation failed: ${error?.message || error}`);
      return null;
    }
  }

  function acceptPrepared(prepared, recordIndex) {
    if (!captureOpen() || !prepared) return 0;
    try {
      const paired = correlator.pushLegacy([{ ...prepared, recordIndex }]);
      acceptedRecordCount += 1;
      absorbCorrelatorFailure();
      return paired;
    } catch (error) {
      invalidate(`legacy acceptance failed: ${error?.message || error}`);
      return 0;
    }
  }

  function discardPrepared(prepared, reason = "consumer discarded an accepted ring record") {
    if (!captureOpen() || !prepared) return;
    discardedPreparedRecordCount += 1;
    invalidate(reason);
  }

  function retryPrepared(prepared) {
    if (!captureOpen() || !prepared) return;
    retriedPreparedRecordCount += 1;
  }

  function invalidate(reason) {
    if (!enabled || capturePhase === "frozen") return;
    failed = true;
    capturePhase = "failed";
    reasons.add(String(reason || "semantic runtime invalidated"));
    try {
      sink.markMismatch();
    } catch {
      reasons.add("semantic mismatch marker failed");
    }
  }

  function maybeRequestCaptureEnd({ commandRingRead, commandRingWrite, ownershipHealth } = {}) {
    if (!captureOpen() || captureStopRequested) return false;
    const read = u32(commandRingRead, "commandRingRead");
    const write = u32(commandRingWrite, "commandRingWrite");
    if (read !== write || !healthyDrainedTrace(ownershipHealth)) return false;
    const state = buildSnapshot({ detailed: false });
    if (!state.evidenceValid || state.parity.committedEventCount < minimumCommitted) {
      return false;
    }
    captureStopRequested = true;
    capturePhase = "stop-requested";
    return true;
  }

  function markNativeStopRequestSent() {
    if (!captureStopRequested || nativeStopRequestSent || !captureOpen()) return false;
    nativeStopRequestSent = true;
    return true;
  }

  function maybeFreezeCapture({ commandRingRead, commandRingWrite, ownershipHealth } = {}) {
    if (!captureOpen() || !nativeStopRequestSent) return null;
    const read = u32(commandRingRead, "commandRingRead");
    const write = u32(commandRingWrite, "commandRingWrite");
    if (read !== write || !healthyDrainedTrace(ownershipHealth)) return null;
    const checkpoint = correlator.checkpoint({ compact: false });
    if (!checkpoint.captureEndSeen || write !== checkpoint.captureEndCommandRingWrite) {
      return null;
    }
    const detailedState = buildSnapshot({ detailed: true, checkpoint });
    if (!detailedState.evidenceValid ||
        detailedState.parity.committedEventCount < minimumCommitted) {
      return null;
    }
    capturePhase = "frozen";
    frozenDetailedSnapshot = Object.freeze({
      ...detailedState,
      capturePhase,
      captureComplete: true,
    });
    frozenCompactSnapshot = frozenDetailedSnapshot;
    return Object.freeze({
      captureId: checkpoint.captureId,
      commandRingWrite: checkpoint.captureEndCommandRingWrite,
      commandSerial: checkpoint.captureEndCommandSerial,
    });
  }

  function captureControl() {
    const state = correlator?.snapshot() ?? null;
    return Object.freeze({
      open: captureOpen(),
      phase: capturePhase,
      stopRequested: captureStopRequested,
      nativeStopRequestPending:
        captureStopRequested && !nativeStopRequestSent && captureOpen(),
      nativeStopRequestSent,
      captureEndSeen: Boolean(state?.captureEndSeen),
      captureId: state?.captureId ?? 0,
      captureComplete: capturePhase === "frozen",
    });
  }

  function snapshot({ detailed = false } = {}) {
    if (capturePhase === "frozen") {
      return detailed ? frozenDetailedSnapshot : frozenCompactSnapshot;
    }
    return buildSnapshot({ detailed });
  }

  function buildSnapshot({ detailed = false, checkpoint = null } = {}) {
    checkpoint ??= correlator?.checkpoint({ compact: !detailed }) ?? null;
    const correlatorState = correlator?.snapshot() ?? null;
    // checkpoint already obtained the sink state. Reusing it avoids a second
    // registry snapshot in the 5 Hz causal-telemetry path.
    const sinkState = checkpoint?.sink ?? null;
    const evidenceValid = Boolean(
      enabled &&
      !failed &&
      checkpoint?.valid &&
      checkpoint?.initialConsumerResetAttested &&
      discardedPreparedRecordCount === 0 &&
      sinkState?.dependencyEncodingReady &&
      sinkState?.independentDecodingReady
    );
    return Object.freeze({
      schema: WGPU_SEMANTIC_RUNTIME_SCHEMA,
      requested: Boolean(requested),
      active: enabled,
      failed: failed || Boolean(correlatorState?.failed) || Boolean(sinkState?.failed),
      reasons: Object.freeze([...reasons]),
      workerIntegrationActive: enabled,
      detailed: Boolean(detailed),
      evidenceValid,
      captureScope: "bounded-prefix",
      capturePhase,
      captureComplete: false,
      captureStopRequested,
      nativeStopRequestSent,
      minimumCommittedEventCount: minimumCommitted,
      captureEndSeen: Boolean(checkpoint?.captureEndSeen),
      captureEndCommandRingWrite: checkpoint?.captureEndCommandRingWrite ?? 0,
      captureEndCommandSerial: checkpoint?.captureEndCommandSerial ?? 0,
      captureId: checkpoint?.captureId ?? 0,
      preparedRecordCount,
      acceptedRecordCount,
      discardedPreparedRecordCount,
      retriedPreparedRecordCount,
      ownershipBatchCount,
      failureOwnershipRecords,
      checkpoint,
      correlator: correlatorState,
      parity: sinkState,
    });
  }

  function absorbCorrelatorFailure(state = correlator.snapshot()) {
    if (!state.failed) return;
    failed = true;
    for (const reason of state.reasons) reasons.add(reason);
  }

  function captureOpen() {
    return enabled && !failed && capturePhase !== "frozen";
  }

  return Object.freeze({
    pushOwnership,
    prepareLegacy,
    acceptPrepared,
    discardPrepared,
    retryPrepared,
    invalidate,
    maybeRequestCaptureEnd,
    markNativeStopRequestSent,
    maybeFreezeCapture,
    captureControl,
    snapshot,
  });
}

function healthyDrainedTrace(value) {
  return Boolean(
    value?.registered === true &&
    Number(value.backlog) === 0 &&
    Number(value.nativeDropped) === 0 &&
    Number(value.recordEpochMismatchCount) === 0 &&
    Number(value.monotonicOrderingViolationCount) === 0 &&
    Number(value.malformedHeaderCount) === 0 &&
    Number(value.malformedDescriptorCount) === 0
  );
}

function positiveSafeInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return number;
}

function u32(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 0xffff_ffff) {
    throw new RangeError(`${name} must be a u32`);
  }
  return number >>> 0;
}
