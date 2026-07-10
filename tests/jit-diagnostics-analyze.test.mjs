import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  classifyCorrelatedSlice,
  classifyDvdCompletionProfile,
  classifyJitDiagnostics,
  findMostDiagnosticTimingProfile,
  findMostDiagnosticHelper,
  parseCorrelatedSliceTuple,
  parseDvdCompletionProfile,
  parseJitHelperStats,
  parseSlicePhaseProfile,
  parseSlowCoreTimingEvents,
  parseThrottleSiteProfiles,
  selectMostDiagnosticCorrelatedSlice,
  validateDvdCompletionProfile,
  validateSliceThrottleAttribution,
  validateThrottleSiteProfile
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
    worstDvdCompletion: null,
    throttleSites: [],
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

test("parses coherent DVD completion and throttle-site profiles", () => {
  const structured =
    "dvdprof:v=1,total=16059,map=8,wait=15500,pop=31,copy=210,finish=88,other=222,bytes=32768,loops=2 " +
    "throttleprof:v=1,site=vi-end-field,count=10,slow=8,total=320000,max=48000,requested=47500,overshoot=500 " +
    "throttleprof:v=1,site=vi-si-poll,count=12,slow=9,total=390000,max=57235,requested=56800,overshoot=435";

  assert.deepEqual(parseDvdCompletionProfile(structured), {
    schemaVersion: 1,
    totalUs: 16059,
    mapUs: 8,
    queueWaitUs: 15500,
    queuePopUs: 31,
    ramCopyUs: 210,
    commandFinishUs: 88,
    otherUs: 222,
    bytes: 32768,
    queueLoops: 2
  });
  assert.deepEqual(parseThrottleSiteProfiles(structured), [
    {
      schemaVersion: 1,
      site: "vi-end-field",
      count: 10,
      slowCount: 8,
      totalActualUs: 320000,
      maxActualUs: 48000,
      requestedAtMaxUs: 47500,
      overshootAtMaxUs: 500
    },
    {
      schemaVersion: 1,
      site: "vi-si-poll",
      count: 12,
      slowCount: 9,
      totalActualUs: 390000,
      maxActualUs: 57235,
      requestedAtMaxUs: 56800,
      overshootAtMaxUs: 435
    }
  ]);
  const helperStats = parseJitHelperStats(structured);
  assert.equal(helperStats.worstDvdCompletion.queueWaitUs, 15500);
  assert.equal(helperStats.throttleSites.length, 2);
  assert.equal(classifyDvdCompletionProfile(structured).owner, "queue-wait");
});

test("retains causal phase attribution on the exact winning slice", () => {
  const compact =
    "sliceprof:total=48015,advance=47990,execute=25,compile=0,throttle=47755,dvd=0,video=210,event=VICallback " +
    "slicephase:v=1,throttlesite=vi-end-field,throttlesiteus=47755,throttlemax=47755,requested=47500,overshoot=255," +
    "dvdtotal=0,dvdmap=0,dvdwait=0,dvdpop=0,dvdcopy=0,dvdfinish=0,dvdother=0,dvdbytes=0,dvdloops=0";
  assert.deepEqual(parseSlicePhaseProfile(compact), {
    schemaVersion: 1,
    throttleSite: "vi-end-field",
    throttleSiteUs: 47755,
    throttleMaxUs: 47755,
    throttleRequestedUs: 47500,
    throttleOvershootUs: 255,
    dvdCompletion: null
  });

  const parsed = parseCorrelatedSliceTuple(compact);
  assert.equal(parsed.throttleSite, "vi-end-field");
  assert.equal(parsed.throttleSiteUs, 47755);
  const classified = classifyCorrelatedSlice(parsed);
  assert.equal(classified.owner, "pacing-wait");
  assert.equal(classified.ownerDetail, "pacing-wait:vi-end-field");
  assert.equal(classified.causalAttribution.throttle.valid, true);
  assert.equal(classified.causalAttribution.dvdCompletion, null);

  const staleTupleWithoutPhase = {
    totalUs: 48015,
    advanceUs: 47990,
    executeUs: 25,
    compileUs: 0,
    throttleWaitUs: 47755,
    dvdWaitUs: 0,
    videoWorkUs: 210,
    event: "VICallback"
  };
  assert.equal(
    selectMostDiagnosticCorrelatedSlice(staleTupleWithoutPhase, compact).throttleSite,
    "vi-end-field"
  );
  assert.equal(
    classifyJitDiagnostics(compact, "", staleTupleWithoutPhase)
      .longSliceClassification.ownerDetail,
    "pacing-wait:vi-end-field"
  );
});

test("retains a coherent DVD phase tuple from the exact winning slice", () => {
  const compact =
    "sliceprof:total=16080,advance=16070,execute=10,compile=0,throttle=0,dvd=15500,video=0,event=FinishReadDVDThread " +
    "slicephase:v=1,throttlesite=none,throttlesiteus=0,throttlemax=0,requested=0,overshoot=0," +
    "dvdtotal=16059,dvdmap=8,dvdwait=15500,dvdpop=31,dvdcopy=210,dvdfinish=88,dvdother=222,dvdbytes=32768,dvdloops=2";
  const classified = classifyCorrelatedSlice(compact);
  assert.equal(classified.owner, "dvd-io-wait");
  assert.equal(classified.ownerDetail, "dvd-io-wait:queue-wait");
  assert.equal(classified.causalAttribution.throttle, null);
  assert.equal(classified.causalAttribution.dvdCompletion.valid, true);
  assert.equal(classified.causalAttribution.dvdCompletion.phaseSumUs, 16059);

  const mismatched = classifyCorrelatedSlice(compact.replace("dvd=15500", "dvd=15499"));
  assert.equal(mismatched.causalAttribution.dvdCompletion.owner, "invalid");
  assert.deepEqual(mismatched.causalAttribution.dvdCompletion.validationErrors, [
    "queue-wait-does-not-match-slice"
  ]);
});

test("rejects inconsistent DVD and throttle tuples instead of assigning ownership", () => {
  const invalidDvd = {
    schemaVersion: 1,
    totalUs: 100,
    mapUs: 20,
    queueWaitUs: 90,
    queuePopUs: 0,
    ramCopyUs: 0,
    commandFinishUs: 0,
    otherUs: 0,
    bytes: 0,
    queueLoops: 1
  };
  assert.deepEqual(validateDvdCompletionProfile(invalidDvd).errors, ["phase-sum-mismatch"]);
  assert.equal(classifyDvdCompletionProfile(invalidDvd).owner, "invalid");

  const invalidAggregateThrottle = validateThrottleSiteProfile({
    schemaVersion: 1,
    site: "vi-end-field",
    count: 1,
    slowCount: 2,
    totalActualUs: 40,
    maxActualUs: 50,
    requestedAtMaxUs: 45,
    overshootAtMaxUs: 0
  });
  assert.equal(invalidAggregateThrottle.valid, false);
  assert.deepEqual(invalidAggregateThrottle.validationErrors, [
    "slow-count-exceeds-count",
    "max-exceeds-total",
    "max-request-overshoot-mismatch"
  ]);

  const invalidSliceThrottle = validateSliceThrottleAttribution({
    throttleWaitUs: 40,
    throttleSite: "vi-si-poll",
    throttleSiteUs: 50,
    throttleMaxUs: 50,
    throttleRequestedUs: 45,
    throttleOvershootUs: 0
  });
  assert.equal(invalidSliceThrottle.valid, false);
  assert.deepEqual(invalidSliceThrottle.validationErrors, [
    "site-total-exceeds-slice-total",
    "max-request-overshoot-mismatch"
  ]);
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
  assert.equal(result.schemaVersion, 4);
  assert.equal(result.longSliceClassification.owner, "pacing-wait");
  assert.equal(result.longSliceClassification.source, "structured-correlated-slice");
  assert.equal(result.longSliceClassification.dominantDurationUs, 47755);
  assert.equal(result.longSliceClassification.correlatedSlice.event, "vi-end-field");
});

test("classifies a CoreTiming Advance spike independently from JIT compilation", () => {
  const result = classifyJitDiagnostics(helper, "[ct-slow-event] name=VICallback us=59059");
  assert.equal(result.schemaVersion, 4);
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
