import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const coreJs = new URL("../cores/dolphin/dolphin-core-upstream.js", import.meta.url);
const coreWasm = new URL("../cores/dolphin/dolphin-core-upstream.wasm", import.meta.url);

function encodeDForm(opcd, rdOrRs, ra, immediate) {
  return ((opcd << 26) | (rdOrRs << 21) | (ra << 16) | (immediate & 0xffff)) >>> 0;
}

function encodeXForm(opcd, rs, ra, rb, xo, rc = false) {
  return ((opcd << 26) | (rs << 21) | (ra << 16) | (rb << 11) | (xo << 1) | (rc ? 1 : 0)) >>> 0;
}

function encodeAForm(opcd, fd, fa, fb, fc, xo, rc = false) {
  return (
    ((opcd << 26) | (fd << 21) | (fa << 16) | (fb << 11) | (fc << 6) | (xo << 1) | (rc ? 1 : 0)) >>>
    0
  );
}

function encodeBc(bo, bi, displacement, aa = false, lk = false) {
  return (
    ((16 << 26) |
      (bo << 21) |
      (bi << 16) |
      (displacement & 0xfffc) |
      (aa ? 2 : 0) |
      (lk ? 1 : 0)) >>>
    0
  );
}

function encodeFloatCompare(crfd, fa, fb, xo, rc = false) {
  return ((63 << 26) | (crfd << 23) | (fa << 16) | (fb << 11) | (xo << 1) | (rc ? 1 : 0)) >>> 0;
}

test("upstream full core can execute a generated WASM JIT smoke function", async (t) => {
  if (!existsSync(coreJs) || !existsSync(coreWasm)) {
    t.skip("upstream full core has not been built");
    return;
  }

  const { default: createDolphinCore } = await import(coreJs);
  const module = await createDolphinCore({
    wasmBinary: readFileSync(coreWasm),
    noInitialRun: true
  });

  const runWasmJitSmoke = module.cwrap("RunWasmJitSmoke", "number", ["number"]);
  assert.equal(runWasmJitSmoke(100), 142);
  assert.equal(runWasmJitSmoke(-50), -8);
});

test("upstream full core can emit and execute a PPC-style addi WASM module", async (t) => {
  if (!existsSync(coreJs) || !existsSync(coreWasm)) {
    t.skip("upstream full core has not been built");
    return;
  }

  const { default: createDolphinCore } = await import(coreJs);
  const module = await createDolphinCore({
    wasmBinary: readFileSync(coreWasm),
    noInitialRun: true
  });

  const runPpcWasmAddiSmoke = module.cwrap("RunPpcWasmAddiSmoke", "number", ["number", "number"]);
  assert.equal(runPpcWasmAddiSmoke(100, 23), 123);
  assert.equal(runPpcWasmAddiSmoke(100, -12), 88);
});

test("upstream full core can execute a generated addi module over shared WASM memory", async (t) => {
  if (!existsSync(coreJs) || !existsSync(coreWasm)) {
    t.skip("upstream full core has not been built");
    return;
  }

  const { default: createDolphinCore } = await import(coreJs);
  const module = await createDolphinCore({
    wasmBinary: readFileSync(coreWasm),
    noInitialRun: true
  });

  const runPpcWasmStateAddiSmoke = module.cwrap("RunPpcWasmStateAddiSmoke", "number", [
    "number",
    "number"
  ]);
  assert.equal(runPpcWasmStateAddiSmoke(0x1000, 0x24), 0x1024);
  assert.equal(runPpcWasmStateAddiSmoke(0x1000, -0x20), 0x0fe0);
});

test("upstream full core can execute generated addi against Dolphin PowerPCState", async (t) => {
  if (!existsSync(coreJs) || !existsSync(coreWasm)) {
    t.skip("upstream full core has not been built");
    return;
  }

  const { default: createDolphinCore } = await import(coreJs);
  const module = await createDolphinCore({
    wasmBinary: readFileSync(coreWasm),
    noInitialRun: true
  });

  const runPpcWasmDolphinStateAddiSmoke = module.cwrap("RunPpcWasmDolphinStateAddiSmoke", "number", [
    "number",
    "number"
  ]);
  assert.equal(runPpcWasmDolphinStateAddiSmoke(0x2000, 0x34), 0x2034);
  assert.equal(runPpcWasmDolphinStateAddiSmoke(0x2000, -0x40), 0x1fc0);
});

test("upstream full core can execute a generated PPC integer block against Dolphin state", async (t) => {
  if (!existsSync(coreJs) || !existsSync(coreWasm)) {
    t.skip("upstream full core has not been built");
    return;
  }

  const { default: createDolphinCore } = await import(coreJs);
  const module = await createDolphinCore({
    wasmBinary: readFileSync(coreWasm),
    noInitialRun: true
  });

  const runPpcWasmIntegerBlockSmoke = module.cwrap("RunPpcWasmIntegerBlockSmoke", "number", []);
  assert.equal(runPpcWasmIntegerBlockSmoke(), 1);
});

test("upstream full core guards risky PPC WASM JIT op tiers", async (t) => {
  if (!existsSync(coreJs) || !existsSync(coreWasm)) {
    t.skip("upstream full core has not been built");
    return;
  }

  const { default: createDolphinCore } = await import(coreJs);
  const module = await createDolphinCore({
    wasmBinary: readFileSync(coreWasm),
    noInitialRun: true
  });

  const isDirectCandidate = module.cwrap("TestPpcWasmDirectCandidate", "number", ["number"]);
  const directCandidateCompiles = module.cwrap("TestPpcWasmDirectCandidateCompiles", "number", [
    "number"
  ]);
  const runMultipleWordMemorySmoke = module.cwrap("RunPpcWasmMultipleWordMemorySmoke", "number", []);
  const runSinglePrecisionArithmeticSmoke = module.cwrap(
    "RunPpcWasmSinglePrecisionArithmeticSmoke",
    "number",
    []
  );
  const runPairedQuantizedMemorySmoke = module.cwrap("RunPpcWasmPairedQuantizedMemorySmoke", "number", []);
  const runFloatCompareSmoke = module.cwrap("RunPpcWasmFloatCompareSmoke", "number", []);
  const detectDcbxLoop = module.cwrap("TestDcbxLoopPattern", "number", [
    "number",
    "number",
    "number",
    "number"
  ]);

  const accepted = [
    encodeDForm(14, 3, 0, 0x1234), // addi r3, r0, 0x1234
    encodeDForm(32, 3, 4, 0x20), // lwz r3, 0x20(r4)
    encodeDForm(36, 3, 4, 0x20), // stw r3, 0x20(r4)
    encodeDForm(46, 18, 1, 0), // lmw r18, 0(r1)
    encodeDForm(47, 18, 1, 0), // stmw r18, 0(r1)
    encodeXForm(31, 3, 4, 5, 444), // or r4, r3, r5
    encodeDForm(48, 3, 4, 0x20), // lfs f3, 0x20(r4)
    encodeDForm(52, 3, 4, 0x20), // stfs f3, 0x20(r4)
    encodeDForm(56, 1, 2, 0), // psq_l f1, 0(r2), 0, qr0
    encodeDForm(57, 1, 2, 0), // psq_lu f1, 0(r2), 0, qr0
    encodeDForm(60, 1, 2, 0), // psq_st f1, 0(r2), 0, qr0
    encodeDForm(61, 1, 2, 0), // psq_stu f1, 0(r2), 0, qr0
    encodeAForm(59, 1, 2, 3, 4, 20), // fsubsx f1, f2, f3
    encodeAForm(59, 1, 2, 3, 4, 21), // faddsx f1, f2, f3
    encodeAForm(59, 1, 2, 3, 4, 25), // fmulsx f1, f2, f4
    encodeAForm(59, 1, 2, 3, 4, 29), // fmaddsx f1, f2, f4, f3
    encodeFloatCompare(1, 2, 3, 0), // fcmpu cr1, f2, f3
    encodeFloatCompare(1, 2, 3, 32), // fcmpo cr1, f2, f3
    encodeXForm(63, 1, 0, 2, 72), // fmr f1, f2
    encodeXForm(31, 3, 4, 5, 535), // lfsx f3, r4, r5
    encodeXForm(31, 3, 4, 5, 663) // stfsx f3, r4, r5
  ];
  for (const inst of accepted) {
    assert.equal(isDirectCandidate(inst), 1);
    assert.equal(directCandidateCompiles(inst), 1);
  }

  const rejected = [
    encodeAForm(59, 1, 2, 3, 4, 29, true), // fmaddsx. is still outside direct tier
    encodeFloatCompare(1, 2, 3, 0, true), // fcmpu. is still outside direct tier
    encodeAForm(63, 1, 2, 3, 4, 21), // double-precision faddx stays helper-only
    encodeDForm(57, 1, 0, 0), // psq_lu with r0 update is invalid for direct tier
    encodeDForm(61, 1, 0, 0), // psq_stu with r0 update is invalid for direct tier
    encodeXForm(63, 1, 0, 2, 72, true) // fmr. is not a specialized path
  ];
  for (const inst of rejected) {
    assert.equal(isDirectCandidate(inst), 0);
    assert.equal(directCandidateCompiles(inst), 0);
  }

  assert.equal(runMultipleWordMemorySmoke(), 1);
  assert.equal(runSinglePrecisionArithmeticSmoke(), 1);
  assert.equal(runPairedQuantizedMemorySmoke(), 1);
  assert.equal(runFloatCompareSmoke(), 1);

  const dcbfR0R3 = encodeXForm(31, 0, 0, 3, 86);
  const dcbiR0R3 = encodeXForm(31, 0, 0, 3, 470);
  const addiR3R3Line = encodeDForm(14, 3, 3, 32);
  const addicDotR4R4Line = encodeDForm(13, 4, 4, -32);
  assert.equal(detectDcbxLoop(dcbfR0R3, addiR3R3Line, encodeBc(16, 0, -8), 0), 1);
  assert.equal(detectDcbxLoop(dcbfR0R3, addiR3R3Line, encodeBc(17, 0, -8), 0), 1);
  assert.equal(detectDcbxLoop(dcbiR0R3, addiR3R3Line, addicDotR4R4Line, encodeBc(12, 1, -12)), 2);
  assert.equal(detectDcbxLoop(dcbiR0R3, addiR3R3Line, addicDotR4R4Line, encodeBc(13, 1, -12)), 2);
  assert.equal(detectDcbxLoop(dcbiR0R3, addiR3R3Line, addicDotR4R4Line, encodeBc(4, 1, -12)), 0);
});
