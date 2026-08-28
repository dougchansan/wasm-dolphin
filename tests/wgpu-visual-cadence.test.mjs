import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { UpstreamWorkerAdapter } from "../src/upstream-worker-adapter.js";
import {
  WGPU_VISUAL_BYTES_PER_ROW,
  WGPU_VISUAL_READBACK_BYTES,
  WGPU_VISUAL_READBACK_RING_SIZE,
  WGPU_VISUAL_SAMPLE_HEIGHT,
  WGPU_VISUAL_SAMPLE_WIDTH,
  createWgpuVisualCadenceTelemetry,
  hashWgpuVisualSample,
  requestedWgpuVisualCadence
} from "../src/wgpu-visual-cadence.js";

test("wgpuvisual follows the video path unless it is set explicitly", () => {
  // Software presenters hash the XFB themselves, so they never want the
  // hardware readback and it stays off for them.
  assert.equal(requestedWgpuVisualCadence(""), false);
  assert.equal(requestedWgpuVisualCadence("?wgpuvisual=true"), false);
  assert.equal(requestedWgpuVisualCadence("?video=wgpu&wgpuvisual=1"), true);

  // The hardware path has no other source of unique-visual-frame counts, so
  // absence of the flag means on (issue #7); wgpuvisual=0 opts back out.
  assert.equal(requestedWgpuVisualCadence("", { hardwareVideo: true }), true);
  assert.equal(
    requestedWgpuVisualCadence("?wgpuvisual=0", { hardwareVideo: true }),
    false
  );
  assert.equal(requestedWgpuVisualCadence("?wgpuvisual=0"), false);

  assert.equal(new UpstreamWorkerAdapter().wgpuVisualCadence, false);
  assert.equal(
    new UpstreamWorkerAdapter({ wgpuVisualCadence: true }).wgpuVisualCadence,
    true
  );
});

test("readback dimensions and ring allocation remain small and fixed", () => {
  assert.equal(WGPU_VISUAL_SAMPLE_WIDTH, 96);
  assert.equal(WGPU_VISUAL_SAMPLE_HEIGHT, 72);
  assert.equal(WGPU_VISUAL_BYTES_PER_ROW, 512);
  assert.equal(WGPU_VISUAL_READBACK_BYTES, 36_864);
  assert.equal(WGPU_VISUAL_READBACK_RING_SIZE, 3);

  const off = createWgpuVisualCadenceTelemetry(false);
  const on = createWgpuVisualCadenceTelemetry(true);
  assert.equal(off.enabled, false);
  assert.equal(off.allocatedReadbackBytes, 0);
  assert.equal(on.enabled, true);
  assert.equal(on.source, "wgpu-downsample-readback");
  assert.equal(on.allocatedReadbackBytes, 110_592);
});

test("visual hash covers every downsampled texel and ignores row padding", () => {
  const width = 3;
  const height = 2;
  const bytesPerRow = 16;
  const first = new Uint8Array(bytesPerRow * height);
  const second = new Uint8Array(first.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width * 4; x += 1) {
      first[y * bytesPerRow + x] = y * 40 + x;
      second[y * bytesPerRow + x] = y * 40 + x;
    }
  }
  first[12] = 1;
  second[12] = 200;
  assert.equal(
    hashWgpuVisualSample(first, { width, height, bytesPerRow }),
    hashWgpuVisualSample(second, { width, height, bytesPerRow })
  );

  second[bytesPerRow + 7] ^= 0xff;
  assert.notEqual(
    hashWgpuVisualSample(first, { width, height, bytesPerRow }),
    hashWgpuVisualSample(second, { width, height, bytesPerRow })
  );
});

test("host and worker plumb a hardware-only presenter readback", async () => {
  const [host, adapter, worker] = await Promise.all([
    readFile(new URL("../src/core-host.js", import.meta.url), "utf8"),
    readFile(new URL("../src/upstream-worker-adapter.js", import.meta.url), "utf8"),
    readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8")
  ]);

  assert.match(host, /hardwareVideo: this\.videoBackend === "WebGPU-Real"/);
  assert.match(host, /wgpuVisualCadence: this\.wgpuVisualCadence/);
  // The hardware path must never be labelled with a measurement it did not
  // take: with the readback off it reports "unsampled", not "xfb-hash".
  assert.match(worker, /hardwareVideoBackend \? "unsampled" : "xfb-hash"/);
  assert.match(adapter, /wgpuVisualCadence: this\.wgpuVisualCadence/);
  assert.match(worker, /wgpuvisual=1 requires video=wgpu/);
  assert.equal(
    worker.match(/wgpuVisualCadenceEnabled \? textureUsage\.TEXTURE_BINDING : 0/g)?.length,
    2,
    "every canvas reconfiguration must retain texture-binding usage"
  );
  assert.match(worker, /length: WGPU_VISUAL_READBACK_RING_SIZE/);
  assert.match(worker, /pass\.setPipeline\(renderGpu\.pipeline\)/);
  assert.match(worker, /encoder\.copyTextureToBuffer/);
  assert.match(worker, /slot\.buffer\.mapAsync\(0x01\)/);
  assert.match(worker, /visualSampleSource = telemetry\.source/);
  assert.match(worker, /visualCadence: wgpuVisualCadenceSnapshot\(\)/);
  assert.match(worker, /visualFps: wgpuVisualCadenceEnabled \? visualChangeFps : 0/);
});
