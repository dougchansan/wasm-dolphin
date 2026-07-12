import test from "node:test";
import assert from "node:assert/strict";
import {
  AUDIO_PCM_HEADER,
  AUDIO_PCM_STATE_PREFILL,
  AUDIO_PCM_STATE_RUNNING,
  audioPcmAvailableFrames,
  consumeAudioPcm,
  createAudioPcmRing,
  requestAudioPcmEpoch,
  writeAudioPcm,
} from "../src/audio-pcm-ring.js";

test("PCM ring has a 256-byte header and bounded stereo writes", () => {
  const ring = createAudioPcmRing(4);
  assert.equal(ring.samples.byteOffset, 256);
  assert.equal(writeAudioPcm(ring, new Int16Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 5), 4);
  assert.equal(audioPcmAvailableFrames(ring.header), 4);
  assert.deepEqual([...ring.samples], [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("PCM ring converts mono to stereo and wraps physical storage", () => {
  const ring = createAudioPcmRing(4);
  Atomics.store(ring.header, AUDIO_PCM_HEADER.READ_INDEX, 0xffff_fffe | 0);
  Atomics.store(ring.header, AUDIO_PCM_HEADER.WRITE_INDEX, 0xffff_fffe | 0);
  assert.equal(writeAudioPcm(ring, new Int16Array([100, -200, 300]), 3, 1), 3);
  Atomics.store(ring.header, AUDIO_PCM_HEADER.STATE, AUDIO_PCM_STATE_RUNNING);
  const left = new Float32Array(3);
  const right = new Float32Array(3);
  const result = consumeAudioPcm(ring, left, right, 3);
  assert.equal(result.consumedFrames, 3);
  assert.deepEqual([...left], [...right]);
  assert.equal(Atomics.load(ring.header, AUDIO_PCM_HEADER.READ_INDEX) >>> 0, 1);
});

test("consumer reports exact partial underrun and zero fills shortage", () => {
  const ring = createAudioPcmRing(8);
  writeAudioPcm(ring, new Int16Array([32767, -32768, 16384, -16384]), 2);
  Atomics.store(ring.header, AUDIO_PCM_HEADER.STATE, AUDIO_PCM_STATE_RUNNING);
  const left = new Float32Array(4).fill(1);
  const right = new Float32Array(4).fill(1);
  const result = consumeAudioPcm(ring, left, right, 4);
  assert.deepEqual(result, { consumedFrames: 2, underrunFrames: 2, flushed: false, epoch: 0 });
  assert.deepEqual([...left].slice(2), [0, 0]);
  assert.deepEqual([...right].slice(2), [0, 0]);
  assert.equal(Atomics.load(ring.header, AUDIO_PCM_HEADER.UNDERRUN_FRAMES), 2);
  assert.equal(Atomics.load(ring.header, AUDIO_PCM_HEADER.UNDERRUN_EVENTS), 1);
});

test("epoch handshake flushes stale audio before prefill can run", () => {
  const ring = createAudioPcmRing(8);
  writeAudioPcm(ring, new Int16Array([11, 12, 13, 14]), 2);
  const epoch = requestAudioPcmEpoch(ring, AUDIO_PCM_STATE_PREFILL);
  const left = new Float32Array(2).fill(1);
  const right = new Float32Array(2).fill(1);
  const result = consumeAudioPcm(ring, left, right, 2);
  assert.equal(result.flushed, true);
  assert.equal(Atomics.load(ring.header, AUDIO_PCM_HEADER.EPOCH_ACK) >>> 0, epoch);
  assert.equal(audioPcmAvailableFrames(ring.header), 0);
  assert.deepEqual([...left], [0, 0]);
});
