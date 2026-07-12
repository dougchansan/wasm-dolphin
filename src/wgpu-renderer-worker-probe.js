// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

const CANARY_VALUE = 0x57a6cafe;

self.addEventListener("message", (event) => {
  if (event.data?.type !== "canary") return;
  runCanary(event.data).then(
    (result) => self.postMessage({ type: "canary-result", ok: true, ...result }),
    (error) => self.postMessage({
      type: "canary-result",
      ok: false,
      error: String(error?.stack || error?.message || error),
    })
  );
});

async function runCanary({ sharedCanary, powerPreference = "high-performance" }) {
  if (!(sharedCanary instanceof SharedArrayBuffer)) {
    throw new Error("renderer worker canary requires SharedArrayBuffer");
  }
  if (!self.navigator?.gpu) throw new Error("WebGPU is unavailable in nested worker");
  const atomics = new Int32Array(sharedCanary);
  const startedAt = performance.now();
  Atomics.store(atomics, 0, CANARY_VALUE | 0);
  Atomics.notify(atomics, 0);

  const adapterStartedAt = performance.now();
  const adapter = await self.navigator.gpu.requestAdapter({ powerPreference });
  if (!adapter) throw new Error("nested worker requestAdapter returned null");
  const adapterMs = performance.now() - adapterStartedAt;
  const deviceStartedAt = performance.now();
  const device = await adapter.requestDevice();
  const deviceMs = performance.now() - deviceStartedAt;

  const source = device.createBuffer({
    size: 4,
    usage: 0x0002 | 0x0004,
    mappedAtCreation: true,
  });
  new Uint32Array(source.getMappedRange())[0] = CANARY_VALUE;
  source.unmap();
  const destination = device.createBuffer({ size: 4, usage: 0x0001 | 0x0008 });
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(source, 0, destination, 0, 4);
  const submitStartedAt = performance.now();
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
  const gpuCompletionMs = performance.now() - submitStartedAt;
  const mapStartedAt = performance.now();
  await destination.mapAsync(0x0001);
  const mapMs = performance.now() - mapStartedAt;
  const observed = new Uint32Array(destination.getMappedRange())[0] >>> 0;
  destination.unmap();
  source.destroy();
  destination.destroy();
  device.destroy();
  if (observed !== CANARY_VALUE) {
    throw new Error(`nested worker GPU copy mismatch: ${observed.toString(16)}`);
  }
  return {
    schema: "wasm-dolphin.wgpu-renderer-worker-canary.v1",
    adapterMs,
    deviceMs,
    gpuCompletionMs,
    mapMs,
    totalMs: performance.now() - startedAt,
    observed,
    sabCanary: Atomics.load(atomics, 0) >>> 0,
  };
}
