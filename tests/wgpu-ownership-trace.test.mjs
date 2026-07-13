// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  WGPU_OWNERSHIP_TRACE_HEADER_WORDS,
  WGPU_OWNERSHIP_TRACE_RECORD_WORDS,
  WGPU_OWNERSHIP_TRACE_SCHEMA,
  attachWgpuOwnershipTraceFromApi,
  createWgpuOwnershipTrace,
  requestedWgpuOwnershipTrace,
} from "../src/wgpu-ownership-trace.js";

test("ownership trace URL request is exact and default-off", () => {
  assert.equal(requestedWgpuOwnershipTrace(""), false);
  assert.equal(requestedWgpuOwnershipTrace("?wgpuownershiptrace=0"), false);
  assert.equal(requestedWgpuOwnershipTrace("?wgpuownershiptrace=1"), true);
  assert.equal(requestedWgpuOwnershipTrace("?wgpuownershiptrace=true"), false);
});

test("native setter and descriptor getters attach the real contiguous ABI", () => {
  const fixture = makeRing(4, { write: 1, epoch: 3 });
  writeRecord(fixture, 0, [2, 3, 7, 11, 6, 99, 128, 1]);
  const calls = [];
  const trace = createWgpuOwnershipTrace();
  const descriptor = attachWgpuOwnershipTraceFromApi(trace, {
    setWebGpuOwnershipTraceEnabled(value) { calls.push(["set", value]); },
    getWebGpuOwnershipTracePtr() { calls.push(["ptr"]); return 0; },
    getWebGpuOwnershipTraceCapacity() { calls.push(["capacity"]); return 4; },
  }, fixture.buffer);
  assert.deepEqual(calls, [["set", 1], ["ptr"], ["capacity"]]);
  assert.deepEqual(descriptor, { ptr: 0, capacity: 4 });
  assert.equal(trace.snapshot().registered, true);
  assert.equal(trace.drain({ collect: true })[0].transactionId, 7);
});

test("decoder drains wrapped records and publishes the read cursor", () => {
  const fixture = makeRing(4, { read: 3, write: 6, epoch: 7 });
  writeRecord(fixture, 3, [1, 7, 10, 20, 6, 100, 64, 0]);
  writeRecord(fixture, 4, [2, 7, 10, 20, 12, 0, 0, 0]);
  writeRecord(fixture, 5, [3, 7, 10, 21, 19, 0, 0, 0]);
  const trace = createWgpuOwnershipTrace();
  trace.configure({ requested: true, active: true, setterAvailable: true, setterInvoked: true });
  trace.attach(fixture.descriptor, fixture.buffer);
  const records = trace.drain({ collect: true });
  assert.deepEqual(records.map((record) => record.commandSerial), [20, 20, 21]);
  assert.equal(fixture.header[1], 6);
  assert.equal(trace.snapshot().observedRecords, 3);
});

test("decoder carries native dropped count and resets ordering at an epoch boundary", () => {
  const fixture = makeRing(4, { write: 1, dropped: 5, epoch: 2 });
  writeRecord(fixture, 0, [1, 2, 1, 100, 6, 0, 0, 0]);
  const trace = createWgpuOwnershipTrace();
  trace.attach(fixture.descriptor, fixture.buffer);
  trace.drain();
  fixture.header[0] = 2;
  fixture.header[4] = 3;
  writeRecord(fixture, 1, [1, 3, 1, 1, 6, 0, 0, 0]);
  trace.drain();
  const snapshot = trace.snapshot();
  assert.equal(snapshot.nativeDropped, 5);
  assert.equal(snapshot.epochChangeCount, 1);
  assert.equal(snapshot.monotonicOrderingViolationCount, 0);
});

test("decoder fails closed on malformed headers", () => {
  const capacityMismatch = makeRing(4);
  capacityMismatch.header[2] = 3;
  const trace = createWgpuOwnershipTrace();
  assert.throws(
    () => trace.attach(capacityMismatch.descriptor, capacityMismatch.buffer),
    /header capacity/
  );
  assert.equal(trace.snapshot().registered, false);
  assert.equal(trace.snapshot().malformedDescriptorCount, 1);

  const impossibleBacklog = makeRing(4, { read: 1, write: 7 });
  trace.attach(impossibleBacklog.descriptor, impossibleBacklog.buffer);
  assert.deepEqual(trace.drain({ collect: true }), []);
  assert.equal(trace.snapshot().malformedHeaderCount, 1);
  assert.equal(trace.snapshot().registered, false);
});

test("decoder detects non-monotonic serials and mismatched record epochs", () => {
  const fixture = makeRing(4, { write: 2, epoch: 9 });
  writeRecord(fixture, 0, [1, 9, 1, 20, 6, 0, 0, 0]);
  writeRecord(fixture, 1, [1, 8, 1, 19, 6, 0, 0, 0]);
  const trace = createWgpuOwnershipTrace();
  trace.attach(fixture.descriptor, fixture.buffer);
  trace.drain();
  assert.equal(trace.snapshot().monotonicOrderingViolationCount, 1);
  assert.equal(trace.snapshot().recordEpochMismatchCount, 1);
});

test("decoder bounds recent storage and histograms", () => {
  const fixture = makeRing(8, { write: 6, epoch: 1 });
  for (let index = 0; index < 6; index += 1) {
    writeRecord(fixture, index, [index === 5 ? 99 : 1, 1, 1, index, index === 5 ? 99 : 6, 0, 0, 0]);
  }
  const trace = createWgpuOwnershipTrace({ recentRecordLimit: 2 });
  trace.attach(fixture.descriptor, fixture.buffer);
  trace.drain();
  const snapshot = trace.snapshot();
  assert.equal(snapshot.recentRecords.length, 2);
  assert.deepEqual(snapshot.recentRecords.map((record) => record.commandSerial), [4, 5]);
  assert.equal(snapshot.eventOverflowCount, 1);
  assert.equal(snapshot.opcodeOverflowCount, 1);
});

test("host, worker, telemetry, and harnesses plumb fail-closed ownership evidence", async () => {
  const [host, adapter, worker, causal, menu, gate] = await Promise.all([
    readFile(new URL("../src/core-host.js", import.meta.url), "utf8"),
    readFile(new URL("../src/upstream-worker-adapter.js", import.meta.url), "utf8"),
    readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8"),
    readFile(new URL("../src/causal-telemetry.js", import.meta.url), "utf8"),
    readFile(new URL("../tools/menu-progress-validate.mjs", import.meta.url), "utf8"),
    readFile(new URL("../tools/perf-regression-gate.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(host, /requestedWgpuOwnershipTrace\(window\.location\.search\)/);
  assert.match(adapter, /wgpuOwnershipTrace: this\.wgpuOwnershipTrace/);
  assert.match(worker, /SetWebGpuOwnershipTraceEnabled/);
  assert.match(worker, /GetWebGpuOwnershipTracePtr/);
  assert.match(worker, /GetWebGpuOwnershipTraceCapacity/);
  assert.match(worker, /attachWgpuOwnershipTraceFromApi/);
  assert.match(worker, /wgpuownershiptrace=1 requires metrics=1/);
  assert.match(worker, /wgpuownershiptrace=1 requires video=wgpu/);
  assert.match(causal, /causalWgpuOwnershipTraceObservedRecords/);
  assert.match(menu, /WGPUOWNERSHIPTRACE/);
  assert.match(gate, /WGPU ownership trace observed zero records/);
});

function makeRing(capacity, { read = 0, write = 0, dropped = 0, epoch = 0 } = {}) {
  const words = WGPU_OWNERSHIP_TRACE_HEADER_WORDS + capacity * WGPU_OWNERSHIP_TRACE_RECORD_WORDS;
  const buffer = new ArrayBuffer(words * 4);
  const header = new Uint32Array(buffer, 0, WGPU_OWNERSHIP_TRACE_HEADER_WORDS);
  header.set([write, read, capacity, dropped, epoch]);
  return {
    buffer,
    header,
    records: new Uint32Array(
      buffer,
      WGPU_OWNERSHIP_TRACE_HEADER_WORDS * 4,
      capacity * WGPU_OWNERSHIP_TRACE_RECORD_WORDS
    ),
    descriptor: {
      ptr: 0,
      capacity,
      schema: WGPU_OWNERSHIP_TRACE_SCHEMA,
      headerWords: WGPU_OWNERSHIP_TRACE_HEADER_WORDS,
      recordWords: WGPU_OWNERSHIP_TRACE_RECORD_WORDS,
    },
  };
}

function writeRecord(fixture, sequence, values) {
  const slot = sequence % fixture.descriptor.capacity;
  fixture.records.set(values, slot * WGPU_OWNERSHIP_TRACE_RECORD_WORDS);
}
