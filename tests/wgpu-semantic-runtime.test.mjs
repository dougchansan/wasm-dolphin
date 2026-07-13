// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { captureInitialWgpuConsumerResetAttestation } from
  "../src/wgpu-consumer-reset-attestation.js";
import { WGPU_OWNERSHIP_EVENT } from "../src/wgpu-ownership-trace.js";
import {
  createWgpuSemanticRuntime,
  requestedWgpuSemanticRuntime,
} from "../src/wgpu-semantic-runtime.js";

test("semantic runtime is default-off and URL opt-in is exact", () => {
  assert.equal(requestedWgpuSemanticRuntime(""), false);
  assert.equal(requestedWgpuSemanticRuntime("?wgpusemantic=1"), true);
  assert.equal(requestedWgpuSemanticRuntime("?wgpusemantic=true"), false);
  const state = createWgpuSemanticRuntime().snapshot();
  assert.equal(state.active, false);
  assert.equal(state.workerIntegrationActive, false);
  assert.equal(state.evidenceValid, false);
});

test("attested startup ownership and accepted legacy records form valid evidence", () => {
  const runtime = activeRuntime();
  runtime.pushOwnership([ownership(WGPU_OWNERSHIP_EVENT.EPOCH, {
    epoch: 1,
    resourceId: 1,
  })], healthy());
  runtime.pushOwnership([ownership(WGPU_OWNERSHIP_EVENT.COMMAND, {
    epoch: 1,
    commandSerial: 1,
    opcode: 5,
    resourceId: 7,
  })], healthy());
  const prepared = runtime.prepareLegacy(Uint32Array.of(5, 7, 64, 1, 0, 0, 0, 0));
  runtime.acceptPrepared(prepared, 0);
  const state = runtime.snapshot();
  assert.equal(state.failed, false);
  assert.equal(state.evidenceValid, true);
  assert.equal(state.acceptedRecordCount, 1);
  assert.equal(state.parity.independentDecodedEventCount, 1);
  assert.equal(state.parity.resourceTracker.resourcesIncluded, false);
  assert.deepEqual(state.parity.resourceTracker.resources, []);

  const detailed = runtime.snapshot({ detailed: true });
  assert.equal(detailed.parity.resourceTracker.resourcesIncluded, true);
  assert.equal(detailed.parity.resourceTracker.resources.length, 1);
});

test("odd retained uploads exclude queue alignment padding before transport reuse", () => {
  const runtime = activeRuntime();
  runtime.pushOwnership([ownership(WGPU_OWNERSHIP_EVENT.EPOCH, {
    epoch: 1,
    resourceId: 1,
  })], healthy());
  runtime.pushOwnership([
    ownership(WGPU_OWNERSHIP_EVENT.COMMAND, {
      epoch: 1,
      commandSerial: 1,
      opcode: 5,
      resourceId: 7,
    }),
    ownership(WGPU_OWNERSHIP_EVENT.COMMAND, {
      epoch: 1,
      commandSerial: 2,
      opcode: 6,
      resourceId: 7,
      payloadLength: 3,
    }),
  ], healthy());
  runtime.acceptPrepared(
    runtime.prepareLegacy(Uint32Array.of(5, 7, 64, 1, 0, 0, 0, 0)),
    0
  );
  const retained = Uint8Array.of(1, 2, 3);
  const prepared = runtime.prepareLegacy(
    Uint32Array.of(6, 7, 0, 0xfffffff0, 3, 2, 0, 0),
    null,
    { payloadBytes: retained }
  );
  retained.fill(9);
  runtime.acceptPrepared(prepared, 1);
  assert.equal(runtime.snapshot().evidenceValid, true);
});

test("permanently rejected records invalidate complete evidence", () => {
  const runtime = activeRuntime();
  const prepared = runtime.prepareLegacy(Uint32Array.of(5, 7, 64, 1, 0, 0, 0, 0));
  runtime.discardPrepared(prepared);
  const state = runtime.snapshot();
  assert.equal(state.preparedRecordCount, 1);
  assert.equal(state.acceptedRecordCount, 0);
  assert.equal(state.discardedPreparedRecordCount, 1);
  assert.equal(state.failed, true);
  assert.equal(state.evidenceValid, false);
});

test("retry preparation is counted without becoming a permanent discard", () => {
  const runtime = activeRuntime();
  const prepared = runtime.prepareLegacy(Uint32Array.of(5, 7, 64, 1, 0, 0, 0, 0));
  runtime.retryPrepared(prepared);
  const state = runtime.snapshot();
  assert.equal(state.retriedPreparedRecordCount, 1);
  assert.equal(state.discardedPreparedRecordCount, 0);
  assert.equal(state.failed, false);
});

test("the first failing ownership batch remains available after later trace activity", () => {
  const runtime = activeRuntime();
  runtime.pushOwnership([ownership(WGPU_OWNERSHIP_EVENT.EPOCH, {
    epoch: 1,
    resourceId: 1,
  })], healthy());
  runtime.pushOwnership([
    ownership(WGPU_OWNERSHIP_EVENT.PENDING_RESERVED, { transactionId: 1 }),
    ownership(WGPU_OWNERSHIP_EVENT.PENDING_RESERVED, { transactionId: 1 }),
  ], healthy());
  runtime.pushOwnership([
    ownership(WGPU_OWNERSHIP_EVENT.PENDING_RESERVED, { transactionId: 2 }),
  ], healthy());
  const state = runtime.snapshot();
  assert.equal(state.failed, true);
  assert.deepEqual(
    state.failureOwnershipRecords.map((record) => record.transactionId),
    [1, 1]
  );
  assert.match(state.reasons[0], /reserved=1, passBegan=0, completed=0/);
});

test("bounded capture stops only after a qualified prefix and terminal native ack", () => {
  const runtime = createWgpuSemanticRuntime({
    requested: true,
    active: true,
    minimumCommittedEventCount: 2,
    initialConsumerResetAttestation: captureInitialWgpuConsumerResetAttestation({
      resourceMaps: emptyMaps(),
      videoBackend: "WebGPU-Real",
      renderDeviceReady: true,
      capturedBeforeTraceAttach: true,
      commandRingRegistered: false,
      commandsProcessed: 0,
      canvasOwnedByCommandRing: false,
      replayFatal: null,
    }),
    now: () => 0,
  });
  runtime.pushOwnership([
    ownership(WGPU_OWNERSHIP_EVENT.EPOCH, { epoch: 1, resourceId: 1 }),
    ownership(WGPU_OWNERSHIP_EVENT.COMMAND, {
      epoch: 1,
      commandSerial: 1,
      opcode: 5,
      resourceId: 7,
    }),
    ownership(WGPU_OWNERSHIP_EVENT.COMMAND, {
      epoch: 1,
      commandSerial: 2,
      opcode: 5,
      resourceId: 8,
    }),
  ], healthy());

  runtime.acceptPrepared(
    runtime.prepareLegacy(Uint32Array.of(5, 7, 64, 1, 0, 0, 0, 0)),
    0
  );
  assert.equal(runtime.captureControl().stopRequested, false);
  runtime.acceptPrepared(
    runtime.prepareLegacy(Uint32Array.of(5, 8, 64, 1, 0, 0, 0, 0)),
    1
  );
  assert.equal(runtime.maybeRequestCaptureEnd({
    commandRingRead: 2,
    commandRingWrite: 2,
    ownershipHealth: healthy(),
  }), true);
  assert.equal(runtime.captureControl().nativeStopRequestPending, true);
  assert.equal(runtime.snapshot().captureComplete, false);

  runtime.markNativeStopRequestSent();
  runtime.pushOwnership([ownership(WGPU_OWNERSHIP_EVENT.CAPTURE_END, {
    epoch: 1,
    commandSerial: 2,
    opcode: 22,
    resourceId: 2,
    payloadLength: 1,
  })], healthy());
  assert.deepEqual(runtime.maybeFreezeCapture({
    commandRingRead: 2,
    commandRingWrite: 2,
    ownershipHealth: healthy(),
  }), {
    captureId: 1,
    commandRingWrite: 2,
    commandSerial: 2,
  });
  const completed = runtime.snapshot({ detailed: true });
  assert.equal(completed.captureComplete, true);
  assert.equal(completed.evidenceValid, true);
  assert.equal(completed.captureEndCommandRingWrite, 2);
  assert.equal(completed.captureEndCommandSerial, 2);

  assert.equal(
    runtime.prepareLegacy(Uint32Array.of(5, 9, 64, 1, 0, 0, 0, 0)),
    null
  );
  runtime.invalidate("later device loss");
  assert.deepEqual(runtime.snapshot({ detailed: true }), completed);
});

function activeRuntime() {
  return createWgpuSemanticRuntime({
    requested: true,
    active: true,
    initialConsumerResetAttestation: captureInitialWgpuConsumerResetAttestation({
      resourceMaps: emptyMaps(),
      videoBackend: "WebGPU-Real",
      renderDeviceReady: true,
      capturedBeforeTraceAttach: true,
      commandRingRegistered: false,
      commandsProcessed: 0,
      canvasOwnedByCommandRing: false,
      replayFatal: null,
    }),
    now: () => 0,
  });
}

function healthy() {
  return {
    registered: true,
    backlog: 0,
    nativeDropped: 0,
    recordEpochMismatchCount: 0,
    monotonicOrderingViolationCount: 0,
    malformedHeaderCount: 0,
    malformedDescriptorCount: 0,
  };
}

function ownership(event, overrides = {}) {
  return {
    event,
    epoch: 1,
    transactionId: 0,
    commandSerial: 0,
    opcode: 0,
    resourceId: 0,
    payloadLength: 0,
    auxiliary: 0,
    ...overrides,
  };
}

function emptyMaps() {
  return Object.fromEntries([
    "shaders", "pipelines", "buffers", "textures",
    "samplers", "bindGroups", "pipeTpl", "pipeVar",
  ].map((name) => [name, new Map()]));
}
