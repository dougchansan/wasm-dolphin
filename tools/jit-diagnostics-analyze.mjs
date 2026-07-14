import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const CORRELATED_SLICE_DOMINANCE_THRESHOLD = 0.8;

export function parseFallbackMapStats(value) {
  const text = String(value || "");
  const match = /\bfbmap:hit\/empty\/collision\/found\/missing:(\d+)\/(\d+)\/(\d+)\/(\d+)\/(\d+)/.exec(text);
  if (!match) {
    return /\bfbmap:off\b/.test(text)
      ? { status: "off", enabled: false }
      : { status: "unavailable", enabled: null };
  }

  const hit = Number(match[1]);
  const emptyMiss = Number(match[2]);
  const collisionMiss = Number(match[3]);
  const slowFound = Number(match[4]);
  const slowMissing = Number(match[5]);
  const dispatchCount = hit + emptyMiss + collisionMiss;
  const slowLookupCount = slowFound + slowMissing;
  const directMissCount = emptyMiss + collisionMiss;
  return {
    status: "enabled",
    enabled: true,
    hit,
    emptyMiss,
    collisionMiss,
    slowFound,
    slowMissing,
    dispatchCount,
    slowLookupCount,
    collisionRate: dispatchCount ? collisionMiss / dispatchCount : 0,
    slowLookupRate: dispatchCount ? slowLookupCount / dispatchCount : 0,
    slowFoundRate: slowLookupCount ? slowFound / slowLookupCount : 0,
    internallyConsistent: directMissCount === slowLookupCount,
  };
}

export function parseJitHelperStats(helper) {
  const text = String(helper || "");
  const runloop = /\brunloop:(\d+)slices\/avg(\d+)us\/max(\d+)us\/runOnlyMax(\d+)us\/advMax(\d+)us\/execMax(\d+)us/.exec(text);
  const result = {
    emitFailureCount: integerMatch(text, /\bemitfail:(\d+)/),
    compileFailureCount: integerMatch(text, /\bcompilefail:(\d+)/),
    moduleCompileMaxUs: integerMatch(text, /\bmodcompile:\d+us\/max(\d+)us/),
    moduleInstantiateMaxUs: integerMatch(text, /\bmodinst:\d+us\/max(\d+)us/),
    compileBurstMaxCount: integerMatch(text, /\bsmearcompile:rej\d+\/maxN(\d+)/),
    compileBurstMaxUs: integerMatch(text, /\bsmearcompile:rej\d+\/maxN\d+\/maxUs(\d+)/),
    worstSlice: parseCorrelatedSliceTuple(text),
    worstDvdCompletion: parseDvdCompletionProfile(text),
    throttleSites: parseThrottleSiteProfiles(text),
    fallbackMap: parseFallbackMapStats(text),
    runloop: runloop ? {
      sliceCount: Number(runloop[1]),
      averageUs: Number(runloop[2]),
      maxUs: Number(runloop[3]),
      runOnlyMaxUs: Number(runloop[4]),
      advanceMaxUs: Number(runloop[5]),
      executeMaxUs: Number(runloop[6])
    } : null,
    emitFailureKeys: []
  };

  for (const match of text.matchAll(/\bemitkey(\d+)\/(\d+):(\d+)(?:@([0-9a-f]+))?/gi)) {
    result.emitFailureKeys.push({
      opcode: Number(match[1]),
      subop10: Number(match[2]),
      count: Number(match[3]),
      samplePc: match[4] ? `0x${match[4].toLowerCase()}` : null
    });
  }
  return result;
}

export function parseDvdCompletionProfile(value) {
  const match = /\bdvdprof:v=(\d+),total=(\d+),map=(\d+),wait=(\d+),pop=(\d+),copy=(\d+),finish=(\d+),other=(\d+),bytes=(\d+),loops=(\d+)/.exec(
    String(value || "")
  );
  if (!match || Number(match[2]) <= 0) return null;
  return {
    schemaVersion: Number(match[1]),
    totalUs: Number(match[2]),
    mapUs: Number(match[3]),
    queueWaitUs: Number(match[4]),
    queuePopUs: Number(match[5]),
    ramCopyUs: Number(match[6]),
    commandFinishUs: Number(match[7]),
    otherUs: Number(match[8]),
    bytes: Number(match[9]),
    queueLoops: Number(match[10])
  };
}

export function parseThrottleSiteProfiles(value) {
  const profiles = [];
  for (const match of String(value || "").matchAll(
    /\bthrottleprof:v=(\d+),site=([^,\s]+),count=(\d+),slow=(\d+),total=(\d+),max=(\d+),requested=(\d+),overshoot=(-?\d+)/g
  )) {
    profiles.push({
      schemaVersion: Number(match[1]),
      site: match[2],
      count: Number(match[3]),
      slowCount: Number(match[4]),
      totalActualUs: Number(match[5]),
      maxActualUs: Number(match[6]),
      requestedAtMaxUs: Number(match[7]),
      overshootAtMaxUs: Number(match[8])
    });
  }
  return profiles;
}

export function parseSlicePhaseProfile(value) {
  const match = /\bslicephase:v=(\d+),throttlesite=([^,\s]+),throttlesiteus=(\d+),throttlemax=(\d+),requested=(\d+),overshoot=(-?\d+),dvdtotal=(\d+),dvdmap=(\d+),dvdwait=(\d+),dvdpop=(\d+),dvdcopy=(\d+),dvdfinish=(\d+),dvdother=(\d+),dvdbytes=(\d+),dvdloops=(\d+)/.exec(
    String(value || "")
  );
  if (!match) return null;
  const dvdTotalUs = Number(match[7]);
  return {
    schemaVersion: Number(match[1]),
    throttleSite: match[2] === "none" ? null : match[2],
    throttleSiteUs: Number(match[3]),
    throttleMaxUs: Number(match[4]),
    throttleRequestedUs: Number(match[5]),
    throttleOvershootUs: Number(match[6]),
    dvdCompletion: dvdTotalUs > 0 ? {
      schemaVersion: Number(match[1]),
      totalUs: dvdTotalUs,
      mapUs: Number(match[8]),
      queueWaitUs: Number(match[9]),
      queuePopUs: Number(match[10]),
      ramCopyUs: Number(match[11]),
      commandFinishUs: Number(match[12]),
      otherUs: Number(match[13]),
      bytes: Number(match[14]),
      queueLoops: Number(match[15])
    } : null
  };
}

export function validateDvdCompletionProfile(value) {
  const profile = typeof value === "string" ? parseDvdCompletionProfile(value) : value;
  if (!profile?.totalUs) return null;
  const componentKeys = [
    "mapUs",
    "queueWaitUs",
    "queuePopUs",
    "ramCopyUs",
    "commandFinishUs",
    "otherUs"
  ];
  const errors = [];
  for (const key of [...componentKeys, "totalUs", "bytes", "queueLoops"]) {
    if (!Number.isSafeInteger(profile[key]) || profile[key] < 0) errors.push(`${key}-invalid`);
  }
  const phaseSumUs = componentKeys.reduce((sum, key) => sum + nonNegativeNumber(profile[key]), 0);
  if (phaseSumUs !== profile.totalUs) errors.push("phase-sum-mismatch");
  return { valid: errors.length === 0, errors, phaseSumUs, profile };
}

export function validateThrottleSiteProfile(profile) {
  if (!profile) return null;
  const errors = [];
  for (const key of [
    "count",
    "slowCount",
    "totalActualUs",
    "maxActualUs",
    "requestedAtMaxUs"
  ]) {
    if (!Number.isSafeInteger(profile[key]) || profile[key] < 0) errors.push(`${key}-invalid`);
  }
  if (!Number.isSafeInteger(profile.overshootAtMaxUs)) errors.push("overshootAtMaxUs-invalid");
  if (profile.slowCount > profile.count) errors.push("slow-count-exceeds-count");
  if (profile.maxActualUs > profile.totalActualUs) errors.push("max-exceeds-total");
  if (profile.count === 0 && (profile.totalActualUs !== 0 || profile.maxActualUs !== 0)) {
    errors.push("empty-profile-has-duration");
  }
  if (profile.maxActualUs !== profile.requestedAtMaxUs + profile.overshootAtMaxUs) {
    errors.push("max-request-overshoot-mismatch");
  }
  return { ...profile, valid: errors.length === 0, validationErrors: errors };
}

export function validateSliceThrottleAttribution(slice) {
  if (!slice) return null;
  const hasAttribution = slice.throttleSite || slice.throttleSiteUs || slice.throttleMaxUs ||
    slice.throttleRequestedUs || slice.throttleOvershootUs;
  if (!hasAttribution) return null;
  const errors = [];
  if (!["vi-end-field", "vi-si-poll"].includes(slice.throttleSite)) {
    errors.push("throttle-site-invalid");
  }
  for (const key of ["throttleSiteUs", "throttleMaxUs", "throttleRequestedUs"]) {
    if (!Number.isSafeInteger(slice[key]) || slice[key] < 0) errors.push(`${key}-invalid`);
  }
  if (!Number.isSafeInteger(slice.throttleOvershootUs)) errors.push("throttleOvershootUs-invalid");
  if (slice.throttleSiteUs > slice.throttleWaitUs) errors.push("site-total-exceeds-slice-total");
  if (slice.throttleMaxUs > slice.throttleSiteUs) errors.push("site-max-exceeds-site-total");
  if (slice.throttleMaxUs !== slice.throttleRequestedUs + slice.throttleOvershootUs) {
    errors.push("max-request-overshoot-mismatch");
  }
  return {
    site: slice.throttleSite,
    totalActualUs: slice.throttleSiteUs,
    maxActualUs: slice.throttleMaxUs,
    requestedAtMaxUs: slice.throttleRequestedUs,
    overshootAtMaxUs: slice.throttleOvershootUs,
    valid: errors.length === 0,
    validationErrors: errors
  };
}

export function classifyDvdCompletionProfile(value) {
  const profile = typeof value === "string" ? parseDvdCompletionProfile(value) : value;
  if (!profile?.totalUs) return null;
  const validation = validateDvdCompletionProfile(profile);
  if (!validation.valid) {
    return {
      owner: "invalid",
      source: "structured-dvd-completion",
      valid: false,
      validationErrors: validation.errors,
      phaseSumUs: validation.phaseSumUs,
      profile
    };
  }
  const components = [
    ["queue-wait", nonNegativeNumber(profile.queueWaitUs)],
    ["ram-copy", nonNegativeNumber(profile.ramCopyUs)],
    ["command-finish", nonNegativeNumber(profile.commandFinishUs)],
    ["queue-pop", nonNegativeNumber(profile.queuePopUs)],
    ["result-map", nonNegativeNumber(profile.mapUs)],
    ["other", nonNegativeNumber(profile.otherUs)]
  ].sort((left, right) => right[1] - left[1]);
  const [candidateOwner, dominantDurationUs] = components[0];
  const dominanceRatio = dominantDurationUs / profile.totalUs;
  return {
    owner: dominanceRatio >= CORRELATED_SLICE_DOMINANCE_THRESHOLD ? candidateOwner : "mixed",
    source: "structured-dvd-completion",
    valid: true,
    validationErrors: [],
    phaseSumUs: validation.phaseSumUs,
    dominanceThreshold: CORRELATED_SLICE_DOMINANCE_THRESHOLD,
    dominantDurationUs,
    dominanceRatio,
    componentsUs: Object.fromEntries(components),
    profile
  };
}

export function parseSlowCoreTimingEvents(consoleText) {
  const lines = String(consoleText || "").split(/\r?\n/);
  const mirroredCounts = new Map();
  for (const line of lines) {
    const match = /\[ct-slow-event\]\s+name=(.*?)\s+us=(\d+)/.exec(line);
    if (!match) continue;
    const name = match[1].trim();
    const durationUs = Number(match[2]);
    const signature = `${name}:${durationUs}`;
    const counts = mirroredCounts.get(signature) || { name, durationUs, worker: 0, main: 0 };
    counts[line.includes("[worker:") ? "worker" : "main"] += 1;
    mirroredCounts.set(signature, counts);
  }

  const samples = [];
  for (const counts of mirroredCounts.values()) {
    const sampleCount = Math.max(counts.worker, counts.main);
    for (let index = 0; index < sampleCount; index += 1) {
      samples.push({ name: counts.name, durationUs: counts.durationUs });
    }
  }

  const grouped = new Map();
  for (const sample of samples) {
    if (!grouped.has(sample.name)) grouped.set(sample.name, []);
    grouped.get(sample.name).push(sample.durationUs);
  }
  return [...grouped.entries()]
    .map(([name, durations]) => ({
      name,
      count: durations.length,
      averageUs: average(durations),
      p95Us: percentile(durations, 0.95),
      maxUs: Math.max(...durations)
    }))
    .sort((left, right) => right.maxUs - left.maxUs || right.count - left.count);
}

export function parseCorrelatedSliceTuple(value) {
  let candidate = value;
  if (typeof candidate === "string") {
    const compact = parseCompactCorrelatedSlice(candidate);
    if (compact) return compact;
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return null;
    }
  }
  if (!candidate || typeof candidate !== "object") return null;

  candidate = candidate.runloop?.max || candidate.runloop?.worstSlice ||
    candidate.correlatedSlice || candidate.worstSlice || candidate;
  if (!candidate || typeof candidate !== "object") return null;

  const componentKeys = [
    "advanceUs",
    "executeUs",
    "compileUs",
    "throttleWaitUs",
    "dvdWaitUs",
    "videoWorkUs"
  ];
  const totalUs = nonNegativeNumber(candidate.totalUs);
  const hasTimingComponent = componentKeys.some((key) => Object.hasOwn(candidate, key));
  if (totalUs <= 0 || !hasTimingComponent) return null;

  const tuple = {
    totalUs,
    advanceUs: nonNegativeNumber(candidate.advanceUs),
    executeUs: nonNegativeNumber(candidate.executeUs),
    compileUs: nonNegativeNumber(candidate.compileUs),
    throttleWaitUs: nonNegativeNumber(candidate.throttleWaitUs),
    dvdWaitUs: nonNegativeNumber(candidate.dvdWaitUs),
    videoWorkUs: nonNegativeNumber(candidate.videoWorkUs),
    event: typeof candidate.event === "string" && candidate.event.trim() ? candidate.event.trim() : null
  };
  const phase = candidate.slicePhase || candidate.phaseAttribution || candidate;
  const throttleSite = typeof phase.throttleSite === "string" && phase.throttleSite.trim() &&
    phase.throttleSite !== "none" ? phase.throttleSite.trim() : null;
  const hasThrottlePhase = throttleSite || [
    "throttleSiteUs",
    "throttleMaxUs",
    "throttleRequestedUs",
    "throttleOvershootUs"
  ].some((key) => Object.hasOwn(phase, key));
  const dvd = phase.dvdCompletion;
  if (hasThrottlePhase || dvd?.totalUs) {
    tuple.throttleSite = throttleSite;
    tuple.throttleSiteUs = nonNegativeNumber(phase.throttleSiteUs);
    tuple.throttleMaxUs = nonNegativeNumber(phase.throttleMaxUs);
    tuple.throttleRequestedUs = nonNegativeNumber(phase.throttleRequestedUs);
    tuple.throttleOvershootUs = Number.isSafeInteger(Number(phase.throttleOvershootUs)) ?
      Number(phase.throttleOvershootUs) : 0;
    tuple.dvdCompletion = dvd?.totalUs ? {
      schemaVersion: nonNegativeNumber(dvd.schemaVersion),
      totalUs: nonNegativeNumber(dvd.totalUs),
      mapUs: nonNegativeNumber(dvd.mapUs),
      queueWaitUs: nonNegativeNumber(dvd.queueWaitUs),
      queuePopUs: nonNegativeNumber(dvd.queuePopUs),
      ramCopyUs: nonNegativeNumber(dvd.ramCopyUs),
      commandFinishUs: nonNegativeNumber(dvd.commandFinishUs),
      otherUs: nonNegativeNumber(dvd.otherUs),
      bytes: nonNegativeNumber(dvd.bytes),
      queueLoops: nonNegativeNumber(dvd.queueLoops)
    } : null;
  }
  return tuple;
}

export function findMostDiagnosticTimingProfile(value) {
  const candidates = [];
  visit(value, (_key, entry) => {
    const parsed = parseCorrelatedSliceTuple(entry);
    if (parsed) candidates.push(parsed);
  });
  return selectMostDiagnosticCorrelatedSlice(...candidates);
}

export function selectMostDiagnosticCorrelatedSlice(...values) {
  const candidates = values.map(parseCorrelatedSliceTuple).filter(Boolean);
  return candidates.sort((left, right) =>
    right.totalUs - left.totalUs ||
    correlatedAttributionScore(right) - correlatedAttributionScore(left)
  )[0] || null;
}

export function classifyCorrelatedSlice(value) {
  const correlatedSlice = parseCorrelatedSliceTuple(value);
  if (!correlatedSlice) return null;

  // ExecuteOneBlock includes synchronous compilation, so subtract compile time
  // before comparing mutually exclusive ownership buckets.
  const components = [
    ["pacing-wait", correlatedSlice.throttleWaitUs],
    ["dvd-io-wait", correlatedSlice.dvdWaitUs],
    ["video-work", correlatedSlice.videoWorkUs],
    ["cpu-block-execution", Math.max(0, correlatedSlice.executeUs - correlatedSlice.compileUs)],
    ["jit-compile", correlatedSlice.compileUs]
  ];
  components.sort((left, right) => right[1] - left[1]);
  const [candidateOwner, dominantDurationUs] = components[0];
  const dominanceRatio = dominantDurationUs / correlatedSlice.totalUs;
  const owner = dominanceRatio >= CORRELATED_SLICE_DOMINANCE_THRESHOLD ? candidateOwner : "mixed";
  const attributedUs = components.reduce((sum, [, durationUs]) => sum + durationUs, 0);
  const throttleAttribution = validateSliceThrottleAttribution(correlatedSlice);
  let dvdCompletion = classifyDvdCompletionProfile(correlatedSlice.dvdCompletion);
  if (dvdCompletion?.valid) {
    const causalErrors = [];
    if (dvdCompletion.profile.queueWaitUs !== correlatedSlice.dvdWaitUs) {
      causalErrors.push("queue-wait-does-not-match-slice");
    }
    if (dvdCompletion.profile.totalUs > correlatedSlice.advanceUs) {
      causalErrors.push("dvd-total-exceeds-advance");
    }
    if (causalErrors.length) {
      dvdCompletion = {
        ...dvdCompletion,
        owner: "invalid",
        valid: false,
        validationErrors: [...dvdCompletion.validationErrors, ...causalErrors]
      };
    }
  }
  let ownerDetail = owner;
  if (owner === "pacing-wait" && throttleAttribution?.valid) {
    ownerDetail = `${owner}:${throttleAttribution.site}`;
  } else if (owner === "dvd-io-wait" && dvdCompletion?.valid) {
    ownerDetail = `${owner}:${dvdCompletion.owner}`;
  }

  return {
    owner,
    ownerDetail,
    source: "structured-correlated-slice",
    dominanceThreshold: CORRELATED_SLICE_DOMINANCE_THRESHOLD,
    dominantDurationUs,
    dominanceRatio,
    unattributedUs: Math.max(0, correlatedSlice.totalUs - attributedUs),
    componentsUs: Object.fromEntries(components),
    causalAttribution: {
      throttle: throttleAttribution,
      dvdCompletion
    },
    correlatedSlice
  };
}

export function classifyJitDiagnostics(helper, consoleText = "", timingProfile = null) {
  const jit = parseJitHelperStats(helper);
  const slowEvents = parseSlowCoreTimingEvents(consoleText);
  const classifiedEmitFailures = jit.emitFailureKeys.reduce((sum, entry) => sum + entry.count, 0);
  const runloop = jit.runloop;
  const correlated = classifyCorrelatedSlice(
    selectMostDiagnosticCorrelatedSlice(timingProfile, jit.worstSlice)
  );
  const legacyOwner = classifyLegacyLongSlice(jit);
  const longSliceClassification = correlated || {
    owner: legacyOwner,
    ownerDetail: legacyOwner,
    source: "legacy-independent-maxima",
    dominanceThreshold: CORRELATED_SLICE_DOMINANCE_THRESHOLD,
    dominantDurationUs: null,
    dominanceRatio: null,
    unattributedUs: null,
    componentsUs: null,
    causalAttribution: null,
    correlatedSlice: null
  };
  return {
    schemaVersion: 4,
    jit,
    emitFailureClassification: {
      classifiedCount: classifiedEmitFailures,
      unclassifiedCount: Math.max(0, jit.emitFailureCount - classifiedEmitFailures),
      complete: classifiedEmitFailures === jit.emitFailureCount
    },
    longSliceClassification: {
      ...longSliceClassification,
      topSlowEvent: slowEvents[0] || null,
      events: slowEvents
    },
    dvdCompletionClassification: classifyDvdCompletionProfile(jit.worstDvdCompletion),
    throttleSiteProfiles: jit.throttleSites.map(validateThrottleSiteProfile)
  };
}

export function findMostDiagnosticHelper(value) {
  const candidates = [];
  visit(value, (key, entry) => {
    if ((key === "helper" || key === "ppcWasmHelperStats") && typeof entry === "string") {
      candidates.push(entry);
    }
  });
  return candidates.sort((left, right) => diagnosticScore(right) - diagnosticScore(left))[0] || "";
}

async function main(argv) {
  const args = parseArgs(argv);
  if (!args.summary) throw new Error("Usage: --summary <summary.json> [--console <console.log>] [--out <result.json>]");
  const summary = JSON.parse(await readFile(args.summary, "utf8"));
  const helper = findMostDiagnosticHelper(summary);
  const timingProfile = findMostDiagnosticTimingProfile(summary);
  const consoleText = args.console ? await readFile(args.console, "utf8") : "";
  const result = classifyJitDiagnostics(helper, consoleText, timingProfile);
  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (args.out) await writeFile(args.out, output);
  else process.stdout.write(output);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--summary" || arg === "--console" || arg === "--out") result[arg.slice(2)] = argv[++index];
  }
  return result;
}

function integerMatch(text, pattern) {
  const match = pattern.exec(text);
  return match ? Number(match[1]) : 0;
}

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function parseCompactCorrelatedSlice(value) {
  const text = String(value || "");
  const match = /\bsliceprof:total=(\d+),advance=(\d+),execute=(\d+),compile=(\d+),throttle=(\d+),dvd=(\d+),video=(\d+),event=([^\s,]+)/.exec(text);
  if (!match || Number(match[1]) <= 0) return null;
  const tuple = {
    totalUs: Number(match[1]),
    advanceUs: Number(match[2]),
    executeUs: Number(match[3]),
    compileUs: Number(match[4]),
    throttleWaitUs: Number(match[5]),
    dvdWaitUs: Number(match[6]),
    videoWorkUs: Number(match[7]),
    event: match[8] === "none" ? null : match[8]
  };
  const phase = parseSlicePhaseProfile(text);
  return phase ? { ...tuple, ...phase } : tuple;
}

function classifyLegacyLongSlice(jit) {
  const runloop = jit.runloop;
  if (!runloop?.maxUs) return "unknown";
  if (runloop.advanceMaxUs >= runloop.maxUs * CORRELATED_SLICE_DOMINANCE_THRESHOLD) {
    return "core-timing-advance";
  }
  if (runloop.executeMaxUs >= runloop.maxUs * CORRELATED_SLICE_DOMINANCE_THRESHOLD) {
    return "cpu-block-execution";
  }
  if (jit.compileBurstMaxUs >= runloop.maxUs * CORRELATED_SLICE_DOMINANCE_THRESHOLD) {
    return "jit-compile-burst";
  }
  return "mixed-or-unclassified";
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function percentile(values, quantile) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))];
}

function visit(value, callback, key = "") {
  callback(key, value);
  if (Array.isArray(value)) {
    for (const entry of value) visit(entry, callback);
  } else if (value && typeof value === "object") {
    for (const [childKey, entry] of Object.entries(value)) visit(entry, callback, childKey);
  }
}

function diagnosticScore(helper) {
  const parsed = parseJitHelperStats(helper);
  return parsed.emitFailureCount * 1_000_000 + (parsed.runloop?.sliceCount || 0);
}

function correlatedAttributionScore(slice) {
  if (!slice) return 0;
  return (slice.throttleSite ? 1 : 0) + (slice.dvdCompletion?.totalUs ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
