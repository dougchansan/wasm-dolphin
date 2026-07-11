// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readSource = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("upload transport flows from URL parsing through the worker load payload", async () => {
  const [host, adapter, worker] = await Promise.all([
    readSource("../src/core-host.js"),
    readSource("../src/upstream-worker-adapter.js"),
    readSource("../src/upstream-discio-worker.js"),
  ]);
  assert.match(host, /requestedWgpuUploadTransport\(window\.location\.search\)/);
  assert.match(host, /wgpuUploadTransport: this\.wgpuUploadTransport/);
  assert.match(adapter, /wgpuUploadTransport === "mapped" \? "mapped" : "queue"/);
  assert.match(adapter, /wgpuUploadTransport: this\.wgpuUploadTransport/);
  assert.match(worker, /wgpuUploadTransport: payload\.wgpuUploadTransport/);
  assert.match(worker, /requestedWgpuUploadTransport === "mapped" \? "mapped" : "queue"/);
});

test("mapped uploads are copied into a bounded pool and queue writes stay isolated", async () => {
  const worker = await readSource("../src/upstream-discio-worker.js");
  assert.match(worker, /WGPU_MAPPED_STAGING_SLOT_COUNT = 3/);
  assert.match(worker, /WGPU_MAPPED_STAGING_SLOT_BYTES = 16 \* 1024 \* 1024/);
  assert.match(worker, /if \(wgpuUploadTransport === "mapped"\) \{[\s\S]*?\.stageBuffer\(\{/);
  assert.match(worker, /if \(wgpuUploadTransport === "mapped"\) \{[\s\S]*?\.stageTexture\(\{/);
  assert.match(worker, /\} else \{[\s\S]*?q\.writeBuffer\(/);
  assert.match(worker, /\} else \{[\s\S]*?q\.writeTexture\(/);
  assert.match(worker, /mappedStagingCopyCount/);
  assert.match(worker, /mappedStagingCapacityWaitCount/);
  assert.match(worker, /mappedStagingRemapFailureCount/);
  assert.match(worker, /mappedStagingRetainedDrainCount/);
});

test("submission orders upload before render and capacity never falls back", async () => {
  const worker = await readSource("../src/upstream-discio-worker.js");
  assert.match(
    worker,
    /q\.submit\(mappedBatch\s*\? \[mappedBatch\.commandBuffer, renderCommandBuffer\]/
  );
  assert.match(worker, /q\.submit\(\[batch\.commandBuffer\]\)/);
  assert.match(
    worker,
    /if \(mappedCapacityHold\) \{[\s\S]*?if \(pass\) \{[\s\S]*?markWgpuReplayFatal/
  );
  assert.match(
    worker,
    /The current upload record is deliberately still owned by the ring/
  );
  assert.match(worker, /rejectMappedBatch\(mappedBatch, e\)/);
  assert.match(worker, /wgpuMappedStagingPool\?\.invalidate\("WebGPU device lost"\)/);
  assert.match(
    worker,
    /reason === "drain-boundary" && wgpuUploadTransport === "mapped"[\s\S]*?return false;[\s\S]*?flushMappedUploadsOnly\(reason\)/
  );
});

test("performance validation fails closed when the mapped arm executes queue transport", async () => {
  const gate = await readSource("../tools/perf-regression-gate.mjs");
  assert.match(gate, /"wgpuuploadtransport"/);
  assert.match(gate, /WGPU upload transport mismatch: requested=/);
  assert.match(gate, /final\.causalTelemetry\?\.webgpu\?\.uploadTransport/);
});
