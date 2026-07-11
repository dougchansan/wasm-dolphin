// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import {
  WGPU_GEOMETRY_PACKET_MAX_OFFSET,
  checkedAlignUp,
  createWgpuGeometryPacketArena,
  packWgpuGeometryPacket,
  planWgpuGeometryPacketLayout,
  reconstructWgpuGeometryPacket,
} from "../src/wgpu-geometry-packet.js";

test("checked alignment rejects invalid inputs and uint32 overflow", () => {
  assert.equal(checkedAlignUp(5, 4), 8);
  assert.equal(checkedAlignUp(8, 4), 8);
  assert.equal(checkedAlignUp(WGPU_GEOMETRY_PACKET_MAX_OFFSET, 4), null);
  assert.equal(checkedAlignUp(-1, 4), null);
  assert.equal(checkedAlignUp(0, 0), null);
});

test("layout covers padding, empty spans, exact end, and overflow", () => {
  assert.deepEqual(planWgpuGeometryPacketLayout({
    baseOffset: 3,
    capacity: 32,
    vertexLength: 5,
    indexLength: 3,
    vertexAlignment: 4,
    indexAlignment: 4,
  }), {
    packetOffset: 4,
    packetLength: 11,
    vertexOffset: 4,
    vertexLength: 5,
    indexOffset: 12,
    indexLength: 3,
    indexPadding: 3,
    endOffset: 15,
  });

  assert.deepEqual(planWgpuGeometryPacketLayout({
    baseOffset: 7, capacity: 7, vertexLength: 0, indexLength: 0,
  }), {
    packetOffset: 7,
    packetLength: 0,
    vertexOffset: 7,
    vertexLength: 0,
    indexOffset: 7,
    indexLength: 0,
    indexPadding: 0,
    endOffset: 7,
  });

  assert.equal(planWgpuGeometryPacketLayout({
    baseOffset: 0, capacity: 16, vertexLength: 9, indexLength: 4,
  }).endOffset, 16);
  assert.equal(planWgpuGeometryPacketLayout({
    baseOffset: 0, capacity: 15, vertexLength: 9, indexLength: 4,
  }), null);
});

test("packed bytes reconstruct exactly and padding is deterministic zero", () => {
  const vertexBytes = Uint8Array.of(1, 2, 3, 4, 5);
  const indexBytes = Uint8Array.of(9, 8, 7);
  const packet = packWgpuGeometryPacket({
    vertexBytes,
    indexBytes,
    baseOffset: 4,
    capacity: 32,
  });
  assert.deepEqual([...packet.bytes], [1, 2, 3, 4, 5, 0, 0, 0, 9, 8, 7]);
  assert.deepEqual(reconstructWgpuGeometryPacket(packet), { vertexBytes, indexBytes });
});

test("arena preparation, commit, and abort are transactional", () => {
  const arena = createWgpuGeometryPacketArena({ capacity: 16 });
  const first = arena.prepare({
    vertexBytes: Uint8Array.of(1, 2, 3, 4),
    indexBytes: Uint8Array.of(5, 6, 7, 8),
  });
  assert.equal(arena.snapshot().cursor, 0);
  assert.equal(arena.prepare({ vertexBytes: Uint8Array.of(1) }), null);
  assert.equal(arena.abort(first), true);
  assert.deepEqual(arena.snapshot().liveGenerations, []);
  assert.equal(arena.snapshot().cursor, 0);

  const second = arena.prepare({ vertexBytes: Uint8Array.of(1, 2, 3, 4) });
  const committed = arena.commit(second);
  assert.equal(committed.layout.endOffset, 4);
  assert.equal(arena.snapshot().cursor, 4);
  assert.equal(arena.commit(second), null);
});

test("overflow before submit rotates generation without overwriting live bytes", () => {
  const arena = createWgpuGeometryPacketArena({ capacity: 12 });
  const first = arena.commit(arena.prepare({
    vertexBytes: Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8),
  }));
  const firstCopy = first.bytes.slice();
  const secondTx = arena.prepare({
    vertexBytes: Uint8Array.of(9, 10, 11, 12, 13, 14, 15, 16),
  });
  assert.equal(secondTx.rotates, true);
  const second = arena.commit(secondTx);
  assert.notEqual(second.generation, first.generation);
  assert.deepEqual(arena.snapshot().liveGenerations, [first.generation, second.generation]);
  assert.deepEqual(first.bytes, firstCopy);
});

test("only successful SUBMIT_PRESENT releases generations for reuse", () => {
  const arena = createWgpuGeometryPacketArena({ capacity: 8, maxLiveGenerations: 1 });
  arena.commit(arena.prepare({ vertexBytes: new Uint8Array(8) }));
  assert.equal(arena.recordSubmitPresent(false), false);
  assert.equal(arena.prepare({ vertexBytes: Uint8Array.of(1) }), null);
  assert.equal(arena.recordSubmitPresent(true), true);
  const next = arena.prepare({ vertexBytes: Uint8Array.of(1) });
  assert.equal(next.layout.packetOffset, 0);
  assert.equal(arena.snapshot().liveGenerations.length, 0);
});

test("a pending transaction blocks a submit barrier and invalidation discards it", () => {
  const arena = createWgpuGeometryPacketArena({ capacity: 8 });
  const transaction = arena.prepare({ indexBytes: Uint8Array.of(1, 2) });
  assert.equal(arena.recordSubmitPresent(true), false);
  assert.equal(arena.snapshot().successfulSubmitBarriers, 0);
  arena.invalidate();
  assert.equal(arena.commit(transaction), null);
  assert.equal(arena.snapshot().pending, false);
  assert.equal(arena.snapshot().invalidations, 1);
});

test("randomized fake consumer matches legacy vertex and index destinations", () => {
  let seed = 0x42f00d;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
  };

  for (let run = 0; run < 1000; run += 1) {
    const vertexBytes = Uint8Array.from(
      { length: random() % 129 }, () => random() & 0xff
    );
    const indexBytes = Uint8Array.from(
      { length: random() % 65 }, () => random() & 0xff
    );
    const vertexAlignment = [4, 8, 12, 16][random() % 4];
    const packet = packWgpuGeometryPacket({
      vertexBytes,
      indexBytes,
      baseOffset: random() % 32,
      capacity: 256,
      vertexAlignment,
      indexAlignment: 4,
    });
    assert.ok(packet);
    assert.equal(packet.layout.vertexOffset % vertexAlignment, 0);
    assert.equal(packet.layout.indexOffset % 4, 0);

    const packedBuffer = new Uint8Array(256);
    packedBuffer.set(packet.bytes, packet.layout.packetOffset);
    const fakeConsumer = {
      vertexBytes: packedBuffer.slice(
        packet.layout.vertexOffset,
        packet.layout.vertexOffset + packet.layout.vertexLength
      ),
      indexBytes: packedBuffer.slice(
        packet.layout.indexOffset,
        packet.layout.indexOffset + packet.layout.indexLength
      ),
    };
    assert.deepEqual(fakeConsumer.vertexBytes, vertexBytes);
    assert.deepEqual(fakeConsumer.indexBytes, indexBytes);
  }
});
