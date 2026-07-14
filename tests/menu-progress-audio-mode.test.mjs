import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const harnessUrl = new URL("../tools/menu-progress-validate.mjs", import.meta.url);

test("headed harness makes audible versus muted audio an explicit recorded choice", async () => {
  const source = await readFile(harnessUrl, "utf8");

  assert.match(source, /const audioMode = String\(process\.env\.AUDIO_MODE \|\| "audible"\)/);
  assert.match(source, /\["audible", "muted"\]\.includes\(audioMode\)/);
  assert.match(source, /audio\.setMuted\(selectedAudioMode === "muted"\)/);
  assert.match(source, /runMetadata\.benchmark\.audioMode = audioMode/);
  assert.match(source, /summary\.audio\.requestedMode = audioMode/);
});
