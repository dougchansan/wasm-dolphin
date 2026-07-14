// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import {
  WGPU_UPLOAD_PROBE_OWNER,
  WGPU_UPLOAD_PROBE_SCHEMA,
  createWgpuUploadProbeExecutor,
} from "../src/wgpu-upload-probe-executor.js";
import {
  createFakeUploadDevice,
  createWgpuCommandRingFixture,
} from "./helpers/wgpu-command-ring-fixture.mjs";

function createExecutor(mode, fixture, fake = null, options = {}) {
  return createWgpuUploadProbeExecutor({
    mode,
    device: fake?.device,
    ownerBuffer: fixture.ownerBuffer,
    schedule: () => 1,
    cancelSchedule() {},
    ...options,
  });
}

test("all upload-probe arms consume the same normalized workload", async () => {
  const snapshots = [];
  for (const mode of ["inline-upload", "worker-upload", "null-drain"]) {
    const fixture = createWgpuCommandRingFixture();
    const fake = mode === "null-drain" ? null : createFakeUploadDevice();
    const executor = createExecutor(mode, fixture, fake);
    executor.attach(fixture.descriptor);
    executor.drain();
    snapshots.push(await executor.finalize());
  }

  for (const snapshot of snapshots) {
    assert.equal(snapshot.schema, WGPU_UPLOAD_PROBE_SCHEMA);
    assert.equal(snapshot.passed, true);
    assert.equal(snapshot.quiesced, true);
    assert.equal(snapshot.observedRecordCount, 9);
    assert.equal(snapshot.consumedRecordCount, 9);
    assert.equal(snapshot.opHistogram.reduce((sum, value) => sum + value, 0), 9);
    assert.equal(snapshot.uploadRecordCount, 2);
    assert.equal(snapshot.releasedUploadCount, 2);
    assert.equal(snapshot.bufferUploadBytes, 4);
    assert.equal(snapshot.textureUploadBytes, 16);
    assert.equal(snapshot.totalUploadBytes, 20);
    assert.equal(snapshot.finalUploadRead, 20);
    assert.equal(snapshot.backlog, 0);
    assert.equal(snapshot.invalidRecordCount, 0);
    assert.equal(snapshot.unknownOpcodeCount, 0);
  }
  assert.equal(new Set(snapshots.map((entry) => entry.streamDigest)).size, 1);
  assert.deepEqual(snapshots[0].opHistogram, snapshots[1].opHistogram);
  assert.deepEqual(snapshots[1].opHistogram, snapshots[2].opHistogram);
  assert.equal(snapshots[0].submissionCount, 1);
  assert.equal(snapshots[1].submissionCount, 1);
  assert.equal(snapshots[2].submissionCount, 0);
  assert.equal(snapshots[2].staging, null);
});

test("measurement boundary resets workload evidence while preserving ownership", async () => {
  const fixture = createWgpuCommandRingFixture([[0], [22]]);
  const executor = createExecutor("null-drain", fixture);
  executor.attach(fixture.descriptor);
  executor.drain();
  const boundary = await executor.beginMeasurement();
  assert.equal(boundary.claimCount, 1);
  assert.equal(boundary.claimedOwner, WGPU_UPLOAD_PROBE_OWNER.null);
  assert.equal(boundary.observedRecordCount, 0);
  assert.equal(boundary.submissionCount, 0);
  assert.equal(boundary.streamDigest, "811c9dc5");
  assert.deepEqual(boundary.submitDigests, []);

  const words = new Uint32Array(fixture.heapBuffer);
  const next = Atomics.load(fixture.header, 0) >>> 0;
  const base = (fixture.descriptor.slotsPtr + (next % fixture.descriptor.capacity) * 32) >>> 2;
  words[base] = 0;
  Atomics.store(fixture.header, 0, (next + 1) | 0);
  const final = await executor.finalize();
  assert.equal(final.observedRecordCount, 1);
  assert.equal(final.consumedRecordCount, 1);
  assert.equal(final.initialRead, next);
  assert.equal(final.finalRead, (next + 1) >>> 0);
});

test("workload digests normalize runtime resource identifiers", async () => {
  const snapshots = [];
  for (const [id, destinationOffset] of [[7, 0], [7007, 4096]]) {
    const fixture = createWgpuCommandRingFixture([
      [5, id, 64, 0x0c],
      [6, id, destinationOffset, 4096, 4, 3],
      [22],
      [23, 1, id],
    ]);
    const executor = createExecutor("null-drain", fixture);
    executor.attach(fixture.descriptor);
    snapshots.push(await executor.finalize());
  }
  assert.equal(snapshots[0].streamDigest, snapshots[1].streamDigest);
  assert.deepEqual(snapshots[0].submitDigests, snapshots[1].submitDigests);
});

test("submit digests compare structure while stream digest retains payload evidence", async () => {
  const snapshots = [];
  for (const payload of [[1, 2, 3, 4], [4, 3, 2, 1]]) {
    const fixture = createWgpuCommandRingFixture([
      [5, 1, 64, 0x0c],
      [6, 1, 0, 4096, 4, 3],
      [22],
    ]);
    new Uint8Array(fixture.heapBuffer, 4096, 4).set(payload);
    const executor = createExecutor("null-drain", fixture);
    executor.attach(fixture.descriptor);
    snapshots.push(await executor.finalize());
  }
  assert.deepEqual(snapshots[0].submitDigests, snapshots[1].submitDigests);
  assert.notEqual(snapshots[0].streamDigest, snapshots[1].streamDigest);
});

test("quiescence requires a stable empty ring and consumes a late publication", async () => {
  const fixture = createWgpuCommandRingFixture([]);
  const executor = createExecutor("null-drain", fixture);
  executor.attach(fixture.descriptor);
  const words = new Uint32Array(fixture.heapBuffer);
  setTimeout(() => {
    const base = fixture.descriptor.slotsPtr >>> 2;
    words[base] = 0;
    Atomics.store(fixture.header, 0, 1);
  }, 10);
  const final = await executor.finalize();
  assert.equal(final.quiesced, true);
  assert.equal(final.observedRecordCount, 1);
  assert.equal(final.finalWrite, 1);
  assert.equal(final.finalRead, 1);
});

test("mapped capacity retains the current record and upload bytes for one retry", async () => {
  const records = [
    [5, 1, 64, 0x0c],
    [6, 1, 0, 4096, 4, 3],
    [6, 1, 4, 4100, 4, 3],
    [22],
  ];
  const fixture = createWgpuCommandRingFixture(records);
  const fake = createFakeUploadDevice();
  const executor = createExecutor("inline-upload", fixture, fake, {
    slotCount: 1,
    slotSize: 4,
  });
  executor.attach(fixture.descriptor);
  const held = executor.drain();
  assert.equal(held.finalRead, 2);
  assert.equal(held.finalUploadRead, 4);
  assert.equal(held.capacityHoldCount, 1);
  assert.equal(held.observedRecordCount, 3);
  await Promise.resolve();
  executor.drain();
  const final = await executor.finalize();
  assert.equal(final.quiesced, true);
  assert.equal(final.consumedRecordCount, 4);
  assert.equal(final.observedRecordCount, 4);
  assert.equal(final.uploadRecordCount, 2);
  assert.equal(final.releasedUploadCount, 2);
  assert.equal(final.finalUploadRead, 8);
  assert.equal(final.submissionCount, 2);
});

test("ownership is exclusive and a conflicting consumer cannot publish", () => {
  const fixture = createWgpuCommandRingFixture();
  const first = createExecutor("null-drain", fixture);
  first.attach(fixture.descriptor);
  const second = createExecutor("inline-upload", fixture, createFakeUploadDevice());
  assert.throws(() => second.attach(fixture.descriptor), /ownership conflict/);
  assert.equal(Atomics.load(new Int32Array(fixture.ownerBuffer), 0), WGPU_UPLOAD_PROBE_OWNER.null);
  assert.equal(fixture.header[1], 0);
});

test("an unknown opcode fails protocol v3 and wakes the producer-facing state", () => {
  const fixture = createWgpuCommandRingFixture([[99]]);
  const executor = createExecutor("null-drain", fixture);
  executor.attach(fixture.descriptor);
  const snapshot = executor.drain();
  assert.equal(snapshot.passed, false);
  assert.equal(snapshot.unknownOpcodeCount, 1);
  assert.equal(snapshot.consumerState, 2);
  assert.equal(snapshot.consumerError, 1);
  assert.equal(fixture.header[1], 0);
  assert.equal(Atomics.load(new Int32Array(fixture.ownerBuffer), 0), WGPU_UPLOAD_PROBE_OWNER.failed);
});

test("an invalid upload span is never released or consumed", () => {
  const fixture = createWgpuCommandRingFixture([
    [5, 1, 64, 0x0c],
    [6, 1, 0, 1234, 4, 3],
  ]);
  const executor = createExecutor("null-drain", fixture);
  executor.attach(fixture.descriptor);
  const snapshot = executor.drain();
  assert.equal(snapshot.finalRead, 1);
  assert.equal(snapshot.finalUploadRead, 0);
  assert.equal(snapshot.releasedUploadCount, 0);
  assert.equal(snapshot.invalidUploadSpanCount, 1);
  assert.equal(snapshot.consumerState, 2);
});

test("record indices and upload watermarks advance across uint32 and arena wrap", async () => {
  const wrappedRecords = createWgpuCommandRingFixture([
    [0], [0], [0],
  ], { initialRead: 0xfffffffe });
  const recordExecutor = createExecutor("null-drain", wrappedRecords);
  recordExecutor.attach(wrappedRecords.descriptor);
  const recordFinal = await recordExecutor.finalize();
  assert.equal(recordFinal.initialRead, 0xfffffffe);
  assert.equal(recordFinal.finalRead, 1);
  assert.equal(recordFinal.consumedRecordCount, 3);
  assert.equal(recordFinal.backlog, 0);

  const uploadRecords = createWgpuCommandRingFixture([
    [5, 1, 64, 0x0c],
    [6, 1, 0, 4096 + 4090, 6, 3],
    [6, 1, 8, 4096, 4, 3],
  ], { initialUploadRead: 4090 });
  new Uint8Array(uploadRecords.heapBuffer, 4096 + 4090, 6).set([1, 2, 3, 4, 5, 6]);
  const uploadExecutor = createExecutor("null-drain", uploadRecords);
  uploadExecutor.attach(uploadRecords.descriptor);
  const uploadFinal = await uploadExecutor.finalize();
  assert.equal(uploadFinal.initialUploadRead, 4090);
  assert.equal(uploadFinal.finalUploadRead, 4100);
  assert.equal(uploadFinal.releasedUploadCount, 2);
  assert.equal(uploadFinal.totalUploadBytes, 10);
});

test("synchronous WebGPU exceptions fail and wake the protocol-v3 producer", () => {
  const fixture = createWgpuCommandRingFixture([[5, 1, 64, 0x0c]]);
  const fake = createFakeUploadDevice();
  const createBuffer = fake.device.createBuffer.bind(fake.device);
  fake.device.createBuffer = (descriptor) => {
    if (!descriptor.mappedAtCreation) throw new Error("destination allocation failed");
    return createBuffer(descriptor);
  };
  const executor = createExecutor("inline-upload", fixture, fake);
  executor.attach(fixture.descriptor);
  const snapshot = executor.drain();
  assert.equal(snapshot.passed, false);
  assert.equal(snapshot.fatalScope, "record-execution");
  assert.match(snapshot.fatalError, /destination allocation failed/);
  assert.equal(snapshot.consumerState, 2);
  assert.equal(snapshot.consumerError, 1);
  assert.equal(Atomics.load(new Int32Array(fixture.ownerBuffer), 0), WGPU_UPLOAD_PROBE_OWNER.failed);
});

test("finalize timeout fails the consumer instead of leaving a RUNNING producer", async () => {
  const fixture = createWgpuCommandRingFixture([
    [5, 1, 64, 0x0c],
    [6, 1, 0, 4096, 4, 3],
    [6, 1, 4, 4100, 4, 3],
  ]);
  const fake = createFakeUploadDevice();
  const createBuffer = fake.device.createBuffer.bind(fake.device);
  fake.device.createBuffer = (descriptor) => {
    const buffer = createBuffer(descriptor);
    if (descriptor.mappedAtCreation) buffer.mapAsync = () => new Promise(() => {});
    return buffer;
  };
  let clock = 0;
  const executor = createExecutor("inline-upload", fixture, fake, {
    slotCount: 1,
    slotSize: 4,
    now: () => clock++,
  });
  executor.attach(fixture.descriptor);
  executor.drain();
  const snapshot = await executor.finalize({ timeoutMs: 4 });
  assert.equal(snapshot.quiesced, false);
  assert.equal(snapshot.passed, false);
  assert.equal(snapshot.fatalScope, "finalize-timeout");
  assert.equal(snapshot.consumerState, 2);
  assert.equal(Atomics.load(new Int32Array(fixture.ownerBuffer), 0), WGPU_UPLOAD_PROBE_OWNER.failed);
});

test("destroy records and finalization release probe-owned GPU resources", async () => {
  const fixture = createWgpuCommandRingFixture();
  const fake = createFakeUploadDevice();
  const executor = createExecutor("inline-upload", fixture, fake);
  executor.attach(fixture.descriptor);
  executor.drain();
  const snapshot = await executor.finalize();
  const destinationBuffer = fake.buffers.find((buffer) => !buffer.descriptor.mappedAtCreation);
  assert.equal(snapshot.bufferDestroyCount, 1);
  assert.equal(snapshot.textureDestroyCount, 1);
  assert.equal(destinationBuffer.destroyed, true);
  assert.equal(fake.textures[0].destroyed, true);
});

test("texture byte arithmetic cannot wrap into a valid upload span", () => {
  const fixture = createWgpuCommandRingFixture([
    [7, 2, 2, 2, 0, 0x06, 1],
    [8, 2, 4096, 0xffffffff, 2, 2, 0, 0],
  ]);
  const executor = createExecutor("null-drain", fixture);
  executor.attach(fixture.descriptor);
  const snapshot = executor.drain();
  assert.equal(snapshot.finalRead, 1);
  assert.equal(snapshot.finalUploadRead, 0);
  assert.equal(snapshot.fatalScope, "upload-texture-layout");
  assert.equal(snapshot.consumerState, 2);
});
