import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createWgpuReplayClassifier,
  requestedWgpuAtomicPassReplay,
  requestedWgpuDeepReplayDiagnostics,
  requestedWgpuReplayDiagnostics,
  selectAtomicReplayLimit
} from "../src/wgpu-replay-diagnostics.js";

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
  assert.equal(classifier.needsPostDrawEfbReadback(1), true);

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

test("host-to-worker plumbing keeps the classifier query-gated and reportable", async () => {
  const [host, adapter, worker] = await Promise.all([
    readFile(new URL("../src/core-host.js", import.meta.url), "utf8"),
    readFile(new URL("../src/upstream-worker-adapter.js", import.meta.url), "utf8"),
    readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8")
  ]);

  assert.match(host, /requestedWgpuReplayDiagnostics\(window\.location\.search\)/);
  assert.match(host, /requestedWgpuDeepReplayDiagnostics\(window\.location\.search\)/);
  assert.match(host, /requestedWgpuAtomicPassReplay\(window\.location\.search\)/);
  assert.match(adapter, /wgpuReplayDiagnostics: this\.wgpuReplayDiagnostics/);
  assert.match(adapter, /wgpuDeepReplayDiagnostics: this\.wgpuDeepReplayDiagnostics/);
  assert.match(adapter, /wgpuAtomicPassReplay: this\.wgpuAtomicPassReplay/);
  assert.match(worker, /wgpuReplayDiagnostics\s+\? createWgpuReplayClassifier\(\{ scope: "core-load" \}\)/);
  assert.match(worker, /wgpuDeepReplayDiagnostics = Boolean\(requestedWgpuDeepReplayDiagnostics\)/);
  assert.match(worker, /if \(!wgpuDeepReplayDiagnostics\) break;/);
  assert.match(worker, /wgpuDeepReplayDiagnostics && bid === self\._wgVtxBufId/);
  assert.match(worker, /createWgpuReplayClassifier\(\{ scope: "load-state-file" \}\)/);
  assert.match(worker, /classifierGeneration === wgpuReplayClassifierGeneration/);
  assert.match(worker, /wgpuReplayClassifier: wgpuReplayClassifier\?\.snapshot\(\) \?\? null/);
  assert.match(worker, /const replayLimit = wgpuAtomicPassReplay\s+\? selectAtomicReplayLimit/);
  assert.match(worker, /while \(read !== replayLimit\)/);
  assert.match(worker, /endPass\("drain-boundary", read\)/);
});

function incrementingClock() {
  let value = 0;
  return () => ++value;
}
