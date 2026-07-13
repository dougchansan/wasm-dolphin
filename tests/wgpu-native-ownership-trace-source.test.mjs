// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("native ownership trace keeps a separate fixed ABI and explicit allocation gate", async () => {
  const [header, source] = await Promise.all([
    read("vendor/dolphin/Source/Core/VideoBackends/WebGPU/WebGPUCommandStream.h"),
    read("vendor/dolphin/Source/Core/VideoBackends/WebGPU/WebGPUCommandStream.cpp"),
  ]);

  assert.match(header, /static_assert\(sizeof\(CmdRecord\) == 32/);
  assert.match(header, /static_assert\(sizeof\(CmdRingHeader\) == 28/);
  assert.match(header, /static_assert\(sizeof\(OwnershipTraceHeader\) == 20/);
  assert.match(header, /static_assert\(sizeof\(OwnershipTraceRecord\) == 32/);
  assert.match(header, /std::atomic<bool> m_trace_enabled\{false\}/);

  const ensureCalls = source.match(/EnsureOwnershipTrace\(\)/g) ?? [];
  assert.equal(ensureCalls.length, 2, "only the definition and explicit setter may allocate");
  assert.match(
    source,
    /SetOwnershipTraceEnabled\(bool enabled\)[\s\S]*?EnsureOwnershipTrace\(\)[\s\S]*?m_trace_enabled\.store\(true/
  );
  assert.doesNotMatch(source, /webgpu-ownership-trace-ring/);
  const ensureBody = /void WebGPUCommandStream::EnsureOwnershipTrace\(\)[\s\S]*?\n\}/
    .exec(source)?.[0] ?? "";
  assert.doesNotMatch(ensureBody, /EM_ASM|postMessage/);
  assert.match(header, /u32 GetOwnershipTracePtr\(\) const/);
  assert.match(header, /u32 GetOwnershipTraceCapacity\(\) const/);
  assert.match(source, /kOwnershipTraceCapacity = 131072/);
  assert.match(source, /m_trace_header->epoch\.store\(m_trace_epoch/);
});

test("native ownership trace records transaction outcomes without widening replay commands", async () => {
  const [source, vertexManager] = await Promise.all([
    read("vendor/dolphin/Source/Core/VideoBackends/WebGPU/WebGPUCommandStream.cpp"),
    read("vendor/dolphin/Source/Core/VideoBackends/WebGPU/WebGPUVertexManager.cpp"),
  ]);

  assert.match(source, /TraceCommand\(rec\);[\s\S]*?return true;/);
  assert.match(source, /BeginPendingOwnership\(\)/);
  assert.match(vertexManager, /CommitBuffer[\s\S]*?cs\.BeginPendingOwnership\(\)/);
  assert.match(source, /OwnershipTraceEvent::PendingReserved/);
  assert.match(
    source,
    /BeginPendingOwnership\(\)[\s\S]*?m_pass_staging \|\| m_trace_active_transaction != 0/,
    "an active pass must not reserve a mislabeled successor transaction"
  );
  assert.match(source, /OwnershipTraceEvent::PassBegin/);
  assert.match(source, /OwnershipTraceEvent::Commit/);
  assert.match(source, /OwnershipTraceEvent::Abort/);
  assert.match(source, /OwnershipTraceEvent::Poison/);
  assert.match(source, /OwnershipTraceEvent::Rollback/);
  assert.match(source, /OwnershipTraceEvent::ConsumerFailure/);
  assert.match(source, /OwnershipAttribution::Pending/);
  assert.match(source, /OwnershipAttribution::Active/);
  assert.match(source, /OwnershipAttribution::Outside/);
  assert.match(source, /record\.resource_id = detail0/);
  assert.match(source, /record\.payload_length = detail1/);
  assert.match(
    source,
    /case CmdOp::BeginPass:[\s\S]*?resource_id = rec\.arg\.u\[0\]/,
    "BeginPass must correlate its framebuffer id with the legacy semantic decoder"
  );
  assert.match(source, /publication << 8/);
  assert.match(source, /m_header->write\.store\(w \+ count, std::memory_order_release\)/);
});

test("save-state wrappers publish a deferred ownership load-request epoch", async () => {
  const [wrapper, gfx, cmake] = await Promise.all([
    read("core/upstream/dolphin_web_core.cpp"),
    read("vendor/dolphin/Source/Core/VideoBackends/WebGPU/WebGPUGfx.cpp"),
    read("vendor/dolphin/Source/Core/Core/CMakeLists.txt"),
  ]);

  assert.match(gfx, /SetWebGpuOwnershipTraceEnabled\(int enabled\)/);
  assert.match(gfx, /GetWebGpuOwnershipTracePtr\(\)/);
  assert.match(gfx, /GetWebGpuOwnershipTraceCapacity\(\)/);
  assert.match(gfx, /NotifyWebGpuOwnershipTraceLoadRequested\(\)/);
  assert.equal(
    wrapper.match(/^  NotifyWebGpuOwnershipTraceLoadRequested\(\);/gm)?.length,
    2,
    "slot and file state loads must both mark the native trace"
  );
  assert.match(cmake, /'_SetWebGpuOwnershipTraceEnabled'/);
  assert.match(cmake, /'_GetWebGpuOwnershipTracePtr'/);
  assert.match(cmake, /'_GetWebGpuOwnershipTraceCapacity'/);
  assert.doesNotMatch(wrapper, /LoadBoundary/);
});

test("locked native ownership patch replays the source contract", async () => {
  const patch = await read(
    "patches/dolphin-wasm/snapshot/0039-webgpu-native-ownership-trace.patch"
  );
  assert.match(patch, /OwnershipTraceHeader/);
  assert.match(patch, /ownership trace header must stay 20 bytes/);
  assert.match(patch, /SetWebGpuOwnershipTraceEnabled/);
  assert.match(patch, /GetWebGpuOwnershipTracePtr/);
  assert.match(patch, /GetWebGpuOwnershipTraceCapacity/);
  assert.match(patch, /LoadRequested/);
});
