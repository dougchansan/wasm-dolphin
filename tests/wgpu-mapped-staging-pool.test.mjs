// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import {
  attemptRetainedWgpuUpload,
  createWgpuMappedStagingPool,
  submitWgpuUploadBeforeRender,
} from "../src/wgpu-mapped-staging-pool.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function createFakeDevice() {
  const lost = deferred();
  const buffers = [];
  const encoders = [];
  const device = {
    lost: lost.promise,
    createBuffer(descriptor) {
      const maps = [];
      const storage = new ArrayBuffer(descriptor.size);
      const buffer = {
        descriptor,
        storage,
        maps,
        unmaps: 0,
        destroys: 0,
        getMappedRange: () => storage,
        unmap() { this.unmaps += 1; },
        mapAsync(mode) {
          const operation = deferred();
          maps.push({ mode, operation });
          return operation.promise;
        },
        destroy() { this.destroys += 1; },
      };
      buffers.push(buffer);
      return buffer;
    },
    createCommandEncoder(descriptor) {
      const copies = [];
      const commandBuffer = { kind: "upload", copies };
      const encoder = {
        descriptor,
        copies,
        copyBufferToBuffer(...args) { copies.push(["buffer", ...args]); },
        copyBufferToTexture(...args) { copies.push(["texture", ...args]); },
        finish() { return commandBuffer; },
      };
      encoders.push(encoder);
      return encoder;
    },
  };
  return { device, lost, buffers, encoders };
}

function createPool(fake, options = {}) {
  return createWgpuMappedStagingPool({
    device: fake.device,
    slotCount: 2,
    slotSize: 1024,
    bufferUsage: 0x0006,
    mapMode: 0x0002,
    ...options,
  });
}

test("creates a fixed mapped-at-creation pool and preserves aligned buffer bytes", () => {
  const fake = createFakeDevice();
  const pool = createPool(fake, { slotCount: 2, slotSize: 32 });
  assert.equal(fake.buffers.length, 2);
  assert.deepEqual(fake.buffers[0].descriptor, {
    label: "Dolphin mapped upload staging 0",
    size: 32,
    usage: 0x0006,
    mappedAtCreation: true,
  });

  assert.deepEqual(pool.stageBuffer({
    data: Uint8Array.of(1, 2, 3, 4), destination: { name: "a" }, alignment: 16,
  }), { ok: true, slot: 0, offset: 0, logicalBytes: 4, stagedBytes: 4 });
  assert.deepEqual(pool.stageBuffer({
    data: Uint8Array.of(5, 6, 7, 8), destination: { name: "b" }, alignment: 16,
  }), { ok: true, slot: 0, offset: 16, logicalBytes: 4, stagedBytes: 4 });
  assert.deepEqual([...new Uint8Array(fake.buffers[0].storage).slice(0, 20)], [
    1, 2, 3, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 6, 7, 8,
  ]);

  const batch = pool.seal();
  const copies = batch.commandBuffer.copies;
  assert.equal(copies.length, 2);
  assert.deepEqual(copies.map((copy) => [copy[0], copy[2], copy[4], copy[5]]), [
    ["buffer", 0, 0, 4],
    ["buffer", 16, 0, 4],
  ]);
});

test("packs tight texture rows into 256-byte aligned copy layouts", () => {
  const fake = createFakeDevice();
  const pool = createPool(fake);
  const texture = { name: "texture" };
  const source = Uint8Array.from({ length: 24 }, (_, index) => index + 1);
  const result = pool.stageTexture({
    data: source,
    destination: texture,
    copySize: { width: 2, height: 2, depthOrArrayLayers: 2 },
    sourceBytesPerRow: 4,
    sourceRowsPerImage: 3,
    origin: { x: 1, y: 2, z: 3 },
  });
  assert.deepEqual(result, {
    ok: true, slot: 0, offset: 0, logicalBytes: 16, stagedBytes: 1024,
  });
  const staged = new Uint8Array(fake.buffers[0].storage);
  assert.deepEqual([...staged.slice(0, 4)], [1, 2, 3, 4]);
  assert.deepEqual([...staged.slice(256, 260)], [5, 6, 7, 8]);
  assert.deepEqual([...staged.slice(512, 516)], [13, 14, 15, 16]);
  assert.deepEqual([...staged.slice(768, 772)], [17, 18, 19, 20]);

  const batch = pool.seal();
  const copy = batch.commandBuffer.copies[0];
  assert.equal(copy[0], "texture");
  assert.deepEqual(copy[1], {
    buffer: fake.buffers[0], offset: 0, bytesPerRow: 256, rowsPerImage: 2,
  });
  assert.deepEqual(copy[2], { texture, origin: { x: 1, y: 2, z: 3 } });
  assert.deepEqual(copy[3], { width: 2, height: 2, depthOrArrayLayers: 2 });
});

test("reports bounded capacity misses without allocating or dropping prior uploads", () => {
  const fake = createFakeDevice();
  const pool = createPool(fake, { slotCount: 1, slotSize: 8 });
  const destination = {};
  assert.equal(pool.stageBuffer({ data: new Uint8Array(8), destination }).ok, true);
  assert.deepEqual(pool.stageBuffer({ data: new Uint8Array(4), destination }), {
    ok: false, reason: "no-capacity",
  });
  assert.deepEqual(pool.stageBuffer({ data: new Uint8Array(12), destination }), {
    ok: false, reason: "payload-too-large",
  });
  assert.equal(fake.buffers.length, 1);
  assert.deepEqual(pool.snapshot(), {
    slotCount: 1,
    slotSize: 8,
    capacityBytes: 8,
    failed: false,
    lastError: null,
    states: { mapped: 1, sealed: 0, remapping: 0, failed: 0 },
    pendingUploads: 1,
    activeBatches: 0,
    remapLatencyBucketBoundsMs: [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1000],
    bufferUploads: 1,
    bufferUploadsCoalesced: 0,
    textureUploads: 0,
    copyCommandsEncoded: 1,
    logicalBytes: 8,
    stagedBytes: 8,
    capacityMisses: 2,
    oversizedMisses: 1,
    capacityMissesNoMappedSlots: 0,
    capacityMissesMappedSlotsFull: 1,
    batchesSealed: 0,
    batchesSubmitted: 0,
    sealedSlotCountTotal: 0,
    sealedBytesTotal: 0,
    sealedBytesMax: 0,
    sealedRecordsTotal: 0,
    sealedRecordsMax: 0,
    remapsStarted: 0,
    remapsCompleted: 0,
    remapFailures: 0,
    remapLatencyTotalMs: 0,
    remapLatencyMaxMs: 0,
    remapLatencyHistogram: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    invalidations: 0,
  });
});

test("coalesces adjacent copies to the same buffer without changing byte order", () => {
  const fake = createFakeDevice();
  const pool = createPool(fake, { slotCount: 1, slotSize: 32 });
  const destination = { name: "stream" };
  pool.stageBuffer({
    data: Uint8Array.of(1, 2, 3, 4), destination, destinationOffset: 8,
  });
  pool.stageBuffer({
    data: Uint8Array.of(5, 6, 7, 8), destination, destinationOffset: 12,
  });
  const batch = pool.seal();
  assert.equal(batch.commandBuffer.copies.length, 1);
  assert.deepEqual(batch.commandBuffer.copies[0].slice(0, 6), [
    "buffer", fake.buffers[0], 0, destination, 8, 8,
  ]);
  assert.equal(pool.snapshot().bufferUploads, 2);
  assert.equal(pool.snapshot().bufferUploadsCoalesced, 1);
  assert.equal(pool.snapshot().copyCommandsEncoded, 1);
});

test("submits upload before render and remaps slots only after acceptance", async () => {
  const fake = createFakeDevice();
  const pool = createPool(fake, { slotCount: 1 });
  pool.stageBuffer({ data: Uint8Array.of(1, 2, 3, 4), destination: {} });
  const batch = pool.seal();
  assert.equal(pool.snapshot().states.sealed, 1);
  const render = { kind: "render" };
  const submissions = [];
  const remapped = submitWgpuUploadBeforeRender({
    queue: { submit: (commands) => submissions.push(commands) },
    pool,
    batch,
    renderCommandBuffers: [render],
  });
  assert.deepEqual(submissions, [[batch.commandBuffer, render]]);
  assert.equal(pool.snapshot().states.remapping, 1);
  assert.equal(fake.buffers[0].maps[0].mode, 0x0002);
  fake.buffers[0].maps[0].operation.resolve();
  assert.equal(await remapped, true);
  assert.equal(pool.snapshot().states.mapped, 1);
  assert.equal(pool.stageBuffer({ data: Uint8Array.of(9, 8, 7, 6), destination: {} }).ok, true);
});

test("records batch utilization, remap latency, and unavailable-slot misses", async () => {
  const fake = createFakeDevice();
  let clock = 10;
  const pool = createPool(fake, {
    slotCount: 1,
    slotSize: 32,
    now: () => clock,
  });
  pool.stageBuffer({ data: new Uint8Array(8), destination: {} });
  const batch = pool.seal();
  assert.equal(pool.snapshot().sealedSlotCountTotal, 1);
  assert.equal(pool.snapshot().sealedBytesTotal, 8);
  assert.equal(pool.snapshot().sealedRecordsTotal, 1);
  const remapped = submitWgpuUploadBeforeRender({
    queue: { submit() {} }, pool, batch,
  });
  assert.deepEqual(pool.stageBuffer({ data: new Uint8Array(4), destination: {} }), {
    ok: false, reason: "no-capacity",
  });
  assert.equal(pool.snapshot().capacityMissesNoMappedSlots, 1);
  clock = 29;
  fake.buffers[0].maps[0].operation.resolve();
  assert.equal(await remapped, true);
  const snapshot = pool.snapshot();
  assert.equal(snapshot.remapLatencyTotalMs, 19);
  assert.equal(snapshot.remapLatencyMaxMs, 19);
  assert.equal(snapshot.remapLatencyHistogram[5], 1);
});

test("submission failure invalidates all slots and rethrows", () => {
  const fake = createFakeDevice();
  const pool = createPool(fake);
  pool.stageBuffer({ data: Uint8Array.of(1, 2, 3, 4), destination: {} });
  const batch = pool.seal();
  assert.throws(() => submitWgpuUploadBeforeRender({
    queue: { submit: () => { throw new Error("queue rejected"); } },
    pool,
    batch,
  }), /queue rejected/);
  assert.equal(pool.snapshot().failed, true);
  assert.equal(pool.snapshot().lastError, "queue rejected");
  assert.deepEqual(fake.buffers.map((buffer) => buffer.destroys), [1, 1]);
  assert.deepEqual(pool.stageBuffer({ data: Uint8Array.of(1, 2, 3, 4), destination: {} }), {
    ok: false, reason: "pool-failed",
  });
});

test("remap rejection and device loss fail closed with cleanup", async () => {
  const remapFake = createFakeDevice();
  const remapPool = createPool(remapFake, { slotCount: 1 });
  remapPool.stageBuffer({ data: Uint8Array.of(1, 2, 3, 4), destination: {} });
  const remapBatch = remapPool.seal();
  const remapped = submitWgpuUploadBeforeRender({
    queue: { submit() {} }, pool: remapPool, batch: remapBatch,
  });
  remapFake.buffers[0].maps[0].operation.reject(new Error("map failed"));
  assert.equal(await remapped, false);
  assert.equal(remapPool.snapshot().remapFailures, 1);
  assert.equal(remapPool.snapshot().failed, true);
  assert.equal(remapFake.buffers[0].destroys, 1);

  const lossFake = createFakeDevice();
  const lossPool = createPool(lossFake);
  lossFake.lost.resolve({ message: "adapter reset" });
  await Promise.resolve();
  assert.equal(lossPool.snapshot().failed, true);
  assert.equal(lossPool.snapshot().lastError, "adapter reset");
  assert.deepEqual(lossFake.buffers.map((buffer) => buffer.destroys), [1, 1]);
});

test("rejects invalid copy layouts rather than corrupting adjacent destinations", () => {
  const fake = createFakeDevice();
  const pool = createPool(fake);
  assert.throws(() => pool.stageBuffer({ data: new Uint8Array(3), destination: {} }),
    /multiples of 4/);
  assert.throws(() => pool.stageBuffer({
    data: new Uint8Array(4), destination: {}, destinationOffset: 2,
  }), /multiples of 4/);
  assert.throws(() => pool.stageTexture({
    data: new Uint8Array(4),
    destination: {},
    copySize: { width: 1, height: 2 },
    sourceBytesPerRow: 4,
  }), /every requested row/);
  assert.equal(pool.snapshot().pendingUploads, 0);
});

test("retained ring bytes survive a capacity miss and retry byte-identically", () => {
  const retainedBytes = Uint8Array.of(9, 7, 5, 3);
  const stagedUploads = new Map([[41, { kind: "buffer", data: retainedBytes }]]);
  const seen = [];
  let attempt = 0;
  const stage = (data) => {
    seen.push([...data]);
    attempt += 1;
    return attempt === 1
      ? { ok: false, reason: "no-capacity" }
      : { ok: true, slot: 0 };
  };

  const first = attemptRetainedWgpuUpload({ stagedUploads, recordIndex: 41, stage });
  assert.equal(first.accepted, false);
  assert.equal(stagedUploads.get(41).data, retainedBytes);

  const second = attemptRetainedWgpuUpload({ stagedUploads, recordIndex: 41, stage });
  assert.equal(second.accepted, true);
  assert.equal(stagedUploads.has(41), false);
  assert.deepEqual(seen, [[9, 7, 5, 3], [9, 7, 5, 3]]);
});
