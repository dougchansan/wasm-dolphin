// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createWgpuPassStateCache,
  parseWgpuProducerStateStats
} from "../src/wgpu-pass-state-cache.js";

test("producer stats expose suppression counts and invalidate dropped runs", () => {
  assert.deepEqual(
    parseWgpuProducerStateStats(
      "wgstate:1 pipe:4 bg:5,6,7 vb:8 ib:9 wgdrop:0 " +
      "wgbabort:10 wgboversize:11 wguploadto:12 " +
      "wgubo:1 wgubometrics:1 ulook:13,14,15 uhit:16,17,18 uexp:19,20,21 " +
      "usupcall:22,23,24 usupbyte:25,26,27 wggeom:1 wggeomepoch:28 " +
      "wgarena:67108864,67108864,29,30,31,33554432"
    ),
    {
      enabled: true,
      pipelineRecordsSuppressed: 4,
      bindGroupRecordsSuppressed: [5, 6, 7],
      vertexBufferRecordsSuppressed: 8,
      indexBufferRecordsSuppressed: 9,
      commandDroppedCount: 0,
      batchAbortCount: 10,
      batchOversizeCount: 11,
      uploadTimeoutCount: 12,
      uboCacheEnabled: true,
      uboCacheMetricsEnabled: true,
      uboCacheClassOrder: ["vs", "ps", "gs"],
      uboCacheLookups: [13, 14, 15],
      uboCacheHits: [16, 17, 18],
      uboCacheExpired: [19, 20, 21],
      uboUploadCallsSuppressed: [22, 23, 24],
      uboUploadBytesSuppressed: [25, 26, 27],
      geometryPackEnabled: true,
      geometryPackEpoch: 28,
      uploadArenaRequestedBytes: 67108864,
      uploadArenaConfiguredBytes: 67108864,
      uploadArenaFallbackCount: 29,
      uploadArenaLateRejectCount: 30,
      uploadArenaWrapCount: 31,
      uploadArenaInflightHighWaterBytes: 33554432
    }
  );
  assert.deepEqual(
    parseWgpuProducerStateStats(
      "wgstate:0 pipe:0 bg:0,0,0 vb:0 ib:0 wgdrop:0"
    ),
    {
      enabled: false,
      pipelineRecordsSuppressed: 0,
      bindGroupRecordsSuppressed: [0, 0, 0],
      vertexBufferRecordsSuppressed: 0,
      indexBufferRecordsSuppressed: 0,
      commandDroppedCount: 0,
      batchAbortCount: 0,
      batchOversizeCount: 0,
      uploadTimeoutCount: 0,
      uboCacheEnabled: false,
      uboCacheMetricsEnabled: false,
      uboCacheClassOrder: ["vs", "ps", "gs"],
      uboCacheLookups: [0, 0, 0],
      uboCacheHits: [0, 0, 0],
      uboCacheExpired: [0, 0, 0],
      uboUploadCallsSuppressed: [0, 0, 0],
      uboUploadBytesSuppressed: [0, 0, 0],
      geometryPackEnabled: false,
      geometryPackEpoch: 0,
      uploadArenaRequestedBytes: 0,
      uploadArenaConfiguredBytes: 0,
      uploadArenaFallbackCount: 0,
      uploadArenaLateRejectCount: 0,
      uploadArenaWrapCount: 0,
      uploadArenaInflightHighWaterBytes: 0
    }
  );
  assert.equal(parseWgpuProducerStateStats("wgstate:1 pipe:4"), null);
});

test("exact successful state repeats are redundant", () => {
  const cache = createWgpuPassStateCache();
  const pipeline = {};
  const bindGroup = {};
  const vertexBuffer = {};
  const indexBuffer = {};

  assert.equal(cache.pipelineNeedsApply(pipeline), true);
  assert.equal(cache.recordPipelineApplied(pipeline), true);
  assert.equal(cache.pipelineNeedsApply(pipeline), false);
  assert.equal(cache.isPipelineReady(pipeline), true);
  assert.equal(cache.pipelineNeedsApply({}), true);

  assert.equal(cache.bindGroupNeedsApply(2, bindGroup), true);
  assert.equal(cache.recordBindGroupApplied(2, bindGroup), true);
  assert.equal(cache.bindGroupNeedsApply(2, bindGroup), false);

  assert.equal(cache.vertexBufferNeedsApply(0, vertexBuffer, 32), true);
  assert.equal(cache.recordVertexBufferApplied(0, vertexBuffer, 32), true);
  assert.equal(cache.vertexBufferNeedsApply(0, vertexBuffer, 32), false);
  assert.equal(cache.vertexBufferNeedsApply(0, vertexBuffer, 36), true);

  assert.equal(cache.indexBufferNeedsApply(indexBuffer, "uint16", 64), true);
  assert.equal(cache.recordIndexBufferApplied(indexBuffer, "uint16", 64), true);
  assert.equal(cache.indexBufferNeedsApply(indexBuffer, "uint16", 64), false);
  assert.equal(cache.indexBufferNeedsApply(indexBuffer, "uint32", 64), true);
  assert.equal(cache.indexBufferNeedsApply(indexBuffer, "uint16", 68), true);

  const counters = cache.snapshot().counters;
  assert.equal(counters.pipeline.redundant, 1);
  assert.equal(counters.bindGroups.slots[2].redundant, 1);
  assert.equal(counters.vertexBuffers.slots[0].redundant, 1);
  assert.equal(counters.indexBuffer.redundant, 1);
});

test("bind-group dynamic offsets are copied and compared exactly", () => {
  const cache = createWgpuPassStateCache();
  const bindGroup = {};
  const offsets = new Uint32Array([64, 128, 256, 512]);

  assert.equal(cache.bindGroupNeedsApply(0, bindGroup, offsets, 4), true);
  assert.equal(cache.recordBindGroupApplied(0, bindGroup, offsets, 4), true);
  offsets[0] = 999;

  assert.equal(cache.bindGroupNeedsApply(0, bindGroup,
    new Uint32Array([64, 128, 256, 512]), 4), false);
  assert.equal(cache.bindGroupNeedsApply(0, bindGroup,
    new Uint32Array([64, 128, 256, 513]), 4), true);
  assert.equal(cache.bindGroupNeedsApply(0, bindGroup,
    new Uint32Array([64, 128, 256, 512]), 3), true);
});

test("bind-group and vertex-buffer slots remain independent", () => {
  const cache = createWgpuPassStateCache();
  const bindGroup = {};
  const buffer = {};

  cache.recordBindGroupApplied(0, bindGroup);
  cache.recordVertexBufferApplied(0, buffer, 0);

  assert.equal(cache.bindGroupNeedsApply(0, bindGroup), false);
  assert.equal(cache.bindGroupNeedsApply(1, bindGroup), true);
  assert.equal(cache.vertexBufferNeedsApply(0, buffer, 0), false);
  assert.equal(cache.vertexBufferNeedsApply(1, buffer, 0), true);
});

test("the first state after a pass reset always requires an apply", () => {
  const cache = createWgpuPassStateCache();
  const pipeline = {};
  const bindGroup = {};
  const vertexBuffer = {};
  const indexBuffer = {};

  cache.recordPipelineApplied(pipeline);
  cache.recordBindGroupApplied(2, bindGroup);
  cache.recordVertexBufferApplied(0, vertexBuffer, 0);
  cache.recordIndexBufferApplied(indexBuffer, "uint16", 0);

  assert.equal(cache.reset("begin-pass"), 4);
  assert.equal(cache.isPipelineReady(), false);
  assert.equal(cache.pipelineNeedsApply(pipeline), true);
  assert.equal(cache.bindGroupNeedsApply(2, bindGroup), true);
  assert.equal(cache.vertexBufferNeedsApply(0, vertexBuffer, 0), true);
  assert.equal(cache.indexBufferNeedsApply(indexBuffer, "uint16", 0), true);
  assert.deepEqual(cache.snapshot().counters.lifecycle.resetReasons,
    { "begin-pass": 1 });
});

test("missing resources and failed applies never populate the cache", () => {
  const cache = createWgpuPassStateCache();
  const bindGroup = {};
  const vertexBuffer = {};
  const indexBuffer = {};
  const pipeline = {};

  assert.equal(cache.bindGroupNeedsApply(2, bindGroup), true);
  cache.recordBindGroupApplyFailed(2);
  assert.equal(cache.bindGroupNeedsApply(2, bindGroup), true);

  assert.equal(cache.recordBindGroupApplied(2, null), false);
  assert.equal(cache.bindGroupNeedsApply(2, null), true);

  assert.equal(cache.recordPipelineApplied(undefined), false);
  assert.equal(cache.isPipelineReady(), false);

  assert.equal(cache.pipelineNeedsApply(pipeline), true);
  cache.recordPipelineApplyFailed();
  assert.equal(cache.pipelineNeedsApply(pipeline), true);

  assert.equal(cache.vertexBufferNeedsApply(0, vertexBuffer, 0), true);
  cache.recordVertexBufferApplyFailed(0);
  assert.equal(cache.vertexBufferNeedsApply(0, vertexBuffer, 0), true);

  assert.equal(cache.indexBufferNeedsApply(indexBuffer, "uint16", 0), true);
  cache.recordIndexBufferApplyFailed();
  assert.equal(cache.indexBufferNeedsApply(indexBuffer, "uint16", 0), true);

  const counters = cache.snapshot().counters;
  assert.equal(counters.bindGroups.slots[2].failures, 2);
  assert.equal(counters.pipeline.failures, 2);
  assert.equal(counters.vertexBuffers.slots[0].failures, 1);
  assert.equal(counters.indexBuffer.failures, 1);
});

test("DESTROY invalidates only state that references the destroyed resource", () => {
  const cache = createWgpuPassStateCache();
  const bindGroup0 = {};
  const bindGroup1 = {};
  const buffer0 = {};
  const buffer1 = {};
  const pipeline = {};

  cache.recordBindGroupApplied(0, bindGroup0);
  cache.recordBindGroupApplied(1, bindGroup1);
  cache.recordVertexBufferApplied(0, buffer0, 0);
  cache.recordVertexBufferApplied(1, buffer1, 0);
  cache.recordIndexBufferApplied(buffer0, "uint16", 0);
  cache.recordPipelineApplied(pipeline);

  assert.equal(cache.invalidateDestroyedResource("bind-group", bindGroup0), 1);
  assert.equal(cache.bindGroupNeedsApply(0, bindGroup0), true);
  assert.equal(cache.bindGroupNeedsApply(1, bindGroup1), false);

  assert.equal(cache.invalidateDestroyedResource(1, buffer0), 2);
  assert.equal(cache.vertexBufferNeedsApply(0, buffer0, 0), true);
  assert.equal(cache.vertexBufferNeedsApply(1, buffer1, 0), false);
  assert.equal(cache.indexBufferNeedsApply(buffer0, "uint16", 0), true);

  assert.equal(cache.invalidateDestroyedResource("pipeline", pipeline), 1);
  assert.equal(cache.isPipelineReady(), false);

  const lifecycle = cache.snapshot().counters.lifecycle;
  assert.equal(lifecycle.destroyCount, 3);
  assert.equal(lifecycle.destroyEntries, 4);
  assert.deepEqual(lifecycle.destroyKinds,
    { "bind-group": 1, buffer: 1, pipeline: 1 });
});

test("worker integrates the cache without crossing pass, load, or destroy boundaries", async () => {
  const worker = await readFile(
    new URL("../src/upstream-discio-worker.js", import.meta.url),
    "utf8"
  );
  assert.match(worker,
    /if \(wgpuConsumerStateCacheEnabled\) wgpuPassStateCache\.reset\("load-fence-discard"\)/);
  assert.match(worker,
    /if \(wgpuConsumerStateCacheEnabled\) wgpuPassStateCache\.reset\(reason\)/);
  assert.match(worker,
    /if \(!passWasOpen && wgpuConsumerStateCacheEnabled\)[\s\S]*?wgpuPassStateCache\.reset\("begin-pass"\)/);
  assert.match(worker, /wgpuPassStateCache\.bindGroupNeedsApply/);
  assert.match(worker, /wgpuPassStateCache\.vertexBufferNeedsApply/);
  assert.match(worker, /wgpuPassStateCache\.indexBufferNeedsApply/);
  assert.match(worker,
    /if \(resource && wgpuConsumerStateCacheEnabled\)[\s\S]*?wgpuPassStateCache\.invalidateDestroyedResource\(tag, resource\)/);
  assert.match(worker,
    /stateCache: wgpuConsumerStateCacheEnabled \? wgpuPassStateCache\.snapshot\(\) : null/);
  assert.match(worker, /const needsApply = !wgpuConsumerStateCacheEnabled \|\|/);
  assert.match(worker,
    /wgpuConsumerStateCacheEnabled =\s*wgpuStateCacheEnabled && !wgpuProducerStateCacheAvailable/);
  assert.match(worker,
    /producerStateCacheEnabled:\s*wgpuStateCacheEnabled && wgpuProducerStateCacheAvailable/);
  assert.match(worker,
    /case WGPU_CMD_OP_SET_PIPELINE:[\s\S]*?passHasPipe = false;[\s\S]*?passHasPipe = true;/);
  assert.match(worker,
    /case WGPU_CMD_OP_SET_VERTEX_BUFFER:[\s\S]*?vertexBufferValid = false;[\s\S]*?vertexBufferValid = true;/);
  assert.match(worker,
    /case WGPU_CMD_OP_SET_INDEX_BUFFER:[\s\S]*?indexBufferValid = false;[\s\S]*?indexBufferValid = true;/);
  assert.match(worker,
    /WGPU_CMD_OP_DRAW_INDEXED[\s\S]*?passNeedsVertexBuffer[\s\S]*?indexBufferValid/);
  assert.match(worker, /if \(needsApply\)/);
});

test("producer suppresses exact state only after successful records and skips draws after state failure", async () => {
  const [streamHeader, gfxHeader, gfxSource, coreCmake] = await Promise.all([
    readFile(new URL(
      "../vendor/dolphin/Source/Core/VideoBackends/WebGPU/WebGPUCommandStream.h",
      import.meta.url
    ), "utf8"),
    readFile(new URL(
      "../vendor/dolphin/Source/Core/VideoBackends/WebGPU/WebGPUGfx.h",
      import.meta.url
    ), "utf8"),
    readFile(new URL(
      "../vendor/dolphin/Source/Core/VideoBackends/WebGPU/WebGPUGfx.cpp",
      import.meta.url
    ), "utf8"),
    readFile(new URL(
      "../vendor/dolphin/Source/Core/Core/CMakeLists.txt",
      import.meta.url
    ), "utf8")
  ]);
  assert.match(streamHeader, /bool PushSetPipeline\(/);
  assert.match(streamHeader, /bool PushSetBindGroup\(/);
  assert.match(streamHeader, /GetWebGpuCommandDroppedRecordCount/);
  assert.match(gfxSource, /wgdrop:[\s\S]*?GetWebGpuCommandDroppedRecordCount/);
  assert.match(gfxHeader, /bool PrepareDrawResources\(\)/);
  assert.match(gfxSource, /if \(!m_cmd_stream\.PushSetBindGroup[\s\S]*?return false;/);
  assert.match(gfxSource, /if \(!PrepareDrawResources\(\)\)[\s\S]*?return;/);
  assert.match(gfxSource, /!SetRecordedVertexBuffer[\s\S]*?!SetRecordedIndexBuffer/);
  assert.match(gfxSource,
    /s_state_cache_enabled\.store\(enabled != 0, std::memory_order_relaxed\)/);
  assert.doesNotMatch(gfxSource,
    /s_state_cache_enabled\.(?:load|store)\([^\n]*memory_order_(?:acquire|release)/);
  assert.match(gfxSource,
    /SetRecordedBindGroup[\s\S]*?if \(!s_state_cache_enabled\.load\(std::memory_order_relaxed\)\)[\s\S]*?return m_cmd_stream\.PushSetBindGroup/);
  assert.match(gfxSource,
    /SetRecordedVertexBuffer[\s\S]*?if \(!s_state_cache_enabled\.load\(std::memory_order_relaxed\)\)[\s\S]*?return m_cmd_stream\.PushSetVertexBuffer/);
  assert.match(gfxSource,
    /SetRecordedIndexBuffer[\s\S]*?if \(!s_state_cache_enabled\.load\(std::memory_order_relaxed\)\)[\s\S]*?return m_cmd_stream\.PushSetIndexBuffer/);
  assert.match(coreCmake, /'_SetWebGpuStateCacheEnabled'/);
  assert.match(coreCmake, /'_GetWebGpuStateCacheStats'/);
});

test("opt-in UBO cache is exact, two-entry MRU, serial-bounded, and load-invalidated", async () => {
  const [gfxHeader, gfxSource, coreCmake, worker] = await Promise.all([
    readFile(new URL(
      "../vendor/dolphin/Source/Core/VideoBackends/WebGPU/WebGPUGfx.h",
      import.meta.url
    ), "utf8"),
    readFile(new URL(
      "../vendor/dolphin/Source/Core/VideoBackends/WebGPU/WebGPUGfx.cpp",
      import.meta.url
    ), "utf8"),
    readFile(new URL(
      "../vendor/dolphin/Source/Core/Core/CMakeLists.txt",
      import.meta.url
    ), "utf8"),
    readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8")
  ]);

  assert.match(gfxSource, /std::atomic<bool> s_ubo_cache_enabled\{false\}/);
  assert.match(gfxSource, /std::atomic<bool> s_ubo_cache_metrics_enabled\{false\}/);
  assert.match(gfxSource,
    /EMSCRIPTEN_KEEPALIVE void SetWebGpuUboCacheEnabled\(int mode\)/);
  assert.match(gfxSource, /s_ubo_cache_enabled\.store\(\(mode & 1\) != 0/);
  assert.match(gfxSource, /s_ubo_cache_metrics_enabled\.store\(\(mode & 2\) != 0/);
  assert.match(coreCmake, /'_SetWebGpuUboCacheEnabled'/);
  assert.match(gfxHeader,
    /std::array<std::array<UboSliceCacheEntry, 2>,[\s\S]*?m_ubo_slice_cache/);
  assert.match(gfxSource,
    /entry\.size != size \|\| std::memcmp\(entry\.bytes\.data\(\), data, size\) != 0/);
  assert.match(gfxHeader, /kUboReuseSafetySlots = 4/);
  assert.match(gfxSource,
    /age < static_cast<u64>\(kUboRingSliceCount - kUboReuseSafetySlots\)/);
  assert.match(gfxSource, /AcquireUboSlice\(UboClass::Vertex/);
  assert.match(gfxSource, /AcquireUboSlice\(UboClass::Pixel/);
  assert.match(gfxSource, /AcquireUboSlice\(UboClass::Geometry/);

  const push = gfxSource.indexOf("if (!m_cmd_stream.PushUploadBuffer");
  const publication = gfxSource.indexOf("m_last_ubo_slice_serial = ++m_ubo_publication_serial", push);
  assert.ok(push >= 0 && publication > push,
    "publication serial must advance only after the upload record succeeds");

  const acquireStart = gfxSource.indexOf("u32 WebGPUGfx::AcquireUboSlice");
  const acquireEnd = gfxSource.indexOf("u32 WebGPUGfx::AllocUboSlice", acquireStart);
  const acquireSource = gfxSource.slice(acquireStart, acquireEnd);
  assert.doesNotMatch(acquireSource, /RefreshUboCacheState/,
    "the synchronized caller must not pay redundant epoch refreshes per cache lookup");
  assert.match(acquireSource,
    /const bool record_metrics = s_ubo_cache_metrics_enabled\.load[\s\S]*?if \(record_metrics\)[\s\S]*?s_ubo_cache_lookups/);
  assert.match(acquireSource,
    /if \(record_metrics\)\s*\{[\s\S]*?s_ubo_cache_hits[\s\S]*?s_ubo_upload_calls_suppressed[\s\S]*?s_ubo_upload_bytes_suppressed/);
  const expireStart = gfxSource.indexOf("void WebGPUGfx::ExpireUboClass");
  const expireEnd = gfxSource.indexOf("void WebGPUGfx::InvalidateUboSlices", expireStart);
  assert.match(gfxSource.slice(expireStart, expireEnd),
    /if \(s_ubo_cache_metrics_enabled\.load[\s\S]*?s_ubo_cache_expired/);

  const passResetStart = gfxSource.indexOf("void WebGPUGfx::ResetRecordedPassState()");
  const passResetEnd = gfxSource.indexOf("bool WebGPUGfx::SetRecordedPipeline", passResetStart);
  assert.doesNotMatch(gfxSource.slice(passResetStart, passResetEnd), /ResetUboSliceCache/,
    "successful pass boundaries must retain serial-live cross-pass entries");
  assert.match(gfxSource,
    /void WebGPUGfx::AbortRecordedPass\(\)[\s\S]*?InvalidateUboSlices\(\)/);
  assert.match(gfxSource,
    /s_ubo_cache_epoch\.fetch_add\(1, std::memory_order_release\)/);
  const utilityStart = gfxSource.indexOf("void WebGPUGfx::UploadUtilityUniforms");
  const utilityEnd = gfxSource.indexOf("void WebGPUGfx::Draw(", utilityStart);
  const utilitySource = gfxSource.slice(utilityStart, utilityEnd);
  const utilityRefresh = utilitySource.indexOf("RefreshUboCacheState();");
  const utilityAlloc = utilitySource.indexOf(
    "AllocUboSlice(data, size, BufferUploadRole::Utility)"
  );
  const utilityArm = utilitySource.indexOf("m_util_uniform_mode = true");
  assert.ok(
    utilityStart >= 0 && utilityEnd > utilityStart &&
    utilityRefresh >= 0 && utilityRefresh < utilityAlloc && utilityAlloc < utilityArm,
    "utility uploads must consume an epoch change before publishing and arming their slice"
  );
  assert.match(worker,
    /case "loadState":[\s\S]*?setWebGpuUboCacheEnabled[\s\S]*?api\?\.loadState[\s\S]*?setWebGpuUboCacheEnabled/);
  assert.match(worker,
    /api\.loadStateFile\(path\)[\s\S]*?setTimeout\(r, 1200\)[\s\S]*?setWebGpuUboCacheEnabled/);
  assert.match(worker,
    /function webGpuUboCacheMode\(\)[\s\S]*?wgpuUboCacheEnabled \? 1 : 0[\s\S]*?collectMetrics \? 2 : 0/);
  assert.match(worker, /setWebGpuUboCacheEnabled\?\.\(webGpuUboCacheMode\(\)\)/);
  assert.match(worker,
    /\? \(mode\) => ccall\("SetWebGpuUboCacheEnabled", null, \["number"\], \[mode \| 0\]\)/);
  assert.match(gfxSource, /ulook:[\s\S]*?uhit:[\s\S]*?uexp:[\s\S]*?usupcall:[\s\S]*?usupbyte:/);
});

test("opt-in geometry packing uses one transactional upload and a published-submit reuse barrier", async () => {
  const [streamHeader, streamSource, vertexHeader, vertexSource, gfxSource, coreCmake, worker] =
    await Promise.all([
      readFile(new URL("../vendor/dolphin/Source/Core/VideoBackends/WebGPU/WebGPUCommandStream.h", import.meta.url), "utf8"),
      readFile(new URL("../vendor/dolphin/Source/Core/VideoBackends/WebGPU/WebGPUCommandStream.cpp", import.meta.url), "utf8"),
      readFile(new URL("../vendor/dolphin/Source/Core/VideoBackends/WebGPU/WebGPUVertexManager.h", import.meta.url), "utf8"),
      readFile(new URL("../vendor/dolphin/Source/Core/VideoBackends/WebGPU/WebGPUVertexManager.cpp", import.meta.url), "utf8"),
      readFile(new URL("../vendor/dolphin/Source/Core/VideoBackends/WebGPU/WebGPUGfx.cpp", import.meta.url), "utf8"),
      readFile(new URL("../vendor/dolphin/Source/Core/Core/CMakeLists.txt", import.meta.url), "utf8"),
      readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8"),
    ]);

  assert.match(streamHeader, /Geometry = 6,[\s\S]*?Count = 7/);
  assert.match(streamHeader, /UploadAllocTwoSegments/);
  assert.match(streamSource, /ReserveUpload\(total_size, packet_align\)/);
  assert.match(streamSource, /std::memcpy\(destination, first, first_len\)/);
  assert.match(streamSource, /std::memset\(destination \+ first_len, 0/);
  assert.doesNotMatch(streamSource, /std::vector[^\n]*UploadPacket/);
  assert.match(streamSource, /if \(!Push\(rec\)\)[\s\S]*?\+\+m_submit_serial/);
  assert.match(vertexHeader, /kGeometryBufferSize = 32u \* 1024u \* 1024u/);
  assert.match(vertexHeader, /kMaxGeometryGenerationsPerSubmit = 8/);
  assert.match(vertexSource, /kUsageGeometry = 0x20 \| 0x10 \| 0x8/);
  assert.match(vertexSource, /if \(submit_serial != m_geometry_submit_serial\)/);
  assert.match(vertexSource, /PushUploadBuffer\(candidate_buffer_id,[\s\S]*?BufferUploadRole::Geometry\)/);
  assert.match(vertexSource, /m_geometry_offset = packet_offset \+ packet\.total_size/);
  assert.match(vertexSource, /EnsureLegacyBuffers\(\)/);
  assert.match(gfxSource, /EMSCRIPTEN_KEEPALIVE void SetWebGpuGeometryPackEnabled\(int enabled\)/);
  assert.match(gfxSource, /s_geometry_upload_pack_epoch\.fetch_add\(1, std::memory_order_release\)/);
  assert.match(coreCmake, /'_SetWebGpuGeometryPackEnabled'/);
  assert.match(worker, /case "loadState":[\s\S]*?setWebGpuGeometryPackEnabled[\s\S]*?api\?\.loadState[\s\S]*?setWebGpuGeometryPackEnabled/);
  assert.match(worker, /api\.loadStateFile\(path\)[\s\S]*?setTimeout\(r, 1200\)[\s\S]*?setWebGpuGeometryPackEnabled/);
});
