import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  evaluateAudioClaimQualification,
  normalizePerfAudioMode,
} from "../tools/perf-artifacts.mjs";

test("perf audio mode defaults to muted and accepts explicit audible opt-in", () => {
  assert.equal(normalizePerfAudioMode(undefined), "muted");
  assert.equal(normalizePerfAudioMode(""), "muted");
  assert.equal(normalizePerfAudioMode(" MUTED "), "muted");
  assert.equal(normalizePerfAudioMode(" AUDIBLE "), "audible");
  assert.throws(
    () => normalizePerfAudioMode("auto"),
    /Invalid PERF_AUDIO_MODE=.*expected muted or audible/
  );
});

test("only qualified headed audible runs can qualify audio claims", () => {
  assert.deepEqual(
    evaluateAudioClaimQualification({
      audioMode: "muted",
      headed: true,
      qualificationEligible: true,
    }),
    {
      mode: "muted",
      audibleRequested: false,
      eligible: false,
      reason: "audio-mode-muted",
    }
  );
  assert.equal(
    evaluateAudioClaimQualification({
      audioMode: "audible",
      headed: false,
      qualificationEligible: true,
    }).reason,
    "headless"
  );
  assert.equal(
    evaluateAudioClaimQualification({
      audioMode: "audible",
      headed: true,
      qualificationEligible: false,
    }).reason,
    "run-not-qualified"
  );
  assert.equal(
    evaluateAudioClaimQualification({
      audioMode: "audible",
      headed: true,
      qualificationEligible: true,
    }).eligible,
    true
  );
});

test("perf gate applies and records the harness-only audio contract", async () => {
  const source = await readFile(
    new URL("../tools/perf-regression-gate.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /normalizePerfAudioMode\(process\.env\.PERF_AUDIO_MODE\)/);
  assert.match(source, /audio\.setMuted\(requestedMode === "muted"\)/);
  assert.match(source, /manifest\.benchmark\.audioMode = context\.audioMode/);
  assert.match(source, /summary\.audioMode = context\.audioMode/);
  assert.match(source, /audioClaimsEligible: audioClaimQualification\.eligible/);
  const mountIndex = source.indexOf("await waitForMount(page, scenarioDir)");
  const audioApplicationIndex = source.indexOf(
    "audioModeApplication = await applyHarnessAudioMode(page, context.audioMode)"
  );
  assert.notEqual(mountIndex, -1);
  assert.notEqual(audioApplicationIndex, -1);
  assert.ok(
    mountIndex < audioApplicationIndex,
    "the harness audio override must run after the app mount flow completes"
  );
});
