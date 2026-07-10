import assert from "node:assert/strict";
import test from "node:test";

import {
  compareInputGenerations,
  readInputStateSnapshot,
  writeInputStateSnapshot
} from "../src/input-transport.js";

test("input generation ordering is wrap-safe and rejects stale delivery", () => {
  assert.equal(compareInputGenerations(7, 7), 0);
  assert.equal(compareInputGenerations(8, 7), 1);
  assert.equal(compareInputGenerations(7, 8), -1);
  assert.equal(compareInputGenerations(1, 0xffff_ffff), 1);
  assert.equal(compareInputGenerations(0xffff_ffff, 1), -1);
});

test("input SAB writer publishes an even sequence around one coherent snapshot", () => {
  const view = new Int32Array(new SharedArrayBuffer(48));
  writeInputStateSnapshot(view, {
    mask: 0x101,
    stickX: 130,
    stickY: 126,
    cStickX: 140,
    cStickY: 120,
    triggerLeft: 1,
    triggerRight: 2,
    analogA: 255,
    analogB: 3,
    inputGeneration: 9,
    sentAtEpochMs: 0x1234_5678
  });

  assert.equal(Atomics.load(view, 11) & 1, 0);
  assert.deepEqual(readInputStateSnapshot(view).snapshot, {
    mask: 0x101,
    stickX: 130,
    stickY: 126,
    cStickX: 140,
    cStickY: 120,
    triggerLeft: 1,
    triggerRight: 2,
    analogA: 255,
    analogB: 3,
    inputGeneration: 9,
    sentAtEpochMsLow: 0x1234_5678
  });
});

test("input SAB reader refuses an in-progress writer", () => {
  const view = new Int32Array(new SharedArrayBuffer(48));
  Atomics.store(view, 11, 3);
  const result = readInputStateSnapshot(view);
  assert.equal(result.snapshot, null);
  assert.equal(result.status, "writer-active");
});

test("input SAB sequence wraps from max odd to zero without publishing odd", () => {
  const view = new Int32Array(new SharedArrayBuffer(48));
  Atomics.store(view, 11, -2);
  writeInputStateSnapshot(view, { inputGeneration: 1 });
  assert.equal(Atomics.load(view, 11) >>> 0, 0);
  assert.equal(readInputStateSnapshot(view).snapshot.inputGeneration, 1);
});
