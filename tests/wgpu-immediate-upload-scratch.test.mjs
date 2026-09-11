// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const worker = await readFile(
  new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8"
);
const helperStart = worker.indexOf("function copyWgpuUploadPayload(");
const helperEnd = worker.indexOf("function stageHeldWgpuUploads(", helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, "worker upload helper region exists");
const helper = worker.slice(helperStart, helperEnd);
const CAP = 4 * 1024 * 1024;
function harness() {
  const context = vm.createContext({});
  vm.runInContext(helper, context);
  const fallback = context.copyWgpuUploadPayload;
  const fallbackCalls = [];
  context.copyWgpuUploadPayload = (...args) => {
    fallbackCalls.push(args);
    return fallback(...args);
  };
  return {
    context, fallback, fallbackCalls,
    copy: context.copyImmediateWgpuBufferUpload,
    capacity: () => vm.runInContext("wgpuImmediateBufferScratch.byteLength", context),
  };
}
function expected(heap, pointer, bytes) {
  return [...heap.subarray(pointer, pointer + bytes), ...Array((4 - bytes % 4) % 4).fill(0)];
}

test("ordinary and shared heaps produce independent exact-length padded payloads", () => {
  for (const BufferType of [ArrayBuffer, SharedArrayBuffer]) {
    const h = harness();
    const backing = new BufferType(4096);
    const heap = new Uint8Array(backing, 8, 4080);
    for (let i = 0; i < heap.length; i++) heap[i] = (i * 29 + 7) & 255;
    const before = [...heap];
    for (const bytes of [0, 1, 2, 3, 4, 5, 7, 8, 255, 256, 257, 1025]) {
      const payload = h.copy(heap, 11, bytes);
      assert.deepEqual([...payload], expected(heap, 11, bytes));
      assert.equal(payload.byteLength, Math.ceil(bytes / 4) * 4);
      assert.equal(Object.prototype.toString.call(payload.buffer), "[object ArrayBuffer]");
      assert.notEqual(payload.buffer, heap.buffer);
      assert.equal(payload.byteOffset, 0);
      assert.ok(payload.buffer.byteLength <= CAP);
    }
    assert.deepEqual([...heap], before, "source bytes are never changed");
  }
});

test("reuse clears every padding byte left dirty by a preceding longer upload", () => {
  const h = harness();
  const heap = new Uint8Array(32).fill(0xff);
  const first = h.copy(heap, 0, 16);
  for (const bytes of [1, 2, 3, 5, 6, 7]) {
    heap.fill(0x35);
    const next = h.copy(heap, 1, bytes);
    assert.equal(next.buffer, first.buffer);
    assert.deepEqual([...next], [...Array(bytes).fill(0x35), ...Array((4 - bytes % 4) % 4).fill(0)]);
    heap.fill(0xff);
    h.copy(heap, 0, 16);
  }
});

test("scratch grows geometrically, retains bounded capacity, and returns only the requested view", () => {
  const h = harness();
  const heap = new Uint8Array(CAP + 16).fill(0x62);
  assert.equal(h.copy(heap, 0, 0).byteLength, 0);
  assert.equal(h.capacity(), 0, "empty upload does not allocate backing storage");
  const first = h.copy(heap, 0, 256);
  assert.equal(h.capacity(), 256);
  assert.equal(h.copy(heap, 0, 4).buffer, first.buffer);
  const grown = h.copy(heap, 0, 257);
  assert.equal(grown.byteLength, 260);
  assert.equal(h.capacity(), 512);
  assert.notEqual(grown.buffer, first.buffer);
  const maximum = h.copy(heap, 0, CAP);
  assert.equal(h.capacity(), CAP);
  const short = h.copy(heap, 0, 3);
  assert.equal(short.buffer, maximum.buffer);
  assert.equal(short.byteLength, 4, "writeBuffer receives a short view, not the full capacity");
});

test("oversize uploads use the original helper without growing or corrupting retained scratch", () => {
  const h = harness();
  const heap = new Uint8Array(new SharedArrayBuffer(CAP + 32)).fill(0x74);
  const small = h.copy(heap, 0, 4);
  const beforeCapacity = h.capacity();
  const large = h.copy(heap, 5, CAP + 1);
  assert.equal(h.fallbackCalls.length, 1);
  assert.equal(h.fallbackCalls[0][3], true, "fallback keeps four-byte padding");
  assert.equal(large.byteLength, CAP + 4);
  assert.deepEqual([...large.subarray(-5)], [0x74, 0x74, 0, 0, 0]);
  assert.notEqual(large.buffer, small.buffer);
  assert.equal(h.capacity(), beforeCapacity);
  const snapshot = [...large.subarray(0, 12)];
  heap.fill(0x21, 0, 12);
  const next = h.copy(heap, 0, 12);
  assert.equal(next.buffer, small.buffer);
  assert.deepEqual([...large.subarray(0, 12)], snapshot);
});

test("truncated spans retain the original helper behavior rather than exposing stale scratch bytes", () => {
  const h = harness();
  const heap = Uint8Array.from({ length: 16 }, (_, i) => i);
  h.copy(heap, 0, 16);
  for (const bytes of [3, 4]) {
    assert.deepEqual([...h.copy(heap, 14, bytes)], [...h.fallback(heap, 14, bytes, true)]);
  }
  assert.equal(h.fallbackCalls.length, 2);
});

test("actual immediate replay snapshots each write before scratch reuse and preserves held payload ownership", () => {
  const h = harness();
  const startCase = worker.indexOf("case WGPU_CMD_OP_UPLOAD_BUFFER: {");
  const start = worker.indexOf("let uploadPayload = stagedUpload?.data;", startCase);
  const marker = "q.writeBuffer(buf, u32[recWord + 2] & ~3, uploadPayload);";
  const end = worker.indexOf(marker, start) + marker.length;
  assert.ok(start > startCase && end > start);
  const events = [], writes = [];
  let writing = false;
  const copy = h.context.copyImmediateWgpuBufferUpload;
  h.context.copyImmediateWgpuBufferUpload = (...args) => {
    assert.equal(writing, false, "reuse must occur after the previous synchronous write returns");
    events.push("copy");
    return copy(...args);
  };
  h.context.queue = {
    writeBuffer(buffer, offset, payload) {
      writing = true;
      events.push("write-start");
      writes.push({ buffer, offset, bytes: Uint8Array.from(payload) });
      writing = false;
      events.push("write-return");
    },
  };
  h.context.destination = {};
  const replay = vm.runInContext(`(function(heap, srcP, uploadBytes, stagedUpload = null) {
    const causalMetricsEnabled = false, recWord = 0;
    const q = queue, buf = destination, u32 = new Uint32Array([0, 0, 11]);
    ${worker.slice(start, end)}
    return uploadPayload;
  })`, h.context);
  const heap = new Uint8Array(new SharedArrayBuffer(128));
  heap.fill(0x12);
  const held = h.fallback(heap, 4, 5, true);
  const first = replay(heap, 4, 5);
  heap.fill(0x93);
  const second = replay(heap, 8, 9);
  assert.equal(first.buffer, second.buffer);
  assert.deepEqual([...writes[0].bytes], [0x12, 0x12, 0x12, 0x12, 0x12, 0, 0, 0]);
  assert.deepEqual([...writes[1].bytes], [...Array(9).fill(0x93), 0, 0, 0]);
  assert.equal(writes[0].offset, 8, "existing destination alignment is unchanged");
  assert.deepEqual(events, ["copy", "write-start", "write-return", "copy", "write-start", "write-return"]);
  events.length = 0;
  const reusedHeld = replay(heap, 4, 5, { data: held });
  assert.equal(reusedHeld, held, "staged upload keeps its owning allocation");
  assert.deepEqual(events, ["write-start", "write-return"]);
  replay(heap, 0, 64);
  assert.deepEqual([...held], [0x12, 0x12, 0x12, 0x12, 0x12, 0, 0, 0]);
  assert.deepEqual([...writes[2].bytes], [...held]);
});

