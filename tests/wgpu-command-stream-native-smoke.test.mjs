// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const patchUrl = new URL(
  "../patches/dolphin-wasm/snapshot/0028-webgpu-command-stream-geometry-smokes.patch",
  import.meta.url
);

test("native WebGPU command-stream geometry smokes execute real upload and draw methods", async () => {
  const patch = await readFile(patchUrl, "utf8");

  assert.match(patch, /RunWebGpuCommandStreamGeometryParitySmoke\(int indexed\)/);
  assert.match(patch, /UploadAlloc\(vertices, sizeof\(vertices\), 4\)/);
  assert.match(patch, /UploadAllocTwoSegments\(/);
  assert.match(patch, /PushUploadBuffer\(/);
  assert.match(patch, /PushDrawIndexed\(6, 1, 2, 3\)/);
  assert.match(patch, /PushDraw\(6, 1, 2\)/);
  assert.match(patch, /PushEndPass\(\)/);
  assert.match(patch, /std::memcmp/);
});

test("native rollback smoke rejects publication without advancing either ring", async () => {
  const patch = await readFile(patchUrl, "utf8");

  assert.match(patch, /RunWebGpuCommandStreamGeometryRollbackSmoke\(\)/);
  assert.match(patch, /FailConsumer\(fixture\.stream/);
  assert.match(patch, /UploadWrite\(fixture\.stream\) != 0/);
  assert.match(patch, /header\.write\.load\(std::memory_order_acquire\) != 0/);
  assert.match(patch, /failed allocation did not reject the owning pass/);
});

test("native smoke exports are either pending rebuild or present in the core", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../provenance/dolphin-core-abi-v1.json", import.meta.url), "utf8")
  );
  const expected = [
    "_RunWebGpuCommandStreamGeometryParitySmoke",
    "_RunWebGpuCommandStreamGeometryRollbackSmoke",
    "_GetWebGpuCommandStreamGeometrySmokeError",
    "_RunWebGpuVertexManagerGeometryParitySmoke",
    "_RunWebGpuVertexManagerGeometryRollbackSmoke",
    "_RunWebGpuVertexManagerGeometryLifecycleSmoke",
    "_RunWebGpuVertexManagerGeometryRangeSmoke",
    "_GetWebGpuVertexManagerGeometrySmokeError",
  ];
  for (const name of expected) {
    assert.ok(
      manifest.moduleExports.includes(name) ||
        manifest.sourceOnlyExportsPendingRebuild.includes(name),
      `${name} must be exported or explicitly pending a rebuild`
    );
  }

  const updater = await readFile(new URL("../tools/update-core-abi.mjs", import.meta.url), "utf8");
  assert.match(updater, /previous\.sourceOnlyExportsPendingRebuild/);
  assert.match(updater, /filter\(\(name\) => !moduleExports\.includes\(name\)\)/);
});

test("standalone native harness invokes both parity modes and rollback", async () => {
  const harness = await readFile(
    new URL("./native/wgpu-command-stream-smoke-main.cpp", import.meta.url),
    "utf8"
  );
  assert.match(harness, /RunWebGpuCommandStreamGeometryParitySmoke\(0\)/);
  assert.match(harness, /RunWebGpuCommandStreamGeometryParitySmoke\(1\)/);
  assert.match(harness, /RunWebGpuCommandStreamGeometryRollbackSmoke\(\)/);
  assert.match(harness, /GetWebGpuCommandStreamGeometrySmokeError/);
  assert.match(harness, /RunWebGpuVertexManagerGeometryParitySmoke\(indexed_mode, packed\)/);
  assert.match(harness, /RunWebGpuVertexManagerGeometryRollbackSmoke\(packed\)/);
  assert.match(harness, /RunWebGpuVertexManagerGeometryLifecycleSmoke\(\)/);
  assert.match(harness, /RunWebGpuVertexManagerGeometryRangeSmoke\(\)/);
});

test("native geometry range smoke locks ordering, padding, and rollback", async () => {
  const patch = await readFile(
    new URL(
      "../patches/dolphin-wasm/snapshot/0031-webgpu-geometry-range.patch",
      import.meta.url
    ),
    "utf8"
  );

  assert.match(patch, /RunWebGpuVertexManagerGeometryRangeSmoke\(\)/);
  assert.match(patch, /FlushPendingGeometryRange\(\)/);
  assert.match(patch, /PushUploadBuffer[\s\S]*?PushEndPass/);
  assert.match(patch, /kGeometryRangeMaxGap = 64/);
  assert.match(patch, /kGeometryRangeMaxBytes = 256u \* 1024u/);
  assert.match(patch, /kGeometryRangeHardBytes = 16u \* 1024u \* 1024u/);
  assert.match(patch, /std::any_of\(range \+ 200, range \+ 256/);
  assert.match(patch, /constexpr u16 indices\[\] = \{0, 1, 2\}/);
  assert.match(patch, /memcmp\(range \+ 256 \+ stride \* 3, indices/);
  assert.match(patch, /failed range flush did not rollback and poison pass/);
  assert.match(patch, /skipped draw published draw A without its upload/);
  assert.match(patch, /missing first draw published or poisoned a pass/);
  assert.match(patch, /stream\.AbortPass\(\);[\s\S]*?DiscardPendingGeometryRange\(\)/);
});

test("native VertexManager smoke crosses the real CommitBuffer boundary", async () => {
  const patch = await readFile(
    new URL(
      "../patches/dolphin-wasm/snapshot/0030-webgpu-vertex-manager-geometry-smokes.patch",
      import.meta.url
    ),
    "utf8"
  );

  assert.match(patch, /manager\.CommitBuffer\(/);
  assert.match(patch, /RunWebGpuVertexManagerGeometryParitySmoke\(int indexed,[\s\S]*?int packed\)/);
  assert.match(patch, /RunWebGpuVertexManagerGeometryRollbackSmoke\(int packed\)/);
  assert.match(patch, /RunWebGpuVertexManagerGeometryLifecycleSmoke\(\)/);
  assert.match(patch, /SeedPackedWrap/);
  assert.match(patch, /SeedLegacyWrap/);
  assert.match(patch, /FailConsumer\(GetCommandStream\(\)/);
  assert.match(patch, /InvalidateGeometryUploadPack\(\)/);
  assert.match(patch, /PushDrawIndexed/);
  assert.match(patch, /PushDraw\(3, 1, base_vertex\)/);
  assert.match(patch, /refused to replace a live WebGPU command ring/);
});
