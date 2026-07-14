// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createWgpuSparseUboCopyForward,
  planWgpuUboDirtyRanges,
  requestedWgpuSparseUbo,
} from "../src/wgpu-sparse-ubo-copy-forward.js";
import { WGPU_UPLOAD_ROLE } from "../src/wgpu-upload-attribution.js";

function fakeDevice() {
  const buffers = [];
  return {
    buffers,
    createBuffer(descriptor) {
      const buffer = { descriptor, destroys: 0, destroy() { this.destroys += 1; } };
      buffers.push(buffer);
      return buffer;
    },
  };
}

test("sparse UBO copy-forward is explicit and default-off", () => {
  assert.equal(requestedWgpuSparseUbo(""), false);
  assert.equal(requestedWgpuSparseUbo("?wgpuubosparse=0"), false);
  assert.equal(requestedWgpuSparseUbo("?wgpuubosparse=1"), true);
  assert.equal(requestedWgpuSparseUbo("?wgpuubosparse=true"), false);
});

test("dirty planner preserves 16-byte boundary coverage", () => {
  const before = new Uint8Array(4112);
  const after = before.slice();
  for (const offset of [15, 16, 17, 255, 256, 4111]) after[offset] = 1;
  const plan = planWgpuUboDirtyRanges(after, before);
  assert.equal(plan.dirtyBytes, 80);
  assert.deepEqual(plan.ranges, [
    { start: 0, end: 32 },
    { start: 240, end: 272 },
    { start: 4096, end: 4112 },
  ]);
});

test("manager commits shadows only after an atomic stage succeeds", () => {
  const device = fakeDevice();
  const calls = [];
  let accept = false;
  const pool = {
    stageBufferSnapshot(options) {
      calls.push(options);
      return accept
        ? { ok: true, stagedBytes: options.ranges.reduce(
            (total, range) => total + range.end - range.start, 0) }
        : { ok: false, reason: "no-capacity" };
    },
  };
  const manager = createWgpuSparseUboCopyForward({ device });
  const first = new Uint8Array(64).fill(1);
  const destination = {};

  assert.equal(manager.stage({
    pool, data: first, destination, role: WGPU_UPLOAD_ROLE.UBO,
  }).ok, false);
  assert.deepEqual(manager.snapshot().shadowValid, [false, false, false]);
  assert.equal(manager.snapshot().capacityMisses, 1);

  accept = true;
  assert.equal(manager.stage({
    pool, data: first, destination, role: WGPU_UPLOAD_ROLE.UBO,
  }).mode, "baseline");
  assert.deepEqual(manager.snapshot().shadowValid, [false, false, true]);

  const second = first.slice();
  second[16] = 2;
  const sparse = manager.stage({
    pool, data: second, destination, destinationOffset: 256,
    role: WGPU_UPLOAD_ROLE.UBO,
  });
  assert.equal(sparse.mode, "sparse");
  assert.equal(sparse.stagedBytes, 16);
  assert.equal(calls.at(-1).copyForward, true);
  assert.deepEqual(calls.at(-1).ranges, [{ start: 16, end: 32 }]);

  const equal = manager.stage({
    pool, data: second, destination, destinationOffset: 512,
    role: WGPU_UPLOAD_ROLE.UBO,
  });
  assert.equal(equal.mode, "equal");
  assert.equal(equal.stagedBytes, 0);
  assert.equal(manager.snapshot().equalCalls, 1);
  assert.equal(manager.snapshot().sparseCalls, 1);
});

test("high dirty coverage stages a full replacement snapshot", () => {
  const calls = [];
  const pool = {
    stageBufferSnapshot(options) {
      calls.push(options);
      return { ok: true, stagedBytes: options.ranges.reduce(
        (total, range) => total + range.end - range.start, 0) };
    },
  };
  const manager = createWgpuSparseUboCopyForward({ device: fakeDevice() });
  const first = new Uint8Array(64);
  const second = new Uint8Array(64).fill(1);
  manager.stage({ pool, data: first, destination: {}, role: WGPU_UPLOAD_ROLE.UBO });
  const replacement = manager.stage({
    pool, data: second, destination: {}, role: WGPU_UPLOAD_ROLE.UBO,
  });
  assert.equal(replacement.mode, "full-fallback");
  assert.equal(replacement.stagedBytes, 64);
  assert.equal(calls.at(-1).copyForward, false);
  assert.deepEqual(calls.at(-1).ranges, [{ start: 0, end: 64 }]);
  assert.equal(manager.snapshot().fullFallbackCalls, 1);
});

test("unknown and non-UBO uploads stay on the existing path", () => {
  const manager = createWgpuSparseUboCopyForward({ device: fakeDevice() });
  const pool = { stageBufferSnapshot() { throw new Error("must not stage"); } };
  assert.equal(manager.stage({
    pool, data: new Uint8Array(128), destination: {}, role: WGPU_UPLOAD_ROLE.UBO,
  }).handled, false);
  assert.equal(manager.stage({
    pool, data: new Uint8Array(64), destination: {}, role: WGPU_UPLOAD_ROLE.VERTEX,
  }).handled, false);
});

test("reset destroys GPU shadows and forces a new baseline", () => {
  const device = fakeDevice();
  const pool = {
    stageBufferSnapshot(options) {
      return { ok: true, stagedBytes: options.ranges.reduce(
        (total, range) => total + range.end - range.start, 0) };
    },
  };
  const manager = createWgpuSparseUboCopyForward({ device });
  const data = new Uint8Array(1536);
  manager.stage({ pool, data, destination: {}, role: WGPU_UPLOAD_ROLE.UBO });
  assert.equal(manager.reset("load"), 1);
  assert.equal(device.buffers[0].destroys, 1);
  assert.deepEqual(manager.snapshot().shadowValid, [false, false, false]);
  assert.equal(manager.stage({
    pool, data, destination: {}, role: WGPU_UPLOAD_ROLE.UBO,
  }).mode, "baseline");
});

test("sparse UBO flag is wired from URL through validation and perf gating", async () => {
  const [host, adapter, worker, harness, gate, artifacts] = await Promise.all([
    readFile(new URL("../src/core-host.js", import.meta.url), "utf8"),
    readFile(new URL("../src/upstream-worker-adapter.js", import.meta.url), "utf8"),
    readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8"),
    readFile(new URL("../tools/menu-progress-validate.mjs", import.meta.url), "utf8"),
    readFile(new URL("../tools/perf-regression-gate.mjs", import.meta.url), "utf8"),
    readFile(new URL("../tools/perf-artifacts.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(host, /this\.wgpuSparseUbo = requestedWgpuSparseUbo\(window\.location\.search\)/);
  assert.match(host, /wgpuSparseUbo: this\.wgpuSparseUbo/);
  assert.match(adapter, /this\.wgpuSparseUbo = Boolean\(wgpuSparseUbo\)/);
  assert.match(adapter, /wgpuSparseUbo: this\.wgpuSparseUbo/);
  assert.match(worker, /wgpuubosparse=1 requires video=wgpu/);
  assert.match(worker, /wgpuubosparse=1 requires wgpuuploadtransport=mapped/);
  assert.match(worker, /wgpuSparseUbo: payload\.wgpuSparseUbo/);
  assert.match(worker, /wgpuSparseUbo: requestedWgpuSparseUbo = false/);
  assert.match(worker, /ensureWgpuSparseUbo\(dev\)\?\.stage/);
  assert.match(worker, /wgpuSparseUbo\?\.reset\("core-reset"\)/);
  assert.match(worker, /wgpuSparseUbo\?\.reset\("slot-state-load"\)/);
  assert.match(worker, /wgpuSparseUbo\?\.reset\("save-state-load"\)/);
  assert.match(worker, /wgpuSparseUbo\?\.reset\("core-reload"\)/);
  assert.match(worker, /wgpuSparseUbo\?\.reset\("device-loss"\)/);
  assert.match(worker, /wgpuSparseUbo\?\.reset\(`fatal-\$\{scope\}`\)/);
  assert.match(harness, /\["WGPUUBOSPARSE", "wgpuubosparse"\]/);
  assert.match(gate, /evaluateWgpuSparseUboEvidence/);
  assert.match(gate, /require wgpustagefast=0 to isolate the mechanism/);
  assert.match(artifacts, /handled no eligible uploads in the timed window/);
  assert.match(artifacts, /reconstructed no sparse slices in the timed window/);
  assert.match(artifacts, /did not reduce mapped bytes in the timed window/);
});
