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
  assert.match(harness, /GetWebGpuCommandStreamGeometrySmokeError\(\)/);
});
