// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  WGPU_PASS_PACKAGE_OP as OP,
  WGPU_PASS_PACKAGE_PROJECTION_SCHEMA,
  createWgpuPassPackageProjection,
  requestedWgpuPassPackageProjection,
} from "../src/wgpu-pass-package-projection.js";

function consume(projection, ops, start = 0) {
  ops.forEach((op, offset) => projection.observeConsumedRecord(
    op,
    start + offset,
    op === OP.UPLOAD_BUFFER ? 128 : op === OP.UPLOAD_TEXTURE ? 512 : 0
  ));
}

test("pass-package projection request is exact and default-off", () => {
  assert.equal(requestedWgpuPassPackageProjection(""), false);
  assert.equal(requestedWgpuPassPackageProjection("?wgpupackageprojection=0"), false);
  assert.equal(requestedWgpuPassPackageProjection("?wgpupackageprojection=1"), true);
  assert.equal(requestedWgpuPassPackageProjection("?wgpupackageprojection=true"), false);
  const snapshot = createWgpuPassPackageProjection().snapshot();
  assert.equal(snapshot.schema, WGPU_PASS_PACKAGE_PROJECTION_SCHEMA);
  assert.equal(snapshot.requested, false);
  assert.equal(snapshot.active, false);
  assert.equal(snapshot.runtimeEligible, false);
  assert.equal(snapshot.payloadByteProof, "unavailable");
  assert.equal(snapshot.lifecycleDigestProof, "unavailable");
  assert.equal(snapshot.drawObservableDigestProof, "unavailable");
});

test("complete passes and outside segments retain order and counts", () => {
  const projection = createWgpuPassPackageProjection();
  consume(projection, [
    OP.CREATE_BUFFER,
    OP.UPLOAD_BUFFER,
    OP.BEGIN_PASS,
    OP.SET_PIPELINE,
    OP.DRAW,
    OP.END_PASS,
    OP.SUBMIT_PRESENT,
  ]);
  const snapshot = projection.snapshot({ requested: true, active: true });
  assert.equal(snapshot.legacy.records, 7);
  assert.equal(snapshot.legacy.publications, 4);
  assert.equal(snapshot.projected.records, 4);
  assert.equal(snapshot.projected.publications, 4);
  assert.equal(snapshot.projected.publicationReduction, 0);
  assert.equal(snapshot.projected.publicationReductionClaimed, false);
  assert.equal(snapshot.speculativeFullEnvelope.records, 3);
  assert.equal(snapshot.speculativeFullEnvelope.publications, 3);
  assert.equal(snapshot.speculativeFullEnvelope.unsafe, true);
  assert.equal(snapshot.projected.completePassPackages, 1);
  assert.equal(snapshot.projected.outsideSegments, 2);
  assert.equal(snapshot.records.uploads, 1);
  assert.equal(snapshot.records.uploadBytes, 128);
  assert.equal(snapshot.records.resources, 1);
  assert.equal(snapshot.ownership.resolvedPrePassUploads, 0);
  assert.equal(snapshot.ownership.unresolvedPrePassUploads, 1);
  assert.equal(snapshot.ownership.pendingPrePassUploads, 0);
  assert.equal(snapshot.epochs.submission, 1);
  assert.deepEqual(snapshot.recentPackages.map((pkg) => pkg.kind), [
    "outside", "pass", "outside",
  ]);
  assert.equal(snapshot.recentPackages[1].ownedPrePassUploadRecords, 0);
  assert.equal(snapshot.recentPackages[1].disposition, "complete");
});

test("all known operations populate the fixed histogram", () => {
  const projection = createWgpuPassPackageProjection();
  consume(projection, Array.from({ length: 25 }, (_, op) => op));
  const snapshot = projection.snapshot();
  assert.equal(snapshot.opHistogram.length, 25);
  assert.deepEqual(snapshot.opHistogram, new Array(25).fill(1));
  assert.equal(snapshot.records.unsupported, 0);
  assert.equal(snapshot.records.uploads, 2);
  assert.equal(snapshot.records.resources, 8);
});

test("unsupported, malformed, nested, orphan, and state-outside hazards are explicit", () => {
  const projection = createWgpuPassPackageProjection();
  projection.observeConsumedRecord(99, 0);
  projection.observeConsumedRecord("bad", -1);
  consume(projection, [
    OP.SET_PIPELINE,
    OP.END_PASS,
    OP.BEGIN_PASS,
    OP.BEGIN_PASS,
    OP.END_PASS,
  ], 2);
  const snapshot = projection.snapshot();
  assert.equal(snapshot.records.unsupported, 2);
  assert.equal(snapshot.records.malformed, 2);
  assert.equal(snapshot.records.nestedPasses, 1);
  assert.equal(snapshot.records.stateOutsidePass, 1);
  assert.equal(snapshot.boundaries.incompletePasses, 1);
  assert.deepEqual(snapshot.unsupportedOpHistogram, { "99": 1, "4294967295": 1 });
});

test("pre-pass uploads remain unresolved across reset and open pass is incomplete", () => {
  const projection = createWgpuPassPackageProjection();
  consume(projection, [OP.UPLOAD_BUFFER, OP.BEGIN_PASS, OP.DRAW], 0);
  consume(projection, [OP.UPLOAD_TEXTURE], 3);
  // The texture upload is inside the open pass. The earlier upload remains
  // unresolved because consumer order cannot prove its producer transaction;
  // reset classifies the open pass without inventing either ownership edge.
  projection.reset("load-fence-discard");
  consume(projection, [OP.UPLOAD_BUFFER], 4);
  projection.reset("device-lost");
  const snapshot = projection.snapshot();
  assert.equal(snapshot.ownership.resolvedPrePassUploads, 0);
  assert.equal(snapshot.ownership.unresolvedPrePassUploads, 2);
  assert.equal(snapshot.ownership.unresolvedOutsideResources, 0);
  assert.equal(snapshot.boundaries.incompletePasses, 1);
  assert.equal(snapshot.boundaries.resets, 2);
  assert.deepEqual(snapshot.boundaries.resetKinds, {
    "load-fence-discard": 1,
    "device-lost": 1,
  });
  assert.equal(snapshot.epochs.lifecycle, 2);
  assert.equal(snapshot.epochs.submission, 0);
});

test("recent package retention is bounded and max package remains lifetime data", () => {
  const projection = createWgpuPassPackageProjection({ recentPackageLimit: 2 });
  for (let pass = 0; pass < 4; pass += 1) {
    consume(projection, [OP.BEGIN_PASS, OP.DRAW, OP.END_PASS], pass * 3);
  }
  const snapshot = projection.snapshot();
  assert.equal(snapshot.recentPackageLimit, 2);
  assert.equal(snapshot.recentPackages.length, 2);
  assert.deepEqual(snapshot.recentPackages.map((pkg) => pkg.sequence), [3, 4]);
  assert.equal(snapshot.projected.maxPackageRecords, 3);
  assert.equal(snapshot.projected.maxLegacyRecordBytesInSegment, 96);
  assert.equal(snapshot.projected.maxLegacyRecordBytesInSegmentIsLowerBound, true);
  assert.equal(snapshot.projected.packageCapacityEvidence, false);
});

test("open projections are reported without mutating finalized history", () => {
  const projection = createWgpuPassPackageProjection();
  consume(projection, [OP.BEGIN_PASS, OP.DRAW]);
  const first = projection.snapshot();
  const second = projection.snapshot();
  assert.equal(first.legacy.publications, 1);
  assert.equal(first.projected.records, 1);
  assert.equal(first.projected.publications, 1);
  assert.equal(first.speculativeFullEnvelope.records, 1);
  assert.deepEqual(first, second);
  assert.equal(first.recentPackages.length, 0);
});

test("BEGIN accounts for one atomic publication and END never double counts it", () => {
  const projection = createWgpuPassPackageProjection();
  consume(projection, [OP.BEGIN_PASS, OP.DRAW]);
  assert.equal(projection.snapshot().legacy.publications, 1);
  consume(projection, [OP.END_PASS], 2);
  const complete = projection.snapshot();
  assert.equal(complete.legacy.publications, 1);
  assert.equal(complete.projected.completePassPackages, 1);
});

test("reset retains the open publication and classifies scalar ownership hazards", () => {
  const projection = createWgpuPassPackageProjection();
  consume(projection, [OP.CREATE_BUFFER, OP.UPLOAD_BUFFER, OP.BEGIN_PASS, OP.DRAW]);
  assert.equal(projection.snapshot().legacy.publications, 3);
  projection.reset("load-fence-discard");
  const snapshot = projection.snapshot();
  assert.equal(snapshot.legacy.publications, 3);
  assert.equal(snapshot.boundaries.incompletePasses, 1);
  assert.equal(snapshot.boundaries.resets, 1);
  assert.equal(snapshot.ownership.unresolvedPrePassUploads, 1);
  assert.equal(snapshot.ownership.unresolvedOutsideResources, 1);
  assert.equal(snapshot.ownership.pendingPrePassUploads, 0);
  assert.equal(snapshot.ownership.pendingOutsideResources, 0);
});

test("pure projection source has no renderer, synchronization, or payload-copy APIs", async () => {
  const source = await readFile(
    new URL("../src/wgpu-pass-package-projection.js", import.meta.url),
    "utf8"
  );
  for (const forbidden of [
    /navigator\.gpu/,
    /createRenderPipeline/,
    /beginRenderPass/,
    /Atomics\./,
    /SharedArrayBuffer/,
    /postMessage/,
    /new Uint8Array/,
    /crypto\.subtle/,
  ]) {
    assert.doesNotMatch(source, forbidden);
  }
  assert.match(source, /function observeConsumedRecord\(opValue, recordIndexValue, payloadBytesValue = 0\)/);
  assert.doesNotMatch(source, /pendingPrePassUploads\s*=\s*\[/);
  assert.doesNotMatch(source, /normalizeRecord\(/);
});

test("host-worker-tool plumbing is complete and observation precedes read advance", async () => {
  const [host, adapter, worker, causal, menu, gate] = await Promise.all([
    readFile(new URL("../src/core-host.js", import.meta.url), "utf8"),
    readFile(new URL("../src/upstream-worker-adapter.js", import.meta.url), "utf8"),
    readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8"),
    readFile(new URL("../src/causal-telemetry.js", import.meta.url), "utf8"),
    readFile(new URL("../tools/menu-progress-validate.mjs", import.meta.url), "utf8"),
    readFile(new URL("../tools/perf-regression-gate.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(host, /requestedWgpuPassPackageProjection\(\s*window\.location\.search/);
  assert.match(host, /wgpuPassPackageProjection: this\.wgpuPassPackageProjection/);
  assert.match(adapter, /wgpuPassPackageProjection = false/);
  assert.match(adapter, /wgpuPassPackageProjection: this\.wgpuPassPackageProjection/);
  assert.match(worker, /wgpupackageprojection=1 requires metrics=1/);
  assert.match(worker, /wgpupackageprojection=1 requires video=wgpu/);
  assert.match(worker, /wgpuPassPackageProjection\.reset\("load-fence-discard"\)/);
  assert.match(worker, /wgpuPassPackageProjection\.reset\("device-lost"\)/);
  const observe = worker.indexOf("wgpuPassPackageProjection.observeConsumedRecord");
  const mappedHold = worker.lastIndexOf("if (mappedCapacityHold)", observe);
  const catchStart = worker.lastIndexOf("} catch (e) {", observe);
  const catchReject = worker.indexOf("replayRecordAccepted = false;", catchStart);
  const advance = worker.indexOf("read = (read + 1) >>> 0;", observe);
  assert.ok(catchStart >= 0 && catchReject > catchStart && mappedHold > catchReject);
  assert.ok(observe > mappedHold && advance > observe);
  assert.match(worker, /if \(wgpuPassPackageProjectionActive && replayRecordAccepted\)/);
  assert.match(worker, /observeConsumedRecord\(op, read, payloadBytes\)/);
  assert.doesNotMatch(worker, /wgpuPassPackageProjection\.reset\("load-state"\)/);
  assert.match(causal, /causalWgpuPassPackageProjectionActive/);
  assert.match(menu, /WGPUPACKAGEPROJECTION/);
  assert.match(gate, /WGPU pass-package projection mismatch/);
  assert.match(gate, /runtimeEligible=false/);
  assert.match(gate, /projection observed zero records/);
  assert.match(gate, /projection observed zero complete passes/);
  for (const hazard of [
    "unsupported", "malformed", "nested passes", "state outside pass", "incomplete passes",
  ]) {
    assert.match(gate, new RegExp(`\\["${hazard.replace(" ", "\\s")}`));
  }
});
