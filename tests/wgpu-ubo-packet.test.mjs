// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildDenseUboSourcePacket,
  planDenseUboPacket,
  replayDenseUboUpload,
} from "../src/wgpu-ubo-packet.js";
import { requestedWgpuUboPack } from "../src/wgpu-replay-diagnostics.js";

const payloads = [
  Uint8Array.from({ length: 37 }, (_, index) => 0x10 + index),
  Uint8Array.from({ length: 73 }, (_, index) => 0x40 + index),
  Uint8Array.from({ length: 19 }, (_, index) => 0x90 + index),
];

test("dense UBO planner preserves all eight masks, alignment, bytes, and zero gaps", () => {
  for (let mask = 0; mask < 8; mask += 1) {
    const plan = planDenseUboPacket({ cursor: 256, ringSize: 4096, payloads, changeMask: mask });
    const source = buildDenseUboSourcePacket(plan, payloads);
    const destination = new Uint8Array(4096).fill(0xcd);
    replayDenseUboUpload(destination, plan, source);
    assert.equal(plan.end % 256, 0, `mask ${mask} must publish an aligned ownership end`);

    for (let index = 0; index < 3; index += 1) {
      const changed = (mask & (1 << index)) !== 0;
      assert.equal(plan.relativeOffsets[index] != null, changed);
      if (!changed) continue;
      assert.equal(plan.destinationOffsets[index] % 256, 0);
      assert.deepEqual(
        destination.slice(plan.destinationOffsets[index], plan.destinationOffsets[index] + payloads[index].length),
        payloads[index]
      );
    }
    for (let offset = 0; offset < source.length; offset += 1) {
      const owned = plan.relativeOffsets.some((start, index) =>
        start != null && offset >= start && offset < start + payloads[index].length
      );
      if (!owned) assert.equal(source[offset], 0, `mask ${mask} gap ${offset} must be zero`);
    }
  }
});

test("dense UBO planner wraps one owned interval without publishing caller state", () => {
  const state = { cursor: 4032, offsets: [11, 22, 33], serial: 8 };
  const before = structuredClone(state);
  const plan = planDenseUboPacket({
    cursor: state.cursor,
    ringSize: 4096,
    payloads,
    changeMask: 7,
  });
  assert.equal(plan.start, 0);
  assert.deepEqual(state, before, "planning must be side-effect free so allocation/publication can roll back");
});

test("dense UBO physical order minimizes padding while offsets stay VS/PS/GS indexed", () => {
  const actual = [new Uint8Array(4112), new Uint8Array(1536), new Uint8Array(64)];
  const plan = planDenseUboPacket({ cursor: 0, ringSize: 32768, payloads: actual, changeMask: 7 });
  assert.deepEqual(plan.relativeOffsets, [1792, 0, 1536]);
  assert.equal(plan.packetSize, 6144);

  const vsPs = planDenseUboPacket({ cursor: 0, ringSize: 32768, payloads: actual, changeMask: 3 });
  assert.deepEqual(vsPs.relativeOffsets, [1536, 0, null]);
  assert.equal(vsPs.packetSize, 5888, "PS followed by VS has no inter-class gap and an aligned tail");
});

test("wgpuubopack is default-off and explicitly selectable", () => {
  assert.equal(requestedWgpuUboPack(""), false);
  assert.equal(requestedWgpuUboPack("", true), true);
  assert.equal(requestedWgpuUboPack("?wgpuubopack=1"), true);
  assert.equal(requestedWgpuUboPack("?wgpuubopack=0", true), false);
});

test("patch 0029 integrates one transactional UBO upload with cache fallback", async () => {
  const [patch, coreCmake, worker, gfx, abi] = await Promise.all([
    readFile(new URL("../patches/dolphin-wasm/snapshot/0029-webgpu-dense-ubo-packets.patch", import.meta.url), "utf8"),
    readFile(new URL("../vendor/dolphin/Source/Core/Core/CMakeLists.txt", import.meta.url), "utf8"),
    readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8"),
    readFile(new URL("../vendor/dolphin/Source/Core/VideoBackends/WebGPU/WebGPUGfx.cpp", import.meta.url), "utf8"),
    readFile(new URL("../provenance/dolphin-core-abi-v1.json", import.meta.url), "utf8"),
  ]);
  assert.match(patch, /PlanDenseUboPacket/);
  assert.match(patch, /UploadAllocUboPacket/);
  assert.match(patch, /PushUploadBuffer\(m_ubo_ring,[\s\S]*?BufferUploadRole::Ubo/);
  assert.match(patch, /for \(u32 mask = 0; mask < 8; \+\+mask\)/);
  assert.match(patch, /RunWebGpuDenseUboPacketSmoke/);
  assert.match(patch, /RunWebGpuDenseUboRollbackSmoke/);
  assert.match(patch, /ShouldUseDenseUboPackets/);
  assert.match(coreCmake, /'_SetWebGpuUboPackEnabled'/);
  assert.match(worker, /wgpuUboPackEnabled && !wgpuUboCacheEnabled/);
  assert.match(worker, /setWebGpuUboPackEnabled/);

  const denseStart = gfx.indexOf("if (dense_ubo_enabled)");
  const denseEnd = gfx.indexOf("auto& vsm = system.GetVertexShaderManager()", denseStart);
  const dense = gfx.slice(denseStart, denseEnd);
  const upload = dense.indexOf("m_cmd_stream.PushUploadBuffer");
  const commit = dense.indexOf("Transaction commit begins here");
  assert.ok(denseStart >= 0 && denseEnd > denseStart && upload >= 0 && commit > upload);
  const beforeCommit = dense.slice(0, commit);
  assert.doesNotMatch(beforeCommit, /m_ubo_ring_off\s*=/);
  assert.doesNotMatch(beforeCommit, /m_(?:vs|ps|gs)_off\s*=(?!=)/);
  assert.doesNotMatch(beforeCommit, /m_(?:vs|ps|gs)_publication_serial\s*=(?!=)/);
  assert.doesNotMatch(beforeCommit, /\.dirty\s*=\s*false/);
  assert.doesNotMatch(beforeCommit, /m_(?:vs|ps|gs)_shadow_valid\s*=\s*true/);
  assert.doesNotMatch(beforeCommit, /\+\+m_ubo_publication_serial/);
  const afterCommit = dense.slice(commit);
  assert.match(afterCommit, /m_ubo_ring_off = plan\.destination_end/);
  assert.match(afterCommit, /const u64 publication_serial = \+\+m_ubo_publication_serial/);
  assert.match(afterCommit, /m_vs_off = plan\.destination_offsets\[0\]/);
  assert.match(afterCommit, /m_ps_off = plan\.destination_offsets\[1\]/);
  assert.match(afterCommit, /m_gs_off = plan\.destination_offsets\[2\]/);
  assert.ok(commit < denseEnd, "dense publication must commit before legacy class tests");
  const legacy = gfx.slice(denseEnd, gfx.indexOf("RecordUboPacketOpportunity", denseEnd));
  assert.match(legacy, /if \(vsm\.dirty \|\| m_vs_off == kUboOffNone \|\| vs_changed\)/);
  assert.match(legacy, /if \(psm\.dirty \|\| m_ps_off == kUboOffNone \|\| ps_changed\)/);
  assert.match(legacy, /if \(gsm\.dirty \|\| m_gs_off == kUboOffNone \|\| gs_changed\)/);
  assert.equal((dense.match(/PushUploadBuffer/g) ?? []).length, 1);
  assert.match(afterCommit, /dense_vsm\.dirty = false[\s\S]*?m_vs_shadow_valid = true/);
  assert.match(afterCommit, /dense_psm\.dirty = false[\s\S]*?m_ps_shadow_valid = true/);
  assert.match(afterCommit, /dense_gsm\.dirty = false[\s\S]*?m_gs_shadow_valid = true/);
  assert.match(gfx, /ShouldUseDenseUboPackets\([\s\S]*?ubo_cache_enabled\)/);
  assert.match(gfx, /const u32 dyn\[4\] = \{b0, off\(m_vs_off\), b0, off\(m_gs_off\)\}/);

  const manifest = JSON.parse(abi);
  for (const name of [
    "_SetWebGpuUboPackEnabled",
    "_RunWebGpuDenseUboPacketSmoke",
    "_RunWebGpuDenseUboRollbackSmoke",
    "_GetWebGpuDenseUboSmokeError",
  ]) {
    assert.ok(
      manifest.moduleExports.includes(name) || manifest.sourceOnlyExportsPendingRebuild.includes(name),
      `${name} must be exported or marked pending rebuild`
    );
  }
});
