// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import {
  createWgpuUboComputeReconstruction,
  requestedWgpuUboComputeReconstruction,
  WGPU_UBO_COMPUTE_RECONSTRUCTION_SCHEMA,
  WGPU_UBO_RING_ROLE,
} from "../src/wgpu-ubo-compute-reconstruction.js";
import { encodeWgpuUboComputePackage } from "../src/wgpu-ubo-compute-codec.js";

const STORAGE = 0x0080;
const CLASS_BYTES = { VS: 4112, PS: 1536, GS: 64 };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function createFakeDevice({ limits = {}, mapAsync } = {}) {
  const lost = deferred();
  const operations = [];
  const buffers = [];
  const shaderModules = [];
  const pipelines = [];
  const bindGroups = [];
  const commandBuffers = [];
  const device = {
    lost: lost.promise,
    limits: {
      maxBufferSize: 16 * 1024 * 1024,
      maxStorageBufferBindingSize: 16 * 1024 * 1024,
      maxStorageBuffersPerShaderStage: 8,
      maxComputeInvocationsPerWorkgroup: 256,
      maxComputeWorkgroupSizeX: 256,
      maxComputeWorkgroupsPerDimension: 65535,
      maxBindGroups: 4,
      ...limits,
    },
    createBuffer(descriptor) {
      const storage = new ArrayBuffer(descriptor.size);
      const buffer = {
        descriptor: { ...descriptor },
        storage,
        destroys: 0,
        unmaps: 0,
        maps: 0,
        getMappedRange() { return storage; },
        unmap() {
          this.unmaps += 1;
          operations.push(["unmap", descriptor.label]);
        },
        mapAsync(mode) {
          this.maps += 1;
          operations.push(["mapAsync", descriptor.label, mode]);
          return mapAsync ? mapAsync(this, mode) : Promise.resolve();
        },
        destroy() {
          this.destroys += 1;
          operations.push(["destroy", descriptor.label]);
        },
      };
      buffers.push(buffer);
      operations.push(["createBuffer", descriptor.label, descriptor.usage]);
      return buffer;
    },
    createShaderModule(descriptor) {
      const module = { descriptor };
      shaderModules.push(module);
      operations.push(["createShaderModule", descriptor.label]);
      return module;
    },
    createComputePipeline(descriptor) {
      const layout = { kind: "ubo-compute-layout" };
      const pipeline = {
        descriptor,
        getBindGroupLayout(index) {
          assert.equal(index, 0);
          return layout;
        },
      };
      pipelines.push(pipeline);
      operations.push(["createComputePipeline", descriptor.label]);
      return pipeline;
    },
    createBindGroup(descriptor) {
      const bindGroup = { descriptor };
      bindGroups.push(bindGroup);
      operations.push(["createBindGroup", descriptor.label]);
      return bindGroup;
    },
    createCommandEncoder(descriptor) {
      const encoded = [];
      operations.push(["createCommandEncoder", descriptor.label]);
      const encoder = {
        copyBufferToBuffer(source, sourceOffset, destination, destinationOffset, size) {
          const operation = [
            "copy", source.descriptor.label, sourceOffset,
            destination.descriptor.label, destinationOffset, size,
          ];
          encoded.push(operation);
          operations.push(operation);
        },
        beginComputePass(passDescriptor) {
          const pass = [];
          encoded.push(["computePass", passDescriptor.label, pass]);
          operations.push(["beginComputePass", passDescriptor.label]);
          return {
            setPipeline(pipeline) {
              pass.push(["pipeline", pipeline]);
              operations.push(["setPipeline"]);
            },
            setBindGroup(index, bindGroup) {
              pass.push(["bindGroup", index, bindGroup]);
              operations.push(["setBindGroup", index]);
            },
            dispatchWorkgroups(x, y, z) {
              pass.push(["dispatch", x, y, z]);
              operations.push(["dispatch", x, y, z]);
            },
            end() {
              pass.push(["end"]);
              operations.push(["endComputePass"]);
            },
          };
        },
        finish() {
          const commandBuffer = { descriptor, encoded };
          commandBuffers.push(commandBuffer);
          operations.push(["finish"]);
          return commandBuffer;
        },
      };
      return encoder;
    },
  };
  return {
    device, lost, operations, buffers, shaderModules, pipelines, bindGroups,
    commandBuffers,
  };
}

function createManager(fake, options = {}) {
  return createWgpuUboComputeReconstruction({
    device: fake.device,
    slotSize: 8192,
    watchDeviceLoss: false,
    ...options,
  });
}

function registerRing(manager, size = 64 * 1024, resourceId = 7) {
  const buffer = { name: `ring-${resourceId}` };
  manager.registerResource({
    resourceId,
    role: WGPU_UBO_RING_ROLE,
    buffer,
    size,
    usage: STORAGE,
  });
  return buffer;
}

function bytes(resourceClass, fill = 0) {
  return new Uint8Array(CLASS_BYTES[resourceClass]).fill(fill);
}

test("compute behavior is strictly default-off at the URL boundary", () => {
  assert.equal(requestedWgpuUboComputeReconstruction("?wgpuubocompute=0"), false);
  assert.equal(requestedWgpuUboComputeReconstruction("?wgpuubocompute=1"), true);
  assert.equal(requestedWgpuUboComputeReconstruction("?wgpuubocompute=true"), false);
});

test("requires explicit device limits and the three storage bindings", () => {
  const fake = createFakeDevice({ limits: { maxStorageBuffersPerShaderStage: 2 } });
  assert.throws(() => createManager(fake), /maxStorageBuffersPerShaderStage/);
  const missing = createFakeDevice();
  delete missing.device.limits.maxComputeWorkgroupSizeX;
  assert.throws(() => createManager(missing), /maxComputeWorkgroupSizeX/);
});

test("creates three mapped staging slots, work buffers, and persistent class shadow", () => {
  const fake = createFakeDevice();
  const manager = createManager(fake);
  assert.equal(fake.buffers.length, 6);
  const staging = fake.buffers.filter((buffer) => buffer.descriptor.label.includes("staging"));
  const work = fake.buffers.filter((buffer) => buffer.descriptor.label.includes("work"));
  assert.equal(staging.length, 3);
  assert.ok(staging.every((buffer) =>
    buffer.descriptor.mappedAtCreation && (buffer.descriptor.usage & 0x0006) === 0x0006));
  assert.ok(work.every((buffer) => (buffer.descriptor.usage & 0x0088) === 0x0088));

  registerRing(manager);
  const shadow = fake.buffers.at(-1);
  assert.match(shadow.descriptor.label, /shadow 7/);
  assert.equal(shadow.descriptor.size, 5712);
  assert.ok((shadow.descriptor.usage & STORAGE) !== 0);
  assert.equal(manager.snapshot().registeredUboRings, 1);
});

test("never infers UBO identity from size and rejects malformed uploads", () => {
  const fake = createFakeDevice();
  const manager = createManager(fake);
  assert.throws(() => manager.registerResource({
    resourceId: 7,
    role: "BUFFER",
    buffer: {},
    size: 64 * 1024,
    usage: STORAGE,
  }), /explicit UBO_RING/);
  assert.deepEqual(manager.stage({
    resourceId: 7,
    resourceClass: "VS",
    destinationOffset: 0,
    bytes: bytes("VS"),
  }), { ok: false, reason: "unregistered-ubo-ring" });
  registerRing(manager);
  assert.deepEqual(manager.stage({
    resourceId: 7,
    resourceClass: "VS",
    destinationOffset: 0,
    bytes: bytes("PS"),
  }), { ok: false, reason: "invalid-upload" });
  assert.deepEqual(manager.stage({
    resourceId: 7,
    resourceClass: "GS",
    destinationOffset: 65520,
    bytes: bytes("GS"),
  }), { ok: false, reason: "invalid-upload" });
});

test("unrelated resources do not retire the UBO ring and active retirement is deferred", async () => {
  const fake = createFakeDevice();
  const manager = createManager(fake);
  registerRing(manager);
  const shadow = fake.buffers.at(-1);
  assert.equal(manager.hasResource(7), true);
  assert.equal(manager.hasResource(99), false);
  assert.equal(manager.unregisterResource(99), false);
  assert.equal(manager.hasResource(7), true);
  assert.equal(shadow.destroys, 0);

  manager.stage({
    resourceId: 7,
    resourceClass: "GS",
    destinationOffset: 0,
    bytes: bytes("GS", 0x2a),
  });
  const completion = deferred();
  const accepted = manager.accept(manager.seal(), completion.promise);
  assert.equal(manager.snapshot().activeBatches, 1);
  assert.equal(manager.unregisterResource(7), true);
  assert.equal(manager.hasResource(7), false);
  assert.equal(shadow.destroys, 0, "shadow remains alive for submitted GPU work");
  completion.resolve();
  assert.equal(await accepted, true);
  await Promise.resolve();
  assert.equal(shadow.destroys, 1);
});

test("encodes package copy immediately before one ordered 64-lane dispatch", async () => {
  const fake = createFakeDevice();
  const manager = createManager(fake);
  const ring = registerRing(manager);
  assert.equal(manager.stage({
    resourceId: 7, resourceClass: "VS", destinationOffset: 256, bytes: bytes("VS", 0x41),
  }).ok, true);
  const batch = manager.seal();
  assert.equal(batch.ok, true);
  assert.equal(batch.packageCount, 1);
  assert.deepEqual(batch.commandBuffer.encoded.map((operation) => operation[0]), [
    "copy", "computePass",
  ]);
  const dispatch = batch.commandBuffer.encoded[1][2].find((operation) => operation[0] === "dispatch");
  assert.deepEqual(dispatch, ["dispatch", 1, 1, 1]);
  const binding = fake.bindGroups[0].descriptor.entries;
  assert.match(binding[0].resource.buffer.descriptor.label, /work 0/);
  assert.match(binding[1].resource.buffer.descriptor.label, /shadow 7/);
  assert.equal(binding[2].resource.buffer, ring);
  const shader = fake.shaderModules[0].descriptor.code;
  assert.match(shader, /@workgroup_size\(64\)/);
  assert.match(shader, /storageBarrier\(\)/);
  assert.match(shader, /for \(var record_index/);
  await manager.accept(batch);
  assert.equal(manager.snapshot().batchesCompleted, 1);
});

test("stages producer package bytes unchanged without JS re-encoding", async () => {
  const fake = createFakeDevice();
  const manager = createManager(fake);
  registerRing(manager);
  const encoded = encodeWgpuUboComputePackage({
    uploads: [{
      resourceId: 7,
      resourceClass: "GS",
      destinationOffset: 256,
      bytes: bytes("GS", 0x5c),
    }],
  });
  const staged = manager.stageEncodedPackage({
    resourceId: 7,
    packageBytes: encoded.bytes,
  });
  assert.equal(staged.ok, true);
  const staging = fake.buffers.find((buffer) =>
    buffer.descriptor.label === "Dolphin UBO compute staging 0");
  assert.deepEqual(
    new Uint8Array(staging.storage, 0, encoded.packageBytes),
    encoded.bytes
  );
  const batch = manager.seal();
  assert.equal(batch.producerEncoded, true);
  assert.equal(batch.packageCount, 1);
  assert.equal(batch.recordCount, 1);
  await manager.accept(batch);
  const snapshot = manager.snapshot();
  assert.equal(snapshot.producerPackagesStaged, 1);
  assert.equal(snapshot.producerRecordsStaged, 1);
  assert.equal(snapshot.producerFullRecords, 1);
  assert.equal(snapshot.packagesEncoded, 0, "consumer did not build a package");
});

test("producer DELTA requires an accepted FULL in the current generation", async () => {
  const fake = createFakeDevice();
  const manager = createManager(fake);
  registerRing(manager);
  const initial = bytes("GS", 0x10);
  const changed = initial.slice();
  changed.fill(0x20, 16, 32);
  const full = encodeWgpuUboComputePackage({
    uploads: [{ resourceId: 7, resourceClass: "GS", destinationOffset: 0, bytes: initial }],
  });
  const delta = encodeWgpuUboComputePackage({
    uploads: [{ resourceId: 7, resourceClass: "GS", destinationOffset: 64, bytes: changed }],
    shadows: full.nextShadows,
  });
  assert.equal(manager.stageEncodedPackage({
    resourceId: 7,
    packageBytes: delta.bytes,
  }).ok, false);
  assert.equal(manager.stageEncodedPackage({
    resourceId: 7,
    packageBytes: full.bytes,
  }).ok, true);
  await manager.accept(manager.seal());
  assert.equal(manager.stageEncodedPackage({
    resourceId: 7,
    packageBytes: delta.bytes,
  }).ok, true);
  await manager.accept(manager.seal());
  manager.reset("save-state-load");
  const afterReset = manager.stageEncodedPackage({
    resourceId: 7,
    packageBytes: delta.bytes,
  });
  assert.deepEqual(
    { ok: afterReset.ok, reason: afterReset.reason },
    { ok: false, reason: "package-validation" }
  );
});

test("splits resource changes into ordered copy-dispatch package pairs", async () => {
  const fake = createFakeDevice();
  const manager = createManager(fake);
  registerRing(manager, 64 * 1024, 7);
  registerRing(manager, 64 * 1024, 8);
  manager.stage({ resourceId: 7, resourceClass: "GS", destinationOffset: 0, bytes: bytes("GS", 1) });
  manager.stage({ resourceId: 8, resourceClass: "GS", destinationOffset: 64, bytes: bytes("GS", 2) });
  manager.stage({ resourceId: 7, resourceClass: "GS", destinationOffset: 128, bytes: bytes("GS", 3) });
  const batch = manager.seal();
  assert.equal(batch.packageCount, 3);
  assert.deepEqual(batch.commandBuffer.encoded.map((operation) => operation[0]), [
    "copy", "computePass", "copy", "computePass", "copy", "computePass",
  ]);
  await manager.accept(batch);
});

test("accept commits codec shadow while pre-submit reject does not", async () => {
  const rejectedFake = createFakeDevice();
  const rejected = createManager(rejectedFake);
  registerRing(rejected);
  rejected.stage({ resourceId: 7, resourceClass: "GS", destinationOffset: 0, bytes: bytes("GS", 4) });
  const firstRejected = rejected.seal();
  await rejected.reject(firstRejected, "legacy-fallback");
  rejected.stage({ resourceId: 7, resourceClass: "GS", destinationOffset: 64, bytes: bytes("GS", 4) });
  const secondRejected = rejected.seal();
  const rejectedStaging = rejectedFake.buffers.find((buffer) =>
    buffer.descriptor.label === "Dolphin UBO compute staging 0");
  assert.equal(new DataView(rejectedStaging.storage).getUint32(32, true), 0, "FULL after reject");
  await rejected.reject(secondRejected);

  const acceptedFake = createFakeDevice();
  const accepted = createManager(acceptedFake);
  registerRing(accepted);
  accepted.stage({ resourceId: 7, resourceClass: "GS", destinationOffset: 0, bytes: bytes("GS", 4) });
  await accepted.accept(accepted.seal());
  accepted.stage({ resourceId: 7, resourceClass: "GS", destinationOffset: 64, bytes: bytes("GS", 4) });
  const equalBatch = accepted.seal();
  const acceptedStaging = acceptedFake.buffers.find((buffer) =>
    buffer.descriptor.label === "Dolphin UBO compute staging 0");
  assert.equal(new DataView(acceptedStaging.storage).getUint32(32, true), 2, "EQUAL after accept");
  await accepted.accept(equalBatch);
});

test("submission completion rejection permanently invalidates the manager", async () => {
  const fake = createFakeDevice();
  const manager = createManager(fake);
  registerRing(manager);
  manager.stage({ resourceId: 7, resourceClass: "GS", destinationOffset: 0, bytes: bytes("GS") });
  const completion = deferred();
  const accepted = manager.accept(manager.seal(), completion.promise);
  completion.reject(new Error("queue failed"));
  assert.equal(await accepted, false);
  assert.equal(manager.snapshot().failed, true);
  assert.match(manager.snapshot().lastError, /submission-or-remap-rejected:queue failed/);
  assert.throws(() => manager.stage({}), /invalid/);
});

test("reset destroys stale internal state and starts with fresh FULL shadows", async () => {
  const fake = createFakeDevice();
  const manager = createManager(fake);
  registerRing(manager);
  manager.stage({ resourceId: 7, resourceClass: "GS", destinationOffset: 0, bytes: bytes("GS", 9) });
  await manager.accept(manager.seal());
  const buffersBefore = fake.buffers.length;
  manager.reset("save-state-load");
  assert.ok(fake.buffers.slice(0, buffersBefore).every((buffer) => buffer.destroys === 1));
  assert.equal(fake.buffers.length, buffersBefore + 7, "three staging, three work, one shadow");
  manager.stage({ resourceId: 7, resourceClass: "GS", destinationOffset: 64, bytes: bytes("GS", 9) });
  const batch = manager.seal();
  const freshStaging = fake.buffers.findLast((buffer) =>
    buffer.descriptor.label === "Dolphin UBO compute staging 0");
  assert.equal(new DataView(freshStaging.storage).getUint32(32, true), 0);
  assert.deepEqual(manager.snapshot().resetReasons, { "save-state-load": 1 });
  await manager.accept(batch);
});

test("capacity failure occurs before unmapping or command encoding", () => {
  const fake = createFakeDevice();
  const manager = createManager(fake, { slotCount: 1, slotSize: 256 });
  registerRing(manager);
  manager.stage({ resourceId: 7, resourceClass: "VS", destinationOffset: 0, bytes: bytes("VS", 1) });
  const encodersBefore = fake.commandBuffers.length;
  assert.deepEqual(manager.seal(), { ok: false, reason: "no-mapped-capacity" });
  assert.equal(fake.commandBuffers.length, encodersBefore);
  const staging = fake.buffers.find((buffer) => buffer.descriptor.label.includes("staging"));
  assert.equal(staging.unmaps, 0);
  assert.equal(manager.snapshot().pendingUploads, 1);
});

test("snapshot exposes stable reconstruction accounting", async () => {
  const fake = createFakeDevice();
  const manager = createManager(fake);
  registerRing(manager);
  manager.stage({ resourceId: 7, resourceClass: "GS", destinationOffset: 0, bytes: bytes("GS", 7) });
  const batch = manager.seal();
  await manager.accept(batch);
  const snapshot = manager.snapshot();
  assert.equal(snapshot.schema, WGPU_UBO_COMPUTE_RECONSTRUCTION_SCHEMA);
  assert.equal(snapshot.stagedUploads, 1);
  assert.equal(snapshot.stagedLogicalBytes, 64);
  assert.equal(snapshot.packagesEncoded, 1);
  assert.equal(snapshot.copiesEncoded, 1);
  assert.equal(snapshot.dispatchesEncoded, 1);
  assert.equal(snapshot.batchesAccepted, 1);
  assert.equal(snapshot.remapsCompleted, 1);
  assert.equal(snapshot.failed, false);
});
