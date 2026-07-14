// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("perf gate binds the selected candidate prebuilt cache into served and build provenance", async () => {
  const gate = await readFile(
    new URL("../tools/perf-regression-gate.mjs", import.meta.url),
    "utf8"
  );
  assert.match(gate, /const optionalRuntimeAssets = \[selectedCore\.prebuilt\]/);
  assert.match(gate, /paths\.includes\(selectedCore\.prebuilt\)/);
  assert.match(gate, /describePrebuiltJitCache\(blob\)/);
  assert.match(gate, /evaluatePrebuiltJitCacheEvidence/);
  assert.match(gate, /prebuiltJitCache,/);
  assert.match(gate, /name === "prebuilt-jit-cache\.bin"/);
  assert.match(gate, /requireManifestEntry: true/);
});
