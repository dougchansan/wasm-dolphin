// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const worker = fs.readFileSync(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
const host = fs.readFileSync(new URL("../src/core-host.js", import.meta.url), "utf8");
const adapter = fs.readFileSync(
  new URL("../src/upstream-worker-adapter.js", import.meta.url),
  "utf8"
);
const harness = fs.readFileSync(
  new URL("../tools/menu-progress-validate.mjs", import.meta.url),
  "utf8"
);
const perfGate = fs.readFileSync(
  new URL("../tools/perf-regression-gate.mjs", import.meta.url),
  "utf8"
);

test("wgpusemantic is default-off, hardware-only, metrics-only, and implies ownership tracing", () => {
  assert.match(host, /requestedWgpuSemanticRuntime\(window\.location\.search\)/);
  assert.match(host, /if \(this\.wgpuSemanticRuntime\) this\.wgpuOwnershipTrace = true/);
  assert.match(adapter, /wgpuSemanticRuntime = false/);
  assert.match(adapter, /wgpuSemanticRuntime: this\.wgpuSemanticRuntime/);
  assert.match(worker, /wgpusemantic=1 requires metrics=1/);
  assert.match(worker, /wgpusemantic=1 requires video=wgpu/);
  assert.match(harness, /process\.env\.CORE_ID.*"coreid"/);
  assert.match(harness, /\["WGPUSEMANTIC", "wgpusemantic"\]/);
});

test("startup reset evidence is captured before trace attach and before backend activation", () => {
  const capture = worker.indexOf("captureInitialWgpuConsumerResetAttestation({");
  const attach = worker.indexOf("attachWgpuOwnershipTraceFromApi(", capture);
  const backend = worker.indexOf("api.setVideoBackend(videoBackend)", attach);
  assert.ok(capture > 0);
  assert.ok(attach > capture);
  assert.ok(backend > attach);
  assert.match(worker.slice(capture, attach), /resourceMaps: webGpuObjects/);
  assert.match(worker.slice(capture, attach), /commandsProcessed: webGpuCausalStats\.commandsProcessed/);
  assert.match(worker.slice(capture, attach), /commandRingRegistered: Boolean\(webGpuCmdRing\)/);
});

test("legacy semantics snapshot before replay and commit only before the read cursor advances", () => {
  const prepare = worker.indexOf("wgpuSemanticRuntime.prepareLegacy(");
  const payloadSnapshot = worker.lastIndexOf("const retainedSemanticPayload", prepare);
  const replay = worker.indexOf("const replayOpStartedAt", prepare);
  const decision = worker.lastIndexOf("if (wgpuSemanticRuntimeActive)",
    worker.indexOf("wgpuSemanticRuntime.acceptPrepared", replay));
  const accept = worker.indexOf("wgpuSemanticRuntime.acceptPrepared", replay);
  const advance = worker.indexOf("read = (read + 1) >>> 0", accept);
  assert.ok(prepare > 0);
  assert.ok(replay > prepare);
  assert.ok(accept > replay);
  assert.ok(advance > accept);
  assert.match(worker.slice(payloadSnapshot, replay), /exactRetainedSemanticPayload/);
  assert.match(worker.slice(payloadSnapshot, replay), /subarray\(0, u32\[recWord \+ 4\]\)/);
  assert.match(worker.slice(decision, advance), /replayRecordAccepted/);
  assert.match(worker.slice(decision, advance), /!wgpuReplayFatal/);
  assert.match(worker.slice(decision, advance), /!mappedCapacityHold/);
  assert.match(worker.slice(decision, advance), /retryPrepared/);
});

test("replay resolves retained upload payload once and only for upload opcodes", () => {
  const loop = worker.slice(
    worker.indexOf("while (read !== replayLimit)"),
    worker.indexOf("read = (read + 1) >>> 0")
  );
  const lookup = loop.indexOf("ring.stagedUploads.get(read)");
  const semantic = loop.indexOf("const retainedSemanticPayload");
  assert.ok(lookup > 0);
  assert.ok(semantic > lookup);
  assert.equal(loop.match(/ring\.stagedUploads\.get\(read\)/g)?.length, 1);
  assert.match(
    loop.slice(0, semantic),
    /op === WGPU_CMD_OP_UPLOAD_BUFFER[\s\S]*op === WGPU_CMD_OP_UPLOAD_TEXTURE[\s\S]*ring\.stagedUploads\?\.size/
  );
  assert.match(loop, /const retainedSemanticPayload = stagedUpload\?\.data/);
});

test("mapped sparse UBO staging is screened by the producer upload role", () => {
  const uploadCase = worker.slice(
    worker.indexOf("case WGPU_CMD_OP_UPLOAD_BUFFER"),
    worker.indexOf("case WGPU_CMD_OP_CREATE_TEXTURE")
  );
  assert.equal(uploadCase.match(/ensureWgpuSparseUbo\(dev\)\?\.stage/g)?.length, 2);
  assert.equal(
    uploadCase.match(/uploadRole === WGPU_UPLOAD_ROLE\.UBO[\s\S]{0,120}ensureWgpuSparseUbo\(dev\)\?\.stage/g)?.length,
    2
  );
  assert.match(uploadCase, /else if \(wgpuMappedStageFastEnabled\)/);
  assert.match(uploadCase, /pool\.stageBuffer\(\{/);
});

test("load-fence and permanently rejected records invalidate evidence", () => {
  assert.match(
    worker,
    /load fence permanently discarded \$\{discardedRecords\} published records/
  );
  assert.match(worker, /consumer rejected record \$\{read\} opcode \$\{op\}/);
});

test("device loss invalidates semantic evidence instead of claiming a reset", () => {
  const start = worker.indexOf("function clearWgpuReplayStateAfterDeviceLoss()");
  const end = worker.indexOf("function ensureWgpuMappedStagingPool", start);
  const body = worker.slice(start, end);
  assert.match(body, /wgpuSemanticRuntime\.invalidate/);
  assert.doesNotMatch(body, /captureInitialWgpuConsumerResetAttestation/);
});

test("bounded capture freezes at the published cutoff before releasing the producer", () => {
  const publish = worker.indexOf("publishWgpuReadIndex(ring, read);");
  const advance = worker.indexOf("advanceWgpuSemanticCapture(ring, read);", publish);
  assert.ok(publish > 0);
  assert.ok(advance > publish);
  const helperStart = worker.indexOf("function advanceWgpuSemanticCapture(");
  const helperEnd = worker.indexOf("\nasync function initializeWgpuUploadProbe", helperStart);
  const helper = worker.slice(helperStart, helperEnd);
  const request = helper.indexOf("maybeRequestCaptureEnd(");
  const nativeStop = helper.indexOf("setWebGpuOwnershipTraceEnabled(0)", request);
  const freeze = helper.indexOf("maybeFreezeCapture(", nativeStop);
  const acknowledge = helper.indexOf("acknowledgeWebGpuOwnershipTraceCapture", freeze);
  assert.ok(request > 0);
  assert.ok(nativeStop > request);
  assert.ok(freeze > nativeStop);
  assert.ok(acknowledge > freeze);
  assert.match(helper, /commandRingRead: read/);
  assert.match(helper, /commandRingWrite: write/);
  assert.match(
    helper,
    /const loadedCheckpointGeneration = readLastLoadedCheckpoint\(\)\.generation/
  );
  assert.equal(
    helper.match(/loadedCheckpointGeneration,/g)?.length,
    2,
    "capture stop and freeze must both qualify the current loaded checkpoint"
  );
  assert.match(worker, /wgpusemantic=1 requires AcknowledgeWebGpuOwnershipTraceCapture/);
});

test("the perf gate qualifies requested semantic evidence after the loaded checkpoint", () => {
  assert.match(perfGate, /scenario\.params\?\.wgpusemantic/);
  assert.match(perfGate, /evaluateWgpuSemanticQualificationEvidence/);
  assert.match(
    perfGate,
    /final\.causalTelemetry\?\.core\?\.loadedCheckpointGeneration/
  );
  assert.match(perfGate, /"wgpusemantic"/);
});
