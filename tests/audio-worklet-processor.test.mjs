import test from "node:test";
import assert from "node:assert/strict";
import {
  AUDIO_PCM_HEADER,
  AUDIO_PCM_STATE_RUNNING,
  createAudioPcmRing,
  writeAudioPcm,
} from "../src/audio-pcm-ring.js";
import { DolphinPcmProcessor } from "../src/audio-worklet-processor.js";

test("worklet consumes variable render quanta without replacing its result object", () => {
  const ring = createAudioPcmRing(512);
  const samples = new Int16Array(300 * 2).fill(8192);
  writeAudioPcm(ring, samples, 300);
  Atomics.store(ring.header, AUDIO_PCM_HEADER.STATE, AUDIO_PCM_STATE_RUNNING);
  const processor = new DolphinPcmProcessor({ processorOptions: { sab: ring.sab } });
  const result = processor.consumeResult;
  for (const frames of [64, 128, 96]) {
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    assert.equal(processor.process([], [[left, right]]), true);
    assert.equal(left[0], 0.25);
  }
  assert.equal(processor.consumeResult, result);
  assert.equal(Atomics.load(ring.header, AUDIO_PCM_HEADER.CONSUMED_FRAMES), 288);
});

test("worklet counts exact shortage and writes silence", () => {
  const ring = createAudioPcmRing(8);
  writeAudioPcm(ring, new Int16Array([1, 2, 3, 4]), 2);
  Atomics.store(ring.header, AUDIO_PCM_HEADER.STATE, AUDIO_PCM_STATE_RUNNING);
  const processor = new DolphinPcmProcessor({ processorOptions: { sab: ring.sab } });
  const left = new Float32Array(6).fill(1);
  const right = new Float32Array(6).fill(1);
  processor.process([], [[left, right]]);
  assert.equal(processor.consumeResult.underrunFrames, 4);
  assert.deepEqual([...left].slice(2), [0, 0, 0, 0]);
});
