import assert from "node:assert/strict";
import test from "node:test";

import { createDemoCoreWasmBytes, instantiateDemoCore } from "../src/wasm/demo-core.js";

test("demo core generates a valid WebAssembly module", async () => {
  const bytes = createDemoCoreWasmBytes();

  assert.equal(await WebAssembly.validate(bytes), true);

  const { instance } = await WebAssembly.instantiate(bytes, {});
  assert.equal(typeof instance.exports.pixel, "function");
});

test("demo core pixel output is deterministic and input-sensitive", async () => {
  const { instance } = await instantiateDemoCore();

  const idle = instance.exports.pixel(12, 34, 56, 0) >>> 0;
  const pressed = instance.exports.pixel(12, 34, 56, 7) >>> 0;

  assert.equal(idle >>> 24, 255);
  assert.notEqual(idle, pressed);
  assert.equal(instance.exports.pixel(12, 34, 56, 0) >>> 0, idle);
});
