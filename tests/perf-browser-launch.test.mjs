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

test("performance runs keep ephemeral launch by default and opt into a persistent profile", async () => {
  const gate = await readFile(
    new URL("../tools/perf-regression-gate.mjs", import.meta.url),
    "utf8"
  );
  assert.match(gate, /process\.env\.PERF_PERSIST_DIR\?\.trim\(\)/);
  assert.match(gate, /path\.resolve\(requestedPersistentProfile\)/);
  assert.match(gate, /chromium\.launchPersistentContext\(persistentProfileDir/);
  assert.match(gate, /: await chromium\.launch\(launchOptions\)/);
  assert.equal(gate.match(/chromium\.launchPersistentContext\(persistentProfileDir/g)?.length, 2);
  assert.equal(gate.match(/await chromium\.launch\(launchOptions\)/g)?.length, 2);
  assert.match(gate, /persistentProfileDir \? "persistent-reuse" : "cold-ephemeral"/);
  assert.match(gate, /`persistent:\$\{browserLaunch\.persistentProfileDir\}`/);
});

test("persistent performance profiles preserve viewport, affinity, and cleanup behavior", async () => {
  const gate = await readFile(
    new URL("../tools/perf-regression-gate.mjs", import.meta.url),
    "utf8"
  );
  assert.match(gate, /launchWithWindowsCpuAffinity/);
  assert.match(gate, /headless: !headed/);
  assert.match(gate, /await page\.setViewportSize\(\{ width: 1280, height: 900 \}\)/);
  assert.match(gate, /if \(browser\) await browser\.close\(\)\.catch/);
});
