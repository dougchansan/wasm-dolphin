import assert from "node:assert/strict";
import test from "node:test";

import {
  SYNTHETIC_COLORS,
  compareRgba,
  makeCheckerExpected,
  makeSolidExpected,
  makeTriangleExpected,
  readWebGpuSyntheticRequest,
  runWebGpuSyntheticDiagnostics
} from "../src/wgpu-synthetic-diagnostics.js";

test("WGPU synthetic route is absent unless its query gate is present", () => {
  assert.equal(readWebGpuSyntheticRequest("?presenter=webgpu"), null);
  assert.deepEqual(readWebGpuSyntheticRequest("?wgpu-synthetic&presenter=webgpu"), {
    mode: "all",
    presenter: "webgpu",
    rawMode: "all",
    valid: true
  });
  assert.equal(readWebGpuSyntheticRequest("?wgpu-synthetic=triangle").mode, "static-triangle");
  assert.equal(readWebGpuSyntheticRequest("?wgpu-synthetic=unknown").valid, false);
});

test("clear validation permits one 8-bit channel value and rejects two", () => {
  const expected = makeSolidExpected(2, 1, SYNTHETIC_COLORS.clear);
  const withinTolerance = new Uint8ClampedArray(expected);
  withinTolerance[0] += 1;
  assert.equal(compareRgba(withinTolerance, expected, { tolerance: 1 }).pass, true);

  const outsideTolerance = new Uint8ClampedArray(expected);
  outsideTolerance[0] += 2;
  const result = compareRgba(outsideTolerance, expected, { tolerance: 1 });
  assert.equal(result.pass, false);
  assert.equal(result.mismatchCount, 1);
  assert.equal(result.maxChannelDelta, 2);
});

test("static triangle oracle compares the full safe image and ignores only raster edges", () => {
  const expected = makeTriangleExpected(64, 64);
  const clean = compareRgba(expected.pixels, expected.pixels, { tolerance: 1, mask: expected.mask });
  assert.equal(clean.pass, true);
  assert.ok(clean.comparedPixels > 3000);

  const corrupted = new Uint8ClampedArray(expected.pixels);
  corrupted.set(SYNTHETIC_COLORS.background, (24 * 64 + 32) * 4);
  const result = compareRgba(corrupted, expected.pixels, { tolerance: 1, mask: expected.mask });
  assert.equal(result.pass, false);
  assert.equal(result.mismatchCount, 1);
});

test("checker oracle has exact alternating texels and catches a wrong upload", () => {
  const expected = makeCheckerExpected(64, 64);
  assert.deepEqual([...expected.subarray((4 * 64 + 4) * 4, (4 * 64 + 4) * 4 + 4)], SYNTHETIC_COLORS.checkerA);
  assert.deepEqual([...expected.subarray((4 * 64 + 12) * 4, (4 * 64 + 12) * 4 + 4)], SYNTHETIC_COLORS.checkerB);

  const corrupted = new Uint8ClampedArray(expected);
  corrupted.set(SYNTHETIC_COLORS.checkerA, (4 * 64 + 12) * 4);
  assert.equal(compareRgba(corrupted, expected, { tolerance: 1 }).pass, false);
});

test("route failures emit a stable classifier marker before touching a core", async () => {
  const request = readWebGpuSyntheticRequest("?wgpu-synthetic=route&presenter=webgpu");
  const result = await runWebGpuSyntheticDiagnostics({
    request,
    canvas: { getContext() { throw new Error("must not ask for a context without navigator.gpu"); } },
    gpu: null,
    constants: {},
    now: () => 1
  });
  assert.equal(result.status, "fail");
  assert.equal(result.classifier.code, "WEBGPU_API_UNAVAILABLE");
  assert.equal(result.classifier.stage, "route");
  assert.equal(result.classifier.marker, "WGPU_SYNTHETIC_CLASSIFIER:FAIL:WEBGPU_API_UNAVAILABLE:route");
});

test("non-WebGPU presenter is classified without requesting an adapter", async () => {
  const request = readWebGpuSyntheticRequest("?wgpu-synthetic=all&presenter=webgl");
  let adapterRequested = false;
  const result = await runWebGpuSyntheticDiagnostics({
    request,
    canvas: { getContext() { return {}; } },
    gpu: { requestAdapter() { adapterRequested = true; } },
    constants: {},
    now: () => 1
  });
  assert.equal(result.classifier.code, "PRESENTER_ROUTE_MISMATCH");
  assert.equal(adapterRequested, false);
});
