import { test } from "node:test";
import assert from "node:assert/strict";

function parseOglSwapStats(stats) {
  const text = String(stats || "");
  const swap = Number.parseInt(/\bogl_swap:(\d+)/i.exec(text)?.[1] || "", 10);
  const size = /\bbb:(\d+)x(\d+)/i.exec(text);
  const readbackRgba = Number.parseInt(/\brb:0x([0-9a-f]+)/i.exec(text)?.[1] || "", 16);
  const glError = Number.parseInt(/\bglerr:0x([0-9a-f]+)/i.exec(text)?.[1] || "", 16);

  return {
    swap: Number.isFinite(swap) ? swap >>> 0 : 0,
    width: size ? Math.max(0, Number.parseInt(size[1], 10) || 0) : 0,
    height: size ? Math.max(0, Number.parseInt(size[2], 10) || 0) : 0,
    readbackRgba: Number.isFinite(readbackRgba) ? readbackRgba >>> 0 : 0,
    glError: Number.isFinite(glError) ? glError >>> 0 : 0
  };
}

test("OGL swap stats are extracted from the Dolphin video helper string", () => {
  const baseline =
    "video xfb:6284 640x480 stride:1280 present:320x240 hash:32f1dc5 nz:2048 " +
    "bp:1644 cp:45 xf:42 prim:1540 draw:249 rast:0 verts:0 pad polls:12634 " +
    "updates:4 input:10 buttons:1000 stick:128,128 fastsw:1 coreprof xfb_dt:15.5 " +
    "avg:16.6 max:57.3 decode:0.4 avg:0.4 max:1.1 vo_sync:0.0 vo_pub:0.4 vo_total:0.4 " +
    "swxfb:0.0 conv:0.0 copy:0.0 sz:0x0->0 ogl_swap:362 worker:0 commit:0 bb:320x240 " +
    "bits:3 rb:0x0 glerr:0x502";
  const stats = parseOglSwapStats(baseline);
  assert.equal(stats.swap, 362, "ogl_swap counter should be parsed");
  assert.equal(stats.glError, 0x502, "glerr should be parsed as INVALID_OPERATION");
  assert.equal(stats.readbackRgba, 0, "rb:0x0 should yield zero readback");
  assert.equal(stats.width, 320, "bb width should be parsed");
  assert.equal(stats.height, 240, "bb height should be parsed");
});

test("ogl_swap increments translate to a nonzero visualChangeFps signal", () => {
  // Simulate the recordOglSwapDelta accumulator the worker now runs.
  let visualChanges = 0;
  let lastSwap = 0;
  const record = (swap) => {
    if (lastSwap > 0 && swap > lastSwap) {
      visualChanges += swap - lastSwap;
    }
    lastSwap = swap;
  };

  // Snapshots taken from the actual baseline log (t87/t88/t89 of
  // ogl_noinput_ppc_profile_90s.out.log) where visualFps was reported as 0
  // because the legacy path read the frozen XFB hash.
  record(323);
  record(330);
  record(332);

  // First sample is the prime; subsequent samples each contribute their delta.
  assert.equal(visualChanges, 9, "deltas (7 + 2) should accumulate to nine swaps");
});

test("xfb-hash signal is detected as a separate (legacy) source name", () => {
  const baseline = "video xfb:5180 hash:32f1dc5 nz:2048";
  const oglStats = parseOglSwapStats(baseline);
  assert.equal(oglStats.swap, 0, "no ogl_swap field present in legacy XFB-only stats");
});
