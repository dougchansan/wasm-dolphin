// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import {
  WGPU_GEOMETRY_COARSE_RANGE_REASON,
  WGPU_GEOMETRY_PACKET_MAX_OFFSET,
  checkedAlignUp,
  createWgpuGeometryPacketArena,
  packWgpuGeometryCoarseRanges,
  packWgpuGeometryPacket,
  planWgpuGeometryCoarseRanges,
  planWgpuGeometryPacketLayout,
  reconstructWgpuGeometryPacket,
} from "../src/wgpu-geometry-packet.js";

const DEFAULT_PASS = Symbol("pass");
const DEFAULT_TRANSACTION = Symbol("transaction");

function coarseSpan(options) {
  return {
    generation: 1,
    passId: DEFAULT_PASS,
    transactionId: DEFAULT_TRANSACTION,
    ...options,
  };
}

test("coarse ranges merge gaps through 64 bytes and materialize legacy destinations", () => {
  const buffer = {};
  const first = Uint8Array.of(1, 2, 3, 4);
  const second = Uint8Array.of(5, 6, 7, 8);
  const spans = [
    coarseSpan({ buffer, generation: 2, destinationOffset: 8, bytes: first }),
    coarseSpan({
      buffer,
      generation: 2,
      destinationOffset: 76,
      bytes: second,
      paddingBeforeBytes: 64,
    }),
  ];
  const packed = packWgpuGeometryCoarseRanges({ spans });

  assert.equal(packed.ok, true);
  assert.equal(packed.ranges.length, 1);
  assert.deepEqual(packed.ranges[0], {
    buffer,
    generation: 2,
    passId: DEFAULT_PASS,
    transactionId: DEFAULT_TRANSACTION,
    startOffset: 8,
    endOffset: 80,
    byteLength: 72,
    spanIndexes: [0, 1],
    gapBytes: 64,
  });
  assert.deepEqual([...packed.packedRanges[0].bytes.slice(0, 4)], [...first]);
  assert.ok(packed.packedRanges[0].bytes.slice(4, 68).every((byte) => byte === 0));
  assert.deepEqual([...packed.packedRanges[0].bytes.slice(68)], [...second]);
  assert.deepEqual(first, Uint8Array.of(1, 2, 3, 4));
  assert.deepEqual(second, Uint8Array.of(5, 6, 7, 8));
  assert.equal(spans[0].destinationOffset, 8);
  const destination = new Uint8Array(88).fill(0xa5);
  destination.set(packed.packedRanges[0].bytes, packed.ranges[0].startOffset);
  const expected = new Uint8Array(88).fill(0xa5);
  expected.set(first, 8);
  expected.fill(0, 12, 76);
  expected.set(second, 76);
  assert.deepEqual(destination, expected);

  const splitAt65 = planWgpuGeometryCoarseRanges({
    alignment: 1,
    spans: [
      coarseSpan({ buffer, generation: 2, destinationOffset: 0, bytes: Uint8Array.of(1) }),
      coarseSpan({
        buffer,
        generation: 2,
        destinationOffset: 66,
        bytes: Uint8Array.of(2),
        paddingBeforeBytes: 65,
      }),
    ],
  });
  assert.equal(
    splitAt65.splits[0].reason,
    WGPU_GEOMETRY_COARSE_RANGE_REASON.GAP_EXCEEDS_LIMIT
  );
});

test("coarse ranges expose deterministic split reasons", () => {
  const a = {};
  const b = {};
  const pass2 = {};
  const transaction2 = {};
  const bytes = new Uint8Array(4);
  const plan = planWgpuGeometryCoarseRanges({
    maxRangeBytes: 80,
    spans: [
      coarseSpan({ buffer: a, destinationOffset: 0, bytes }),
      coarseSpan({ buffer: a, destinationOffset: 72, bytes, paddingBeforeBytes: 68 }),
      coarseSpan({ buffer: a, destinationOffset: 80, bytes, boundaryBefore: true }),
      coarseSpan({ buffer: b, destinationOffset: 0, bytes }),
      coarseSpan({ buffer: b, generation: 2, destinationOffset: 8, bytes }),
      coarseSpan({
        buffer: b, generation: 2, passId: pass2, destinationOffset: 0, bytes,
      }),
      coarseSpan({
        buffer: b,
        generation: 2,
        passId: pass2,
        transactionId: transaction2,
        destinationOffset: 0,
        bytes,
      }),
      coarseSpan({
        buffer: b,
        generation: 2,
        passId: pass2,
        transactionId: transaction2,
        destinationOffset: 68,
        bytes,
        paddingBeforeBytes: 64,
      }),
      coarseSpan({
        buffer: b,
        generation: 2,
        passId: pass2,
        transactionId: transaction2,
        destinationOffset: 136,
        bytes,
        paddingBeforeBytes: 64,
      }),
    ],
  });

  assert.equal(plan.ok, true);
  assert.deepEqual(plan.splits.map(({ reason }) => reason), [
    WGPU_GEOMETRY_COARSE_RANGE_REASON.GAP_EXCEEDS_LIMIT,
    WGPU_GEOMETRY_COARSE_RANGE_REASON.EXPLICIT_BOUNDARY,
    WGPU_GEOMETRY_COARSE_RANGE_REASON.BUFFER_CHANGED,
    WGPU_GEOMETRY_COARSE_RANGE_REASON.GENERATION_CHANGED,
    WGPU_GEOMETRY_COARSE_RANGE_REASON.PASS_CHANGED,
    WGPU_GEOMETRY_COARSE_RANGE_REASON.TRANSACTION_CHANGED,
    WGPU_GEOMETRY_COARSE_RANGE_REASON.RANGE_EXCEEDS_CAP,
  ]);
});

test("coarse ranges preserve unauthorized gaps and reject mismatched padding", () => {
  const buffer = {};
  const first = coarseSpan({
    buffer, destinationOffset: 4, bytes: Uint8Array.of(1, 2, 3, 4),
  });
  const second = coarseSpan({
    buffer, destinationOffset: 16, bytes: Uint8Array.of(5, 6, 7, 8),
  });
  const packed = packWgpuGeometryCoarseRanges({ spans: [first, second] });
  assert.equal(packed.ok, true);
  assert.equal(packed.ranges.length, 2);
  assert.equal(
    packed.splits[0].reason,
    WGPU_GEOMETRY_COARSE_RANGE_REASON.PADDING_NOT_AUTHORIZED
  );
  const destination = new Uint8Array(24).fill(0xa5);
  for (const range of packed.packedRanges) {
    destination.set(range.bytes, range.startOffset);
  }
  const expected = new Uint8Array(24).fill(0xa5);
  expected.set(first.bytes, first.destinationOffset);
  expected.set(second.bytes, second.destinationOffset);
  assert.deepEqual(destination, expected);

  const mismatch = packWgpuGeometryCoarseRanges({
    spans: [first, { ...second, paddingBeforeBytes: 7 }],
  });
  assert.equal(mismatch.ok, false);
  assert.equal(
    mismatch.fallbacks[0].reason,
    WGPU_GEOMETRY_COARSE_RANGE_REASON.PADDING_MISMATCH
  );
  assert.deepEqual(mismatch.packedRanges, []);
});

test("coarse ranges fail closed for unsafe logical spans", () => {
  const buffer = {};
  const cases = [
    {
      spans: [coarseSpan({ buffer, destinationOffset: 2, bytes: new Uint8Array(4) })],
      reason: WGPU_GEOMETRY_COARSE_RANGE_REASON.MISALIGNED_SPAN,
    },
    {
      spans: [
        coarseSpan({ buffer, destinationOffset: 16, bytes: new Uint8Array(4) }),
        coarseSpan({ buffer, destinationOffset: 12, bytes: new Uint8Array(4) }),
      ],
      reason: WGPU_GEOMETRY_COARSE_RANGE_REASON.DESTINATION_REGRESSION,
    },
    {
      spans: [
        coarseSpan({ buffer, destinationOffset: 16, bytes: new Uint8Array(8) }),
        coarseSpan({ buffer, destinationOffset: 20, bytes: new Uint8Array(4) }),
      ],
      reason: WGPU_GEOMETRY_COARSE_RANGE_REASON.OVERLAPPING_SPAN,
    },
    {
      spans: [coarseSpan({
        buffer,
        destinationOffset: 0xfffffffc,
        bytes: new Uint8Array(8),
      })],
      reason: WGPU_GEOMETRY_COARSE_RANGE_REASON.UNSAFE_INTEGER_OVERFLOW,
    },
    {
      maxRangeBytes: 8,
      spans: [coarseSpan({ buffer, destinationOffset: 0, bytes: new Uint8Array(12) })],
      reason: WGPU_GEOMETRY_COARSE_RANGE_REASON.LOGICAL_SPAN_EXCEEDS_CAP,
    },
    {
      spans: [coarseSpan({ buffer: null, destinationOffset: 0, bytes: new Uint8Array(4) })],
      reason: WGPU_GEOMETRY_COARSE_RANGE_REASON.INVALID_IDENTITY,
    },
    {
      spans: [coarseSpan({
        buffer, passId: Number.NaN, destinationOffset: 0, bytes: new Uint8Array(4),
      })],
      reason: WGPU_GEOMETRY_COARSE_RANGE_REASON.INVALID_IDENTITY,
    },
    {
      spans: [{
        buffer,
        generation: 1,
        passId: DEFAULT_PASS,
        destinationOffset: 0,
        bytes: new Uint8Array(4),
      }],
      reason: WGPU_GEOMETRY_COARSE_RANGE_REASON.INVALID_IDENTITY,
    },
    {
      spans: [coarseSpan({ buffer, destinationOffset: 0, bytes: new Uint8Array(0) })],
      reason: WGPU_GEOMETRY_COARSE_RANGE_REASON.ZERO_LENGTH_SPAN,
    },
  ];

  for (const options of cases) {
    const packed = packWgpuGeometryCoarseRanges(options);
    assert.equal(packed.ok, false);
    assert.equal(packed.fallbacks.at(-1).reason, options.reason);
    assert.deepEqual(packed.packedRanges, []);
  }

  assert.equal(planWgpuGeometryCoarseRanges({
    spans: [], maxRangeBytes: (16 * 1024 * 1024) + 1,
  }).fallbacks[0].reason, WGPU_GEOMETRY_COARSE_RANGE_REASON.INVALID_OPTIONS);
});

test("randomized coarse packing exactly matches legacy destination writes", () => {
  let seed = 0x9e3779b9;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
  };

  for (let run = 0; run < 500; run += 1) {
    const buffer = {};
    const spans = [];
    let destinationOffset = (random() % 8) * 4;
    const spanCount = 1 + (random() % 20);
    for (let index = 0; index < spanCount; index += 1) {
      destinationOffset += (random() % 17) * 4;
      const bytes = Uint8Array.from(
        { length: (1 + (random() % 16)) * 4 },
        () => random() & 0xff
      );
      const priorEnd = spans.length === 0
        ? null
        : spans.at(-1).destinationOffset + spans.at(-1).bytes.byteLength;
      const authorizePadding = priorEnd !== null && (random() & 1) === 1;
      spans.push(coarseSpan({
        buffer,
        destinationOffset,
        bytes,
        ...(authorizePadding
          ? { paddingBeforeBytes: destinationOffset - priorEnd }
          : {}),
      }));
      destinationOffset += bytes.byteLength;
    }

    const packed = packWgpuGeometryCoarseRanges({ spans, maxRangeBytes: 512 });
    assert.equal(packed.ok, true);
    const legacy = new Uint8Array(destinationOffset).fill(0xa5);
    for (const range of packed.ranges) {
      for (let index = 1; index < range.spanIndexes.length; index += 1) {
        const previous = spans[range.spanIndexes[index - 1]];
        const current = spans[range.spanIndexes[index]];
        legacy.fill(
          0,
          previous.destinationOffset + previous.bytes.byteLength,
          current.destinationOffset
        );
      }
    }
    for (const span of spans) legacy.set(span.bytes, span.destinationOffset);
    const actual = new Uint8Array(destinationOffset).fill(0xa5);
    for (const range of packed.packedRanges) actual.set(range.bytes, range.startOffset);
    for (const span of spans) {
      assert.deepEqual(
        actual.slice(span.destinationOffset, span.destinationOffset + span.bytes.byteLength),
        span.bytes
      );
    }
    assert.deepEqual(actual, legacy);
  }
});

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
