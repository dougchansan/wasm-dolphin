import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const FIXED_MELEE_BATTLE_FIXTURE = Object.freeze({
  sceneLabel: "Melee Kirby vs Link fixed battle",
  isoSha256: "1018b65a58ca654056be1611a43e753de5dd5f842ce5266581b29c6a12ce7c67",
  saveStateSha256: "620879e2ed3c35248deba9fb2f7b2a39f91f5374d2f6a98d2a2455cb55e156d1",
});

export const REQUIRED_RUN_PROVENANCE = Object.freeze([
  "git.commit",
  "browser.version",
  "benchmark.url",
  "benchmark.sceneLabel",
  "benchmark.saveStateAt",
  "benchmark.inputScriptMode",
  "artifacts.rom.sha256",
  "artifacts.core.sha256",
  "artifacts.saveState.sha256",
  "fixture.isoVerified",
  "fixture.saveStateVerified",
  "fixture.saveStateLoaded",
]);

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

export async function describeFile(filePath, { hash = true } = {}) {
  if (!filePath) return null;
  const info = await stat(filePath);
  const startedAt = performance.now();
  const sha256 = hash ? await hashFile(filePath) : null;
  return {
    name: path.basename(filePath),
    bytes: info.size,
    sha256,
    hashDurationMs: hash ? Math.round(performance.now() - startedAt) : null,
  };
}

export async function verifyFileFixture(filePath, { label, expectedSha256 }) {
  if (!filePath) {
    throw new Error(`Missing ${label} path`);
  }
  let description;
  try {
    description = await describeFile(filePath, { hash: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Missing ${label}: ${filePath}`);
    }
    throw error;
  }
  const expected = String(expectedSha256 || "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    throw new Error(`Expected SHA-256 for ${label} must be 64 hexadecimal characters`);
  }
  if (description.sha256 !== expected) {
    throw new Error(
      `${label} SHA-256 mismatch: expected ${expected}, got ${description.sha256}`
    );
  }
  return { ...description, path: path.resolve(filePath), verified: true };
}

export function missingRunProvenance(manifest, required = REQUIRED_RUN_PROVENANCE) {
  return required.filter((field) => {
    const value = readPath(manifest, field);
    return value === undefined || value === null || value === "";
  });
}

export function assertRunProvenance(manifest, required = REQUIRED_RUN_PROVENANCE) {
  const missing = missingRunProvenance(manifest, required);
  if (missing.length) {
    throw new Error(`Missing required run provenance: ${missing.join(", ")}`);
  }
  if (manifest.benchmark.saveStateAt !== 0) {
    throw new Error("Fixed-battle timing requires benchmark.saveStateAt=0");
  }
  if (manifest.benchmark.inputScriptMode !== "none") {
    throw new Error("Fixed-battle timing requires benchmark.inputScriptMode=none");
  }
  if (manifest.benchmark.sceneLabel !== FIXED_MELEE_BATTLE_FIXTURE.sceneLabel) {
    throw new Error(`Unexpected benchmark scene: ${manifest.benchmark.sceneLabel}`);
  }
  if (!manifest.fixture.isoVerified || !manifest.fixture.saveStateVerified) {
    throw new Error("Fixed-battle fixture hashes were not verified");
  }
  if (!manifest.fixture.saveStateLoaded) {
    throw new Error("Fixed-battle save state was not loaded before timing");
  }
  return manifest;
}

export function validateComparisonConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Comparison config must be a JSON object");
  }
  const mode = value.mode;
  if (mode !== "screening" && mode !== "confirmation") {
    throw new Error('Comparison mode must be "screening" or "confirmation"');
  }
  const blockCount = Number(value.blockCount ?? (mode === "screening" ? 2 : 5));
  if (!Number.isInteger(blockCount)) {
    throw new Error("Comparison blockCount must be an integer");
  }
  if (mode === "screening" && blockCount !== 2) {
    throw new Error("Screening is bounded to exactly 2 comparison blocks");
  }
  if (mode === "confirmation" && (blockCount < 5 || blockCount > 10)) {
    throw new Error("Confirmation requires 5 to 10 comparison blocks");
  }
  if (!value.armA?.name || !value.armB?.name) {
    throw new Error("Comparison config requires named armA and armB objects");
  }
  if (!value.primaryMetric || typeof value.primaryMetric !== "string") {
    throw new Error("Comparison config requires one primaryMetric path");
  }
  const direction = value.direction || "higher";
  if (direction !== "higher" && direction !== "lower") {
    throw new Error('Comparison direction must be "higher" or "lower"');
  }
  const minimumEffectPercent = Number(value.minimumEffectPercent ?? 3);
  if (!Number.isFinite(minimumEffectPercent) || minimumEffectPercent < 0) {
    throw new Error("minimumEffectPercent must be a non-negative number");
  }
  return {
    schemaVersion: 1,
    mode,
    blockCount,
    primaryMetric: value.primaryMetric,
    direction,
    minimumEffectPercent,
    hypothesis: String(value.hypothesis || "").trim() || null,
    invalidationRules: Array.isArray(value.invalidationRules)
      ? value.invalidationRules.map(String)
      : [],
    stopRule:
      String(value.stopRule || "").trim() ||
      (mode === "screening"
        ? "Reject crashes, correctness failures, or absent/wrong-direction signal; never promote."
        : "Stop at 10 valid blocks and classify an unresolved interval INCONCLUSIVE."),
    armA: normalizeArm(value.armA, "A"),
    armB: normalizeArm(value.armB, "B"),
  };
}

export function buildComparisonTasklist(configValue) {
  const config = validateComparisonConfig(configValue);
  const blocks = [];
  for (let blockIndex = 0; blockIndex < config.blockCount; blockIndex += 1) {
    const order = blockIndex % 2 === 0 ? ["A", "B", "B", "A"] : ["B", "A", "A", "B"];
    blocks.push(makeComparisonBlock(config, blockIndex + 1, order));
  }
  return {
    schemaVersion: 1,
    mode: config.mode,
    requestedValidBlocks: config.blockCount,
    maxInvalidBlocks: Math.floor(config.blockCount / 4),
    primaryMetric: config.primaryMetric,
    direction: config.direction,
    minimumEffectPercent: config.minimumEffectPercent,
    hypothesis: config.hypothesis,
    invalidationRules: config.invalidationRules,
    stopRule: config.stopRule,
    blocks,
  };
}

export function buildReplacementBlock(configValue, invalidBlock, replacementNumber = 1) {
  const config = validateComparisonConfig(configValue);
  if (!invalidBlock?.order || invalidBlock.order.length !== 4) {
    throw new Error("Replacement requires the invalid four-run block and its original order");
  }
  const blockNumber = Number(invalidBlock.blockNumber);
  const replacement = makeComparisonBlock(config, blockNumber, [...invalidBlock.order]);
  replacement.blockId = `${invalidBlock.blockId}-replacement-${replacementNumber}`;
  replacement.replaces = invalidBlock.blockId;
  replacement.runs = replacement.runs.map((run, index) => ({
    ...run,
    runId: `${replacement.blockId}-run-${index + 1}`,
    blockId: replacement.blockId,
  }));
  return replacement;
}

export function summarizeComparison(configValue, runs) {
  const config = validateComparisonConfig(configValue);
  const byBlock = new Map();
  for (const run of runs || []) {
    if (!run?.blockId) continue;
    const group = byBlock.get(run.blockId) || [];
    group.push(run);
    byBlock.set(run.blockId, group);
  }
  const blocks = [];
  for (const [blockId, blockRuns] of byBlock) {
    const invalidReasons = blockRuns.flatMap((run) =>
      run.valid === false ? run.invalidReasons?.length ? run.invalidReasons : [`${run.runId}: invalid`] : []
    );
    const armA = blockRuns.filter((run) => run.arm === "A");
    const armB = blockRuns.filter((run) => run.arm === "B");
    if (blockRuns.length !== 4 || armA.length !== 2 || armB.length !== 2) {
      invalidReasons.push(`${blockId}: expected exactly two A and two B runs`);
    }
    const valuesA = armA.map((run) => Number(readPath(run, config.primaryMetric)));
    const valuesB = armB.map((run) => Number(readPath(run, config.primaryMetric)));
    if ([...valuesA, ...valuesB].some((number) => !Number.isFinite(number))) {
      invalidReasons.push(`${blockId}: primary metric ${config.primaryMetric} is missing or non-numeric`);
    }
    const valid = invalidReasons.length === 0;
    const meanA = valid ? mean(valuesA) : null;
    const meanB = valid ? mean(valuesB) : null;
    const rawEffect = valid ? meanB - meanA : null;
    const normalizedEffect = valid
      ? config.direction === "higher" ? rawEffect : -rawEffect
      : null;
    const effectPercent = valid
      ? meanA === 0 ? null : (normalizedEffect / Math.abs(meanA)) * 100
      : null;
    if (valid && !Number.isFinite(effectPercent)) {
      invalidReasons.push(`${blockId}: cannot compute relative effect from zero-valued arm A`);
    }
    blocks.push({
      blockId,
      valid: valid && Number.isFinite(effectPercent),
      invalidReasons,
      runIds: blockRuns.map((run) => run.runId),
      meanA,
      meanB,
      rawEffect,
      effectPercent: Number.isFinite(effectPercent) ? effectPercent : null,
    });
  }
  const validBlocks = blocks.filter((block) => block.valid);
  const invalidBlocks = blocks.filter((block) => !block.valid);
  const effects = validBlocks.map((block) => block.effectPercent);
  const medianEffectPercent = effects.length ? median(effects) : null;
  const interval95 = effects.length ? bootstrapMedianInterval(effects) : null;
  const permutationPValue = effects.length ? signPermutationPValue(effects) : null;
  const infrastructureLimit = Math.floor(config.blockCount / 4);

  let outcome = "INCOMPLETE";
  if (invalidBlocks.length > infrastructureLimit) {
    outcome = "INFRASTRUCTURE_INCONCLUSIVE";
  } else if (validBlocks.length >= config.blockCount) {
    const clearsEffect = medianEffectPercent >= config.minimumEffectPercent;
    const excludesZero = interval95.low > 0;
    if (config.mode === "screening") {
      outcome = clearsEffect && medianEffectPercent > 0 ? "SCREENING_SIGNAL" : "SCREENING_REJECT";
    } else if (clearsEffect && excludesZero) {
      outcome = "STATISTICAL_GATE_PASS";
    } else if (config.blockCount < 10) {
      outcome = "NEEDS_MORE_BLOCKS";
    } else {
      outcome = "INCONCLUSIVE";
    }
  }

  return {
    schemaVersion: 1,
    mode: config.mode,
    primaryMetric: config.primaryMetric,
    direction: config.direction,
    minimumEffectPercent: config.minimumEffectPercent,
    requestedValidBlocks: config.blockCount,
    attemptedBlocks: blocks.length,
    validBlockCount: validBlocks.length,
    invalidBlockCount: invalidBlocks.length,
    maxInvalidBlocks: infrastructureLimit,
    medianEffectPercent,
    interval95,
    permutationPValue,
    outcome,
    promotable: config.mode === "confirmation" && outcome === "STATISTICAL_GATE_PASS",
    blocks,
  };
}

export function summarizeNumeric(values) {
  const sorted = (values || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return {
    count: sorted.length,
    min: sorted[0],
    mean: mean(sorted),
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
    max: sorted.at(-1),
  };
}

export async function collectRunMetadata({
  root,
  url,
  browserName,
  browserChannel,
  browserVersion,
  browserExecutable,
  headed,
  durationSeconds,
  sampleMs,
  screenshotEverySeconds,
  captureScreenshots,
  showDebugPanel,
  romPath,
  hashRom = true,
  corePath,
  saveStateUrl,
  saveStatePath,
  saveStateAt,
  inputScript,
  sceneLabel,
  artifactDescriptions = {},
  startedAt = new Date().toISOString(),
}) {
  const dirtyPaths = (git(root, ["status", "--porcelain=v1"]) || "")
    .split(/\r?\n/)
    .filter(Boolean);
  const cpuModels = [...new Set(os.cpus().map((cpu) => cpu.model.trim()).filter(Boolean))];
  const [rom, core, saveState] = await Promise.all([
    artifactDescriptions.rom || describeFile(romPath, { hash: hashRom }),
    artifactDescriptions.core || describeFile(corePath, { hash: true }),
    artifactDescriptions.saveState || describeFile(saveStatePath, { hash: true }),
  ]);

  return {
    schemaVersion: 1,
    startedAt,
    finishedAt: null,
    git: {
      commit: git(root, ["rev-parse", "HEAD"]),
      branch: git(root, ["branch", "--show-current"]),
      dirty: dirtyPaths.length > 0,
      dirtyPaths,
    },
    runtime: {
      node: process.version,
      argv: process.argv.slice(1),
    },
    machine: {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      cpuModels,
      logicalCpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
    },
    browser: {
      name: browserName,
      channel: browserChannel || null,
      version: browserVersion || null,
      executable: browserExecutable ? path.basename(browserExecutable) : null,
      headed: Boolean(headed),
    },
    benchmark: {
      url,
      durationSeconds,
      sampleMs,
      screenshotEverySeconds,
      captureScreenshots: Boolean(captureScreenshots),
      showDebugPanel: Boolean(showDebugPanel),
      sceneLabel: sceneLabel || null,
      saveStateUrl: saveStateUrl || null,
      saveStateAt: saveStateUrl ? saveStateAt : null,
      inputScriptSha256: createHash("sha256").update(String(inputScript || "")).digest("hex"),
    },
    artifacts: {
      rom,
      core,
      saveState,
    },
  };
}

export function parseProfileMetrics(helper = "", frameProfile = "") {
  const core = /\bcoreprof\s+xfb_dt:([\d.]+)\s+avg:([\d.]+)\s+max:([\d.]+)\s+decode:([\d.]+)\s+avg:([\d.]+)\s+max:([\d.]+)\s+vo_sync:([\d.]+)\/max([\d.]+)\s+vo_pub:([\d.]+)\/max([\d.]+)\s+vo_total:([\d.]+)\/max([\d.]+)\s+swxfb:([\d.]+)\s+conv:([\d.]+)\s+copy:([\d.]+)/.exec(helper);
  const frame = /\bloop:([\d.]+)\s+pump:([\d.]+)\s+run:([\d.]+)\s+api:([\d.]+)\s+cap:([\d.]+)\s+copy:([\d.]+)\s+present:([\d.]+)\s+draw:([\d.]+)\s+hash:([\d.]+)\s+paced:([\d.]+)\s+copy:([\d.]+)MB\/s\s+cap:(\d+)\s+shown:(\d+)/.exec(frameProfile);
  const number = (match, index) => (match ? Number(match[index]) : null);

  return {
    coreXfbIntervalMs: number(core, 1),
    coreXfbAverageIntervalMs: number(core, 2),
    coreXfbMaxIntervalMs: number(core, 3),
    coreXfbDecodeMs: number(core, 4),
    coreXfbAverageDecodeMs: number(core, 5),
    coreXfbMaxDecodeMs: number(core, 6),
    videoOutputSyncMs: number(core, 7),
    videoOutputMaxSyncMs: number(core, 8),
    videoOutputPublishMs: number(core, 9),
    videoOutputMaxPublishMs: number(core, 10),
    videoOutputTotalMs: number(core, 11),
    videoOutputMaxTotalMs: number(core, 12),
    softwareXfbTotalMs: number(core, 13),
    softwareXfbConvertMs: number(core, 14),
    softwareXfbCopyMs: number(core, 15),
    jsLoopMs: number(frame, 1),
    jsPumpMs: number(frame, 2),
    jsRunMs: number(frame, 3),
    jsApiMs: number(frame, 4),
    jsCaptureMs: number(frame, 5),
    jsCopyMs: number(frame, 6),
    jsPresentMs: number(frame, 7),
    jsDrawMs: number(frame, 8),
    jsHashMs: number(frame, 9),
    jsPacedMs: number(frame, 10),
    jsCopyMegabytesPerSecond: number(frame, 11),
    jsCaptureCount: number(frame, 12),
    jsPresentCount: number(frame, 13),
  };
}

export function recordsToCsv(records) {
  if (!records?.length) return "";
  const columns = [...new Set(records.flatMap((record) => Object.keys(record)))];
  const lines = [columns.map(csvCell).join(",")];
  for (const record of records) {
    lines.push(columns.map((column) => csvCell(record[column])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function csvCell(value) {
  if (value === undefined || value === null) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function normalizeArm(arm, label) {
  const params = arm.params == null ? {} : arm.params;
  if (typeof params !== "object" || Array.isArray(params)) {
    throw new Error(`Comparison arm ${label} params must be an object`);
  }
  const cacheState = arm.cacheState == null ? "cold" : String(arm.cacheState);
  if (cacheState !== "cold" && cacheState !== "disabled") {
    throw new Error(`Comparison arm ${label} cacheState must be "cold" or "disabled"`);
  }
  return {
    name: String(arm.name),
    params: Object.fromEntries(
      Object.entries(params).map(([key, value]) => [String(key), String(value)])
    ),
    cacheState,
  };
}

function makeComparisonBlock(config, blockNumber, order) {
  const blockId = `block-${String(blockNumber).padStart(2, "0")}`;
  return {
    blockId,
    blockNumber,
    order,
    status: "pending",
    runs: order.map((arm, index) => ({
      runId: `${blockId}-run-${index + 1}`,
      blockId,
      blockNumber,
      orderIndex: index + 1,
      arm,
      armName: arm === "A" ? config.armA.name : config.armB.name,
      params: { ...(arm === "A" ? config.armA.params : config.armB.params) },
      cacheState: arm === "A" ? config.armA.cacheState : config.armB.cacheState,
      status: "pending",
    })),
  };
}

function readPath(value, dottedPath) {
  return String(dottedPath)
    .split(".")
    .reduce((current, key) => current?.[key], value);
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return quantile(sorted, 0.5);
}

function quantile(sorted, probability) {
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function bootstrapMedianInterval(effects, iterations = 4096) {
  if (effects.length === 1) {
    return { low: effects[0], high: effects[0], method: "block-bootstrap-median", iterations: 1 };
  }
  let state = effects.reduce(
    (seed, value, index) => (seed ^ Math.imul(Math.round(value * 1000) + index + 1, 2654435761)) >>> 0,
    0x9e3779b9
  );
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
  const medians = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sample = [];
    for (let index = 0; index < effects.length; index += 1) {
      sample.push(effects[Math.floor(next() * effects.length)]);
    }
    medians.push(median(sample));
  }
  medians.sort((a, b) => a - b);
  return {
    low: quantile(medians, 0.025),
    high: quantile(medians, 0.975),
    method: "block-bootstrap-median",
    iterations,
  };
}

function signPermutationPValue(effects) {
  const observed = Math.abs(mean(effects));
  const combinations = 2 ** effects.length;
  let atLeastAsExtreme = 0;
  for (let mask = 0; mask < combinations; mask += 1) {
    const signed = effects.map((effect, index) =>
      mask & (1 << index) ? effect : -effect
    );
    if (Math.abs(mean(signed)) >= observed - Number.EPSILON) {
      atLeastAsExtreme += 1;
    }
  }
  return atLeastAsExtreme / combinations;
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
