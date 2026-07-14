// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("behavior flag is strict, default-off, mapped-only, and independent of projection", async () => {
  const [host, adapter, worker, menu, gate] = await Promise.all([
    source("src/core-host.js"),
    source("src/upstream-worker-adapter.js"),
    source("src/upstream-discio-worker.js"),
    source("tools/menu-progress-validate.mjs"),
    source("tools/perf-regression-gate.mjs"),
  ]);
  assert.match(host, /requestedWgpuUboComputeReconstruction/);
  assert.match(adapter, /wgpuUboComputeReconstruction = false/);
  assert.match(worker, /wgpuubocompute=1 requires metrics=1/);
  assert.match(worker, /wgpuubocompute=1 requires video=wgpu/);
  assert.match(worker, /wgpuubocompute=1 requires wgpuuploadtransport=mapped/);
  assert.match(menu, /WGPUUBOCOMPUTE/);
  assert.match(gate, /wgpuubocompute/);
  assert.match(worker, /wgpuUboComputeProjectionRequested = Boolean/);
  assert.match(worker, /wgpuUboComputeReconstructionRequested = Boolean/);
});

test("worker admits only producer-tagged UBO rings and orders compute before render", async () => {
  const worker = await source("src/upstream-discio-worker.js");
  assert.match(worker, /resourceRole === WGPU_BUFFER_RESOURCE_ROLE_UBO_RING/);
  assert.match(worker, /usage \|= 0x0080; \/\/ GPUBufferUsage\.STORAGE/);
  assert.match(worker, /role: WGPU_UBO_RING_ROLE/);
  assert.match(worker, /role !== WGPU_UPLOAD_ROLE\.UBO/);
  assert.match(worker, /const result = manager\.stage/);
  assert.match(
    worker,
    /\.\.\.\(mappedBatch\?\.ordinary[\s\S]*\.\.\.\(mappedBatch\?\.compute[\s\S]*renderCommandBuffer/
  );
  assert.match(worker, /markWgpuReplayFatal\("staging-seal"/);
  assert.match(worker, /markWgpuReplayFatal\("submit-error"/);
});

test("all replay-invalidating lifecycle paths invalidate or reset compute shadows", async () => {
  const worker = await source("src/upstream-discio-worker.js");
  for (const reason of [
    "core-reset",
    "slot-state-load",
    "save-state-load",
    "load-fence-discard",
  ]) {
    assert.match(
      worker,
      new RegExp(`wgpuUboComputeReconstruction\\?\\.reset\\(\"${reason}\"\\)`)
    );
  }
  assert.match(worker, /wgpuUboComputeReconstruction\?\.invalidate\("device-loss"\)/);
  assert.match(worker, /wgpuUboComputeReconstruction\?\.invalidate\(`fatal-\$\{scope\}`\)/);
});
