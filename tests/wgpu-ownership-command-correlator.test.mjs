// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import {
  WGPU_COMMAND_PUBLICATION,
  WGPU_OWNERSHIP_EVENT,
  createWgpuOwnershipCommandCorrelator,
} from "../src/wgpu-ownership-command-correlator.js";
import { WGPU_SEMANTIC_DIGEST_SCHEMA } from "../src/wgpu-semantic-digest.js";
import { createWgpuSemanticDigest } from "../src/wgpu-semantic-digest.js";

test("pairs trace-ahead and legacy-ahead chunks in global ring order", () => {
  const traceAhead = fixture();
  traceAhead.correlator.pushOwnership([
    command({ serial: 1, opcode: 5, resourceId: 10 }),
    command({ serial: 2, opcode: 6, resourceId: 10, payloadLength: 3 }),
  ]);
  assert.equal(traceAhead.correlator.snapshot().pendingOwnershipRecords, 2);
  traceAhead.correlator.pushLegacy([legacy({ opcode: 5, resourceId: 10 })]);
  traceAhead.correlator.pushLegacy([
    legacy({ opcode: 6, resourceId: 10, payload: [1, 2, 3] }),
  ]);
  assert.deepEqual(traceAhead.events.map((event) => event.opcode), [5, 6]);
  assert.equal(traceAhead.correlator.checkpoint().valid, true);

  const legacyAhead = fixture();
  legacyAhead.correlator.pushLegacy([
    legacy({ opcode: 5, resourceId: 10 }),
    legacy({ opcode: 6, resourceId: 10, payload: [1, 2, 3] }),
  ]);
  legacyAhead.correlator.pushOwnership([
    command({ serial: 1, opcode: 5, resourceId: 10 }),
  ]);
  legacyAhead.correlator.pushOwnership([
    command({ serial: 2, opcode: 6, resourceId: 10, payloadLength: 3 }),
  ]);
  assert.deepEqual(legacyAhead.events.map((event) => event.opcode), [5, 6]);
  assert.equal(legacyAhead.correlator.checkpoint().valid, true);
});

test("reorders staged and immediate records by publication rather than trace order", () => {
  const { correlator, events } = fixture();
  correlator.pushOwnership([
    lifecycle(WGPU_OWNERSHIP_EVENT.PENDING_RESERVED, { transactionId: 7 }),
    lifecycle(WGPU_OWNERSHIP_EVENT.PASS_BEGIN, { transactionId: 7 }),
    command({
      serial: 1,
      opcode: 12,
      transactionId: 7,
      publication: WGPU_COMMAND_PUBLICATION.PRIVATE_STAGED,
    }),
    command({
      serial: 2,
      opcode: 5,
      resourceId: 44,
      transactionId: 7,
      publication: WGPU_COMMAND_PUBLICATION.IMMEDIATE_ACTIVE,
    }),
    command({
      serial: 3,
      opcode: 19,
      transactionId: 7,
      publication: WGPU_COMMAND_PUBLICATION.PRIVATE_STAGED,
    }),
    command({ serial: 4, opcode: 21, transactionId: 7, publication: 1 }),
    lifecycle(WGPU_OWNERSHIP_EVENT.COMMIT, {
      transactionId: 7,
      serial: 4,
      resourceId: 3,
    }),
  ]);
  correlator.pushLegacy([
    legacy({ opcode: 5, resourceId: 44 }),
    legacy({ opcode: 12 }),
    legacy({ opcode: 19 }),
    legacy({ opcode: 21 }),
  ]);
  assert.deepEqual(events.map((event) => event.opcode), [5, 12, 19, 21]);
  assert.deepEqual(events.map((event) => event.publication), [2, 1, 1, 1]);
  assert.equal(correlator.checkpoint().valid, false, "commit is not a close fence");

  correlator.pushOwnership([
    command({ serial: 5, opcode: 22, transactionId: 7 }),
  ]);
  correlator.pushLegacy([legacy({ opcode: 22 })]);
  assert.equal(correlator.checkpoint().valid, true);
});

test("projects one immutable package while retaining ineligible immediate commands", () => {
  const { correlator } = fixture();
  correlator.pushOwnership([
    lifecycle(WGPU_OWNERSHIP_EVENT.PASS_BEGIN, { transactionId: 7 }),
    command({
      serial: 1,
      opcode: 6,
      resourceId: 40,
      payloadLength: 4,
      transactionId: 7,
      publication: WGPU_COMMAND_PUBLICATION.IMMEDIATE_ACTIVE,
    }),
    command({
      serial: 2,
      opcode: 12,
      transactionId: 7,
      publication: WGPU_COMMAND_PUBLICATION.PRIVATE_STAGED,
    }),
    command({
      serial: 3,
      opcode: 21,
      transactionId: 7,
      publication: WGPU_COMMAND_PUBLICATION.PRIVATE_STAGED,
    }),
    lifecycle(WGPU_OWNERSHIP_EVENT.COMMIT, {
      transactionId: 7,
      serial: 3,
      resourceId: 2,
    }),
    command({ serial: 4, opcode: 22, transactionId: 7 }),
  ]);
  correlator.pushLegacy([
    legacy({ opcode: 6, resourceId: 40, payload: [1, 2, 3, 4] }),
    legacy({ opcode: 12 }),
    legacy({ opcode: 21 }),
    legacy({ opcode: 22 }),
  ]);

  assert.deepEqual(correlator.snapshot().packageOpportunity, {
    schema: "wasm-dolphin.wgpu-pass-package-opportunity.v1",
    currentEpochOnly: true,
    runtimeBehaviorChanged: false,
    eligible: true,
    reasons: [],
    legacyRecords: 4,
    projectedRecords: 2,
    recordReduction: 2,
    legacyPublications: 3,
    projectedPublications: 2,
    publicationReduction: 1,
    publicationReductionRatio: 1 / 3,
    committedTransactions: 1,
    abortedTransactions: 0,
    outsideImmediateCommands: 0,
    eligibleImmediateCommands: 1,
    privateStagedCommands: 2,
    ineligibleTransactionCommands: 1,
    eligiblePayloadBytes: 4,
    maximumPackageRecords: 3,
    maximumPackagePayloadBytes: 4,
    maximumPackageBytes: 100,
    requiresMultiplePayloadPages: false,
  });
});

test("accepts an active command after Commit and delays close until present", () => {
  const { correlator, events } = fixture();
  correlator.pushOwnership([
    lifecycle(WGPU_OWNERSHIP_EVENT.PASS_BEGIN, { transactionId: 2 }),
    command({
      serial: 10,
      opcode: 12,
      transactionId: 2,
      publication: WGPU_COMMAND_PUBLICATION.PRIVATE_STAGED,
    }),
    command({ serial: 11, opcode: 21, transactionId: 2, publication: 1 }),
    lifecycle(WGPU_OWNERSHIP_EVENT.COMMIT, {
      transactionId: 2,
      serial: 11,
      resourceId: 2,
    }),
    command({ serial: 12, opcode: 7, resourceId: 90, transactionId: 2 }),
  ]);
  correlator.pushLegacy([
    legacy({ opcode: 12 }),
    legacy({ opcode: 21 }),
    legacy({ opcode: 7, resourceId: 90 }),
  ]);
  assert.equal(correlator.snapshot().completedTransactions, 0);
  assert.equal(correlator.checkpoint().valid, false);

  correlator.pushOwnership([command({ serial: 13, opcode: 22, transactionId: 2 })]);
  correlator.pushLegacy([legacy({ opcode: 22 })]);
  assert.deepEqual(events.map((event) => event.opcode), [12, 21, 7, 22]);
  assert.equal(correlator.snapshot().completedTransactions, 1);
  assert.equal(correlator.checkpoint().valid, true);
});

test("a successor transaction is a delayed fence after prior records pair", () => {
  const { correlator } = fixture();
  correlator.pushOwnership([
    lifecycle(WGPU_OWNERSHIP_EVENT.PASS_BEGIN, { transactionId: 1 }),
    command({ serial: 1, opcode: 12, transactionId: 1, publication: 1 }),
    command({ serial: 2, opcode: 21, transactionId: 1, publication: 1 }),
    lifecycle(WGPU_OWNERSHIP_EVENT.COMMIT, {
      transactionId: 1,
      serial: 2,
      resourceId: 2,
    }),
    lifecycle(WGPU_OWNERSHIP_EVENT.PASS_BEGIN, { transactionId: 2, serial: 2 }),
  ]);
  assert.equal(correlator.snapshot().completedTransactions, 0);
  correlator.pushLegacy([legacy({ opcode: 12 }), legacy({ opcode: 21 })]);
  assert.equal(correlator.snapshot().completedTransactions, 1);
  assert.equal(correlator.snapshot().openTransactionCount, 1);
});

test("abort discards only private records and preserves immediate publications", () => {
  const { correlator, events } = fixture();
  correlator.pushOwnership([
    lifecycle(WGPU_OWNERSHIP_EVENT.PASS_BEGIN, { transactionId: 3 }),
    command({ serial: 1, opcode: 12, transactionId: 3, publication: 1 }),
    command({ serial: 2, opcode: 5, resourceId: 8, transactionId: 3, publication: 2 }),
    command({ serial: 3, opcode: 19, transactionId: 3, publication: 1 }),
    lifecycle(WGPU_OWNERSHIP_EVENT.ABORT, { transactionId: 3, serial: 3 }),
  ]);
  correlator.pushLegacy([legacy({ opcode: 5, resourceId: 8 })]);
  assert.deepEqual(events.map((event) => event.opcode), [5]);
  assert.equal(correlator.snapshot().discardedPrivateRecords, 2);
  assert.equal(correlator.snapshot().packageOpportunity.abortedTransactions, 1);
  assert.equal(correlator.snapshot().packageOpportunity.eligible, false);
  assert.match(
    correlator.snapshot().packageOpportunity.reasons.join(" "),
    /producer-state rollback proof/
  );
  assert.equal(correlator.checkpoint().valid, true);
});

test("LoadRequested invalidates unmatched lanes instead of manufacturing a clean generation", () => {
  const { correlator } = fixture();
  correlator.pushOwnership([command({ serial: 50, opcode: 5, resourceId: 4 })]);
  assert.equal(correlator.checkpoint().valid, false);
  correlator.pushOwnership([
    lifecycle(WGPU_OWNERSHIP_EVENT.LOAD_REQUESTED, { epoch: 2, serial: 50 }),
  ]);
  const checkpoint = correlator.checkpoint();
  assert.equal(checkpoint.valid, false);
  assert.equal(checkpoint.committedPrefixValid, false);
  assert.match(checkpoint.reasons.join(" "), /epoch boundary has unmatched/);
  assert.equal(checkpoint.generation, 1);
  assert.equal(checkpoint.epoch, 2);
});

test("a clean LoadRequested begins a new checkpoint generation", () => {
  const { correlator } = fixture();
  correlator.pushOwnership([command({ serial: 1, opcode: 5, resourceId: 4 })]);
  correlator.pushLegacy([legacy({ opcode: 5, resourceId: 4 })]);
  correlator.pushOwnership([
    lifecycle(WGPU_OWNERSHIP_EVENT.LOAD_REQUESTED, { epoch: 2, serial: 1 }),
  ]);
  assert.equal(correlator.checkpoint().valid, true);
  assert.equal(correlator.checkpoint().generation, 1);
  assert.equal(correlator.snapshot().packageOpportunity.legacyRecords, 0);
  assert.equal(correlator.snapshot().packageOpportunity.currentEpochOnly, true);
});

test("fails closed on signature mismatches, trace drops, and serial gaps", () => {
  const mismatch = fixture();
  mismatch.correlator.pushLegacy([legacy({ opcode: 5, resourceId: 4 })]);
  mismatch.correlator.pushOwnership([command({ serial: 1, opcode: 7, resourceId: 4 })]);
  assert.equal(mismatch.events.length, 0);
  assert.match(
    mismatch.correlator.snapshot().reasons[0],
    /mismatch at opcode 7, serial 1, legacy record 0: opcode 7 != 5/
  );

  const dropped = fixture();
  dropped.correlator.pushOwnership([], { nativeDropped: 1 });
  assert.equal(dropped.correlator.checkpoint().valid, false);
  assert.match(dropped.correlator.snapshot().reasons[0], /dropped/);

  const gap = fixture();
  gap.correlator.pushOwnership([
    command({ serial: 4, opcode: 5, resourceId: 1 }),
    command({ serial: 6, opcode: 5, resourceId: 2 }),
  ]);
  assert.equal(gap.correlator.snapshot().failed, true);
  assert.match(gap.correlator.snapshot().reasons[0], /serial gap/);
});

test("accepts exact u32 command-serial wrap", () => {
  const { correlator, events } = fixture();
  correlator.pushOwnership([
    command({ serial: 0xffff_ffff, opcode: 5, resourceId: 1 }),
    command({ serial: 0, opcode: 5, resourceId: 2 }),
  ]);
  correlator.pushLegacy([
    legacy({ opcode: 5, resourceId: 1 }),
    legacy({ opcode: 5, resourceId: 2 }),
  ]);
  assert.equal(events.length, 2);
  assert.equal(correlator.checkpoint().valid, true);
});

test("snapshots payload bytes and digest before producer memory can change", () => {
  const { correlator, events } = fixture();
  const payload = Uint8Array.of(1, 2, 3, 4);
  correlator.pushLegacy([legacy({ opcode: 6, resourceId: 2, payload })]);
  payload.fill(9);
  correlator.pushOwnership([
    command({ serial: 1, opcode: 6, resourceId: 2, payloadLength: 4 }),
  ]);
  assert.deepEqual(Array.from(events[0].payloadBytes), [1, 2, 3, 4]);
  assert.equal(
    events[0].payloadSha256,
    "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a"
  );
});

test("checkpoint rejects unmatched lanes, open transactions, and dirty sinks", () => {
  const pending = fixture();
  pending.correlator.pushLegacy([legacy({ opcode: 5, resourceId: 1 })]);
  assert.deepEqual(pending.correlator.checkpoint().reasons, ["unmatched legacy commands"]);

  const dirtySink = {
    appendEvent() {},
    snapshot() {
      return { openTransactionCount: 0, unresolvedCount: 1, mismatchCount: 0, overflow: false };
    },
  };
  const correlator = createWgpuOwnershipCommandCorrelator({ semanticSink: dirtySink });
  assert.deepEqual(correlator.checkpoint().reasons, ["semantic sink committed prefix is invalid"]);
});

test("capture end is a terminal producer acknowledgement with an exclusive ring cutoff", () => {
  const { correlator } = fixture();
  correlator.pushOwnership([
    command({ serial: 1, opcode: 5, resourceId: 7 }),
  ]);
  correlator.pushLegacy([{ ...legacy({ opcode: 5, resourceId: 7 }), recordIndex: 9 }]);
  correlator.pushOwnership([lifecycle(WGPU_OWNERSHIP_EVENT.CAPTURE_END, {
    serial: 1,
    opcode: 22,
    resourceId: 10,
    payloadLength: 1,
  })]);
  const checkpoint = correlator.checkpoint();
  assert.equal(checkpoint.valid, true);
  assert.equal(checkpoint.captureEndSeen, true);
  assert.equal(checkpoint.captureEndCommandRingWrite, 10);
  assert.equal(checkpoint.captureEndCommandSerial, 1);

  correlator.pushOwnership([command({ serial: 2, opcode: 5, resourceId: 8 })]);
  assert.equal(correlator.snapshot().failed, true);
  assert.match(correlator.snapshot().reasons.join(" "), /after capture end/);
});

test("drives the semantic sink lifecycle without making immediate records rollbackable", () => {
  const sink = createWgpuSemanticDigest({ now: () => 0 });
  const correlator = createWgpuOwnershipCommandCorrelator({ semanticSink: sink });
  openEpoch(correlator);
  correlator.pushOwnership([
    lifecycle(WGPU_OWNERSHIP_EVENT.PASS_BEGIN, { transactionId: 5 }),
    command({ serial: 1, opcode: 12, transactionId: 5, publication: 1 }),
    command({ serial: 2, opcode: 5, resourceId: 9, transactionId: 5, publication: 2 }),
    command({ serial: 3, opcode: 21, transactionId: 5, publication: 1 }),
    lifecycle(WGPU_OWNERSHIP_EVENT.COMMIT, {
      transactionId: 5,
      serial: 3,
      resourceId: 2,
    }),
  ]);
  correlator.pushLegacy([{ ...legacy({ opcode: 5, resourceId: 9 }), recordIndex: 0 }]);
  assert.equal(sink.snapshot().committedEventCount, 1);
  assert.equal(sink.snapshot().openTransactionCount, 0);
  correlator.pushLegacy([{ ...legacy({ opcode: 12 }), recordIndex: 1 }]);
  assert.equal(sink.snapshot().openTransactionCount, 1);
  correlator.pushLegacy([{ ...legacy({ opcode: 21 }), recordIndex: 2 }]);
  assert.equal(sink.snapshot().committedEventCount, 3);
  assert.equal(sink.snapshot().openTransactionCount, 0);
  correlator.pushOwnership([command({ serial: 4, opcode: 22, transactionId: 5 })]);
  correlator.pushLegacy([{ ...legacy({ opcode: 22 }), recordIndex: 3 }]);
  assert.equal(sink.snapshot().committedEventCount, 4);
  assert.equal(correlator.checkpoint().valid, true);
});

test("trace-ahead transactions never create overlapping semantic branches", () => {
  const sink = createWgpuSemanticDigest({ now: () => 0 });
  const correlator = createWgpuOwnershipCommandCorrelator({ semanticSink: sink });
  openEpoch(correlator);
  correlator.pushOwnership([
    lifecycle(WGPU_OWNERSHIP_EVENT.PASS_BEGIN, { transactionId: 1 }),
    command({ serial: 1, opcode: 12, transactionId: 1, publication: 1 }),
    command({ serial: 2, opcode: 21, transactionId: 1, publication: 1 }),
    lifecycle(WGPU_OWNERSHIP_EVENT.COMMIT, { transactionId: 1, serial: 2, resourceId: 2 }),
    lifecycle(WGPU_OWNERSHIP_EVENT.PASS_BEGIN, { transactionId: 2, serial: 2 }),
    command({ serial: 3, opcode: 12, transactionId: 2, publication: 1 }),
    command({ serial: 4, opcode: 21, transactionId: 2, publication: 1 }),
    lifecycle(WGPU_OWNERSHIP_EVENT.COMMIT, { transactionId: 2, serial: 4, resourceId: 2 }),
  ]);
  assert.equal(sink.snapshot().openTransactionCount, 0);
  correlator.pushLegacy([
    { ...legacy({ opcode: 12 }), recordIndex: 0 },
    { ...legacy({ opcode: 21 }), recordIndex: 1 },
    { ...legacy({ opcode: 12 }), recordIndex: 2 },
    { ...legacy({ opcode: 21 }), recordIndex: 3 },
  ]);
  assert.equal(correlator.snapshot().failed, false);
  assert.equal(sink.snapshot().openTransactionCount, 0);
  assert.equal(sink.snapshot().committedTransactionCount, 2);
});

test("commit validates native batch count and one BEGIN/END pair", () => {
  const wrongCount = fixture();
  wrongCount.correlator.pushOwnership([
    lifecycle(WGPU_OWNERSHIP_EVENT.PASS_BEGIN, { transactionId: 1 }),
    command({ serial: 1, opcode: 12, transactionId: 1, publication: 1 }),
    command({ serial: 2, opcode: 21, transactionId: 1, publication: 1 }),
    lifecycle(WGPU_OWNERSHIP_EVENT.COMMIT, { transactionId: 1, serial: 2, resourceId: 1 }),
  ]);
  assert.match(wrongCount.correlator.snapshot().reasons[0], /commit count/);

  const missingEnd = fixture();
  missingEnd.correlator.pushOwnership([
    lifecycle(WGPU_OWNERSHIP_EVENT.PASS_BEGIN, { transactionId: 1 }),
    command({ serial: 1, opcode: 12, transactionId: 1, publication: 1 }),
    command({ serial: 2, opcode: 19, transactionId: 1, publication: 1 }),
    lifecycle(WGPU_OWNERSHIP_EVENT.COMMIT, { transactionId: 1, serial: 2, resourceId: 2 }),
  ]);
  assert.match(missingEnd.correlator.snapshot().reasons[0], /exactly one BEGIN and END/);
});

test("only actively attributed SubmitPresent closes a transaction", () => {
  const { correlator } = fixture();
  correlator.pushOwnership([
    lifecycle(WGPU_OWNERSHIP_EVENT.PASS_BEGIN, { transactionId: 1 }),
    command({ serial: 1, opcode: 12, transactionId: 1, publication: 1 }),
    command({ serial: 2, opcode: 21, transactionId: 1, publication: 1 }),
    lifecycle(WGPU_OWNERSHIP_EVENT.COMMIT, { transactionId: 1, serial: 2, resourceId: 2 }),
    command({ serial: 3, opcode: 22, transactionId: 1, attribution: 1 }),
  ]);
  correlator.pushLegacy([
    legacy({ opcode: 12 }),
    legacy({ opcode: 21 }),
    legacy({ opcode: 22 }),
  ]);
  assert.equal(correlator.snapshot().completedTransactions, 0);
  assert.equal(correlator.checkpoint().committedPrefixValid, true);
  assert.equal(correlator.checkpoint().fullyQuiescent, false);
});

test("bounds pending records and validates modulo-u32 legacy indices", () => {
  const bounded = createWgpuOwnershipCommandCorrelator({
    maxPendingRecords: 2,
    semanticSink: { appendEvent() {} },
  });
  openEpoch(bounded);
  bounded.pushOwnership([
    command({ serial: 1, opcode: 5, resourceId: 1 }),
    command({ serial: 2, opcode: 5, resourceId: 2 }),
    command({ serial: 3, opcode: 5, resourceId: 3 }),
  ]);
  assert.match(bounded.snapshot().reasons[0], /pending-record limit/);

  const gap = createWgpuOwnershipCommandCorrelator({ semanticSink: { appendEvent() {} } });
  gap.pushLegacy([
    { ...legacy({ opcode: 5, resourceId: 1 }), recordIndex: 10 },
    { ...legacy({ opcode: 5, resourceId: 2 }), recordIndex: 12 },
  ]);
  assert.match(gap.snapshot().reasons[0], /legacy record index gap/);

  const wrap = createWgpuOwnershipCommandCorrelator({ semanticSink: { appendEvent() {} } });
  wrap.pushLegacy([
    { ...legacy({ opcode: 5, resourceId: 1 }), recordIndex: 0xffff_ffff },
    { ...legacy({ opcode: 5, resourceId: 2 }), recordIndex: 0 },
  ]);
  assert.equal(wrap.snapshot().failed, false);
});

test("rejects duplicate lifecycle, late commands, and non-active staged attribution", () => {
  const duplicate = fixture();
  duplicate.correlator.pushOwnership([
    lifecycle(WGPU_OWNERSHIP_EVENT.PASS_BEGIN, { transactionId: 6 }),
    lifecycle(WGPU_OWNERSHIP_EVENT.PASS_BEGIN, { transactionId: 6 }),
  ]);
  assert.match(duplicate.correlator.snapshot().reasons[0], /duplicate or late pass begin/);

  const badStaged = fixture();
  badStaged.correlator.pushOwnership([
    lifecycle(WGPU_OWNERSHIP_EVENT.PASS_BEGIN, { transactionId: 7 }),
    command({
      serial: 1,
      opcode: 12,
      transactionId: 7,
      publication: WGPU_COMMAND_PUBLICATION.PRIVATE_STAGED,
      attribution: 1,
    }),
  ]);
  assert.match(badStaged.correlator.snapshot().reasons[0], /not actively attributed/);

  const late = fixture();
  late.correlator.pushOwnership([
    lifecycle(WGPU_OWNERSHIP_EVENT.PASS_BEGIN, { transactionId: 8 }),
    command({ serial: 1, opcode: 12, transactionId: 8, publication: 1 }),
    command({ serial: 2, opcode: 21, transactionId: 8, publication: 1 }),
    lifecycle(WGPU_OWNERSHIP_EVENT.COMMIT, {
      transactionId: 8,
      serial: 2,
      resourceId: 2,
    }),
    command({ serial: 3, opcode: 22, transactionId: 8 }),
  ]);
  late.correlator.pushLegacy([
    { ...legacy({ opcode: 12 }), recordIndex: 0 },
    { ...legacy({ opcode: 21 }), recordIndex: 1 },
    { ...legacy({ opcode: 22 }), recordIndex: 2 },
  ]);
  late.correlator.pushOwnership([
    command({ serial: 4, opcode: 5, resourceId: 1, transactionId: 8 }),
  ]);
  assert.match(late.correlator.snapshot().reasons[0], /transaction 8 is already retired/);
});

test("load-boundary abort closes a committed transaction before the new epoch", () => {
  const { correlator } = fixture();
  correlator.pushOwnership([
    lifecycle(WGPU_OWNERSHIP_EVENT.PASS_BEGIN, { transactionId: 1 }),
    command({ serial: 1, opcode: 12, transactionId: 1, publication: 1 }),
    command({ serial: 2, opcode: 21, transactionId: 1, publication: 1 }),
    lifecycle(WGPU_OWNERSHIP_EVENT.COMMIT, {
      transactionId: 1,
      serial: 2,
      resourceId: 2,
    }),
  ]);
  correlator.pushLegacy([legacy({ opcode: 12 }), legacy({ opcode: 21 })]);
  assert.equal(correlator.checkpoint().fullyQuiescent, false);
  correlator.pushOwnership([
    lifecycle(WGPU_OWNERSHIP_EVENT.ABORT, {
      transactionId: 1,
      serial: 2,
      payloadLength: 3,
    }),
    lifecycle(WGPU_OWNERSHIP_EVENT.LOAD_REQUESTED, { epoch: 2, serial: 2 }),
  ]);
  assert.equal(correlator.checkpoint().valid, true);
  assert.equal(correlator.snapshot().retiredTransactionHighWater, 1);
});

test("malformed inputs and sink epoch failures can never leave a clean checkpoint", () => {
  const malformedTrace = fixture();
  malformedTrace.correlator.pushOwnership([{ event: "bad" }]);
  assert.equal(malformedTrace.correlator.checkpoint().valid, false);
  assert.match(malformedTrace.correlator.snapshot().reasons[0], /invalid ownership record/);

  const malformedLegacy = fixture();
  malformedLegacy.correlator.pushLegacy([{ ...legacy({ opcode: 5 }), payloadBytes: "bad" }]);
  assert.equal(malformedLegacy.correlator.checkpoint().valid, false);
  assert.match(malformedLegacy.correlator.snapshot().reasons[0], /invalid legacy record/);

  const throwingSink = cleanSink();
  throwingSink.beginEpoch = () => { throw new Error("epoch boom"); };
  const failedEpoch = createWgpuOwnershipCommandCorrelator({ semanticSink: throwingSink });
  openEpoch(failedEpoch);
  assert.equal(failedEpoch.checkpoint().valid, false);
  assert.match(failedEpoch.snapshot().reasons.join(" "), /epoch begin failed/);
});

test("completed transactions retire and lifecycle-only state is bounded", () => {
  const sink = cleanSink();
  const correlator = createWgpuOwnershipCommandCorrelator({
    semanticSink: sink,
    maxPendingRecords: 8,
  });
  openEpoch(correlator);
  let serial = 0;
  let recordIndex = 0;
  for (let transactionId = 1; transactionId <= 50; transactionId += 1) {
    correlator.pushOwnership([
      lifecycle(WGPU_OWNERSHIP_EVENT.PASS_BEGIN, { transactionId, serial }),
      command({ serial: ++serial, opcode: 12, transactionId, publication: 1 }),
      command({ serial: ++serial, opcode: 21, transactionId, publication: 1 }),
      lifecycle(WGPU_OWNERSHIP_EVENT.COMMIT, {
        transactionId,
        serial,
        resourceId: 2,
      }),
      command({ serial: ++serial, opcode: 22, transactionId }),
    ]);
    correlator.pushLegacy([
      { ...legacy({ opcode: 12 }), recordIndex: recordIndex++ },
      { ...legacy({ opcode: 21 }), recordIndex: recordIndex++ },
      { ...legacy({ opcode: 22 }), recordIndex: recordIndex++ },
    ]);
    assert.equal(correlator.snapshot().trackedTransactionCount, 0);
  }
  assert.equal(correlator.snapshot().failed, false);
  assert.equal(correlator.snapshot().retiredTransactionHighWater, 50);

  const bounded = createWgpuOwnershipCommandCorrelator({
    semanticSink: cleanSink(),
    maxPendingRecords: 2,
  });
  openEpoch(bounded);
  bounded.pushOwnership([
    lifecycle(WGPU_OWNERSHIP_EVENT.PASS_BEGIN, { transactionId: 1 }),
    lifecycle(WGPU_OWNERSHIP_EVENT.PASS_BEGIN, { transactionId: 2 }),
    lifecycle(WGPU_OWNERSHIP_EVENT.PASS_BEGIN, { transactionId: 3 }),
  ]);
  assert.match(bounded.snapshot().reasons.join(" "), /pending-record limit/);
});

test("commit ordering, epoch schema, and inspectable sink evidence fail closed", () => {
  const wrongOrder = fixture();
  wrongOrder.correlator.pushOwnership([
    lifecycle(WGPU_OWNERSHIP_EVENT.PASS_BEGIN, { transactionId: 1 }),
    command({ serial: 1, opcode: 21, transactionId: 1, publication: 1 }),
    command({ serial: 2, opcode: 12, transactionId: 1, publication: 1 }),
    lifecycle(WGPU_OWNERSHIP_EVENT.COMMIT, {
      transactionId: 1,
      serial: 2,
      resourceId: 2,
    }),
  ]);
  assert.match(wrongOrder.correlator.snapshot().reasons.join(" "), /contiguous/);

  const duplicateEpoch = fixture();
  duplicateEpoch.correlator.pushOwnership([
    lifecycle(WGPU_OWNERSHIP_EVENT.EPOCH, { epoch: 1, resourceId: 1 }),
  ]);
  assert.match(duplicateEpoch.correlator.snapshot().reasons.join(" "), /duplicate ownership epoch/);

  const badVersion = createWgpuOwnershipCommandCorrelator({ semanticSink: cleanSink() });
  badVersion.pushOwnership([
    lifecycle(WGPU_OWNERSHIP_EVENT.EPOCH, { epoch: 1, resourceId: 2 }),
  ]);
  assert.match(badVersion.snapshot().reasons.join(" "), /ABI version 1/);

  const opaque = createWgpuOwnershipCommandCorrelator({ semanticSink: { appendEvent() {} } });
  openEpoch(opaque);
  assert.equal(opaque.checkpoint().valid, false);
  assert.match(opaque.checkpoint().reasons.join(" "), /snapshot is unavailable/);

  const malformedSnapshot = createWgpuOwnershipCommandCorrelator({
    semanticSink: { appendEvent() {}, snapshot() { return {}; } },
  });
  openEpoch(malformedSnapshot);
  assert.equal(malformedSnapshot.checkpoint().valid, false);
  assert.match(malformedSnapshot.checkpoint().reasons.join(" "), /committed prefix is invalid/);
});

function fixture() {
  const events = [];
  const sink = cleanSink((event) => events.push(event));
  const raw = createWgpuOwnershipCommandCorrelator({
    semanticSink: sink,
  });
  raw.pushOwnership([lifecycle(WGPU_OWNERSHIP_EVENT.EPOCH, {
    epoch: 1,
    resourceId: 1,
  })]);
  let recordIndex = 0;
  return {
    events,
    correlator: {
      ...raw,
      pushLegacy(commands) {
        return raw.pushLegacy(commands.map((entry) => ({
          ...entry,
          recordIndex: entry.recordIndex ?? recordIndex++,
        })));
      },
    },
  };
}

function cleanSink(onEvent = () => {}) {
  return {
    appendEvent: onEvent,
    beginEpoch() {},
    beginTransaction() {},
    commitTransaction() {},
    abortTransaction() {},
    markMismatch() {},
    snapshot() {
      return {
        schema: WGPU_SEMANTIC_DIGEST_SCHEMA,
        openTransactionCount: 0,
        unresolvedCount: 0,
        mismatchCount: 0,
        overflow: false,
        globalDigest: "0".repeat(64),
        epochDigest: "0".repeat(64),
      };
    },
  };
}

function openEpoch(correlator, epoch = 1) {
  correlator.pushOwnership([lifecycle(WGPU_OWNERSHIP_EVENT.EPOCH, {
    epoch,
    resourceId: 1,
  })]);
}

function command({
  epoch = 1,
  transactionId = 0,
  serial,
  opcode,
  resourceId = 0,
  payloadLength = 0,
  publication = WGPU_COMMAND_PUBLICATION.IMMEDIATE,
  attribution = transactionId === 0 ? 0 : 2,
}) {
  return {
    event: WGPU_OWNERSHIP_EVENT.COMMAND,
    epoch,
    transactionId,
    commandSerial: serial,
    opcode,
    resourceId,
    payloadLength,
    auxiliary: attribution | (publication << 8),
  };
}

function lifecycle(event, {
  epoch = 1,
  transactionId = 0,
  serial = 0,
  opcode = 0,
  resourceId = 0,
  payloadLength = 0,
} = {}) {
  return {
    event,
    epoch,
    transactionId,
    commandSerial: serial,
    opcode,
    resourceId,
    payloadLength,
    auxiliary: transactionId === 0 ? 0 : 2,
  };
}

function legacy({ opcode, resourceId = 0, payload = [] }) {
  return {
    kind: 1,
    opcode,
    resourceClass: 0,
    resourceId,
    generation: 0,
    args: [],
    payloadBytes: payload instanceof Uint8Array ? payload : Uint8Array.from(payload),
  };
}
