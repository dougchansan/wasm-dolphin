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
  assert.match(gate, /final\.causalTelemetry\?\.webgpu\?\.uboPackEnabled/);
  assert.match(gate, /WGPU UBO pack mismatch: requested=/);
});
