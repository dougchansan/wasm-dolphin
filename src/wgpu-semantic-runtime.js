// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import { decodeLegacyWgpuCommandRecord } from "./wgpu-legacy-semantic-decoder.js";
import { createWgpuOwnershipCommandCorrelator } from
  "./wgpu-ownership-command-correlator.js";
import { createWgpuSemanticParitySink } from "./wgpu-semantic-parity-sink.js";

export const WGPU_SEMANTIC_RUNTIME_SCHEMA =
  "wasm-dolphin.wgpu-semantic-runtime.v1";

export function requestedWgpuSemanticRuntime(search = "") {
  return new URLSearchParams(search).get("wgpusemantic") === "1";
}

export function createWgpuSemanticRuntime({
  requested = false,
  active = false,
  initialConsumerResetAttestation = null,
  now,
} = {}) {
  const enabled = Boolean(active);
  const reasons = new Set();
  let failed = false;
  let preparedRecordCount = 0;
  let acceptedRecordCount = 0;
  let discardedPreparedRecordCount = 0;
  let retriedPreparedRecordCount = 0;
  let ownershipBatchCount = 0;
  let failureOwnershipRecords = Object.freeze([]);

  const sink = enabled ? createWgpuSemanticParitySink({ now }) : null;
  const correlator = enabled ? createWgpuOwnershipCommandCorrelator({
    semanticSink: sink,
    initialConsumerResetAttestation,
  }) : null;

  function pushOwnership(records, health = {}) {
    if (!enabled || failed) return 0;
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
    if (!enabled || failed) return null;
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
    if (!enabled || failed || !prepared) return 0;
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
    if (!enabled || !prepared) return;
    discardedPreparedRecordCount += 1;
    invalidate(reason);
  }

  function retryPrepared(prepared) {
    if (!enabled || !prepared) return;
    retriedPreparedRecordCount += 1;
  }

  function invalidate(reason) {
    if (!enabled) return;
    failed = true;
    reasons.add(String(reason || "semantic runtime invalidated"));
    try {
      sink.markMismatch();
    } catch {
      reasons.add("semantic mismatch marker failed");
    }
  }

  function snapshot({ detailed = false } = {}) {
    const checkpoint = correlator?.checkpoint({ compact: !detailed }) ?? null;
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

  return Object.freeze({
    pushOwnership,
    prepareLegacy,
    acceptPrepared,
    discardPrepared,
    retryPrepared,
    invalidate,
    snapshot,
  });
}
