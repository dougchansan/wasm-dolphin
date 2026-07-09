import assert from "node:assert/strict";
import test from "node:test";

import { parseProfileMetrics, recordsToCsv } from "../tools/perf-artifacts.mjs";

test("profile parser separates core, XFB, publish, and JS presentation costs", () => {
  const helper =
    "video xfb:10 coreprof xfb_dt:16.7 avg:17.1 max:41.2 decode:1.3 avg:1.4 max:2.8 " +
    "vo_sync:0.1/max4.2 vo_pub:1.5/max3.1 vo_total:1.6/max5.0 " +
    "swxfb:0.9 conv:0.8 copy:0.1 sz:640x480->480 | jit:on";
  const frame =
    "loop:0.35 pump:0.02 run:0.10 api:0.03 cap:0.50 copy:0.40 " +
    "present:1.90 draw:1.20 hash:0.08 paced:0.04 copy:73.2MB/s cap:30 shown:29";

  assert.deepEqual(parseProfileMetrics(helper, frame), {
    coreXfbIntervalMs: 16.7,
    coreXfbAverageIntervalMs: 17.1,
    coreXfbMaxIntervalMs: 41.2,
    coreXfbDecodeMs: 1.3,
    coreXfbAverageDecodeMs: 1.4,
    coreXfbMaxDecodeMs: 2.8,
    videoOutputSyncMs: 0.1,
    videoOutputMaxSyncMs: 4.2,
    videoOutputPublishMs: 1.5,
    videoOutputMaxPublishMs: 3.1,
    videoOutputTotalMs: 1.6,
    videoOutputMaxTotalMs: 5,
    softwareXfbTotalMs: 0.9,
    softwareXfbConvertMs: 0.8,
    softwareXfbCopyMs: 0.1,
    jsLoopMs: 0.35,
    jsPumpMs: 0.02,
    jsRunMs: 0.1,
    jsApiMs: 0.03,
    jsCaptureMs: 0.5,
    jsCopyMs: 0.4,
    jsPresentMs: 1.9,
    jsDrawMs: 1.2,
    jsHashMs: 0.08,
    jsPacedMs: 0.04,
    jsCopyMegabytesPerSecond: 73.2,
    jsCaptureCount: 30,
    jsPresentCount: 29,
  });
});

test("profile parser uses nulls when a backend does not emit a profile", () => {
  const parsed = parseProfileMetrics("jit:warmup", "-");
  assert.equal(parsed.coreXfbIntervalMs, null);
  assert.equal(parsed.softwareXfbTotalMs, null);
  assert.equal(parsed.jsPresentMs, null);
});

test("CSV output preserves arrays, commas, quotes, and newlines", () => {
  const csv = recordsToCsv([
    { run: 1, note: 'hello, "GPU"', histogram: [1, 2] },
    { run: 2, note: "line1\nline2", histogram: null },
  ]);
  assert.equal(
    csv,
    'run,note,histogram\n1,"hello, ""GPU""","[1,2]"\n2,"line1\nline2",\n'
  );
});
