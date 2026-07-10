import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  classifyJitDiagnostics,
  findMostDiagnosticHelper,
  parseJitHelperStats,
  parseSlowCoreTimingEvents
} from "../tools/jit-diagnostics-analyze.mjs";

const helper = "tier:guarded emitfail:8 compilefail:0 " +
  "modcompile:119837us/max1015us modinst:19716us/max74us " +
  "smearcompile:rej1291/maxN8/maxUs1264 " +
  "runloop:2249456slices/avg28us/max59204us/runOnlyMax59204us/advMax59139us/execMax4164us " +
  "emitkey31/202:8@80123456";

test("parses classified emit failures and split runloop timing", () => {
  assert.deepEqual(parseJitHelperStats(helper), {
    emitFailureCount: 8,
    compileFailureCount: 0,
    moduleCompileMaxUs: 1015,
    moduleInstantiateMaxUs: 74,
    compileBurstMaxCount: 8,
    compileBurstMaxUs: 1264,
    runloop: {
      sliceCount: 2249456,
      averageUs: 28,
      maxUs: 59204,
      runOnlyMaxUs: 59204,
      advanceMaxUs: 59139,
      executeMaxUs: 4164
    },
    emitFailureKeys: [{ opcode: 31, subop10: 202, count: 8, samplePc: "0x80123456" }]
  });
});

test("deduplicates mirrored worker console slow-event lines", () => {
  const consoleText = [
    "[worker:core.js:log] [ct-slow-event] name=VICallback us=59059",
    "[log] [ct-slow-event] name=VICallback us=59059",
    "[worker:core.js:log] [ct-slow-event] name=VICallback us=42000",
    "[log] [ct-slow-event] name=VICallback us=42000",
    "[worker:core.js:log] [ct-slow-event] name=FinishReadDVDThread us=15899",
    "[log] [ct-slow-event] name=FinishReadDVDThread us=15899"
  ].join("\n");
  assert.deepEqual(parseSlowCoreTimingEvents(consoleText), [
    { name: "VICallback", count: 2, averageUs: 50529.5, p95Us: 59059, maxUs: 59059 },
    { name: "FinishReadDVDThread", count: 1, averageUs: 15899, p95Us: 15899, maxUs: 15899 }
  ]);
});

test("classifies a CoreTiming Advance spike independently from JIT compilation", () => {
  const result = classifyJitDiagnostics(helper, "[ct-slow-event] name=VICallback us=59059");
  assert.equal(result.emitFailureClassification.complete, true);
  assert.equal(result.longSliceClassification.owner, "core-timing-advance");
  assert.equal(result.longSliceClassification.topSlowEvent.name, "VICallback");
});

test("selects the helper carrying the strongest final diagnostics", () => {
  assert.equal(findMostDiagnosticHelper({ samples: [{ helper: "emitfail:0" }, { helper }] }), helper);
});

test("active JIT source disables no emitter at compile time and records failure keys", () => {
  const patch = readFileSync("patches/dolphin-wasm/snapshot/0010-jit-emit-diagnostics.patch", "utf8");
  assert.match(patch, /^-#define DOLPHIN_WEB_DISABLE_FASTOTHER_31ADDZEX_ALONE/m);
  assert.match(patch, /^\+\/\/ #define DOLPHIN_WEB_DISABLE_FASTOTHER_31ADDZEX_ALONE/m);
  assert.match(patch, /emitkey/);
  assert.match(patch, /s_wasm_emit_fail_key_counts\[key\]/);
});
