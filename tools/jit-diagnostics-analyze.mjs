import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

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
  const workerLines = lines.filter((line) => line.includes("[worker:") && line.includes("[ct-slow-event]"));
  const selected = workerLines.length > 0 ? workerLines : collapseMirroredLines(lines);
  const samples = [];
  for (const line of selected) {
    const match = /\[ct-slow-event\]\s+name=(.*?)\s+us=(\d+)/.exec(line);
    if (match) samples.push({ name: match[1].trim(), durationUs: Number(match[2]) });
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

export function classifyJitDiagnostics(helper, consoleText = "") {
  const jit = parseJitHelperStats(helper);
  const slowEvents = parseSlowCoreTimingEvents(consoleText);
  const classifiedEmitFailures = jit.emitFailureKeys.reduce((sum, entry) => sum + entry.count, 0);
  const runloop = jit.runloop;
  let longSliceOwner = "unknown";
  if (runloop?.maxUs > 0) {
    if (runloop.advanceMaxUs >= runloop.maxUs * 0.8) longSliceOwner = "core-timing-advance";
    else if (runloop.executeMaxUs >= runloop.maxUs * 0.8) longSliceOwner = "cpu-block-execution";
    else if (jit.compileBurstMaxUs >= runloop.maxUs * 0.8) longSliceOwner = "jit-compile-burst";
    else longSliceOwner = "mixed-or-unclassified";
  }
  return {
    schemaVersion: 1,
    jit,
    emitFailureClassification: {
      classifiedCount: classifiedEmitFailures,
      unclassifiedCount: Math.max(0, jit.emitFailureCount - classifiedEmitFailures),
      complete: classifiedEmitFailures === jit.emitFailureCount
    },
    longSliceClassification: {
      owner: longSliceOwner,
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
  const consoleText = args.console ? await readFile(args.console, "utf8") : "";
  const result = classifyJitDiagnostics(helper, consoleText);
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

function collapseMirroredLines(lines) {
  const result = [];
  let previousSignature = "";
  for (const line of lines) {
    const match = /\[ct-slow-event\]\s+name=(.*?)\s+us=(\d+)/.exec(line);
    if (!match) continue;
    const signature = `${match[1]}:${match[2]}`;
    if (signature !== previousSignature) result.push(line);
    previousSignature = signature;
  }
  return result;
}

function integerMatch(text, pattern) {
  const match = pattern.exec(text);
  return match ? Number(match[1]) : 0;
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
