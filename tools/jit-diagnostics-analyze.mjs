import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const CORRELATED_SLICE_DOMINANCE_THRESHOLD = 0.8;

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

  return {
    totalUs,
    advanceUs: nonNegativeNumber(candidate.advanceUs),
    executeUs: nonNegativeNumber(candidate.executeUs),
    compileUs: nonNegativeNumber(candidate.compileUs),
    throttleWaitUs: nonNegativeNumber(candidate.throttleWaitUs),
    dvdWaitUs: nonNegativeNumber(candidate.dvdWaitUs),
    videoWorkUs: nonNegativeNumber(candidate.videoWorkUs),
    event: typeof candidate.event === "string" && candidate.event.trim() ? candidate.event.trim() : null
  };
}

export function findMostDiagnosticTimingProfile(value) {
  const candidates = [];
  visit(value, (_key, entry) => {
    const parsed = parseCorrelatedSliceTuple(entry);
    if (parsed) candidates.push(parsed);
  });
  return candidates.sort((left, right) => right.totalUs - left.totalUs)[0] || null;
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

  return {
    owner,
    source: "structured-correlated-slice",
    dominanceThreshold: CORRELATED_SLICE_DOMINANCE_THRESHOLD,
    dominantDurationUs,
    dominanceRatio,
    unattributedUs: Math.max(0, correlatedSlice.totalUs - attributedUs),
    componentsUs: Object.fromEntries(components),
    correlatedSlice
  };
}

export function classifyJitDiagnostics(helper, consoleText = "", timingProfile = null) {
  const jit = parseJitHelperStats(helper);
  const slowEvents = parseSlowCoreTimingEvents(consoleText);
  const classifiedEmitFailures = jit.emitFailureKeys.reduce((sum, entry) => sum + entry.count, 0);
  const runloop = jit.runloop;
  const correlated = classifyCorrelatedSlice(timingProfile || jit.worstSlice);
  const legacyOwner = classifyLegacyLongSlice(jit);
  const longSliceClassification = correlated || {
    owner: legacyOwner,
    source: "legacy-independent-maxima",
    dominanceThreshold: CORRELATED_SLICE_DOMINANCE_THRESHOLD,
    dominantDurationUs: null,
    dominanceRatio: null,
    unattributedUs: null,
    componentsUs: null,
    correlatedSlice: null
  };
  return {
    schemaVersion: 2,
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
    }
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
  const match = /\bsliceprof:total=(\d+),advance=(\d+),execute=(\d+),compile=(\d+),throttle=(\d+),dvd=(\d+),video=(\d+),event=([^\s,]+)/.exec(
    String(value || "")
  );
  if (!match || Number(match[1]) <= 0) return null;
  return {
    totalUs: Number(match[1]),
    advanceUs: Number(match[2]),
    executeUs: Number(match[3]),
    compileUs: Number(match[4]),
    throttleWaitUs: Number(match[5]),
    dvdWaitUs: Number(match[6]),
    videoWorkUs: Number(match[7]),
    event: match[8] === "none" ? null : match[8]
  };
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
