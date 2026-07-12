// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

export function createWgpuCommandRingFixture(records = defaultRecords(), {
  initialRead = 0,
  initialUploadRead = 0,
} = {}) {
  const heapBuffer = new SharedArrayBuffer(64 * 1024);
  const headerPtr = 0;
  const slotsPtr = 64;
  const capacity = 32;
  const uploadPtr = 4096;
  const uploadSize = 4096;
  const header = new Int32Array(heapBuffer, headerPtr, 7);
  const words = new Uint32Array(heapBuffer);
  header[0] = (initialRead + records.length) >>> 0;
  header[1] = initialRead | 0;
  header[2] = capacity;
  header[3] = initialUploadRead | 0;
  records.forEach((record, index) => {
    const base = (slotsPtr + (((initialRead + index) >>> 0) % capacity) * 32) >>> 2;
    for (let word = 0; word < 8; word += 1) words[base + word] = record[word] ?? 0;
  });
  new Uint8Array(heapBuffer, uploadPtr, 20).set([
    1, 2, 3, 4,
    10, 11, 12, 13, 14, 15, 16, 17,
    18, 19, 20, 21, 22, 23, 24, 25,
  ]);
  return {
    heapBuffer,
    header,
    ownerBuffer: new SharedArrayBuffer(16),
    descriptor: {
      heapBuffer,
      headerPtr,
      headerWords: 7,
      slotsPtr,
      capacity,
      uploadPtr,
      uploadSize,
      protocolVersion: 3,
      start: false,
    },
  };
}

export function defaultRecords() {
  return [
    [5, 1, 64, 0x0c],
    [6, 1, 0, 4096, 4, 3],
    [7, 2, 2, 2, 0, 0x06, 1],
    [8, 2, 4100, 8, 2, 2, 0, 0],
    [12],
    [19, 3, 1, 0],
    [22],
    [23, 1, 1],
    [23, 2, 2],
  ];
}

export function createFakeUploadDevice() {
  const buffers = [];
  const textures = [];
  const submissions = [];
  const encoders = [];
  let completionCount = 0;
  const device = {
    lost: new Promise(() => {}),
    createBuffer(descriptor) {
      const storage = new ArrayBuffer(descriptor.size);
      const buffer = {
        descriptor,
        storage,
        destroyed: false,
        getMappedRange: () => storage,
        unmap() {},
        mapAsync: async () => {},
        destroy() { this.destroyed = true; },
      };
      buffers.push(buffer);
      return buffer;
    },
    createTexture(descriptor) {
      const texture = { descriptor, destroyed: false, destroy() { this.destroyed = true; } };
      textures.push(texture);
      return texture;
    },
    createCommandEncoder() {
      const copies = [];
      const encoder = {
        copyBufferToBuffer(...args) { copies.push(["buffer", ...args]); },
        copyBufferToTexture(...args) { copies.push(["texture", ...args]); },
        finish: () => ({ copies }),
      };
      encoders.push(encoder);
      return encoder;
    },
    queue: {
      submit(commands) { submissions.push(commands); },
      async onSubmittedWorkDone() { completionCount += 1; },
    },
  };
  return {
    device,
    buffers,
    textures,
    submissions,
    encoders,
    get completionCount() { return completionCount; },
  };
}
