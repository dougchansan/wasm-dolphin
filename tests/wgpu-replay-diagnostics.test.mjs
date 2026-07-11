import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  WGPU_REPLAY_OP_NAMES,
  createWgpuReplayOpMetrics,
  createWgpuReplayClassifier,
  requestedWgpuAtomicPassReplay,
  requestedWgpuDeepReplayDiagnostics,
  requestedWgpuDetachedPresenter,
  requestedWgpuLoadEpochFence,
  requestedWgpuReplayPump,
  requestedWgpuReplayDiagnostics,
  requestedWgpuGeometryPack,
  requestedWgpuStateCache,
  requestedWgpuUboCache,
  selectAtomicReplayLimit,
  summarizeWgpuReplayRange
} from "../src/wgpu-replay-diagnostics.js";

test("WGPU replay op metrics retain an exact 25-op zero-filled histogram", () => {
  const metrics = createWgpuReplayOpMetrics();
  let snapshot = metrics.snapshot({ enabled: false });

  assert.equal(snapshot.enabled, false);
  assert.equal(snapshot.opCount, 25);
  assert.equal(WGPU_REPLAY_OP_NAMES.length, 25);
  assert.deepEqual(snapshot.names, [...WGPU_REPLAY_OP_NAMES]);
  for (const field of [
    "histogram",
    "replayCpuTotalMs",
    "replayCpuMaxMs",
    "uploadCopyCalls",
    "uploadCopyBytes",
    "uploadCopyCpuTotalMs",
    "uploadCopyCpuMaxMs",
    "queueUploadCalls",
    "queueUploadBytes"
  ]) {
    assert.equal(snapshot[field].length, 25, `${field} must cover every wire op`);
    assert.ok(snapshot[field].every((value) => value === 0));
  }

  assert.equal(metrics.recordReplay(6, 1.25), true);
  assert.equal(metrics.recordReplay(6, 0.75), true);
  assert.equal(metrics.recordReplay(24, 0.5), true);
  assert.equal(metrics.recordReplay(25, 99), false);
  assert.equal(metrics.recordUploadCopy(6, 1536, 0.2), true);
  assert.equal(metrics.recordUploadCopy(8, 4096, 0.4), true);
  assert.equal(metrics.recordQueueUpload(6, 1536), true);
  assert.equal(metrics.recordQueueUpload(8, 4096), true);

  snapshot = metrics.snapshot();
  assert.equal(snapshot.histogram[6], 2);
  assert.equal(snapshot.histogram[24], 1);
  assert.equal(snapshot.replayCpuTotalMs[6], 2);
  assert.equal(snapshot.replayCpuMaxMs[6], 1.25);
  assert.equal(snapshot.uploadCopyCalls[6], 1);
  assert.equal(snapshot.uploadCopyBytes[6], 1536);
  assert.equal(snapshot.uploadCopyCpuTotalMs[8], 0.4);
  assert.equal(snapshot.queueUploadCalls[8], 1);
  assert.equal(snapshot.queueUploadBytes[8], 4096);

  metrics.reset();
  assert.ok(metrics.snapshot().histogram.every((value) => value === 0));
});

test("WGPU replay diagnostics are opt-in", () => {
  assert.equal(requestedWgpuReplayDiagnostics(""), false);
  assert.equal(requestedWgpuReplayDiagnostics("?wgpuclassify=1"), true);
  assert.equal(requestedWgpuReplayDiagnostics("?wgpuclassify=0"), false);
});

test("atomic pass replay defaults on and retains an explicit legacy rollback", () => {
  assert.equal(requestedWgpuAtomicPassReplay(""), true);
  assert.equal(requestedWgpuAtomicPassReplay("?wgpuatomic=1"), true);
  assert.equal(requestedWgpuAtomicPassReplay("?wgpuatomic=0"), false);
});

test("classifier identifies a drain boundary that splits an open pass", () => {
  const classifier = createWgpuReplayClassifier({ now: incrementingClock() });
  classifier.recordPassBegin({ framebufferId: 14, recordIndex: 100 });
  classifier.recordEfbClear({ framebufferId: 14, rgba: [0, 0, 0, 0] });
  classifier.recordPassEnd({ reason: "drain-boundary", recordIndex: 103 });
  classifier.recordStateOutsidePass({ op: "set-pipeline", recordIndex: 104 });

  const snapshot = classifier.snapshot();
  assert.equal(snapshot.classifier.code, "PASS_SPLIT_AT_DRAIN");
  assert.equal(snapshot.stages.passAtomicity.status, "fail");
  assert.equal(snapshot.stages.passAtomicity.splitAtDrainCount, 1);
  assert.equal(snapshot.stages.passAtomicity.recordsOutsidePass, 1);
});

test("classifier records an incomplete pass held for the next producer snapshot", () => {
  const classifier = createWgpuReplayClassifier({ scope: "load-state-file", now: incrementingClock() });
  classifier.recordAtomicHold({ recordIndex: 12, writeIndex: 15 });

  const snapshot = classifier.snapshot();
  assert.equal(snapshot.scope, "load-state-file");
  assert.equal(snapshot.stages.passAtomicity.heldIncompletePassCount, 1);
  assert.equal(snapshot.stages.passAtomicity.splitAtDrainCount, 0);
  assert.equal(snapshot.events[0].type, "incomplete-pass-held");
});

test("classifier distinguishes draws, zero EFB, nonzero EFB, and present completion", () => {
  const classifier = createWgpuReplayClassifier({ now: incrementingClock() });
  classifier.recordPassBegin({ framebufferId: 14, recordIndex: 1 });
  classifier.recordEfbClear({ framebufferId: 14, rgba: [0, 0, 0, 0] });
  classifier.recordRealDraw({
    framebufferId: 14,
    indexed: true,
    pipelineId: 79,
    efb: true,
    state: {
      pipeline: { id: 79, resolved: true, colorFormat: "rgba8unorm", depthFormat: "depth32float" },
      bindGroups: [31, 32, 33],
      vertexBuffer: { id: 7, offset: 0 },
      indexBuffer: { id: 8, format: "uint16", offset: 0 },
      viewport: [0, 0, 640, 528, 0, 1],
      scissor: [0, 0, 640, 528]
    }
  });
  classifier.recordPassEnd({ reason: "explicit", recordIndex: 8 });
  classifier.recordPresentCommand({ recordIndex: 9 });
  classifier.recordSubmission({ reason: "present", submitted: true });
  classifier.recordEfbReadback({
    framebufferId: 14,
    nonzeroBytes: 0,
    maxByte: 0,
    presentSequence: 1
  });

  let snapshot = classifier.snapshot();
  assert.equal(snapshot.classifier.code, "EFB_DRAW_NO_MUTATION");
  assert.equal(snapshot.stages.firstRealDraw.status, "pass");
  assert.equal(snapshot.stages.firstEfbDraw.status, "pass");
  assert.equal(snapshot.stages.firstEfbDraw.pipelineId, 79);
  assert.deepEqual(snapshot.stages.firstEfbDraw.state.bindGroups, [31, 32, 33]);
  assert.equal(snapshot.stages.firstIndexedEfbDraw.status, "pass");
  assert.equal(snapshot.stages.firstIndexedEfbDraw.pipelineId, 79);
  assert.equal(snapshot.stages.firstNonzeroEfb.status, "pending");
  assert.equal(snapshot.stages.presentSubmission.submittedCount, 1);

  classifier.recordEfbReadback({
    framebufferId: 14,
    nonzeroBytes: 12,
    maxByte: 255,
    presentSequence: 871
  });
  classifier.recordPresentCompletion({ completed: true });
  snapshot = classifier.snapshot();
  assert.equal(snapshot.classifier.code, "PASS");
  assert.equal(snapshot.stages.efbMutation.status, "pass");
  assert.equal(snapshot.stages.firstNonzeroEfb.status, "pass");
  assert.equal(snapshot.stages.firstNonzeroEfb.presentSequence, 871);
  assert.equal(snapshot.stages.firstNonzeroEfb.readbackOrdinal, 2);
  assert.equal(snapshot.stages.presentSubmission.completedCount, 1);
});

test("legacy deep replay probes are default-off with an explicit rollback", () => {
  assert.equal(requestedWgpuDeepReplayDiagnostics(""), false);
  assert.equal(requestedWgpuDeepReplayDiagnostics("?wgpudeepdiag=1"), true);
  assert.equal(requestedWgpuDeepReplayDiagnostics("?wgpudeepdiag=0"), false);
});

test("load fencing is opt-in while real-WGPU replay pumping has a rollback", () => {
  assert.equal(requestedWgpuLoadEpochFence(""), false);
  assert.equal(requestedWgpuLoadEpochFence("?wgpuloadfence=1"), true);
  assert.equal(requestedWgpuReplayPump(""), false);
  assert.equal(requestedWgpuReplayPump("", true), true);
  assert.equal(requestedWgpuReplayPump("?wgpupump=1"), true);
  assert.equal(requestedWgpuReplayPump("?wgpupump=0", true), false);
  assert.equal(requestedWgpuDetachedPresenter(""), false);
  assert.equal(requestedWgpuDetachedPresenter("?wgpudetached=1"), true);
});

test("first EFB draw evidence is immutable and remains bounded", () => {
  const classifier = createWgpuReplayClassifier({ now: incrementingClock() });
  assert.equal(classifier.needsFirstEfbDrawState(), true);

  classifier.recordRealDraw({
    framebufferId: 14,
    pipelineId: 22,
    efb: true,
    state: { pipeline: { id: 22 }, bindGroups: [1, 2, 3] }
  });
  assert.equal(classifier.needsFirstEfbDrawState(), false);
  assert.equal(classifier.needsFirstEfbDrawState(true), true);
  classifier.recordRealDraw({
    framebufferId: 14,
    pipelineId: 9001,
    indexed: true,
    efb: true,
    state: { pipeline: { id: 9001 }, bindGroups: [4, 5, 6] }
  });
  assert.equal(classifier.needsFirstEfbDrawState(true), false);

  const snapshot = classifier.snapshot();
  assert.equal(snapshot.stages.firstEfbDraw.pipelineId, 22);
  assert.deepEqual(snapshot.stages.firstEfbDraw.state.bindGroups, [1, 2, 3]);
  assert.equal(snapshot.stages.firstIndexedEfbDraw.pipelineId, 9001);
  assert.deepEqual(snapshot.stages.firstIndexedEfbDraw.state.bindGroups, [4, 5, 6]);
});

test("a pre-draw EFB sample cannot classify later draws as non-mutating", () => {
  const classifier = createWgpuReplayClassifier({ now: incrementingClock() });
  classifier.recordEfbReadback({ framebufferId: 14, nonzeroBytes: 0, maxByte: 0 });
  classifier.recordRealDraw({ framebufferId: 14, indexed: true, pipelineId: 79, efb: true });

  let snapshot = classifier.snapshot();
  assert.equal(snapshot.classifier.code, "WAITING_FOR_POST_DRAW_EFB_READBACK");
  assert.equal(snapshot.stages.efbMutation.postDrawReadbackCount, 0);
  assert.equal(classifier.needsPostDrawEfbReadback(1, 1), true);

  classifier.recordEfbReadback({
    framebufferId: 14,
    nonzeroBytes: 0,
    maxByte: 0,
    drawCountAtEncode: classifier.captureEfbDrawCount()
  });
  snapshot = classifier.snapshot();
  assert.equal(snapshot.classifier.code, "EFB_DRAW_NO_MUTATION");
  assert.equal(snapshot.stages.efbMutation.postDrawReadbackCount, 1);
});

test("pass-state caching is opt-in with an explicit boolean override", () => {
  assert.equal(requestedWgpuStateCache(""), false);
  assert.equal(requestedWgpuStateCache("", true), true);
  assert.equal(requestedWgpuStateCache("?wgpustatecache=1"), true);
  assert.equal(requestedWgpuStateCache("?wgpustatecache=0", true), false);
});

test("UBO slice caching is default-off with an explicit boolean override", () => {
  assert.equal(requestedWgpuUboCache(""), false);
  assert.equal(requestedWgpuUboCache("", true), true);
  assert.equal(requestedWgpuUboCache("?wgpuubocache=1"), true);
  assert.equal(requestedWgpuUboCache("?wgpuubocache=0", true), false);
});

test("an immediate first completed EFB pass readback is independent of present-time evidence", () => {
  const classifier = createWgpuReplayClassifier({ now: incrementingClock() });
  assert.equal(classifier.needsFirstEfbPassReadback(14), false);

  classifier.recordRealDraw({
    framebufferId: 14,
    indexed: true,
    pipelineId: 79,
    efb: true
  });
  assert.equal(classifier.needsFirstEfbPassReadback(15), false);
  assert.equal(classifier.needsFirstEfbPassReadback(14), true);
  assert.equal(classifier.beginFirstEfbPassReadback({
    framebufferId: 14,
    passEndRecordIndex: 108,
    drawCountAtEncode: classifier.captureEfbDrawCount()
  }), true);
  assert.equal(classifier.beginFirstEfbPassReadback({ framebufferId: 14 }), false);

  let snapshot = classifier.snapshot();
  assert.equal(snapshot.classifier.code, "WAITING_FOR_FIRST_EFB_PASS_READBACK");
  assert.equal(snapshot.stages.firstEfbPassReadback.status, "running");
  assert.equal(snapshot.stages.firstEfbPassReadback.passEndRecordIndex, 108);
  assert.equal(snapshot.stages.firstEfbPassReadback.drawCountAtEncode, 1);

  assert.equal(classifier.recordFirstEfbPassReadback({
    nonzeroBytes: 0,
    nonzeroColorBytes: 0,
    sampledBytes: 4096,
    maxByte: 0
  }), true);
  assert.equal(classifier.recordFirstEfbPassReadback({ nonzeroBytes: 12 }), false);

  snapshot = classifier.snapshot();
  assert.equal(snapshot.classifier.code, "FIRST_EFB_PASS_NO_MUTATION");
  assert.equal(snapshot.stages.firstEfbPassReadback.status, "fail");
  assert.equal(snapshot.stages.firstEfbPassReadback.readbackCount, 1);
  assert.equal(snapshot.stages.firstEfbPassReadback.sampledBytes, 4096);
  assert.equal(snapshot.stages.efbMutation.readbackCount, 0);
  assert.equal(snapshot.stages.firstNonzeroEfb.status, "pending");

  classifier.recordEfbReadback({
    framebufferId: 14,
    nonzeroBytes: 12,
    nonzeroColorBytes: 9,
    maxByte: 255,
    presentSequence: 871
  });
  classifier.recordPresentCompletion({ completed: true });
  snapshot = classifier.snapshot();
  assert.equal(snapshot.classifier.code, "FIRST_EFB_PASS_NO_MUTATION_LATER_PRESENT_MUTATION");
  assert.equal(snapshot.stages.firstEfbPassReadback.status, "fail");
  assert.equal(snapshot.stages.efbMutation.nonzeroReadbackCount, 1);
  assert.equal(snapshot.stages.firstNonzeroEfb.presentSequence, 871);
});

test("a nonzero immediate first EFB pass readback proves pass mutation", () => {
  const classifier = createWgpuReplayClassifier({ now: incrementingClock() });
  classifier.recordRealDraw({ framebufferId: 14, pipelineId: 79, efb: true });
  assert.equal(classifier.beginFirstEfbPassReadback({
    framebufferId: 14,
    passEndRecordIndex: 21
  }), true);
  assert.equal(classifier.recordFirstEfbPassReadback({
    nonzeroBytes: 16,
    nonzeroColorBytes: 12,
    sampledBytes: 64,
    maxByte: 255
  }), true);

  const snapshot = classifier.snapshot();
  assert.equal(snapshot.classifier.status, "pass");
  assert.equal(snapshot.classifier.code, "FIRST_EFB_PASS_MUTATED");
  assert.equal(snapshot.stages.firstEfbPassReadback.status, "pass");
  assert.equal(snapshot.stages.firstEfbPassReadback.nonzeroColorBytes, 12);
  assert.equal(snapshot.stages.firstEfbPassReadback.maxByte, 255);
  assert.equal(snapshot.stages.efbMutation.readbackCount, 0);
  assert.equal(snapshot.stages.firstNonzeroEfb.status, "pending");
});

test("an immediate first EFB pass readback error is classified explicitly", () => {
  const classifier = createWgpuReplayClassifier({ now: incrementingClock() });
  classifier.recordRealDraw({ framebufferId: 14, pipelineId: 79, efb: true });
  assert.equal(classifier.beginFirstEfbPassReadback({ framebufferId: 14 }), true);
  assert.equal(classifier.recordFirstEfbPassReadback({ error: new Error("map failed") }), true);

  const snapshot = classifier.snapshot();
  assert.equal(snapshot.classifier.status, "fail");
  assert.equal(snapshot.classifier.code, "FIRST_EFB_PASS_READBACK_ERROR");
  assert.equal(snapshot.stages.firstEfbPassReadback.status, "error");
  assert.equal(snapshot.stages.firstEfbPassReadback.error, "Error: map failed");
});

test("missing-resource evidence and event storage stay bounded", () => {
  const classifier = createWgpuReplayClassifier({
    maxEvents: 4,
    maxMissingIdsPerKind: 2,
    now: incrementingClock()
  });
  for (let id = 1; id <= 10; id += 1) {
    classifier.recordMissingResource({ kind: "bind-group", id });
  }
  const snapshot = classifier.snapshot();
  assert.equal(snapshot.classifier.code, "MISSING_RESOURCES");
  assert.equal(snapshot.events.length, 4);
  assert.equal(snapshot.eventsDropped, 6);
  assert.deepEqual(snapshot.stages.missingResources.ids["bind-group"], [1, 2]);
  assert.equal(snapshot.stages.missingResources.total, 10);
});

test("atomic replay limit holds an incomplete pass without delaying safe resource records", () => {
  const ops = new Map([
    [10, 7],
    [11, 11],
    [12, 12],
    [13, 17],
    [14, 13]
  ]);
  assert.equal(selectAtomicReplayLimit({ read: 10, write: 15, opAt: (index) => ops.get(index) }), 12);

  ops.set(15, 14);
  ops.set(16, 20);
  ops.set(17, 21);
  ops.set(18, 22);
  assert.equal(selectAtomicReplayLimit({ read: 10, write: 19, opAt: (index) => ops.get(index) }), 19);

  ops.set(19, 12);
  ops.set(20, 17);
  assert.equal(selectAtomicReplayLimit({ read: 10, write: 21, opAt: (index) => ops.get(index) }), 19);
});

test("atomic replay limit remains correct across the uint32 ring-index wrap", () => {
  const ops = new Map([
    [0xfffffffe, 7],
    [0xffffffff, 12],
    [0, 13],
    [1, 21],
    [2, 12]
  ]);
  assert.equal(
    selectAtomicReplayLimit({ read: 0xfffffffe, write: 3, opAt: (index) => ops.get(index) }),
    2
  );
});

test("ring-range summaries expose a pending pass and upload pressure", () => {
  const records = new Map([
    [100, { op: 12 }],
    [101, { op: 6, uploadBytes: 1536, uploadPointer: 0x1200 }],
    [102, { op: 20 }]
  ]);
  const summary = summarizeWgpuReplayRange({
    read: 100,
    write: 103,
    recordAt: (index) => records.get(index),
    uploadArenaBase: 0x1000,
    uploadArenaSize: 0x1000
  });

  assert.equal(summary.recordCount, 3);
  assert.equal(summary.beginPassCount, 1);
  assert.equal(summary.endPassCount, 0);
  assert.equal(summary.openPassDepth, 1);
  assert.equal(summary.uploadBufferCount, 1);
  assert.equal(summary.uploadBytes, 1536);
  assert.equal(summary.uploadPointerWrapCount, 0);
  assert.equal(summary.uploadReferencesInArena, 1);
  assert.equal(summary.potentialArenaOverwrite, false);
  assert.equal(summary.firstOp, 12);
  assert.equal(summary.lastOp, 20);
});

test("classifier correlates load epoch, EFB, XFB, and backbuffer mutation", () => {
  const classifier = createWgpuReplayClassifier({
    generation: 7,
    now: incrementingClock()
  });
  classifier.recordLoadBoundary({
    readIndex: 100,
    writeIndex: 103,
    uploadReadIndex: 4096,
    summary: {
      recordCount: 3,
      beginPassCount: 1,
      endPassCount: 0,
      openPassDepth: 1
    }
  });
  classifier.recordDrainEpoch({
    readIndex: 100,
    writeIndex: 110100,
    replayLimit: 104,
    processed: 4,
    presentCount: 1,
    summary: { uploadBytes: 64 * 1024 * 1024, potentialArenaOverwrite: true }
  });
  classifier.recordPresentationReadback({
    kind: "efb",
    framebufferId: 14,
    nonzeroBytes: 4096,
    nonzeroColorBytes: 3072,
    nonzeroAlphaBytes: 1024,
    sampledBytes: 8192,
    maxByte: 255,
    presentSequence: 2
  });
  classifier.recordPresentationReadback({
    kind: "xfb",
    framebufferId: 47,
    nonzeroBytes: 2048,
    sampledBytes: 8192,
    maxByte: 239,
    presentSequence: 2
  });
  classifier.recordPresentationReadback({
    kind: "backbuffer",
    framebufferId: 0,
    sourceTextureId: 47,
    nonzeroBytes: 1024,
    sampledBytes: 4096,
    maxByte: 239,
    presentSequence: 2
  });

  const snapshot = classifier.snapshot();
  assert.equal(snapshot.generation, 7);
  assert.equal(snapshot.stages.ringEpoch.loadBoundary.pendingRecords, 3);
  assert.equal(snapshot.stages.ringEpoch.loadBoundary.uploadReadIndex, 4096);
  assert.equal(snapshot.stages.ringEpoch.loadBoundary.openPassDepth, 1);
  assert.equal(snapshot.stages.ringEpoch.backlogHighWater, 110000);
  assert.equal(snapshot.stages.ringEpoch.highWaterSummary.potentialArenaOverwrite, true);
  assert.equal(snapshot.stages.ringEpoch.drainSamples.length, 1);
  assert.equal(snapshot.stages.presentationChain.efb.nonzeroReadbackCount, 1);
  assert.equal(snapshot.stages.presentationChain.xfb.nonzeroReadbackCount, 1);
  assert.equal(snapshot.stages.presentationChain.backbuffer.nonzeroReadbackCount, 1);
  assert.equal(snapshot.stages.presentationChain.backbuffer.nonzeroColorReadbackCount, 1);
  assert.equal(snapshot.stages.presentationChain.backbuffer.sourceTextureId, 47);
});

test("host-to-worker plumbing keeps the classifier query-gated and reportable", async () => {
  const [host, adapter, worker] = await Promise.all([
    readFile(new URL("../src/core-host.js", import.meta.url), "utf8"),
    readFile(new URL("../src/upstream-worker-adapter.js", import.meta.url), "utf8"),
    readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8")
  ]);

  assert.match(host, /requestedWgpuReplayDiagnostics\(window\.location\.search\)/);
  assert.match(host, /requestedWgpuDeepReplayDiagnostics\(window\.location\.search\)/);
  assert.match(host, /requestedWgpuDetachedPresenter\(window\.location\.search\)/);
  assert.match(host, /requestedWgpuLoadEpochFence\(window\.location\.search\)/);
  assert.match(
    host,
    /requestedWgpuReplayPump\(\s*window\.location\.search,\s*this\.videoBackend === "WebGPU-Real"\s*\)/
  );
  assert.match(host, /requestedWgpuAtomicPassReplay\(window\.location\.search\)/);
  assert.match(host, /requestedWgpuStateCache\(window\.location\.search\)/);
  assert.match(host, /requestedWgpuUboCache\(window\.location\.search\)/);
  assert.match(host, /requestedWgpuGeometryPack\(window\.location\.search\)/);
  assert.match(adapter, /wgpuReplayDiagnostics: this\.wgpuReplayDiagnostics/);
  assert.match(adapter, /wgpuDeepReplayDiagnostics: this\.wgpuDeepReplayDiagnostics/);
  assert.match(adapter, /wgpuDetachedPresenter: this\.wgpuDetachedPresenter/);
  assert.match(adapter, /wgpuLoadEpochFence: this\.wgpuLoadEpochFence/);
  assert.match(adapter, /wgpuReplayPump: this\.wgpuReplayPump/);
  assert.match(adapter, /wgpuAtomicPassReplay: this\.wgpuAtomicPassReplay/);
  assert.match(adapter, /wgpuStateCache: this\.wgpuStateCache/);
  assert.match(adapter, /wgpuUboCache: this\.wgpuUboCache/);
  assert.match(adapter, /wgpuGeometryPack: this\.wgpuGeometryPack/);
  assert.match(adapter, /detachedBitmapDrawnCount: this\.detachedOglFramesDrawn/);
  assert.match(worker, /scope: "core-load",\s+generation: wgpuReplayClassifierGeneration/);
  assert.match(worker, /wgpuDeepReplayDiagnostics = Boolean\(requestedWgpuDeepReplayDiagnostics\)/);
  assert.match(worker, /wgpuDetachedPresenter: payload\.wgpuDetachedPresenter/);
  assert.match(worker, /wgpuDetachedPresenter = Boolean\(requestedWgpuDetachedPresenter\)/);
  assert.match(worker, /wgpuLoadEpochFence: payload\.wgpuLoadEpochFence/);
  assert.match(worker, /wgpuReplayPump: payload\.wgpuReplayPump/);
  assert.match(worker, /wgpuStateCache: payload\.wgpuStateCache/);
  assert.match(worker, /wgpuUboCache: payload\.wgpuUboCache/);
  assert.match(worker, /wgpuGeometryPack: payload\.wgpuGeometryPack/);
  assert.match(worker, /setWebGpuUboCacheEnabled\?\.\(webGpuUboCacheMode\(\)\)/);
  assert.match(worker, /setWebGpuGeometryPackEnabled\?\.\(wgpuGeometryPackEnabled \? 1 : 0\)/);
  assert.match(worker, /if \(!wgpuDeepReplayDiagnostics\) break;/);
  assert.match(worker, /wgpuDeepReplayDiagnostics && bid === self\._wgVtxBufId/);
  assert.match(worker, /scope: "load-state-file",\s+generation: wgpuReplayClassifierGeneration/);
  assert.match(worker, /classifierGeneration === wgpuReplayClassifierGeneration/);
  assert.match(worker, /wgpuReplayClassifier: wgpuReplayClassifier\?\.snapshot\(\) \?\? null/);
  assert.match(
    worker,
    /wgpuReplayOps: wgpuReplayOpMetrics\.snapshot\(\{ enabled: causalMetricsEnabled \}\)/
  );
  assert.match(worker, /const replayOpStartedAt = causalMetricsEnabled \? performance\.now\(\) : 0/);
  assert.match(
    worker,
    /wgpuReplayOpMetrics\.recordReplay\(op, performance\.now\(\) - replayOpStartedAt\)/
  );
  assert.match(worker, /wgpuReplayOpMetrics\.recordUploadCopy\(/);
  assert.match(worker, /wgpuReplayOpMetrics\.recordQueueUpload\(/);
  assert.match(worker, /const replayLimit = wgpuAtomicPassReplay\s+\? selectAtomicReplayLimit/);
  assert.match(worker, /const WGPU_REPLAY_WINDOW_RECORDS = 16384/);
  assert.match(worker, /publishWgpuReadIndex\(webGpuCmdRing, webGpuCmdRing\.consumerRead\)/);
  assert.match(worker, /Atomics\.load\(ring\.headerI32, 3\)/);
  assert.match(worker, /type: "detachedWgpuFrame"/);
  assert.match(worker, /scheduleDetachedWgpuBitmap\(q\)/);
  assert.match(worker, /while \(read !== replayLimit\)/);
  assert.match(worker, /endPass\("drain-boundary", read\)/);
});

test("worker reads the first completed EFB pass before later presents can clear it", async () => {
  const worker = await readFile(
    new URL("../src/upstream-discio-worker.js", import.meta.url),
    "utf8"
  );
  assert.match(
    worker,
    /beginFirstEfbPassReadback\(\{[\s\S]*?framebufferId: endedFramebufferId[\s\S]*?copyTextureToBuffer[\s\S]*?submitEnc\("first-efb-pass-readback"\)/
  );
  assert.match(worker, /recordFirstEfbPassReadback\(\{[\s\S]*?nonzeroColorBytes/);
});

test("geometry upload packing is default-off with an explicit boolean override", () => {
  assert.equal(requestedWgpuGeometryPack(""), false);
  assert.equal(requestedWgpuGeometryPack("", true), true);
  assert.equal(requestedWgpuGeometryPack("?wgpugeompack=1"), true);
  assert.equal(requestedWgpuGeometryPack("?wgpugeompack=0", true), false);
});

test("worker publishes upload-role, pass-window, and verified-load attribution", async () => {
  const worker = await readFile(
    new URL("../src/upstream-discio-worker.js", import.meta.url),
    "utf8"
  );

  assert.match(worker, /createWgpuUploadAttribution/);
  assert.match(worker, /const uploadRole = u32\[recWord \+ 5\]/);
  assert.match(
    worker,
    /wgpuUploadAttribution\.recordUpload\([\s\S]*?uploadRole,[\s\S]*?uploadBytes/
  );
  assert.match(
    worker,
    /wgpuUploadAttribution\.recordUpload\([\s\S]*?WGPU_UPLOAD_ROLE\.TEXTURE_ADJACENT/
  );
  assert.match(worker, /wgpuUploadAttribution\.recordPassBegin\(\)/);
  assert.match(worker, /wgpuUploadAttribution\.recordPassEnd\(\)/);
  assert.match(worker, /uploadTimeoutCountBeforeLoad/);
  assert.match(worker, /uploadTimeoutCountAfterVerifiedLoad/);
  assert.match(worker, /wgpuUploadTimeoutBoundary/);
  assert.match(
    worker,
    /wgpuUploadAttribution: wgpuUploadAttribution\.snapshot\(\{ enabled: causalMetricsEnabled \}\)/
  );
});

function incrementingClock() {
  let value = 0;
  return () => ++value;
}
