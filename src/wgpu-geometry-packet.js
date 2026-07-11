// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

// This module is the deterministic reference model for the C++ geometry upload
// packet. It deliberately models layout and lifetime only; it does not imply
// that the runtime implementation should allocate a temporary JS/C++ buffer.

export const WGPU_GEOMETRY_PACKET_MAX_OFFSET = 0xffffffff;

export function checkedAlignUp(
  value,
  alignment,
  limit = WGPU_GEOMETRY_PACKET_MAX_OFFSET
) {
  if (!isNonnegativeInteger(value) || !isPositiveInteger(alignment) ||
      !isNonnegativeInteger(limit) || value > limit) {
    return null;
  }
  const remainder = value % alignment;
  if (remainder === 0) return value;
  const increment = alignment - remainder;
  return increment <= limit - value ? value + increment : null;
}

export function planWgpuGeometryPacketLayout({
  baseOffset = 0,
  capacity,
  vertexLength,
  indexLength,
  vertexAlignment = 4,
  indexAlignment = 4,
} = {}) {
  if (!isNonnegativeInteger(capacity) ||
      capacity > WGPU_GEOMETRY_PACKET_MAX_OFFSET ||
      !isNonnegativeInteger(baseOffset) || baseOffset > capacity ||
      !isNonnegativeInteger(vertexLength) ||
      !isNonnegativeInteger(indexLength) ||
      !isPositiveInteger(vertexAlignment) ||
      !isPositiveInteger(indexAlignment)) {
    return null;
  }

  if (vertexLength === 0 && indexLength === 0) {
    return Object.freeze({
      packetOffset: baseOffset,
      packetLength: 0,
      vertexOffset: baseOffset,
      vertexLength: 0,
      indexOffset: baseOffset,
      indexLength: 0,
      indexPadding: 0,
      endOffset: baseOffset,
    });
  }

  const vertexOffset = checkedAlignUp(baseOffset, vertexAlignment, capacity);
  if (vertexOffset === null || vertexLength > capacity - vertexOffset) return null;
  const vertexEnd = vertexOffset + vertexLength;
  const indexOffset = checkedAlignUp(vertexEnd, indexAlignment, capacity);
  if (indexOffset === null || indexLength > capacity - indexOffset) return null;
  const endOffset = indexOffset + indexLength;

  return Object.freeze({
    packetOffset: vertexOffset,
    packetLength: endOffset - vertexOffset,
    vertexOffset,
    vertexLength,
    indexOffset,
    indexLength,
    indexPadding: indexOffset - vertexEnd,
    endOffset,
  });
}

export function packWgpuGeometryPacket({
  vertexBytes,
  indexBytes,
  baseOffset = 0,
  capacity,
  vertexAlignment = 4,
  indexAlignment = 4,
} = {}) {
  const vertex = copyBytes(vertexBytes);
  const index = copyBytes(indexBytes);
  if (vertex === null || index === null) return null;
  const layout = planWgpuGeometryPacketLayout({
    baseOffset,
    capacity,
    vertexLength: vertex.byteLength,
    indexLength: index.byteLength,
    vertexAlignment,
    indexAlignment,
  });
  if (!layout) return null;

  const bytes = new Uint8Array(layout.packetLength);
  bytes.set(vertex, layout.vertexOffset - layout.packetOffset);
  bytes.set(index, layout.indexOffset - layout.packetOffset);
  return { layout, bytes };
}

export function reconstructWgpuGeometryPacket(packet) {
  if (!packet?.layout || !(packet.bytes instanceof Uint8Array)) return null;
  const { layout, bytes } = packet;
  if (bytes.byteLength !== layout.packetLength) return null;
  const vertexStart = layout.vertexOffset - layout.packetOffset;
  const indexStart = layout.indexOffset - layout.packetOffset;
  if (vertexStart < 0 || indexStart < 0 ||
      vertexStart + layout.vertexLength > bytes.byteLength ||
      indexStart + layout.indexLength > bytes.byteLength) {
    return null;
  }
  return {
    vertexBytes: bytes.slice(vertexStart, vertexStart + layout.vertexLength),
    indexBytes: bytes.slice(indexStart, indexStart + layout.indexLength),
  };
}

export function createWgpuGeometryPacketArena({
  capacity,
  maxLiveGenerations = Number.POSITIVE_INFINITY,
  initialGeneration = 1,
} = {}) {
  if (!isPositiveInteger(capacity) || capacity > WGPU_GEOMETRY_PACKET_MAX_OFFSET) {
    throw new RangeError("capacity must be a positive uint32 byte count");
  }
  if (!(maxLiveGenerations === Number.POSITIVE_INFINITY ||
        isPositiveInteger(maxLiveGenerations))) {
    throw new RangeError("maxLiveGenerations must be positive or Infinity");
  }
  if (!isPositiveInteger(initialGeneration) ||
      initialGeneration > Number.MAX_SAFE_INTEGER) {
    throw new RangeError("initialGeneration must be a positive safe integer");
  }

  const owner = Symbol("wgpu-geometry-packet-arena");
  const liveGenerations = new Set();
  let cursor = 0;
  let generation = initialGeneration;
  let pending = null;
  let nextTransactionId = 1;
  let successfulSubmitBarriers = 0;
  let failedSubmitBarriers = 0;
  let rotationsBeforeBarrier = 0;
  let invalidations = 0;

  function prepare(options = {}) {
    if (pending) return null;
    let packed = packWgpuGeometryPacket({ ...options, baseOffset: cursor, capacity });
    let targetGeneration = generation;
    let rotates = false;

    if (!packed) {
      packed = packWgpuGeometryPacket({ ...options, baseOffset: 0, capacity });
      if (!packed || liveGenerations.size >= maxLiveGenerations) return null;
      targetGeneration = nextGeneration(generation);
      rotates = true;
    }

    const transaction = Object.freeze({
      owner,
      id: nextTransactionId,
      generation: targetGeneration,
      rotates,
      layout: packed.layout,
      bytes: packed.bytes,
    });
    nextTransactionId += 1;
    pending = transaction;
    return transaction;
  }

  function commit(transaction) {
    if (!isPending(transaction)) return null;
    pending = null;
    generation = transaction.generation;
    cursor = transaction.layout.endOffset;
    if (transaction.layout.packetLength > 0) liveGenerations.add(generation);
    if (transaction.rotates) rotationsBeforeBarrier += 1;
    return Object.freeze({
      generation,
      layout: transaction.layout,
      bytes: transaction.bytes,
    });
  }

  function abort(transaction) {
    if (!isPending(transaction)) return false;
    pending = null;
    return true;
  }

  function recordSubmitPresent(success) {
    if (!success) {
      failedSubmitBarriers += 1;
      return false;
    }
    if (pending) return false;
    successfulSubmitBarriers += 1;
    liveGenerations.clear();
    cursor = 0;
    generation = nextGeneration(generation);
    return true;
  }

  function invalidate() {
    pending = null;
    liveGenerations.clear();
    cursor = 0;
    generation = nextGeneration(generation);
    invalidations += 1;
  }

  function snapshot() {
    return {
      capacity,
      cursor,
      generation,
      pending: pending !== null,
      liveGenerations: [...liveGenerations],
      successfulSubmitBarriers,
      failedSubmitBarriers,
      rotationsBeforeBarrier,
      invalidations,
    };
  }

  function isPending(transaction) {
    return transaction?.owner === owner && transaction === pending;
  }

  return { prepare, commit, abort, recordSubmitPresent, invalidate, snapshot };
}

function copyBytes(value) {
  if (value == null) return new Uint8Array(0);
  if (!ArrayBuffer.isView(value)) return null;
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
}

function isNonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function nextGeneration(generation) {
  if (generation >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError("geometry packet generation overflow");
  }
  return generation + 1;
}
