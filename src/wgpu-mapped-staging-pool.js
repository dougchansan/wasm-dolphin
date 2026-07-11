// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

const COPY_ALIGNMENT = 4;
const TEXTURE_ROW_ALIGNMENT = 256;

export function createWgpuMappedStagingPool({
  device,
  slotCount = 3,
  slotSize,
  bufferUsage = resolveBufferUsage(),
  mapMode = resolveMapWriteMode(),
  watchDeviceLoss = true,
} = {}) {
  if (!device?.createBuffer || !device?.createCommandEncoder) {
    throw new TypeError("device must provide WebGPU buffer and encoder creation");
  }
  if (!isPositiveInteger(slotCount)) {
    throw new RangeError("slotCount must be a positive integer");
  }
  if (!isPositiveInteger(slotSize) || slotSize % COPY_ALIGNMENT !== 0) {
    throw new RangeError("slotSize must be a positive multiple of 4");
  }
  if (!isNonnegativeInteger(bufferUsage) || !isNonnegativeInteger(mapMode)) {
    throw new TypeError("bufferUsage and mapMode must be numeric WebGPU flags");
  }

  const owner = Symbol("wgpu-mapped-staging-pool");
  const slots = Array.from({ length: slotCount }, (_, id) => {
    const buffer = device.createBuffer({
      label: `Dolphin mapped upload staging ${id}`,
      size: slotSize,
      usage: bufferUsage,
      mappedAtCreation: true,
    });
    return {
      id,
      buffer,
      mappedBytes: new Uint8Array(buffer.getMappedRange()),
      cursor: 0,
      records: [],
      state: "mapped",
      epoch: 0,
    };
  });

  let failed = false;
  let lastError = null;
  let nextBatchId = 1;
  const activeBatches = new Set();
  const metrics = {
    bufferUploads: 0,
    textureUploads: 0,
    logicalBytes: 0,
    stagedBytes: 0,
    capacityMisses: 0,
    oversizedMisses: 0,
    batchesSealed: 0,
    batchesSubmitted: 0,
    remapsStarted: 0,
    remapsCompleted: 0,
    remapFailures: 0,
    invalidations: 0,
  };

  function stageBuffer({ data, destination, destinationOffset = 0, alignment = 4 } = {}) {
    const bytes = viewBytes(data);
    if (!bytes || !destination) throw new TypeError("buffer upload needs data and destination");
    if (!isNonnegativeInteger(destinationOffset) || destinationOffset % COPY_ALIGNMENT !== 0 ||
        bytes.byteLength === 0 || bytes.byteLength % COPY_ALIGNMENT !== 0) {
      throw new RangeError("buffer copy offsets and byte lengths must be positive multiples of 4");
    }
    const sourceAlignment = combinedAlignment(COPY_ALIGNMENT, alignment);
    const allocation = allocate(bytes.byteLength, sourceAlignment);
    if (!allocation.ok) return allocation;

    allocation.slot.mappedBytes.set(bytes, allocation.offset);
    allocation.slot.records.push({
      kind: "buffer",
      sourceOffset: allocation.offset,
      size: bytes.byteLength,
      destination,
      destinationOffset,
    });
    metrics.bufferUploads += 1;
    metrics.logicalBytes += bytes.byteLength;
    metrics.stagedBytes += bytes.byteLength;
    return success(allocation.slot, allocation.offset, bytes.byteLength, bytes.byteLength);
  }

  function stageTexture({
    data,
    destination,
    copySize,
    sourceBytesPerRow,
    sourceRowsPerImage = copySize?.height,
    origin,
    mipLevel,
    aspect,
  } = {}) {
    const bytes = viewBytes(data);
    const width = copySize?.width;
    const height = copySize?.height;
    const depthOrArrayLayers = copySize?.depthOrArrayLayers ?? 1;
    if (!bytes || !destination) throw new TypeError("texture upload needs data and destination");
    if (!isPositiveInteger(width) || !isPositiveInteger(height) ||
        !isPositiveInteger(depthOrArrayLayers) || !isPositiveInteger(sourceBytesPerRow) ||
        !isPositiveInteger(sourceRowsPerImage) || sourceRowsPerImage < height) {
      throw new RangeError("texture copy dimensions and source row layout must be positive");
    }

    const sourceSliceBytes = sourceBytesPerRow * sourceRowsPerImage;
    const requiredSourceBytes = sourceSliceBytes * (depthOrArrayLayers - 1) +
      sourceBytesPerRow * height;
    if (!Number.isSafeInteger(requiredSourceBytes) || bytes.byteLength < requiredSourceBytes) {
      throw new RangeError("texture source does not contain every requested row");
    }
    const packedBytesPerRow = alignUp(sourceBytesPerRow, TEXTURE_ROW_ALIGNMENT);
    const packedSize = packedBytesPerRow * height * depthOrArrayLayers;
    if (!Number.isSafeInteger(packedSize)) throw new RangeError("texture staging size overflow");
    const allocation = allocate(packedSize, TEXTURE_ROW_ALIGNMENT);
    if (!allocation.ok) return allocation;

    for (let layer = 0; layer < depthOrArrayLayers; layer += 1) {
      for (let row = 0; row < height; row += 1) {
        const sourceOffset = layer * sourceSliceBytes + row * sourceBytesPerRow;
        const targetOffset = allocation.offset +
          (layer * height + row) * packedBytesPerRow;
        allocation.slot.mappedBytes.set(
          bytes.subarray(sourceOffset, sourceOffset + sourceBytesPerRow),
          targetOffset
        );
      }
    }

    allocation.slot.records.push({
      kind: "texture",
      sourceOffset: allocation.offset,
      bytesPerRow: packedBytesPerRow,
      rowsPerImage: height,
      destination,
      origin,
      mipLevel,
      aspect,
      copySize: { width, height, depthOrArrayLayers },
    });
    metrics.textureUploads += 1;
    metrics.logicalBytes += sourceBytesPerRow * height * depthOrArrayLayers;
    metrics.stagedBytes += packedSize;
    return success(
      allocation.slot,
      allocation.offset,
      sourceBytesPerRow * height * depthOrArrayLayers,
      packedSize
    );
  }

  function seal() {
    assertUsable();
    const batchSlots = slots.filter((slot) => slot.state === "mapped" && slot.records.length > 0);
    if (batchSlots.length === 0) return null;

    const encoder = device.createCommandEncoder({ label: "Dolphin mapped staging uploads" });
    try {
      for (const slot of batchSlots) {
        slot.buffer.unmap();
        slot.mappedBytes = null;
        slot.state = "sealed";
        for (const record of slot.records) encodeRecord(encoder, slot.buffer, record);
      }
      const batch = Object.freeze({
        owner,
        id: nextBatchId,
        slots: Object.freeze(batchSlots.slice()),
        commandBuffer: encoder.finish(),
      });
      nextBatchId += 1;
      activeBatches.add(batch);
      metrics.batchesSealed += 1;
      return batch;
    } catch (error) {
      invalidate(error);
      throw error;
    }
  }

  function acceptSubmission(batch) {
    requireActiveBatch(batch);
    activeBatches.delete(batch);
    metrics.batchesSubmitted += 1;
    const generation = batch.id;
    const remaps = batch.slots.map((slot) => {
      slot.state = "remapping";
      slot.records = [];
      slot.cursor = 0;
      slot.epoch = generation;
      metrics.remapsStarted += 1;
      return Promise.resolve(slot.buffer.mapAsync(mapMode)).then(() => {
        if (failed || slot.epoch !== generation || slot.state !== "remapping") return false;
        slot.mappedBytes = new Uint8Array(slot.buffer.getMappedRange());
        slot.state = "mapped";
        metrics.remapsCompleted += 1;
        return true;
      }, (error) => {
        metrics.remapFailures += 1;
        invalidate(error);
        return false;
      });
    });
    return Promise.all(remaps).then((results) => results.every(Boolean));
  }

  function rejectSubmission(batch, error = new Error("WebGPU upload submission rejected")) {
    requireActiveBatch(batch);
    activeBatches.delete(batch);
    invalidate(error);
  }

  function invalidate(reason = "WebGPU staging pool invalidated") {
    if (failed) return false;
    failed = true;
    lastError = normalizeError(reason);
    metrics.invalidations += 1;
    activeBatches.clear();
    for (const slot of slots) {
      slot.epoch += 1;
      slot.state = "failed";
      slot.records = [];
      slot.cursor = 0;
      slot.mappedBytes = null;
      try {
        slot.buffer.destroy();
      } catch {
        // Destruction is best-effort after a device failure.
      }
    }
    return true;
  }

  function snapshot() {
    const states = { mapped: 0, sealed: 0, remapping: 0, failed: 0 };
    for (const slot of slots) states[slot.state] += 1;
    return {
      slotCount,
      slotSize,
      capacityBytes: slotCount * slotSize,
      failed,
      lastError,
      states,
      pendingUploads: slots.reduce((count, slot) => count + slot.records.length, 0),
      activeBatches: activeBatches.size,
      ...metrics,
    };
  }

  function allocate(size, alignment) {
    if (failed) return miss("pool-failed", false);
    if (size > slotSize) return miss("payload-too-large", true);
    for (const slot of slots) {
      if (slot.state !== "mapped") continue;
      const offset = alignUp(slot.cursor, alignment);
      if (offset + size > slotSize) continue;
      slot.cursor = offset + size;
      return { ok: true, slot, offset };
    }
    return miss("no-capacity", false);
  }

  function miss(reason, oversized) {
    metrics.capacityMisses += 1;
    if (oversized) metrics.oversizedMisses += 1;
    return Object.freeze({ ok: false, reason });
  }

  function assertUsable() {
    if (failed) throw new Error(`WebGPU staging pool is failed: ${lastError}`);
  }

  function requireActiveBatch(batch) {
    if (batch?.owner !== owner || !activeBatches.has(batch)) {
      throw new TypeError("batch does not belong to this staging pool or is no longer active");
    }
  }

  if (watchDeviceLoss && device.lost?.then) {
    device.lost.then((info) => invalidate(info?.message || info?.reason || "device lost"));
  }

  return Object.freeze({
    stageBuffer,
    stageTexture,
    seal,
    acceptSubmission,
    rejectSubmission,
    invalidate,
    snapshot,
  });
}

export function submitWgpuUploadBeforeRender({
  queue,
  pool,
  batch,
  renderCommandBuffers = [],
} = {}) {
  if (!queue?.submit || !pool?.acceptSubmission || !pool?.rejectSubmission || !batch) {
    throw new TypeError("queue, pool, and upload batch are required");
  }
  if (!Array.isArray(renderCommandBuffers)) {
    throw new TypeError("renderCommandBuffers must be an array");
  }
  try {
    queue.submit([batch.commandBuffer, ...renderCommandBuffers]);
  } catch (error) {
    pool.rejectSubmission(batch, error);
    throw error;
  }
  return pool.acceptSubmission(batch);
}

function encodeRecord(encoder, sourceBuffer, record) {
  if (record.kind === "buffer") {
    encoder.copyBufferToBuffer(
      sourceBuffer,
      record.sourceOffset,
      record.destination,
      record.destinationOffset,
      record.size
    );
    return;
  }
  const destination = { texture: record.destination };
  if (record.origin !== undefined) destination.origin = record.origin;
  if (record.mipLevel !== undefined) destination.mipLevel = record.mipLevel;
  if (record.aspect !== undefined) destination.aspect = record.aspect;
  encoder.copyBufferToTexture({
    buffer: sourceBuffer,
    offset: record.sourceOffset,
    bytesPerRow: record.bytesPerRow,
    rowsPerImage: record.rowsPerImage,
  }, destination, record.copySize);
}

function success(slot, offset, logicalBytes, stagedBytes) {
  return Object.freeze({ ok: true, slot: slot.id, offset, logicalBytes, stagedBytes });
}

function alignUp(value, alignment) {
  if (!isNonnegativeInteger(value) || !isPositiveInteger(alignment)) {
    throw new RangeError("alignment inputs must be nonnegative safe integers");
  }
  const remainder = value % alignment;
  const result = remainder === 0 ? value : value + alignment - remainder;
  if (!Number.isSafeInteger(result)) throw new RangeError("alignment overflow");
  return result;
}

function combinedAlignment(base, requested) {
  if (!isPositiveInteger(requested)) throw new RangeError("alignment must be positive");
  return leastCommonMultiple(base, requested);
}

function leastCommonMultiple(left, right) {
  const value = left / greatestCommonDivisor(left, right) * right;
  if (!Number.isSafeInteger(value)) throw new RangeError("alignment overflow");
  return value;
}

function greatestCommonDivisor(left, right) {
  while (right !== 0) [left, right] = [right, left % right];
  return left;
}

function viewBytes(value) {
  if (!ArrayBuffer.isView(value)) return null;
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function resolveBufferUsage() {
  const usage = globalThis.GPUBufferUsage;
  if (!usage) throw new Error("GPUBufferUsage is unavailable; pass bufferUsage explicitly");
  return usage.MAP_WRITE | usage.COPY_SRC;
}

function resolveMapWriteMode() {
  const mode = globalThis.GPUMapMode;
  if (!mode) throw new Error("GPUMapMode is unavailable; pass mapMode explicitly");
  return mode.WRITE;
}

function normalizeError(value) {
  return String(value?.message || value?.reason || value || "unknown");
}

function isNonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}
