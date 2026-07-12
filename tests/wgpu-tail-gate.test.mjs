// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { requestedWgpuTailGate } from "../src/wgpu-replay-diagnostics.js";

test("idle FIFO tail elision is explicit and default-off", () => {
  assert.equal(requestedWgpuTailGate(""), false);
  assert.equal(requestedWgpuTailGate("?wgputailgate=0"), false);
  assert.equal(requestedWgpuTailGate("?wgputailgate=1"), true);
  assert.equal(requestedWgpuTailGate("?wgputailgate=true"), false);
});

test("host and worker plumb the gate through fail-closed activation", async () => {
  const [host, adapter, worker] = await Promise.all([
    readFile(new URL("../src/core-host.js", import.meta.url), "utf8"),
    readFile(new URL("../src/upstream-worker-adapter.js", import.meta.url), "utf8"),
    readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8"),
  ]);

  assert.match(host, /requestedWgpuTailGate\(window\.location\.search\)/);
  assert.match(host, /wgpuTailGate: this\.wgpuTailGate/);
  assert.match(adapter, /wgpuTailGate = false/);
  assert.match(adapter, /wgpuTailGate: this\.wgpuTailGate/);
  assert.match(worker, /wgputailgate=1 requires metrics=1/);
  assert.match(worker, /wgputailgate=1 requires the true hardware WebGPU backend/);
  assert.match(worker, /_SetWgpuIdleFifoTailElisionEnabled/);
  assert.match(worker, /SetWgpuIdleFifoTailElisionEnabled/);
  assert.match(worker, /parseWgpuTailGateStats/);
  assert.match(worker, /applyWgpuTailGate\("core boot"\)/);
  assert.match(worker, /applyWgpuTailGate\("core reset"\)/);
  assert.match(worker, /applyWgpuTailGate\("slot state reload"\)/);
  assert.match(worker, /applyWgpuTailGate\("save-state reload"\)/);
});
