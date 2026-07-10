import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  classifyCorrelatedSlice,
  classifyJitDiagnostics,
  findMostDiagnosticTimingProfile,
  findMostDiagnosticHelper,
  parseCorrelatedSliceTuple,
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
    worstSlice: null,
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

test("deduplicates partially mirrored legacy logs without dropping main-only events", () => {
  const consoleText = [
    "[worker:core.js:log] [ct-slow-event] name=VICallback us=47000",
    "[log] [ct-slow-event] name=VICallback us=47000",
    "[worker:core.js:log] [ct-slow-event] name=VICallback us=47000",
    "[log] [ct-slow-event] name=FinishReadDVDThread us=12000"
  ].join("\n");
  assert.deepEqual(parseSlowCoreTimingEvents(consoleText), [
    { name: "VICallback", count: 2, averageUs: 47000, p95Us: 47000, maxUs: 47000 },
    { name: "FinishReadDVDThread", count: 1, averageUs: 12000, p95Us: 12000, maxUs: 12000 }
  ]);
});

test("parses a correlated worst-slice tuple from the structured timing profile", () => {
  const profile = {
    schemaVersion: 1,
    runloop: {
      max: {
        totalUs: 48015,
        advanceUs: 47990,
        executeUs: 25,
        compileUs: 0,
        throttleWaitUs: 47755,
        dvdWaitUs: 0,
        videoWorkUs: 1274,
        event: "vi-end-field"
      }
    }
  };
  assert.deepEqual(parseCorrelatedSliceTuple(profile), {
    totalUs: 48015,
    advanceUs: 47990,
    executeUs: 25,
    compileUs: 0,
    throttleWaitUs: 47755,
    dvdWaitUs: 0,
    videoWorkUs: 1274,
    event: "vi-end-field"
  });
  assert.deepEqual(findMostDiagnosticTimingProfile({ samples: [{ coreTimingProfile: profile }] }),
    parseCorrelatedSliceTuple(profile));
});

test("parses the metrics-gated compact worst-slice tuple emitted by the core", () => {
  const compact = "tier:guarded sliceprof:total=48015,advance=47990,execute=25," +
    "compile=0,throttle=47755,dvd=0,video=210,event=VICallback reject:0";
  const expected = {
    totalUs: 48015,
    advanceUs: 47990,
    executeUs: 25,
    compileUs: 0,
    throttleWaitUs: 47755,
    dvdWaitUs: 0,
    videoWorkUs: 210,
    event: "VICallback"
  };
  assert.deepEqual(parseCorrelatedSliceTuple(compact), expected);
  assert.deepEqual(parseJitHelperStats(compact).worstSlice, expected);
  assert.deepEqual(findMostDiagnosticTimingProfile({ samples: [{ helper: compact }] }), expected);
  assert.equal(classifyJitDiagnostics(compact).longSliceClassification.owner, "pacing-wait");
});

test("classifies non-overlapping correlated timing components", () => {
  const cases = [
    ["pacing-wait", { totalUs: 48015, throttleWaitUs: 47755 }],
    ["dvd-io-wait", { totalUs: 16000, dvdWaitUs: 15000 }],
    ["video-work", { totalUs: 10000, videoWorkUs: 8500 }],
    ["cpu-block-execution", { totalUs: 5000, executeUs: 4200 }],
    ["jit-compile", { totalUs: 2000, compileUs: 1800 }],
    ["mixed", { totalUs: 10000, throttleWaitUs: 4000, executeUs: 3500, videoWorkUs: 2000 }]
  ];
  for (const [expected, tuple] of cases) {
    assert.equal(classifyCorrelatedSlice(tuple).owner, expected);
  }
});

test("structured correlated timing takes precedence over independent legacy maxima", () => {
  const correlated = {
    totalUs: 48015,
    advanceUs: 47990,
    executeUs: 25,
    compileUs: 0,
    throttleWaitUs: 47755,
    dvdWaitUs: 0,
    videoWorkUs: 1274,
    event: "vi-end-field"
  };
  const result = classifyJitDiagnostics(helper, "[ct-slow-event] name=VICallback us=59059", correlated);
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.longSliceClassification.owner, "pacing-wait");
  assert.equal(result.longSliceClassification.source, "structured-correlated-slice");
  assert.equal(result.longSliceClassification.dominantDurationUs, 47755);
  assert.equal(result.longSliceClassification.correlatedSlice.event, "vi-end-field");
});

test("classifies a CoreTiming Advance spike independently from JIT compilation", () => {
  const result = classifyJitDiagnostics(helper, "[ct-slow-event] name=VICallback us=59059");
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.emitFailureClassification.complete, true);
  assert.equal(result.longSliceClassification.owner, "core-timing-advance");
  assert.equal(result.longSliceClassification.source, "legacy-independent-maxima");
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
