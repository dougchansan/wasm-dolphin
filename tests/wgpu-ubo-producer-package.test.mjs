// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("native producer package transport is negotiated and default-off", async () => {
  const [patch, worker, protocol] = await Promise.all([
    source("patches/dolphin-wasm/snapshot/0052-webgpu-producer-ubo-packages.patch"),
    source("src/upstream-discio-worker.js"),
    source("src/wgpu-ring-backpressure.js"),
  ]);
  assert.match(patch, /kProtocolUboComputePackage = 1u << 2/);
  assert.match(patch, /UboComputePackageProtocolActive/);
  assert.match(patch, /BufferUploadRole::UboComputePackage/);
  assert.match(patch, /!UboComputePackageProtocolActive\(\)[\s\S]*?PoisonPass/);
  assert.match(protocol, /WGPU_PROTOCOL_UBO_COMPUTE_PACKAGE_FLAG = 1 << 2/);
  const registration = worker.indexOf("computeManager.registerResource");
  const negotiation = worker.indexOf("enableWgpuUboComputePackageProtocol(ring)");
  assert.ok(registration >= 0 && negotiation > registration);
  assert.doesNotMatch(worker, /enableWgpuUboComputePackageProtocol\(webGpuCmdRing\)/);
  assert.match(worker, /wgpuUboComputeReconstructionRequested/);
});

test("native and browser codecs lock the same v1 wire constants", async () => {
  const [patch, codec] = await Promise.all([
    source("patches/dolphin-wasm/snapshot/0052-webgpu-producer-ubo-packages.patch"),
    source("src/wgpu-ubo-compute-codec.js"),
  ]);
  for (const contract of [
    /kUboComputeCodecMagic = 0x55424350/,
    /kUboComputeCodecVersion = 1/,
    /kUboComputePackageAlignment = 256/,
    /kUboComputeDiffGranularity = 16/,
    /kUboComputeHeaderBytes = 32/,
    /kUboComputeRecordBytes = 32/,
    /kUboComputeRangeBytes = 8/,
    /kUboComputeMaxRecords = 256/,
  ]) {
    assert.match(patch, contract);
  }
  assert.match(codec, /WGPU_UBO_COMPUTE_CODEC_MAGIC = 0x55424350/);
  assert.match(codec, /WGPU_UBO_COMPUTE_CODEC_VERSION = 1/);
  assert.match(codec, /WGPU_UBO_COMPUTE_PACKAGE_ALIGNMENT = 256/);
  assert.match(codec, /const HEADER_BYTES = 32/);
  assert.match(codec, /const RECORD_BYTES = 32/);
  assert.match(codec, /const RANGE_BYTES = 8/);
});

test("pass-level package publication preserves cache and rollback boundaries", async () => {
  const patch = await source(
    "patches/dolphin-wasm/snapshot/0052-webgpu-producer-ubo-packages.patch"
  );
  assert.match(patch, /m_ubo_compute_package\.full\(\)[\s\S]*?FlushUboComputePackage/);
  assert.match(patch, /FlushUboComputePackage\(\)[\s\S]*?PushEndPass/);
  assert.match(patch, /AcquireUboSlice[\s\S]*?AllocUboClassSlice/);
  assert.match(patch, /ResetUboComputePackageState[\s\S]*?m_ubo_compute_shadow_valid\.fill\(false\)/);
  assert.match(patch, /compute package header or record kinds differ/);
  assert.match(patch, /UboComputeKind::Full/);
  assert.match(patch, /UboComputeKind::Delta/);
  assert.match(patch, /UboComputeKind::Equal/);
});

test("default-off producer packages avoid a per-draw protocol poll", async () => {
  const patch = await source(
    "patches/dolphin-wasm/snapshot/0052-webgpu-producer-ubo-packages.patch"
  );
  const beginPass = patch.indexOf("bool WebGPUGfx::BeginPassIfNeeded()");
  const prepareDraw = patch.indexOf("bool WebGPUGfx::PrepareDrawResources()");
  const protocolPoll = patch.indexOf(
    "m_cmd_stream.UboComputePackageProtocolActive()",
    beginPass
  );
  assert.ok(beginPass >= 0 && prepareDraw > beginPass);
  assert.ok(protocolPoll > beginPass && protocolPoll < prepareDraw);
});
