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
  assert.equal(state.loadedCheckpointGeneration, 0);
  assert.equal(state.loadEpochCount, 0);
  assert.equal(state.currentEpochCommittedEventCount, 0);
  assert.equal(state.qualificationReady, false);
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

test("a fenced LoadRequested waits for every pre-load command to pair", () => {
  const runtime = activeRuntime({ minimumCommittedEventCount: 1 });
  runtime.pushOwnership([
    ownership(WGPU_OWNERSHIP_EVENT.EPOCH, { epoch: 1, resourceId: 1 }),
    ownership(WGPU_OWNERSHIP_EVENT.COMMAND, {
      epoch: 1,
      commandSerial: 1,
      opcode: 5,
      resourceId: 7,
    }),
  ], healthy());
  runtime.pushOwnership([
    ownership(WGPU_OWNERSHIP_EVENT.LOAD_REQUESTED, { epoch: 2 }),
  ], healthy());

  let state = runtime.snapshot({ detailed: true });
  assert.equal(state.failed, false);
  assert.equal(state.loadEpochCount, 0);
  assert.equal(state.deferredOwnershipRecordCount, 1);
  assert.equal(state.deferredLoadBoundaryCount, 1);
  assert.deepEqual(
    state.deferredOwnershipRecords.map((record) => record.event),
    [WGPU_OWNERSHIP_EVENT.LOAD_REQUESTED]
  );

  runtime.acceptPrepared(
    runtime.prepareLegacy(Uint32Array.of(5, 7, 64, 1, 0, 0, 0, 0)),
    0
  );
  state = runtime.snapshot();
  assert.equal(state.failed, false);
  assert.equal(state.loadEpochCount, 1);
  assert.equal(state.currentEpochCommittedEventCount, 0);
  assert.equal(state.deferredOwnershipRecordCount, 0);
  assert.equal(state.correlator.pendingOwnershipRecords, 0);

  runtime.pushOwnership([ownership(WGPU_OWNERSHIP_EVENT.COMMAND, {
    epoch: 2,
    commandSerial: 2,
    opcode: 5,
    resourceId: 8,
  })], healthy(), { loadedCheckpointGeneration: 1 });

  runtime.acceptPrepared(
    runtime.prepareLegacy(Uint32Array.of(5, 8, 64, 1, 0, 0, 0, 0)),
    1
  );
  assert.equal(runtime.maybeRequestCaptureEnd({
    commandRingRead: 2,
    commandRingWrite: 2,
    ownershipHealth: healthy(),
    loadedCheckpointGeneration: 1,
  }), true);
  state = runtime.snapshot();
  assert.equal(state.failed, false);
  assert.equal(state.currentEpochCommittedEventCount, 1);
  assert.equal(state.qualificationReady, true);
});

test("ownership must fence at LoadRequested and multiple boundaries fail closed", () => {
  const unfenced = activeRuntime();
  unfenced.pushOwnership([
    ownership(WGPU_OWNERSHIP_EVENT.EPOCH, { epoch: 1, resourceId: 1 }),
    ownership(WGPU_OWNERSHIP_EVENT.COMMAND, {
      epoch: 1,
      commandSerial: 1,
      opcode: 5,
      resourceId: 7,
    }),
  ], healthy());
  unfenced.pushOwnership([
    ownership(WGPU_OWNERSHIP_EVENT.LOAD_REQUESTED, { epoch: 2 }),
    ownership(WGPU_OWNERSHIP_EVENT.COMMAND, {
      epoch: 2,
      commandSerial: 2,
      opcode: 5,
      resourceId: 8,
    }),
  ], healthy());
  assert.equal(unfenced.snapshot().failed, true);
  assert.match(unfenced.snapshot().reasons[0], /must terminate the ownership drain/);

  const duplicate = activeRuntime();
  duplicate.pushOwnership([
    ownership(WGPU_OWNERSHIP_EVENT.EPOCH, { epoch: 1, resourceId: 1 }),
    ownership(WGPU_OWNERSHIP_EVENT.LOAD_REQUESTED, { epoch: 2 }),
    ownership(WGPU_OWNERSHIP_EVENT.LOAD_REQUESTED, { epoch: 3 }),
  ], healthy());
  assert.equal(duplicate.snapshot().failed, true);
  assert.match(duplicate.snapshot().reasons[0], /multiple LoadRequested boundaries/);
});

test("successive applied loads bind qualification to the newest checkpoint generation", () => {
  const runtime = activeRuntime({ minimumCommittedEventCount: 1 });
  runtime.pushOwnership([
    ownership(WGPU_OWNERSHIP_EVENT.EPOCH, { epoch: 1, resourceId: 1 }),
    ownership(WGPU_OWNERSHIP_EVENT.LOAD_REQUESTED, { epoch: 2 }),
  ], healthy(), { loadedCheckpointGeneration: 1 });
  runtime.pushOwnership([
    ownership(WGPU_OWNERSHIP_EVENT.LOAD_REQUESTED, { epoch: 3 }),
  ], healthy(), { loadedCheckpointGeneration: 2 });
  runtime.pushOwnership([ownership(WGPU_OWNERSHIP_EVENT.COMMAND, {
    epoch: 3,
    commandSerial: 1,
    opcode: 5,
    resourceId: 7,
  })], healthy(), { loadedCheckpointGeneration: 2 });
  runtime.acceptPrepared(
    runtime.prepareLegacy(Uint32Array.of(5, 7, 64, 1, 0, 0, 0, 0)),
    0
  );

  assert.deepEqual(pickQualification(runtime.snapshot()), {
    loadedCheckpointGeneration: 2,
    loadEpochCount: 2,
    currentEpochCommittedEventCount: 1,
    qualificationReady: true,
  });
  assert.equal(runtime.maybeRequestCaptureEnd({
    commandRingRead: 1,
    commandRingWrite: 1,
    ownershipHealth: healthy(),
    loadedCheckpointGeneration: 1,
  }), false);
  assert.equal(runtime.maybeRequestCaptureEnd({
    commandRingRead: 1,
    commandRingWrite: 1,
    ownershipHealth: healthy(),
    loadedCheckpointGeneration: 2,
  }), true);
});

test("boot prefix cannot stop and LoadRequested resets current epoch qualification", () => {
  const runtime = activeRuntime({ minimumCommittedEventCount: 2 });
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
  assert.equal(runtime.snapshot().parity.committedEventCount, 2);
  assert.equal(runtime.snapshot().currentEpochCommittedEventCount, 2);
  assert.equal(runtime.maybeRequestCaptureEnd({
    commandRingRead: 2,
    commandRingWrite: 2,
    ownershipHealth: healthy(),
    loadedCheckpointGeneration: 1,
  }), false);
  assert.deepEqual(pickQualification(runtime.captureControl()), {
    loadedCheckpointGeneration: 0,
    loadEpochCount: 0,
    currentEpochCommittedEventCount: 2,
    qualificationReady: false,
  });

  runtime.pushOwnership([
    ownership(WGPU_OWNERSHIP_EVENT.LOAD_REQUESTED, { epoch: 2 }),
  ], healthy(), { loadedCheckpointGeneration: 1 });
  const afterLoad = runtime.snapshot();
  assert.equal(afterLoad.parity.committedEventCount, 2);
  assert.equal(afterLoad.currentEpochCommittedEventCount, 0);
  assert.equal(afterLoad.loadEpochCount, 1);
  assert.equal(afterLoad.qualificationReady, false);

  runtime.pushOwnership([ownership(WGPU_OWNERSHIP_EVENT.COMMAND, {
    epoch: 2,
    commandSerial: 3,
    opcode: 5,
    resourceId: 9,
  })], healthy());
  runtime.acceptPrepared(
    runtime.prepareLegacy(Uint32Array.of(5, 9, 64, 1, 0, 0, 0, 0)),
    2
  );
  assert.equal(runtime.snapshot().currentEpochCommittedEventCount, 1);
  assert.equal(runtime.maybeRequestCaptureEnd({
    commandRingRead: 3,
    commandRingWrite: 3,
    ownershipHealth: healthy(),
    loadedCheckpointGeneration: 1,
  }), false);

  runtime.pushOwnership([ownership(WGPU_OWNERSHIP_EVENT.COMMAND, {
    epoch: 2,
    commandSerial: 4,
    opcode: 5,
    resourceId: 10,
  })], healthy());
  runtime.acceptPrepared(
    runtime.prepareLegacy(Uint32Array.of(5, 10, 64, 1, 0, 0, 0, 0)),
    3
  );
  assert.equal(runtime.maybeRequestCaptureEnd({
    commandRingRead: 4,
    commandRingWrite: 4,
    ownershipHealth: healthy(),
    loadedCheckpointGeneration: 1,
  }), true);
  assert.deepEqual(pickQualification(runtime.captureControl()), {
    loadedCheckpointGeneration: 1,
    loadEpochCount: 1,
    currentEpochCommittedEventCount: 2,
    qualificationReady: true,
  });
});

test("capture stop can fence a valid committed prefix while battle work is pending", () => {
  const runtime = activeRuntime({ minimumCommittedEventCount: 1 });
  runtime.pushOwnership([
    ownership(WGPU_OWNERSHIP_EVENT.EPOCH, { epoch: 1, resourceId: 1 }),
    ownership(WGPU_OWNERSHIP_EVENT.LOAD_REQUESTED, { epoch: 2 }),
  ], healthy(), { loadedCheckpointGeneration: 1 });
  runtime.pushOwnership([ownership(WGPU_OWNERSHIP_EVENT.COMMAND, {
    epoch: 2,
    commandSerial: 1,
    opcode: 5,
    resourceId: 7,
  })], healthy(), { loadedCheckpointGeneration: 1 });
  runtime.acceptPrepared(
    runtime.prepareLegacy(Uint32Array.of(5, 7, 64, 1, 0, 0, 0, 0)),
    0
  );
  runtime.pushOwnership([ownership(WGPU_OWNERSHIP_EVENT.COMMAND, {
    epoch: 2,
    commandSerial: 2,
    opcode: 5,
    resourceId: 8,
  })], healthy(), { loadedCheckpointGeneration: 1 });

  assert.equal(runtime.snapshot().checkpoint.committedPrefixValid, true);
  assert.equal(runtime.snapshot().checkpoint.valid, false);
  assert.equal(runtime.maybeRequestCaptureEnd({
    commandRingRead: 1,
    commandRingWrite: 2,
    ownershipHealth: { ...healthy(), backlog: 7 },
    loadedCheckpointGeneration: 1,
  }), true);
  assert.equal(runtime.captureControl().nativeStopRequestPending, true);
});

test("bounded capture freezes only with renewed post-load eligibility", () => {
  const runtime = activeRuntime({ minimumCommittedEventCount: 1 });
  runtime.pushOwnership([
    ownership(WGPU_OWNERSHIP_EVENT.EPOCH, { epoch: 1, resourceId: 1 }),
    ownership(WGPU_OWNERSHIP_EVENT.LOAD_REQUESTED, { epoch: 2 }),
  ], healthy());
  runtime.pushOwnership([ownership(WGPU_OWNERSHIP_EVENT.COMMAND, {
    epoch: 2,
    commandSerial: 1,
    opcode: 5,
    resourceId: 7,
  })], healthy(), { loadedCheckpointGeneration: 2 });
  runtime.acceptPrepared(
    runtime.prepareLegacy(Uint32Array.of(5, 7, 64, 1, 0, 0, 0, 0)),
    0
  );
  assert.equal(runtime.maybeRequestCaptureEnd({
    commandRingRead: 1,
    commandRingWrite: 1,
    ownershipHealth: healthy(),
  }), false);
  assert.equal(runtime.captureControl().qualificationReady, true);
  assert.equal(runtime.maybeRequestCaptureEnd({
    commandRingRead: 1,
    commandRingWrite: 1,
    ownershipHealth: healthy(),
    loadedCheckpointGeneration: 2,
  }), true);
  assert.equal(runtime.captureControl().nativeStopRequestPending, true);
  assert.equal(runtime.snapshot().captureComplete, false);

  runtime.markNativeStopRequestSent();
  runtime.pushOwnership([ownership(WGPU_OWNERSHIP_EVENT.CAPTURE_END, {
    epoch: 2,
    commandSerial: 1,
    opcode: 22,
    resourceId: 1,
    payloadLength: 1,
  })], healthy());
  assert.equal(runtime.captureControl().loadedCheckpointGeneration, 2);
  assert.equal(runtime.captureControl().qualificationReady, true);
  assert.deepEqual(runtime.maybeFreezeCapture({
    commandRingRead: 1,
    commandRingWrite: 1,
    ownershipHealth: healthy(),
    loadedCheckpointGeneration: 2,
  }), {
    captureId: 1,
    commandRingWrite: 1,
    commandSerial: 1,
  });
  const completed = runtime.snapshot({ detailed: true });
  assert.equal(completed.captureComplete, true);
  assert.equal(completed.evidenceValid, true);
  assert.equal(completed.captureEndCommandRingWrite, 1);
  assert.equal(completed.captureEndCommandSerial, 1);
  assert.equal(completed.loadedCheckpointGeneration, 2);
  assert.equal(completed.loadEpochCount, 1);
  assert.equal(completed.currentEpochCommittedEventCount, 1);
  assert.equal(completed.qualificationReady, true);

  assert.equal(
    runtime.prepareLegacy(Uint32Array.of(5, 9, 64, 1, 0, 0, 0, 0)),
    null
  );
  runtime.invalidate("later device loss");
  assert.deepEqual(runtime.snapshot({ detailed: true }), completed);
});

test("a second checkpoint generation after stop invalidates stale evidence", () => {
  const runtime = activeRuntime({ minimumCommittedEventCount: 1 });
  runtime.pushOwnership([
    ownership(WGPU_OWNERSHIP_EVENT.EPOCH, { epoch: 1, resourceId: 1 }),
    ownership(WGPU_OWNERSHIP_EVENT.LOAD_REQUESTED, { epoch: 2 }),
  ], healthy(), { loadedCheckpointGeneration: 1 });
  runtime.pushOwnership([ownership(WGPU_OWNERSHIP_EVENT.COMMAND, {
    epoch: 2,
    commandSerial: 1,
    opcode: 5,
    resourceId: 7,
  })], healthy(), { loadedCheckpointGeneration: 1 });
  runtime.acceptPrepared(
    runtime.prepareLegacy(Uint32Array.of(5, 7, 64, 1, 0, 0, 0, 0)),
    0
  );
  assert.equal(runtime.maybeRequestCaptureEnd({
    commandRingRead: 1,
    commandRingWrite: 1,
    ownershipHealth: healthy(),
    loadedCheckpointGeneration: 1,
  }), true);
  runtime.markNativeStopRequestSent();
  runtime.pushOwnership([ownership(WGPU_OWNERSHIP_EVENT.CAPTURE_END, {
    epoch: 2,
    commandSerial: 1,
    opcode: 22,
    resourceId: 1,
    payloadLength: 1,
  })], healthy());
  assert.equal(runtime.maybeFreezeCapture({
    commandRingRead: 1,
    commandRingWrite: 1,
    ownershipHealth: healthy(),
    loadedCheckpointGeneration: 2,
  }), null);
  assert.equal(runtime.snapshot().failed, true);
  assert.match(runtime.snapshot().reasons[0], /generation changed after capture stop/);
});

function activeRuntime(options = {}) {
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
    ...options,
  });
}

function pickQualification(value) {
  return {
    loadedCheckpointGeneration: value.loadedCheckpointGeneration,
    loadEpochCount: value.loadEpochCount,
    currentEpochCommittedEventCount: value.currentEpochCommittedEventCount,
    qualificationReady: value.qualificationReady,
  };
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
