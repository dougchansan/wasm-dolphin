import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createCausalTelemetry, flattenCausalTelemetry } from "../src/causal-telemetry.js";

test("causal telemetry flattens exact worklet producer and consumer counters", () => {
  const telemetry = createCausalTelemetry();
  telemetry.audio.requestedTransport = "worklet";
  telemetry.audio.activeTransport = "worklet";
  telemetry.audio.workletRing = {
    fillFrames: 5120,
    underrunFrames: 17,
    underrunEvents: 2,
    writtenFrames: 9000,
    consumedFrames: 3880,
    producerRefills: 7,
    producerEmptyMixes: 1,
    producerTimerGapMaxMs: 13.5,
    producerFillHighWater: 5760,
  };
  const flat = flattenCausalTelemetry(telemetry);
  assert.equal(flat.causalAudioRequestedTransport, "worklet");
  assert.equal(flat.causalAudioActiveTransport, "worklet");
  assert.equal(flat.causalAudioWorkletUnderrunFrames, 17);
  assert.equal(flat.causalAudioWorkletProducerFillHighWater, 5760);
});

test("perf gate carries AUDIOTRANSPORT and fails closed on inactive fallback", async () => {
  const source = await readFile(new URL("../tools/perf-regression-gate.mjs", import.meta.url), "utf8");
  assert.match(source, /"audiotransport"/);
  assert.match(source, /audio transport mismatch: requested=/);
  assert.match(source, /activeAudioTransport !== requestedAudioTransport/);
  assert.match(source, /transportFallbackReason/);
});
