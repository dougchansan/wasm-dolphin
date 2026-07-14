// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("performance runs can disable browser background throttling explicitly", async () => {
  const source = await readFile(
    new URL("../tools/perf-regression-gate.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /PERF_DISABLE_BACKGROUND_THROTTLING/);
  assert.match(source, /--disable-background-timer-throttling/);
  assert.match(source, /--disable-renderer-backgrounding/);
  assert.match(source, /--disable-backgrounding-occluded-windows/);
  assert.match(source, /CalculateNativeWinOcclusion,IntensiveWakeUpThrottling/);
});
