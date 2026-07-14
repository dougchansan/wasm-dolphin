// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  WGPU_UBO_COMPUTE_CLASS_BYTES,
  WGPU_UBO_COMPUTE_DIFF_GRANULARITY,
  WGPU_UBO_COMPUTE_PROJECTION_SCHEMA,
  createWgpuUboComputeProjection,
  requestedWgpuUboComputeProjection,
} from "../src/wgpu-ubo-compute-projection.js";

test("compute projection request is strict and default-off", () => {
  assert.equal(requestedWgpuUboComputeProjection(""), false);
  assert.equal(requestedWgpuUboComputeProjection("?wgpuubocomputeprojection=0"), false);
  assert.equal(requestedWgpuUboComputeProjection("?wgpuubocomputeprojection=1"), true);
  assert.equal(requestedWgpuUboComputeProjection("?wgpuubocomputeprojection=true"), false);
  assert.equal(
    requestedWgpuUboComputeProjection("?x=1&wgpuubocomputeprojection=1"),
    true
  );

  const snapshot = createWgpuUboComputeProjection().snapshot();
  assert.equal(snapshot.schema, WGPU_UBO_COMPUTE_PROJECTION_SCHEMA);
  assert.equal(snapshot.projectionOnly, true);
  assert.equal(snapshot.replayBehaviorChanged, false);
  assert.equal(snapshot.runtimeEligible, false);
  assert.equal(snapshot.configuration.diffGranularity, 16);
});

test("known classes emit full, exact 16-byte delta, and equal records", () => {
  const projection = createWgpuUboComputeProjection();
  const first = new Uint8Array(WGPU_UBO_COMPUTE_CLASS_BYTES.VS);
  const second = first.slice();
  second[18] = 7;
  second[31] = 9;

  const full = projection.observeUpload({
    resourceId: "ubo-ring",
    resourceClass: "VS",
    destinationOffset: 0,
    bytes: first,
  });
  const delta = projection.observeUpload({
    resourceId: "ubo-ring",
    resourceClass: "VS",
    destinationOffset: 8192,
    bytes: second,
  });
  const equal = projection.observeUpload({
    resourceId: "ubo-ring",
    resourceClass: "VS",
    destinationOffset: 16384,
    bytes: second,
  });

  assert.equal(full.kind, "FULL");
  assert.deepEqual(full.ranges.map(({ offset, bytes }) => [offset, bytes.byteLength]), [
    [0, WGPU_UBO_COMPUTE_CLASS_BYTES.VS],
  ]);
  assert.equal(delta.kind, "DELTA");
  assert.deepEqual(delta.ranges.map(({ offset, bytes }) => [offset, bytes.byteLength]), [
    [16, WGPU_UBO_COMPUTE_DIFF_GRANULARITY],
  ]);
  assert.equal(delta.payloadBytes, 16);
  assert.equal(delta.descriptorBytes, 24);
  assert.equal(equal.kind, "EQUAL");
  assert.equal(equal.payloadBytes, 0);
  assert.equal(equal.reconstructedBytes, WGPU_UBO_COMPUTE_CLASS_BYTES.VS);

  projection.boundary("drain");
  const snapshot = projection.snapshot({ requested: true, active: true });
  assert.deepEqual(snapshot.eligible, { calls: 3, bytes: 4112 * 3 });
  assert.deepEqual(snapshot.records, {
    total: 3,
    full: 1,
    delta: 1,
    equal: 1,
    rawFull: 0,
    utilityRaw: 0,
    unknownClassRaw: 0,
    ranges: 2,
    reconstructedBytes: 4112 * 3,
  });
  assert.equal(snapshot.bytes.payload, 4128);
  assert.equal(snapshot.bytes.descriptors, 56);
  assert.equal(snapshot.bytes.packageWork, 4184);
  assert.equal(snapshot.bytes.packagePadding, 168);
  assert.equal(snapshot.bytes.projected, 4352);
  assert.equal(snapshot.bytes.avoided, 7984);
  assert.equal(snapshot.bytes.avoidedPercent, 7984 / 12336 * 100);
  assert.deepEqual(snapshot.commands, {
    legacyCopy: 3,
    projectedCopy: 1,
    avoidedCopy: 2,
    dispatches: 1,
    packages: 1,
  });
});

test("delta falls back to full unless its serialized representation is smaller", () => {
  const projection = createWgpuUboComputeProjection();
  const zero = new Uint8Array(WGPU_UBO_COMPUTE_CLASS_BYTES.GS);
  const allChanged = new Uint8Array(WGPU_UBO_COMPUTE_CLASS_BYTES.GS).fill(1);
  projection.observeUpload({
    resourceId: 7,
    resourceClass: "GS",
    destinationOffset: 0,
    bytes: zero,
  });
  const record = projection.observeUpload({
    resourceId: 7,
    resourceClass: "GS",
    destinationOffset: 256,
    bytes: allChanged,
  });
  assert.equal(record.kind, "FULL");
  assert.equal(record.serializedBytes, 80);
  assert.equal(record.ranges.length, 1);
  assert.deepEqual(record.ranges[0].bytes, allChanged);
});

test("resource and class identities have independent shadows", () => {
  const projection = createWgpuUboComputeProjection();
  const vs = new Uint8Array(WGPU_UBO_COMPUTE_CLASS_BYTES.VS);
  const ps = new Uint8Array(WGPU_UBO_COMPUTE_CLASS_BYTES.PS);
  const records = [
    projection.observeUpload({ resourceId: "a", resourceClass: "VS", destinationOffset: 0, bytes: vs }),
    projection.observeUpload({ resourceId: "a", resourceClass: "PS", destinationOffset: 8192, bytes: ps }),
    projection.observeUpload({ resourceId: "b", resourceClass: "VS", destinationOffset: 12288, bytes: vs }),
    projection.observeUpload({ resourceId: "a", resourceClass: "VS", destinationOffset: 20480, bytes: vs }),
  ];
  assert.deepEqual(records.map((record) => record.kind), [
    "FULL", "FULL", "FULL", "EQUAL",
  ]);
});

test("utility and unclassified uploads stay raw-full but are distinguished", () => {
  const projection = createWgpuUboComputeProjection();
  const utility = projection.observeUpload({
    resourceId: "utility-buffer",
    resourceClass: "RAW_FULL",
    destinationOffset: 4,
    bytes: new Uint8Array([1, 2, 3, 4]),
    utility: true,
  });
  const unknown = projection.observeUpload({
    resourceId: "unknown-buffer",
    resourceClass: "FOO",
    destinationOffset: 8,
    bytes: new Uint8Array([5, 6]),
  });
  const missingIdentity = projection.observeUpload({
    resourceClass: "VS",
    destinationOffset: 12,
    bytes: new Uint8Array([7]),
  });
  const wrongClassSize = projection.observeUpload({
    resourceId: "ubo-ring",
    resourceClass: "GS",
    destinationOffset: 16,
    bytes: new Uint8Array(32),
  });
  projection.observeUpload({
    resourceId: "ubo-ring",
    resourceClass: "RAW_FULL",
    destinationOffset: 32,
    bytes: new Uint8Array(48),
    rawReason: "unknown-class-size",
  });

  assert.deepEqual(
    [utility, unknown, missingIdentity, wrongClassSize].map((record) => record.kind),
    ["RAW_FULL", "RAW_FULL", "RAW_FULL", "RAW_FULL"]
  );
  const snapshot = projection.snapshot();
  assert.equal(snapshot.records.rawFull, 5);
  assert.equal(snapshot.records.utilityRaw, 1);
  assert.equal(snapshot.records.unknownClassRaw, 1);
  assert.equal(snapshot.unclassifiedResourceIdentity, 2);
  assert.equal(snapshot.malformed, 2);
});

test("invalid payloads or destinations are rejected and counted malformed", () => {
  const projection = createWgpuUboComputeProjection();
  const invalidBytes = projection.observeUpload({
    resourceId: "ubo",
    resourceClass: "VS",
    destinationOffset: 0,
    bytes: [1, 2, 3],
  });
  const invalidOffset = projection.observeUpload({
    resourceId: "ubo",
    resourceClass: "VS",
    destinationOffset: -1,
    bytes: new Uint8Array(WGPU_UBO_COMPUTE_CLASS_BYTES.VS),
  });
  assert.deepEqual(
    [invalidBytes.reason, invalidOffset.reason],
    ["invalidBytes", "invalidDestinationOffset"]
  );
  const snapshot = projection.snapshot();
  assert.equal(snapshot.eligible.calls, 0);
  assert.equal(snapshot.malformed, 2);
});

test("record and work caps split packages with exact 256-byte accounting", () => {
  const byRecords = createWgpuUboComputeProjection({
    maxRecordsPerPackage: 2,
    maxPackageWorkBytes: 4096,
  });
  const gs = new Uint8Array(WGPU_UBO_COMPUTE_CLASS_BYTES.GS);
  const recordPlans = [];
  for (let index = 0; index < 3; index += 1) {
    recordPlans.push(byRecords.observeUpload({
      resourceId: "ubo",
      resourceClass: "GS",
      destinationOffset: index * 256,
      bytes: gs,
    }));
  }
  byRecords.boundary("submit");
  assert.deepEqual(recordPlans.map((record) => record.packageSequence), [0, 0, 1]);
  let snapshot = byRecords.snapshot();
  assert.equal(snapshot.splits.reasons.recordCap, 1);
  assert.equal(snapshot.commands.packages, 2);
  assert.equal(snapshot.bytes.packageWork, 112);
  assert.equal(snapshot.bytes.packagePadding, 400);
  assert.equal(snapshot.maxima.recordsPerPackage, 2);

  const byWork = createWgpuUboComputeProjection({
    maxRecordsPerPackage: 100,
    maxPackageWorkBytes: 80,
  });
  byWork.observeUpload({ resourceId: "ubo", resourceClass: "GS", destinationOffset: 0, bytes: gs });
  byWork.observeUpload({ resourceId: "ubo", resourceClass: "GS", destinationOffset: 256, bytes: gs });
  snapshot = byWork.snapshot();
  assert.equal(snapshot.splits.reasons.workCap, 1);
  assert.equal(snapshot.commands.packages, 2);
  assert.equal(snapshot.maxima.packageWorkBytes, 80);
});

test("boundary seals packages while reset also invalidates class shadows", () => {
  const projection = createWgpuUboComputeProjection();
  const gs = new Uint8Array(WGPU_UBO_COMPUTE_CLASS_BYTES.GS);
  const first = projection.observeUpload({ resourceId: "ubo", resourceClass: "GS", destinationOffset: 0, bytes: gs });
  projection.boundary("pass");
  const afterBoundary = projection.observeUpload({ resourceId: "ubo", resourceClass: "GS", destinationOffset: 256, bytes: gs });
  projection.reset("device-lost");
  const afterReset = projection.observeUpload({ resourceId: "ubo", resourceClass: "GS", destinationOffset: 512, bytes: gs });
  assert.deepEqual([first.kind, afterBoundary.kind, afterReset.kind], [
    "FULL", "EQUAL", "FULL",
  ]);
  const snapshot = projection.snapshot();
  assert.equal(snapshot.boundaries.reasons.pass, 1);
  assert.equal(snapshot.boundaries.reasons["device-lost"], 1);
  assert.equal(snapshot.resets.reasons["device-lost"], 1);
  assert.equal(snapshot.resets.shadowEntries, 1);
});

test("randomized projected records exactly reconstruct legacy ordered uploads", () => {
  const projection = createWgpuUboComputeProjection({
    maxRecordsPerPackage: 7,
    maxPackageWorkBytes: 5000,
  });
  const destinationBytes = 256 * 160;
  const legacy = new Uint8Array(destinationBytes);
  const projected = new Uint8Array(destinationBytes);
  const referenceShadows = new Map();
  const classPayloads = new Map();
  const random = xorshift32(0x51a7c0de);
  const classes = ["VS", "PS", "GS"];
  const packageSequences = [];
  let lastRecordSequence = -1;

  for (let index = 0; index < 120; index += 1) {
    const resourceId = index % 11 === 0 ? "ubo-b" : "ubo-a";
    const resourceClass = classes[Math.floor(random() * classes.length)];
    const shadowKey = `${resourceId}:${resourceClass}`;
    let bytes = classPayloads.get(shadowKey)?.slice() ??
      randomBytes(WGPU_UBO_COMPUTE_CLASS_BYTES[resourceClass], random);
    const mutationCount = index % 5 === 0 ? 0 : 1 + Math.floor(random() * 4);
    for (let mutation = 0; mutation < mutationCount; mutation += 1) {
      const offset = Math.floor(random() * bytes.byteLength);
      bytes[offset] ^= 1 + Math.floor(random() * 255);
    }
    classPayloads.set(shadowKey, bytes.slice());
    const destinationOffset = Math.floor(
      random() * (destinationBytes - bytes.byteLength)
    );
    legacy.set(bytes, destinationOffset);

    const record = projection.observeUpload({
      resourceId,
      resourceClass,
      destinationOffset,
      bytes,
    });
    assert.ok(record.sequence > lastRecordSequence);
    lastRecordSequence = record.sequence;
    packageSequences.push(record.packageSequence);
    applyProjectedRecord(projected, referenceShadows, record);
    assert.deepEqual(projected, legacy, `ordered upload ${index}`);
  }

  for (let index = 1; index < packageSequences.length; index += 1) {
    assert.ok(packageSequences[index] >= packageSequences[index - 1]);
    assert.ok(packageSequences[index] - packageSequences[index - 1] <= 1);
  }
  projection.boundary("randomized-end");
  const snapshot = projection.snapshot();
  assert.equal(snapshot.records.total, 120);
  assert.equal(snapshot.records.full + snapshot.records.delta +
    snapshot.records.equal + snapshot.records.rawFull, 120);
  assert.equal(snapshot.packages.records, 120);
  assert.ok(snapshot.commands.packages > 1);
  assert.ok(snapshot.maxima.recordsPerPackage <= 7);
});

test("observer copies payloads used by records and shadows", () => {
  const projection = createWgpuUboComputeProjection();
  const gs = new Uint8Array(WGPU_UBO_COMPUTE_CLASS_BYTES.GS);
  const full = projection.observeUpload({
    resourceId: "ubo",
    resourceClass: "GS",
    destinationOffset: 0,
    bytes: gs,
  });
  gs.fill(0xff);
  assert.equal(full.ranges[0].bytes.every((value) => value === 0), true);
  const equal = projection.observeUpload({
    resourceId: "ubo",
    resourceClass: "GS",
    destinationOffset: 256,
    bytes: new Uint8Array(WGPU_UBO_COMPUTE_CLASS_BYTES.GS),
  });
  assert.equal(equal.kind, "EQUAL");
});

test("projection source has no renderer or browser side effects", async () => {
  const source = await readFile(
    new URL("../src/wgpu-ubo-compute-projection.js", import.meta.url),
    "utf8"
  );
  for (const forbidden of [
    /navigator\.gpu/,
    /queue\.writeBuffer/,
    /copyBufferToBuffer/,
    /createComputePipeline/,
    /postMessage/,
    /Atomics\./,
    /SharedArrayBuffer/,
  ]) {
    assert.doesNotMatch(source, forbidden);
  }
});

test("host, worker, and benchmark plumbing keep projection passive and mapped-only", async () => {
  const [host, adapter, worker, menu, gate] = await Promise.all([
    readFile(new URL("../src/core-host.js", import.meta.url), "utf8"),
    readFile(new URL("../src/upstream-worker-adapter.js", import.meta.url), "utf8"),
    readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8"),
    readFile(new URL("../tools/menu-progress-validate.mjs", import.meta.url), "utf8"),
    readFile(new URL("../tools/perf-regression-gate.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(host, /requestedWgpuUboComputeProjection/);
  assert.match(host, /wgpuUboComputeProjection: this\.wgpuUboComputeProjection/);
  assert.match(adapter, /wgpuUboComputeProjection = false/);
  assert.match(adapter, /wgpuUboComputeProjection: this\.wgpuUboComputeProjection/);
  assert.match(worker, /wgpuubocomputeprojection=1 requires metrics=1/);
  assert.match(worker, /wgpuubocomputeprojection=1 requires video=wgpu/);
  assert.match(worker, /wgpuubocomputeprojection=1 requires wgpuuploadtransport=mapped/);
  assert.match(worker, /wgpuUboComputeProjection\.reset\("device-lost"\)/);
  assert.match(worker, /wgpuUboComputeProjection\.reset\("load-fence-discard"\)/);
  for (const reason of [
    "core-reset",
    "slot-state-load",
    "save-state-load",
    "core-reload",
  ]) {
    assert.match(worker, new RegExp(
      `wgpuUboComputeProjection\\.reset\\(\"${reason}\"\\)`
    ));
  }
  assert.match(worker, /wgpuUboComputeProjection\.reset\(`fatal-\$\{scope\}`\)/);
  assert.equal(
    worker.match(/wgpuUboComputeProjection\.boundary\(reason\)/g)?.length,
    2
  );
  assert.match(worker, /role !== WGPU_UPLOAD_ROLE\.UBO/);
  assert.match(worker, /role === WGPU_UPLOAD_ROLE\.UTILITY_UNIFORM/);
  assert.match(worker, /bytes: uploadSource\.subarray\(0, uploadBytes\)/);
  assert.match(worker, /uboComputeProjection: wgpuUboComputeProjection\.snapshot/);
  const stageAccepted = worker.indexOf("mappedStageAccepted = true;");
  const observe = worker.indexOf("wgpuUboComputeProjection.observeUpload", stageAccepted);
  assert.ok(stageAccepted >= 0 && observe > stageAccepted);
  assert.match(menu, /WGPUUBOCOMPUTEPROJECTION/);
  assert.match(gate, /wgpuubocomputeprojection/);
});

function applyProjectedRecord(destination, shadows, record) {
  if (record.kind === "RAW_FULL") {
    destination.set(record.ranges[0].bytes, record.destinationOffset);
    return;
  }
  const key = `${record.resourceId}:${record.resourceClass}`;
  let shadow = shadows.get(key);
  if (!shadow) shadow = new Uint8Array(record.reconstructedBytes);
  for (const range of record.ranges) shadow.set(range.bytes, range.offset);
  shadows.set(key, shadow);
  destination.set(shadow, record.destinationOffset);
}

function randomBytes(length, random) {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    bytes[index] = Math.floor(random() * 256);
  }
  return bytes;
}

function xorshift32(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}
