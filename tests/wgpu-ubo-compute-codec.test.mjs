// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import {
  applyWgpuUboComputePackageReference,
  encodeWgpuUboComputePackage,
  WGPU_UBO_COMPUTE_CODEC_MAGIC,
} from "../src/wgpu-ubo-compute-codec.js";

const CLASS_BYTES = { VS: 4112, PS: 1536, GS: 64 };

function pattern(size, seed) {
  const bytes = new Uint8Array(size);
  let state = seed >>> 0;
  for (let index = 0; index < size; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bytes[index] = state >>> 24;
  }
  return bytes;
}

function upload(resourceClass, destinationOffset, bytes, resourceId = 7) {
  return { resourceId, resourceClass, destinationOffset, bytes };
}

test("codec deterministically emits aligned FULL, DELTA, and EQUAL packages", () => {
  const initial = pattern(CLASS_BYTES.VS, 1);
  const changed = initial.slice();
  changed.fill(0xaa, 32, 48);
  const shadows = new Map();
  const first = encodeWgpuUboComputePackage({
    uploads: [upload("VS", 0, initial)],
    shadows,
  });
  assert.equal(new DataView(first.bytes.buffer).getUint32(0, true), WGPU_UBO_COMPUTE_CODEC_MAGIC);
  assert.equal(first.packageBytes % 256, 0);
  assert.deepEqual(first.kinds, ["VS:FULL"]);

  const second = encodeWgpuUboComputePackage({
    uploads: [upload("VS", 8192, changed), upload("VS", 16384, changed)],
    shadows: first.nextShadows,
  });
  const repeated = encodeWgpuUboComputePackage({
    uploads: [upload("VS", 8192, changed), upload("VS", 16384, changed)],
    shadows: first.nextShadows,
  });
  assert.deepEqual(second.kinds, ["VS:DELTA", "VS:EQUAL"]);
  assert.deepEqual(second.bytes, repeated.bytes);
});

test("reference reconstruction is byte-exact for subviews and overlapping later writes", () => {
  const backing = pattern(CLASS_BYTES.PS + 19, 2);
  const subview = new Uint8Array(backing.buffer, 11, CLASS_BYTES.PS);
  const later = subview.slice();
  later.fill(0x44, 0, 32);
  const encoded = encodeWgpuUboComputePackage({
    uploads: [upload("PS", 0, subview), upload("PS", 768, later)],
  });
  const destination = new Uint8Array(4096).fill(0xcc);
  const destinations = new Map([[7, destination]]);
  const shadows = new Map();
  applyWgpuUboComputePackageReference({
    packageBytes: encoded.bytes,
    destinations,
    shadows,
  });
  const expected = new Uint8Array(4096).fill(0xcc);
  expected.set(subview, 0);
  expected.set(later, 768);
  assert.deepEqual(destination, expected);
});

test("resource and class shadows remain independent", () => {
  const vs = pattern(CLASS_BYTES.VS, 3);
  const ps = pattern(CLASS_BYTES.PS, 4);
  const gs = pattern(CLASS_BYTES.GS, 5);
  const first = encodeWgpuUboComputePackage({
    uploads: [upload("VS", 0, vs), upload("PS", 8192, ps), upload("GS", 12288, gs)],
  });
  assert.deepEqual(first.kinds, ["VS:FULL", "PS:FULL", "GS:FULL"]);
  const second = encodeWgpuUboComputePackage({
    uploads: [upload("VS", 16384, vs), upload("PS", 24576, ps), upload("GS", 28672, gs)],
    shadows: first.nextShadows,
  });
  assert.deepEqual(second.kinds, ["VS:EQUAL", "PS:EQUAL", "GS:EQUAL"]);
  assert.throws(() => encodeWgpuUboComputePackage({
    uploads: [upload("VS", 0, vs, 7), upload("VS", 8192, vs, 8)],
  }), /only one resource/);
});

test("malformed final record never mutates destination or shadow", () => {
  const bytes = pattern(CLASS_BYTES.GS, 6);
  const encoded = encodeWgpuUboComputePackage({
    uploads: [upload("GS", 0, bytes), upload("GS", 128, bytes)],
  });
  const malformed = encoded.bytes.slice();
  const view = new DataView(malformed.buffer);
  // Second descriptor destination overflows the destination buffer.
  view.setUint32(32 + 32 + 8, 0xfffffff0, true);
  const destination = new Uint8Array(512).fill(0x5a);
  const before = destination.slice();
  const shadows = new Map([["sentinel", Uint8Array.of(1, 2, 3)]]);
  assert.throws(() => applyWgpuUboComputePackageReference({
    packageBytes: malformed,
    destinations: new Map([[7, destination]]),
    shadows,
  }), /invalid/);
  assert.deepEqual(destination, before);
  assert.deepEqual(shadows, new Map([["sentinel", Uint8Array.of(1, 2, 3)]]));
});

test("truncation, bad ranges, unknown resources, and overflow fail closed", () => {
  const bytes = pattern(CLASS_BYTES.GS, 7);
  const encoded = encodeWgpuUboComputePackage({ uploads: [upload("GS", 0, bytes)] });
  assert.throws(() => applyWgpuUboComputePackageReference({
    packageBytes: encoded.bytes.subarray(0, encoded.bytes.byteLength - 1),
    destinations: new Map([[7, new Uint8Array(256)]]),
  }), /alignment|size/);
  assert.throws(() => applyWgpuUboComputePackageReference({
    packageBytes: encoded.bytes,
    destinations: new Map([[8, new Uint8Array(256)]]),
  }), /unknown/);
  const malformedRange = encoded.bytes.slice();
  const view = new DataView(malformedRange.buffer);
  const rangeOffset = view.getUint32(32 + 20, true);
  view.setUint32(rangeOffset, 4, true);
  assert.throws(() => applyWgpuUboComputePackageReference({
    packageBytes: malformedRange,
    destinations: new Map([[7, new Uint8Array(256)]]),
  }), /range/);
  assert.throws(() => encodeWgpuUboComputePackage({
    uploads: [upload("GS", 0xfffffff0, bytes)],
  }), /overflows/);
});

test("randomized ordered reconstruction matches sequential legacy uploads", () => {
  let state = 0x12345678;
  const next = () => (state = (Math.imul(state, 1103515245) + 12345) >>> 0);
  let encodeShadows = new Map();
  const decodeShadows = new Map();
  const destination = new Uint8Array(256 * 1024).fill(0x6d);
  const expected = destination.slice();
  for (let packageIndex = 0; packageIndex < 40; packageIndex += 1) {
    const uploads = [];
    for (let record = 0; record < 20; record += 1) {
      const resourceClass = ["VS", "PS", "GS"][next() % 3];
      const size = CLASS_BYTES[resourceClass];
      const data = pattern(size, next());
      if ((next() & 3) !== 0) data.fill(next() & 0xff, (next() % (size / 16)) * 16, Math.min(size, ((next() % (size / 16)) + 1) * 16));
      const destinationOffset = ((next() % ((destination.byteLength - size) / 256)) * 256) >>> 0;
      uploads.push(upload(resourceClass, destinationOffset, data));
      expected.set(data, destinationOffset);
    }
    const encoded = encodeWgpuUboComputePackage({ uploads, shadows: encodeShadows });
    encodeShadows = encoded.nextShadows;
    applyWgpuUboComputePackageReference({
      packageBytes: encoded.bytes,
      destinations: new Map([[7, destination]]),
      shadows: decodeShadows,
    });
  }
  assert.deepEqual(destination, expected);
});
