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

test("wgpusemantic is default-off, hardware-only, metrics-only, and implies ownership tracing", () => {
  assert.match(host, /requestedWgpuSemanticRuntime\(window\.location\.search\)/);
  assert.match(host, /if \(this\.wgpuSemanticRuntime\) this\.wgpuOwnershipTrace = true/);
  assert.match(adapter, /wgpuSemanticRuntime = false/);
  assert.match(adapter, /wgpuSemanticRuntime: this\.wgpuSemanticRuntime/);
  assert.match(worker, /wgpusemantic=1 requires metrics=1/);
  assert.match(worker, /wgpusemantic=1 requires video=wgpu/);
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
