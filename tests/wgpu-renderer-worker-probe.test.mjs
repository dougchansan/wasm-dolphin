// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readSource = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("nested renderer canary proves SAB and headless WebGPU completion", async () => {
  const source = await readSource("../src/wgpu-renderer-worker-probe.js");
  assert.match(source, /sharedCanary instanceof SharedArrayBuffer/);
  assert.match(source, /Atomics\.store/);
  assert.match(source, /navigator\.gpu\.requestAdapter/);
  assert.match(source, /adapter\.requestDevice/);
  assert.match(source, /copyBufferToBuffer/);
  assert.match(source, /queue\.onSubmittedWorkDone/);
  assert.match(source, /destination\.mapAsync/);
  assert.match(source, /source\.destroy\(\)/);
  assert.match(source, /destination\.destroy\(\)/);
});

test("disc worker runs the canary before touching visible renderer ownership", async () => {
  const worker = await readSource("../src/upstream-discio-worker.js");
  const canaryCall = worker.indexOf("await runWgpuRendererWorkerCanary()");
  const canvasContext = worker.indexOf("createWebGpuPresenter(canvas");
  assert.ok(canaryCall > 0 && canvasContext > canaryCall);
  assert.match(worker, /new Worker\(new URL\("\.\/wgpu-renderer-worker-probe\.js"/);
  assert.match(worker, /new SharedArrayBuffer\(4\)/);
  assert.match(worker, /renderer worker canary timed out/);
  assert.match(worker, /result\.schema !== expectedSchema/);
  assert.match(worker, /result\.observed !== expectedCanary/);
  assert.match(worker, /rendererWorkerProbe\.error = String/);
});

test("canary mode is URL-gated, worker-plumbed, and validation-gated", async () => {
  const [host, adapter, gate] = await Promise.all([
    readSource("../src/core-host.js"),
    readSource("../src/upstream-worker-adapter.js"),
    readSource("../tools/perf-regression-gate.mjs"),
  ]);
  assert.match(host, /requestedWgpuRendererWorkerProbe\(window\.location\.search\)/);
  assert.match(adapter, /wgpuRendererWorkerProbe: this\.wgpuRendererWorkerProbe/);
  assert.match(gate, /"wgpurenderprobe"/);
  assert.match(gate, /evaluateWgpuRendererWorkerProbeEvidence/);
});

test("upload probes share one executor and suppress normal visible replay", async () => {
  const [nested, disc, gate] = await Promise.all([
    readSource("../src/wgpu-renderer-worker-probe.js"),
    readSource("../src/upstream-discio-worker.js"),
    readSource("../tools/perf-regression-gate.mjs"),
  ]);
  assert.match(nested, /createWgpuUploadProbeExecutor/);
  assert.match(nested, /upload-probe-init/);
  assert.match(nested, /upload-probe-attach/);
  assert.match(nested, /upload-probe-finalize/);
  assert.match(nested, /upload-probe-begin-measurement/);
  assert.match(nested, /ownerBuffer instanceof SharedArrayBuffer/);
  assert.match(disc, /isWgpuUploadProbeMode\(wgpuRendererWorkerProbe\)/);
  assert.match(disc, /renderBackend = "wgpu-upload-probe"/);
  assert.match(disc, /cmdRingOwnsCanvas = true/);
  assert.match(disc, /disposition: intentionalBlankProbe \? "intentional-blank-probe" : "visible-canvas"/);
  assert.match(disc, /expectsVisibleCanvas: !intentionalBlankProbe/);
  assert.match(disc, /outputContract: wgpuOutputContractPayload\(\)/);
  assert.match(disc, /validationFinalizeWgpuRendererProbe/);
  assert.match(disc, /validationBeginWgpuRendererProbeMeasurement/);
  assert.match(disc, /validationReadCoreProgress/);
  assert.match(disc, /framePayload\(\{ forceCausalTelemetry: true \}\)/);
  assert.match(disc, /maybeCreateCausalTelemetry\(videoStats, \{ force: forceCausalTelemetry \}\)/);
  assert.match(disc, /attachWgpuUploadProbeRing\(data, heap\.buffer\)/);
  assert.match(disc, /headerPtr \+ 7 \* 4 > heapBuffer\.byteLength/);
  assert.match(disc, /failWgpuUploadProbeRing\("upload probe requires protocol v3 handoff"\)/);
  assert.match(gate, /validateWgpuUploadProbeFinalization/);
  assert.match(gate, /liveWorkerProgress: uploadProbeMode/);
});

test("visible replay classifies the existing failed-present branch", async () => {
  const disc = await readSource("../src/upstream-discio-worker.js");
  const submitPresent = disc.indexOf("const submittedPresent = presentAlreadySubmitted");
  const rejection = disc.indexOf("recordPresentRejected", submitPresent);
  const existingBreak = disc.indexOf("break;", rejection);
  assert.ok(submitPresent > 0 && rejection > submitPresent && existingBreak > rejection);
  assert.match(disc, /lastSubmitFailureReason = wgpuReplayFatal \? "replay-fatal" : "no-command-encoder"/);
  assert.match(disc, /lastSubmitFailureReason = "submit-error"/);
  assert.match(disc, /lastSubmitFailureReason = wgpuReplayFatal\.scope === "submit-error"/);
  assert.match(disc, /\[webgpu-present-rejected\] reason=/);
  assert.match(disc, /_wgPresentRejectedLogCount <= 4/);
});
