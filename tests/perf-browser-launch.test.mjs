// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("performance runs can force and record Chromium WebGPU power selection", async () => {
  const gate = await readFile(
    new URL("../tools/perf-regression-gate.mjs", import.meta.url),
    "utf8"
  );
  assert.match(gate, /process\.env\.PERF_WEBGPU_POWER_OVERRIDE/);
  assert.match(gate, /"force-low-power"/);
  assert.match(gate, /--use-webgpu-power-preference=\$\{webGpuPowerOverride\}/);
  assert.match(gate, /manifest\.browser\.launchArgs = browserLaunch\.args/);
  assert.match(gate, /args: \[\.\.\.args\]/);
});
