// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("performance validation fails closed when the requested UBO packet mode is inactive", async () => {
  const gate = await readFile(
    new URL("../tools/perf-regression-gate.mjs", import.meta.url),
    "utf8"
  );
  assert.match(gate, /scenario\.params\?\.wgpuubopack/);
  for (const flag of ["wgpuubocache", "wgpuubometrics", "wgpuubopack", "wgpugeompack"])
    assert.match(gate, new RegExp(`"${flag}"`));
  assert.match(gate, /final\.causalTelemetry\?\.webgpu\?\.uboPackEnabled/);
  assert.match(gate, /WGPU UBO pack mismatch: requested=/);
});

test("performance validation fails closed when detailed UBO metrics are inactive", async () => {
  const gate = await readFile(
    new URL("../tools/perf-regression-gate.mjs", import.meta.url),
    "utf8"
  );
  assert.match(gate, /scenario\.params\?\.wgpuubometrics/);
  assert.match(gate, /producerUboCacheMetricsEnabled/);
  assert.match(gate, /WGPU UBO metrics mismatch: requested=/);
});

test("the disc worker forwards the requested UBO packet mode into core loading", async () => {
  const worker = await readFile(
    new URL("../src/upstream-discio-worker.js", import.meta.url),
    "utf8"
  );
  assert.match(worker, /wgpuUboPack: payload\.wgpuUboPack/);
  assert.match(worker, /wgpuUboPack: requestedWgpuUboPack = false/);
  assert.match(worker, /wgpuUboPackEnabled = Boolean\(requestedWgpuUboPack\)/);
  assert.match(worker, /wgpuubometrics=1 requires metrics=1/);
  assert.match(worker, /wgpuubometrics=1 requires video=wgpu/);
});
