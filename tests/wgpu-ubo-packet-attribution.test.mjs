// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const patchPath = new URL(
  "../patches/dolphin-wasm/snapshot/0025-webgpu-ubo-packet-attribution.patch",
  import.meta.url
);

test("UBO packet screening is metrics-gated and does not change upload behavior", async () => {
  const source = await readFile(patchPath, "utf8");

  assert.match(source, /s_ubo_change_mask_histogram\[8\]/);
  assert.match(source, /if \(!s_ubo_cache_metrics_enabled\.load\(std::memory_order_relaxed\)\)\s*\+?\s*return;/);
  assert.match(source, /RecordUboPacketOpportunity\(ubo_change_mask, ubo_payload_sizes\)/);
  assert.match(source, /Measurement only: no packet is emitted and all existing uploads remain unchanged/);
  assert.doesNotMatch(source, /^\+.*PushUploadBuffer/m);
  assert.doesNotMatch(source, /^\+.*AllocUboSlice\(/m);
});

test("UBO packet screening records the complete 3-bit opportunity model", async () => {
  const source = await readFile(patchPath, "utf8");

  for (const bit of [0, 1, 2]) {
    assert.match(source, new RegExp(`ubo_change_mask \\|= 1u << ${bit}`));
    assert.match(source, new RegExp(`ubo_payload_sizes\\[${bit}\\] = sizeof`));
    assert.match(source, new RegExp(`RecordUboPrepareCpu\\(${bit}, cpu_start_ms\\)`));
  }
  for (let mask = 0; mask < 8; mask += 1) {
    assert.match(source, new RegExp(`s_ubo_change_mask_histogram\\[${mask}\\]`));
  }
  assert.match(source, /changed_count >= 2/);
  assert.match(source, /theoretical_calls_removed\.fetch_add\(changed_count - 1/);
  assert.match(source, /payload_sizes\[index\] \+ 255u\) & ~255u/);
});

test("UBO CPU attribution is producer-classed and measured only in metrics runs", async () => {
  const source = await readFile(patchPath, "utf8");

  assert.match(source, /s_ubo_prepare_cpu_calls\[3\]/);
  assert.match(source, /s_ubo_prepare_cpu_ns\[3\]/);
  assert.match(source, /const double elapsed_ms = emscripten_get_now\(\) - start_ms/);
  assert.match(source, /umask:/);
  assert.match(source, /upack:/);
  assert.match(source, /ucpucall:/);
  assert.match(source, /ucpuns:/);
});

test("consumer brackets queue.writeBuffer and exports raw role timing", async () => {
  const [worker, causal] = await Promise.all([
    readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8"),
    readFile(new URL("../src/causal-telemetry.js", import.meta.url), "utf8"),
  ]);

  assert.match(worker,
    /queueWriteStartedAt = causalMetricsEnabled \? performance\.now\(\) : 0;[\s\S]*?q\.writeBuffer\([\s\S]*?recordQueueWrite\([\s\S]*?performance\.now\(\) - queueWriteStartedAt/);
  assert.match(worker, /backlogRecords: \(replayLimit - read\) >>> 0/);
  assert.match(worker, /submissionCount: webGpuCausalStats\.queueSubmissionCount/);
  assert.match(worker, /passDepth: protocolPassDepth/);
  assert.match(causal, /causalWgpuQueueWriteTotalMsByRole: queueWrite\.totalMsByRole/);
  assert.match(causal, /causalWgpuQueueWriteSlowEvents: queueWrite\.slowEvents/);
});
