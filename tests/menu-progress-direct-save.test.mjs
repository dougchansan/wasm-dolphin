// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const harnessUrl = new URL("../tools/menu-progress-validate.mjs", import.meta.url);

test("direct-save playthrough pauses, loads, and resumes before visible sampling", async () => {
  const source = await readFile(harnessUrl, "utf8");
  const loadFunction = source.indexOf("const loadConfiguredSaveState");
  const pause = source.indexOf('"validationSetCorePaused"', loadFunction);
  const load = source.indexOf("window.__loadStateFile", pause);
  const resume = source.indexOf('"validationSetCorePaused"', pause + 1);
  const immediateCall = source.indexOf("await loadConfiguredSaveState(0)", resume);
  const firstVisible = source.indexOf("// First-visible-content milestone", immediateCall);
  const audioSetup = source.indexOf("// Phase C: apply the explicit test audio mode", firstVisible);

  assert.ok(loadFunction >= 0);
  assert.ok(pause > loadFunction && load > pause && resume > load);
  assert.ok(immediateCall > resume && firstVisible > immediateCall && audioSetup > firstVisible);
  assert.match(source, /pauseResponse\?\.coreStateName !== "Paused"/);
  assert.match(source, /resumeResponse\?\.coreStateName !== "Running"/);
  assert.match(source, /AUDIO_MODE \|\| "audible"/);
});
