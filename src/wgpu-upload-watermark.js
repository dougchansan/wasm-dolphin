// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

export const WGPU_UPLOAD_READ_HEADER_INDEX = 3;
export const WGPU_PROTOCOL_FLAGS_HEADER_INDEX = 4;
export const WGPU_UPLOAD_WATERMARK_PROTOCOL_FLAG = 1;

export function nextWgpuUploadRead({
  currentRead,
  uploadPointer,
  uploadBytes,
  uploadArenaBase,
  uploadArenaSize
}) {
  const read = currentRead >>> 0;
  const pointer = uploadPointer >>> 0;
  const bytes = uploadBytes >>> 0;
  const base = uploadArenaBase >>> 0;
  const size = uploadArenaSize >>> 0;

  if (!size || !bytes || bytes > size || pointer < base || pointer - base >= size) {
    return null;
  }

  const physicalOffset = (pointer - base) >>> 0;
  if (bytes > size - physicalOffset) return null;
  const cycleOffset = read % size;
  let distance = physicalOffset - cycleOffset;
  if (distance < 0) distance += size;
  return (read + distance + bytes) >>> 0;
}

export function publishWgpuUploadRead(ring, uploadPointer, uploadBytes) {
  if (!ring?.headerI32 || !ring.uploadWatermarkEnabled) return null;
  const currentRead = Atomics.load(
    ring.headerI32,
    WGPU_UPLOAD_READ_HEADER_INDEX
  ) >>> 0;
  const nextRead = nextWgpuUploadRead({
    currentRead,
    uploadPointer,
    uploadBytes,
    uploadArenaBase: ring.uploadBase,
    uploadArenaSize: ring.uploadSize
  });
  if (nextRead === null) return null;
  Atomics.store(ring.headerI32, WGPU_UPLOAD_READ_HEADER_INDEX, nextRead | 0);
  Atomics.notify(ring.headerI32, WGPU_UPLOAD_READ_HEADER_INDEX, 1);
  return nextRead;
}

export function enableWgpuUploadWatermark(ring) {
  if (!ring?.headerI32 || ring.headerI32.length <= WGPU_PROTOCOL_FLAGS_HEADER_INDEX) {
    return false;
  }
  Atomics.or(
    ring.headerI32,
    WGPU_PROTOCOL_FLAGS_HEADER_INDEX,
    WGPU_UPLOAD_WATERMARK_PROTOCOL_FLAG
  );
  Atomics.notify(ring.headerI32, WGPU_PROTOCOL_FLAGS_HEADER_INDEX, 1);
  ring.uploadWatermarkEnabled = true;
  return true;
}
