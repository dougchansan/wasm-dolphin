// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  WgpuRendererRuntime,
  failWgpuRingDescriptor,
} from "../src/wgpu-renderer-runtime.js";
import {
  WGPU_CONSUMER_ERROR_DEVICE_LOST,
  WGPU_CONSUMER_STATE_FAILED,
  WGPU_CONSUMER_STATE_RUNNING,
  WGPU_PROTOCOL_NON_DROPPING_FLAG,
} from "../src/wgpu-ring-backpressure.js";
import {
  WGPU_UPLOAD_WATERMARK_PROTOCOL_FLAG,
} from "../src/wgpu-upload-watermark.js";

function ringFixture({
  protocolVersion = 3,
  capacity = 8,
  writeIndex = 0,
  readIndex = 0,
  uploadRead = 0,
  bytes = 4096,
} = {}) {
  const heapBuffer = new SharedArrayBuffer(bytes);
  const headerPtr = 0;
  const headerWords = protocolVersion === 3 ? 7 : 5;
  const slotsPtr = 64;
  const uploadPtr = slotsPtr + capacity * 32;
  const uploadSize = bytes - uploadPtr;
  const header = new Int32Array(heapBuffer, headerPtr, headerWords);
  Atomics.store(header, 0, writeIndex | 0);
  Atomics.store(header, 1, readIndex | 0);
  Atomics.store(header, 2, capacity | 0);
  Atomics.store(header, 3, uploadRead | 0);
  return {
    heapBuffer,
    descriptor: {
      headerPtr,
      headerWords,
      slotsPtr,
      capacity,
      uploadPtr,
      uploadSize,
      protocolVersion,
    },
    header,
  };
}

function attach(runtime, fixture, {
  sessionId = "session-a",
  heapGeneration = 1,
} = {}) {
  return runtime.attachRing({
    sessionId,
    heapGeneration,
    heapBuffer: fixture.heapBuffer,
    descriptor: fixture.descriptor,
  });
}

test("protocol v2 and v3 attachments enable their exact ownership contracts", () => {
  for (const protocolVersion of [2, 3]) {
    const runtime = new WgpuRendererRuntime();
    const fixture = ringFixture({
      protocolVersion,
      writeIndex: 19,
      readIndex: 7,
      uploadRead: 512,
    });
    const ring = attach(runtime, fixture);
    assert.equal(ring.protocolVersion, protocolVersion);
    assert.equal(runtime.currentReadIndex(), 7);
    assert.equal(runtime.currentUploadReadIndex(), 512);
    assert.equal(
      Atomics.load(fixture.header, 4) & WGPU_UPLOAD_WATERMARK_PROTOCOL_FLAG,
      WGPU_UPLOAD_WATERMARK_PROTOCOL_FLAG
    );
    if (protocolVersion === 3) {
      assert.equal(ring.protocolV3Enabled, true);
      assert.equal(Atomics.load(fixture.header, 5), WGPU_CONSUMER_STATE_RUNNING);
      assert.equal(
        Atomics.load(fixture.header, 4) & WGPU_PROTOCOL_NON_DROPPING_FLAG,
        WGPU_PROTOCOL_NON_DROPPING_FLAG
      );
    } else {
      assert.equal(ring.protocolV3Enabled, false);
    }
  }
});

test("attachment rejects invalid protocol, bounds, alignment, capacity, and header identity", () => {
  const cases = [
    ["protocol", (fixture) => { fixture.descriptor.protocolVersion = 1; }],
    ["headerWords", (fixture) => { fixture.descriptor.headerWords = 4; }],
    ["headerPtr", (fixture) => { fixture.descriptor.headerPtr = 2; }],
    ["slotsPtr", (fixture) => { fixture.descriptor.slotsPtr = 66; }],
    ["uploadPtr", (fixture) => { fixture.descriptor.uploadPtr += 2; }],
    ["capacity", (fixture) => { fixture.descriptor.capacity = 0; }],
    ["slots", (fixture) => { fixture.descriptor.capacity = 1_000_000; }],
    ["upload", (fixture) => { fixture.descriptor.uploadSize = fixture.heapBuffer.byteLength; }],
    ["capacity mismatch", (fixture) => { Atomics.store(fixture.header, 2, 9); }],
  ];
  for (const [label, mutate] of cases) {
    const runtime = new WgpuRendererRuntime();
    const fixture = ringFixture();
    mutate(fixture);
    assert.throws(() => attach(runtime, fixture), undefined, label);
  }
  assert.throws(
    () => new WgpuRendererRuntime().attachRing({
      sessionId: "session-a",
      heapGeneration: 1,
      heapBuffer: new ArrayBuffer(4096),
      descriptor: ringFixture().descriptor,
    }),
    /SharedArrayBuffer/
  );
});

test("session and heap-generation guards reject duplicate or stale ownership", () => {
  const runtime = new WgpuRendererRuntime();
  const first = ringFixture();
  attach(runtime, first, { sessionId: "session-a", heapGeneration: 4 });
  assert.throws(() => attach(runtime, first, {
    sessionId: "session-a",
    heapGeneration: 4,
  }), /already attached/);

  runtime.detach();
  assert.throws(() => attach(runtime, ringFixture(), {
    sessionId: "session-a",
    heapGeneration: 4,
  }), /newer heap generation/);
  assert.throws(() => attach(runtime, ringFixture(), {
    sessionId: "session-a",
    heapGeneration: 3,
  }), /newer heap generation/);

  attach(runtime, ringFixture(), { sessionId: "session-a", heapGeneration: 5 });
  runtime.detach();
  assert.doesNotThrow(() => attach(runtime, ringFixture(), {
    sessionId: "session-b",
    heapGeneration: 1,
  }));
});

test("ring identity distinguishes duplicate notifications from replacement attempts", () => {
  const runtime = new WgpuRendererRuntime();
  const fixture = ringFixture();
  attach(runtime, fixture);
  assert.equal(runtime.matchesRing({
    heapBuffer: fixture.heapBuffer,
    descriptor: fixture.descriptor,
  }), true);
  assert.equal(runtime.matchesRing({
    heapBuffer: fixture.heapBuffer,
    descriptor: { ...fixture.descriptor, uploadSize: fixture.descriptor.uploadSize - 4 },
  }), false);
  assert.equal(runtime.matchesRing({
    heapBuffer: ringFixture().heapBuffer,
    descriptor: fixture.descriptor,
  }), false);
});

test("worker ring handoff keeps duplicates idempotent and rejects replacements", async () => {
  const worker = await readFile(
    new URL("../src/upstream-discio-worker.js", import.meta.url),
    "utf8"
  );
  const handler = worker.slice(
    worker.indexOf("function handleWebGpuCmdRing"),
    worker.indexOf("function currentWgpuReadIndex")
  );
  const ownershipBranch = handler.slice(
    handler.indexOf("if (wgpuRendererRuntime.ring)"),
    handler.indexOf("if (wgpuRendererHeapBuffer !== heap.buffer)")
  );
  assert.match(ownershipBranch, /wgpuRendererRuntime\.matchesRing/);
  assert.match(ownershipBranch, /duplicate attachment ignored[\s\S]*?return;/);
  assert.match(ownershipBranch, /failWgpuRingDescriptor/);
  assert.match(ownershipBranch, /markWgpuReplayFatal\("webgpu-command-ring-ownership"/);
  assert.doesNotMatch(ownershipBranch, /webGpuCmdRing\s*=/);
  assert.equal(
    (handler.match(/webGpuCmdRing\s*=\s*wgpuRendererRuntime\.attachRing/g) || []).length,
    1
  );
});

test("read and upload publication preserve exact unsigned header values", () => {
  const runtime = new WgpuRendererRuntime();
  const fixture = ringFixture({ readIndex: 0xfffffff0, uploadRead: 16 });
  attach(runtime, fixture);
  assert.equal(runtime.publishReadIndex(0xfffffff8), 0xfffffff8);
  assert.equal(runtime.currentReadIndex(), 0xfffffff8);
  assert.equal(Atomics.load(fixture.header, 1) >>> 0, 0xfffffff8);

  const published = runtime.publishUploadRead(
    fixture.descriptor.uploadPtr + 16,
    32
  );
  assert.equal(published, 48);
  assert.equal(runtime.currentUploadReadIndex(), 48);
  assert.equal(Atomics.load(fixture.header, 3) >>> 0, 48);
});

test("detach can fail a protocol-v3 producer before releasing local ownership", () => {
  const runtime = new WgpuRendererRuntime();
  const fixture = ringFixture();
  attach(runtime, fixture);
  assert.equal(runtime.emergencyFail(WGPU_CONSUMER_ERROR_DEVICE_LOST), true);
  assert.equal(Atomics.load(fixture.header, 5), WGPU_CONSUMER_STATE_FAILED);
  assert.equal(Atomics.load(fixture.header, 6), WGPU_CONSUMER_ERROR_DEVICE_LOST);
  const detached = runtime.detach();
  assert.equal(detached.sessionId, "session-a");
  assert.equal(runtime.snapshot().registered, false);
});

test("descriptor rejection wakes protocol-v3 producers without adopting the ring", () => {
  const fixture = ringFixture();
  assert.equal(failWgpuRingDescriptor({
    heapBuffer: fixture.heapBuffer,
    descriptor: fixture.descriptor,
    errorCode: WGPU_CONSUMER_ERROR_DEVICE_LOST,
  }), true);
  assert.equal(Atomics.load(fixture.header, 5), WGPU_CONSUMER_STATE_FAILED);
  assert.equal(Atomics.load(fixture.header, 6), WGPU_CONSUMER_ERROR_DEVICE_LOST);
  assert.equal(failWgpuRingDescriptor({
    heapBuffer: fixture.heapBuffer,
    descriptor: fixture.descriptor,
  }), false);
  assert.equal(Atomics.load(fixture.header, 6), WGPU_CONSUMER_ERROR_DEVICE_LOST);

  const legacy = ringFixture({ protocolVersion: 2 });
  assert.equal(failWgpuRingDescriptor({
    heapBuffer: legacy.heapBuffer,
    descriptor: legacy.descriptor,
  }), false);
});

test("detach requires quiescence or an explicit protocol-v3 failure", () => {
  const backlogRuntime = new WgpuRendererRuntime();
  const backlog = ringFixture({ writeIndex: 2, readIndex: 1 });
  attach(backlogRuntime, backlog);
  assert.throws(() => backlogRuntime.detach(), /quiescent/);
  assert.equal(backlogRuntime.snapshot().registered, true);
  assert.doesNotThrow(() => backlogRuntime.detach({ fail: true }));
  assert.equal(Atomics.load(backlog.header, 5), WGPU_CONSUMER_STATE_FAILED);

  const heldRuntime = new WgpuRendererRuntime();
  const heldRing = attach(heldRuntime, ringFixture());
  heldRing.heldReplayStart = 0;
  assert.throws(() => heldRuntime.detach(), /quiescent/);

  let pendingMappedUploads = 1;
  const mappedRuntime = new WgpuRendererRuntime({
    mappedSnapshot: () => ({ pendingUploads: pendingMappedUploads }),
  });
  attach(mappedRuntime, ringFixture());
  assert.throws(() => mappedRuntime.detach(), /quiescent/);
  pendingMappedUploads = 0;
  assert.doesNotThrow(() => mappedRuntime.detach());

  const legacyRuntime = new WgpuRendererRuntime();
  attach(legacyRuntime, ringFixture({ protocolVersion: 2 }));
  assert.throws(
    () => legacyRuntime.detach({ fail: true }),
    /protocol-v2/
  );
  assert.equal(legacyRuntime.snapshot().registered, true);
  assert.doesNotThrow(() => legacyRuntime.detach());
});

test("a fatal dependency forbids later attachment", () => {
  const runtime = new WgpuRendererRuntime({
    fatal: () => ({ scope: "attach", detail: "malformed descriptor" }),
  });
  assert.throws(() => attach(runtime, ringFixture()), /fatal replay state/);
});

test("quiescence drains to stable empty, finalizes mapped work, and awaits GPU completion", async () => {
  let now = 0;
  let mappedFinalizations = 0;
  let gpuCompletions = 0;
  const fixture = ringFixture({ writeIndex: 4, readIndex: 0 });
  const runtime = new WgpuRendererRuntime({
    now: () => now,
    delay: async (milliseconds) => { now += milliseconds; },
    coreState: () => "Paused",
    drain: ({ writeIndex }) => runtime.publishReadIndex(writeIndex),
    mappedSnapshot: () => ({
      pendingUploads: 0,
      activeBatches: 0,
      pendingRemaps: 0,
      capacityBlocked: false,
      timerPending: false,
    }),
    finalizeMapped: async () => { mappedFinalizations += 1; },
    queue: () => ({
      onSubmittedWorkDone: async () => { gpuCompletions += 1; },
    }),
  });
  attach(runtime, fixture);
  const result = await runtime.quiesce(100, { requireRing: true });
  assert.equal(result.quiesced, true);
  assert.equal(result.initial.backlog, 4);
  assert.equal(result.backlog, 0);
  assert.equal(result.readIndex, 4);
  assert.equal(result.publishedReadIndex, 4);
  assert.equal(result.drainCount, 1);
  assert.ok(result.stableEmptyObservations >= 2);
  assert.ok(result.stableEmptyMs >= 50);
  assert.equal(result.gpuCompletion.completed, true);
  assert.equal(result.coreStateName, "Paused");
  assert.ok(mappedFinalizations > 0);
  assert.equal(gpuCompletions, 1);
});

test("mapped pending work prevents stability until the injected finalizer clears it", async () => {
  let now = 0;
  let pending = 1;
  const runtime = new WgpuRendererRuntime({
    now: () => now,
    delay: async (milliseconds) => { now += milliseconds; },
    coreState: () => "Paused",
    mappedSnapshot: () => ({ pendingUploads: pending }),
    finalizeMapped: async () => { pending = 0; },
  });
  attach(runtime, ringFixture());
  const result = await runtime.quiesce(100);
  assert.equal(result.initial.pendingMappedUploads, 1);
  assert.equal(result.pendingMappedUploads, 0);
  assert.equal(result.quiesced, true);
});

test("snapshot preserves every replay and mapped-work blocker", () => {
  let fatal = null;
  const runtime = new WgpuRendererRuntime({
    loadFenceActive: () => true,
    fatal: () => fatal,
    mappedSnapshot: () => ({
      pendingUploads: 3,
      mapped: { activeBatches: 2 },
      compute: { activeBatches: 1 },
      pendingRemaps: 4,
      capacityBlocked: true,
      timerPending: true,
    }),
  });
  const fixture = ringFixture({ writeIndex: 9, readIndex: 7, uploadRead: 128 });
  const ring = attach(runtime, fixture);
  fatal = { scope: "submit", detail: "lost" };
  ring.stagedUploads.set(8, { data: new Uint8Array([1]) });
  ring.heldReplayStart = 8;
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.backlog, 2);
  assert.equal(snapshot.uploadReadIndex, 128);
  assert.equal(snapshot.stagedUploads, 1);
  assert.equal(snapshot.heldReplay, true);
  assert.equal(snapshot.loadFenceActive, true);
  assert.equal(snapshot.pendingMappedUploads, 3);
  assert.equal(snapshot.activeMappedBatches, 3);
  assert.equal(snapshot.pendingRemaps, 4);
  assert.equal(snapshot.capacityBlocked, true);
  assert.equal(snapshot.mappedDrainTimerPending, true);
  assert.equal(snapshot.fatal, fatal);
});

test("quiescence fails closed for missing ring, non-paused core, GPU rejection, and timeout", async () => {
  await assert.rejects(
    new WgpuRendererRuntime({ coreState: () => "Paused" }).quiesce(10, { requireRing: true }),
    /registered command ring/
  );

  const running = new WgpuRendererRuntime({ coreState: () => "Running" });
  attach(running, ringFixture());
  await assert.rejects(running.quiesce(10), /paused core/);

  let now = 0;
  const rejection = new Error("device lost");
  const rejected = new WgpuRendererRuntime({
    now: () => now,
    delay: async (milliseconds) => { now += milliseconds; },
    coreState: () => "Paused",
    queue: () => ({ onSubmittedWorkDone: () => Promise.reject(rejection) }),
  });
  attach(rejected, ringFixture());
  await assert.rejects(rejected.quiesce(100, { requireRing: true }), rejection);

  now = 0;
  const timedOut = new WgpuRendererRuntime({
    now: () => now,
    delay: async (milliseconds) => { now += milliseconds; },
    coreState: () => "Paused",
    mappedSnapshot: () => ({ pendingUploads: 1 }),
    finalizeMapped: async () => {},
  });
  attach(timedOut, ringFixture());
  await assert.rejects(timedOut.quiesce(20), /timed out/);
});

test("a post-completion producer write invalidates the fence", async () => {
  let now = 0;
  const fixture = ringFixture({ writeIndex: 2, readIndex: 2 });
  const runtime = new WgpuRendererRuntime({
    now: () => now,
    delay: async (milliseconds) => { now += milliseconds; },
    coreState: () => "Paused",
    queue: () => ({
      onSubmittedWorkDone: async () => {
        Atomics.store(fixture.header, 0, 3);
      },
    }),
  });
  attach(runtime, fixture);
  await assert.rejects(
    runtime.quiesce(100, { requireRing: true }),
    /changed during GPU completion/
  );
});
