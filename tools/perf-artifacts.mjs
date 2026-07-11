import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CAUSAL_TELEMETRY_SCHEMA_VERSION } from "../src/causal-telemetry.js";

export const FIXED_MELEE_BATTLE_FIXTURE = Object.freeze({
  sceneLabel: "Melee Kirby vs Link fixed battle",
  isoSha256: "1018b65a58ca654056be1611a43e753de5dd5f842ce5266581b29c6a12ce7c67",
  saveStateSha256: "620879e2ed3c35248deba9fb2f7b2a39f91f5374d2f6a98d2a2455cb55e156d1",
});

export const FIXED_MELEE_BATTLE_CHECKPOINT = Object.freeze({
  // Recorded from the paused, exact-state checkpoint. The harness pauses the
  // core before State::LoadAs so these values are tied to save bytes rather
  // than wall-clock delay after loading. Restored in-slice bookkeeping can
  // make the after-load observation lower by at most one CoreTiming
  // MAX_SLICE_LENGTH (20,000 ticks, about 41 microseconds at 486 MHz). PC,
  // XFB hash, dimensions, callback source, and fixture hashes remain exact.
  frame: null,
  coreTicks: 15166162443,
  coreTicksDeltaMin: -20_000,
  coreTicksDeltaMax: 0,
  ppcPc: -2144030364,
  xfbHash: "4b2d0a3b",
  width: 640,
  height: 480,
  checkpointObservationSource: "cpu-thread-after-load",
  minLoadedCheckpointGeneration: 1,
});

const FIXED_MELEE_SOFTWARE_XFB_HASH_BY_FASTSW = Object.freeze({
  0: "55dc4398",
  1: FIXED_MELEE_BATTLE_CHECKPOINT.xfbHash,
});

const FIXED_MELEE_WGPU_XFB_HASH = "6fd97dc5";

export function expectedBattleCheckpointForParams(params = {}) {
  const video = String(params.video || "software").toLowerCase();
  const fastsw = Number.parseInt(String(params.fastsw ?? "1"), 10);
  let xfbHash = FIXED_MELEE_BATTLE_CHECKPOINT.xfbHash;
  if (video === "software") {
    xfbHash = FIXED_MELEE_SOFTWARE_XFB_HASH_BY_FASTSW[fastsw] ?? xfbHash;
  } else if (video === "wgpu") {
    xfbHash = FIXED_MELEE_WGPU_XFB_HASH;
  }
  return { ...FIXED_MELEE_BATTLE_CHECKPOINT, xfbHash };
}

export const HOST_CORE_ABI_VERSION = 1;
export const PERF_EVENT_SCHEMA_VERSION = 1;

const POST_LOAD_INPUT_KEYS = new Set([
  "x", "z", "v", "b", "q", "e", "c",
  "w", "a", "s", "d", "i", "j", "k", "l",
  "Enter", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
]);

export function parsePostLoadInputScript(value, { durationSeconds = Infinity } = {}) {
  const source = String(value ?? "").trim();
  if (!source || /^(?:none|off)$/i.test(source)) return [];
  if (!(durationSeconds > 0)) {
    throw new Error("Post-load input scripts require a positive benchmark duration");
  }

  const entries = source.split(",");
  if (entries.length > 256) {
    throw new Error("PERF_INPUT_SCRIPT supports at most 256 input events");
  }

  const events = entries.map((entry, index) => {
    const parts = entry.trim().split(":");
    const action = parts[0];
    const second = Number.parseFloat(parts[1]);
    const key = parts[2];
    if (
      parts.length !== 3 ||
      !["down", "up"].includes(action) ||
      !Number.isFinite(second) ||
      second < 0 ||
      second >= durationSeconds ||
      !POST_LOAD_INPUT_KEYS.has(key)
    ) {
      throw new Error(`Invalid PERF_INPUT_SCRIPT entry "${entry}"`);
    }
    return { action, second, key, index };
  }).sort((left, right) => left.second - right.second || left.index - right.index);

  const pressedAt = new Map();
  for (const event of events) {
    if (event.action === "down") {
      if (pressedAt.has(event.key)) {
        throw new Error(`PERF_INPUT_SCRIPT repeats key down without key up: ${event.key}`);
      }
      pressedAt.set(event.key, event.second);
      continue;
    }
    const downAt = pressedAt.get(event.key);
    if (downAt == null) {
      throw new Error(`PERF_INPUT_SCRIPT releases a key that is not down: ${event.key}`);
    }
    if (event.second <= downAt) {
      throw new Error(`PERF_INPUT_SCRIPT key up must follow key down in time: ${event.key}`);
    }
    pressedAt.delete(event.key);
  }
  if (pressedAt.size) {
    throw new Error(`PERF_INPUT_SCRIPT leaves keys pressed: ${[...pressedAt.keys()].join(", ")}`);
  }
  return events;
}

export function serializePostLoadInputScript(events) {
  return events.map((event) => `${event.action}:${event.second}:${event.key}`).join(",");
}

export function selectNextPostLoadBenchmarkAction({
  sampleIndex,
  totalSamples,
  sampleMs,
  inputIndex,
  inputEvents,
}) {
  const sample = sampleIndex <= totalSamples
    ? { type: "sample", index: sampleIndex, atMs: sampleIndex * sampleMs }
    : null;
  const inputEvent = inputEvents[inputIndex];
  const input = inputEvent
    ? { type: "input", index: inputIndex, atMs: inputEvent.second * 1000, event: inputEvent }
    : null;
  if (!sample) return input;
  if (!input || sampleIndex === 0 || sample.atMs <= input.atMs) return sample;
  return input;
}

export function selectNextFixedWorkBenchmarkAction({
  wallTimeCapMs,
  ...schedule
}) {
  const action = selectNextPostLoadBenchmarkAction(schedule);
  if (!action || action.atMs > wallTimeCapMs) {
    return { type: "wall-time-cap", atMs: wallTimeCapMs };
  }
  return action;
}

export function fixedWorkPollDelayMs({
  nowMs,
  deadlineMs,
  pollIntervalMs = 100,
}) {
  const remainingMs = Number(deadlineMs) - Number(nowMs);
  if (!(remainingMs > 0)) return 0;
  const intervalMs = Number(pollIntervalMs);
  if (!(intervalMs > 0)) {
    throw new Error("Fixed-work polling requires a positive poll interval");
  }
  return Math.min(intervalMs, remainingMs);
}

export function summarizeFixedEmulatedWork({
  targetCoreSeconds,
  coreTicksPerSecond,
  baseline,
  observation,
  wallTimeCapSeconds,
  pollIntervalMs,
}) {
  const targetSeconds = Number(targetCoreSeconds);
  const ticksPerSecond = Number(coreTicksPerSecond);
  const baselineTicks = Number(baseline?.coreTicks);
  const baselineFrame = Number(baseline?.frame);
  const baselineObservedAtMs = Number(baseline?.observedAtMs);
  const observedTicks = Number(observation?.coreTicks);
  const observedFrame = Number(observation?.frame);
  const observedAtMs = Number(observation?.observedAtMs);
  if (!(targetSeconds > 0)) {
    throw new Error("Fixed emulated work requires positive targetCoreSeconds");
  }
  if (!(ticksPerSecond > 0)) {
    throw new Error("Fixed emulated work requires positive coreTicksPerSecond");
  }
  if (![baselineTicks, baselineFrame, baselineObservedAtMs, observedTicks, observedFrame, observedAtMs]
    .every(Number.isFinite)) {
    throw new Error("Fixed emulated work requires finite baseline and observation values");
  }

  const targetCoreTicks = targetSeconds * ticksPerSecond;
  const actualCoreTickDelta = observedTicks - baselineTicks;
  const actualFrameDelta = observedFrame - baselineFrame;
  const elapsedWallSeconds = (observedAtMs - baselineObservedAtMs) / 1000;
  const deltasValid = actualCoreTickDelta >= 0 && actualFrameDelta >= 0 && elapsedWallSeconds >= 0;
  const hasElapsedTime = deltasValid && elapsedWallSeconds > 0;
  return {
    enabled: true,
    targetCoreSeconds: targetSeconds,
    targetCoreTicks,
    coreTicksPerSecond: ticksPerSecond,
    wallTimeCapSeconds: Number(wallTimeCapSeconds),
    pollIntervalMs: Number(pollIntervalMs),
    baselineCoreTicks: baselineTicks,
    baselineFrame,
    baselineObservedAtMs,
    observedCoreTicks: observedTicks,
    observedFrame,
    observedAtMs,
    actualCoreTickDelta,
    actualFrameDelta,
    elapsedWallSeconds,
    reachedTarget: deltasValid && actualCoreTickDelta >= targetCoreTicks,
    throughputGameSpeedPercent: hasElapsedTime
      ? (actualCoreTickDelta * 100) / (ticksPerSecond * elapsedWallSeconds)
      : null,
    throughputCoreFps: hasElapsedTime ? actualFrameDelta / elapsedWallSeconds : null,
    deltasValid,
  };
}

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
  "fixture.battleCheckpoint.verified",
  "servedApplication.verified",
  "causalTelemetrySchema.version",
]);

export const REQUIRED_QUALIFICATION_PROVENANCE = Object.freeze([
  "git.dirty",
  "browser.headed",
  "browser.version",
  "browser.executablePath",
  "browser.actualChannel",
  "browser.profileId",
  "benchmark.cacheState",
  "renderer.expectedVideoBackend",
  "renderer.requestedVideoBackend",
  "renderer.activeVideoBackend",
  "renderer.expectedRequestedPresenterBackend",
  "renderer.expectedActivePresenterBackend",
  "renderer.requestedPresenterBackend",
  "renderer.activePresenterBackend",
  "buildProvenance.verification.verified",
  "servedApplication.verified",
  "servedApplication.manifestSha256",
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
  const inputScriptMode = manifest.benchmark.inputScriptMode;
  if (!new Set(["none", "post-load-only"]).has(inputScriptMode)) {
    throw new Error(
      "Fixed-battle timing requires benchmark.inputScriptMode=none or post-load-only"
    );
  }
  if (inputScriptMode === "post-load-only") {
    if (manifest.benchmark.timingStartsAfterVerifiedLoad !== true) {
      throw new Error("Post-load input requires timingStartsAfterVerifiedLoad=true");
    }
    if (manifest.benchmark.inputScriptScheduleOrigin !== "after-first-timed-sample") {
      throw new Error("Post-load input must be scheduled after the first timed baseline sample");
    }
    if (!manifest.benchmark.timingBaselineEstablishedAt) {
      throw new Error("Post-load input requires an established timed baseline sample");
    }
    if (!(manifest.benchmark.inputScriptEventCount > 0)) {
      throw new Error("Post-load input requires a positive inputScriptEventCount");
    }
    if (!/^[0-9a-f]{64}$/i.test(String(manifest.benchmark.inputScriptSha256 || ""))) {
      throw new Error("Post-load input requires a SHA-256 inputScriptSha256");
    }
  }
  const fixedWork = manifest.benchmark.fixedEmulatedWork;
  if (fixedWork?.enabled) {
    if (!(fixedWork.targetCoreSeconds > 0) || !(fixedWork.targetCoreTicks > 0)) {
      throw new Error("Fixed emulated work requires positive target seconds and target ticks");
    }
    if (!(fixedWork.coreTicksPerSecond > 0) || !(fixedWork.wallTimeCapSeconds > 0)) {
      throw new Error("Fixed emulated work requires a positive tick rate and wall-time cap");
    }
    if (!(fixedWork.pollIntervalMs > 0)) {
      throw new Error("Fixed emulated work requires a positive polling interval");
    }
    if (!manifest.benchmark.timingBaselineEstablishedAt) {
      throw new Error("Fixed emulated work requires a post-settle timed baseline sample");
    }
  }
  if (manifest.causalTelemetrySchema.version !== CAUSAL_TELEMETRY_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported causal telemetry schema: expected ${CAUSAL_TELEMETRY_SCHEMA_VERSION}, ` +
      `got ${manifest.causalTelemetrySchema.version}`
    );
  }
  if (!manifest.fixture.isoVerified || !manifest.fixture.saveStateVerified) {
    throw new Error("Fixed-battle fixture hashes were not verified");
  }
  if (!manifest.fixture.saveStateLoaded) {
    throw new Error("Fixed-battle save state was not loaded before timing");
  }
  if (!manifest.fixture.battleCheckpoint?.verified) {
    throw new Error("Deterministic post-load battle/XFB checkpoint was not verified");
  }
  if (!manifest.servedApplication?.verified) {
    throw new Error("Served application/core identity was not verified");
  }
  return manifest;
}

export function evaluateQualificationProvenance(manifest) {
  const missing = missingRunProvenance(manifest, REQUIRED_QUALIFICATION_PROVENANCE);
  if (manifest?.git?.dirty !== false) missing.push("git.dirty=false");
  if (manifest?.browser?.headed !== true) missing.push("browser.headed=true");
  if (!Array.isArray(manifest?.patches?.hashes) || manifest.patches.hashes.length === 0) {
    missing.push("patches.hashes[0]");
  } else if (manifest.patches.hashes.some((hash) => !/^[0-9a-f]{64}$/i.test(String(hash)))) {
    missing.push("patches.hashes(valid SHA-256)");
  }
  const renderer = manifest?.renderer || {};
  if (renderer.requestedVideoBackend !== renderer.expectedVideoBackend) {
    missing.push(`renderer.requestedVideoBackend=${renderer.expectedVideoBackend || "expected"}`);
  }
  if (renderer.activeVideoBackend !== renderer.expectedVideoBackend) {
    missing.push(`renderer.activeVideoBackend=${renderer.expectedVideoBackend || "expected"}`);
  }
  if (renderer.requestedPresenterBackend !== renderer.expectedRequestedPresenterBackend) {
    missing.push(
      `renderer.requestedPresenterBackend=${renderer.expectedRequestedPresenterBackend || "expected"}`
    );
  }
  if (renderer.activePresenterBackend !== renderer.expectedActivePresenterBackend) {
    missing.push(
      `renderer.activePresenterBackend=${renderer.expectedActivePresenterBackend || "expected"}`
    );
  }
  if (renderer.expectedActivePresenterBackend === "webgpu") {
    if (!renderer.adapter?.selected) {
      missing.push("renderer.adapter.selected=true");
    } else if (![renderer.adapter.vendor, renderer.adapter.device, renderer.adapter.description].some(Boolean)) {
      missing.push("renderer.adapter.identity");
    }
    if (!renderer.device?.created) missing.push("renderer.device.created=true");
  }
  if (!manifest?.browser?.profileId) missing.push("browser.profileId");
  if (!/^[0-9a-f]{64}$/i.test(String(manifest?.servedApplication?.manifestSha256 || ""))) {
    missing.push("servedApplication.manifestSha256(valid SHA-256)");
  }
  if (manifest?.hostCore?.abiVersion !== HOST_CORE_ABI_VERSION) {
    missing.push(`hostCore.abiVersion=${HOST_CORE_ABI_VERSION}`);
  }
  if (manifest?.eventSchema?.version !== PERF_EVENT_SCHEMA_VERSION) {
    missing.push(`eventSchema.version=${PERF_EVENT_SCHEMA_VERSION}`);
  }
  if (manifest?.causalTelemetrySchema?.version !== CAUSAL_TELEMETRY_SCHEMA_VERSION) {
    missing.push(`causalTelemetrySchema.version=${CAUSAL_TELEMETRY_SCHEMA_VERSION}`);
  }
  const lockedVerification = validateLockedBuildProvenance(manifest?.buildProvenance || {});
  if (manifest?.buildProvenance?.verification?.verified !== true) {
    missing.push("buildProvenance.verification.verified=true");
  }
  if (!lockedVerification.verified) {
    missing.push(...lockedVerification.failures.map((failure) => `buildProvenance.${failure}`));
  }
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(String(manifest?.upstream?.dolphinSha || ""))) {
    missing.push("upstream.dolphinSha(valid commit)");
  }
  if (manifest?.upstream?.dolphinSha !== manifest?.buildProvenance?.locked?.sourceLock?.upstream?.commit) {
    missing.push("upstream.dolphinSha=locked source commit");
  }
  const lockedPatchHashes = (manifest?.buildProvenance?.locked?.sourceLock?.patches || []).map(
    (patch) => patch?.sha256
  );
  if (JSON.stringify(manifest?.patches?.hashes || []) !== JSON.stringify(lockedPatchHashes)) {
    missing.push("patches.hashes=locked patch order");
  }
  if (JSON.stringify(manifest?.toolchain ?? null) !== JSON.stringify(manifest?.buildProvenance?.locked?.toolchainLock ?? null)) {
    missing.push("toolchain=locked toolchain manifest");
  }
  const uniqueMissing = [...new Set(missing)];
  return {
    eligible: uniqueMissing.length === 0,
    missing: uniqueMissing,
  };
}

export function validateLockedBuildProvenance(provenance = {}) {
  const buildInfo = provenance.locked?.buildInfo;
  const sourceLock = provenance.locked?.sourceLock;
  const abiManifest = provenance.locked?.abiManifest;
  const toolchainLock = provenance.locked?.toolchainLock;
  const vendorSnapshot = provenance.locked?.vendorSnapshot;
  const actual = provenance.actualArtifacts || {};
  const actualContractSources = provenance.actualContractSources || {};
  const evidence = provenance.evidenceFiles || {};
  const failures = [];
  const require = (condition, label) => {
    if (!condition) failures.push(label);
  };
  const sha = (value) => /^[0-9a-f]{64}$/i.test(String(value || ""));
  const commit = (value) => /^[0-9a-f]{40}$/i.test(String(value || ""));
  const exact = (left, right, label) => require(left !== undefined && left === right, label);
  const evidenceFile = (key, { committed = false } = {}) => {
    const entry = evidence[key];
    require(entry?.exists === true, `evidenceFiles.${key}.exists=true`);
    require(sha(entry?.sha256), `evidenceFiles.${key}.sha256`);
    if (committed) {
      require(entry?.trackedAtHead === true, `evidenceFiles.${key}.trackedAtHead=true`);
      require(entry?.matchesHead === true, `evidenceFiles.${key}.matchesHead=true`);
    }
  };

  require(buildInfo?.schemaVersion === 1, "locked.buildInfo.schemaVersion=1");
  require(sourceLock?.schemaVersion === 1, "locked.sourceLock.schemaVersion=1");
  require(abiManifest?.schemaVersion === 1, "locked.abiManifest.schemaVersion=1");
  require(toolchainLock?.schemaVersion === 1, "locked.toolchainLock.schemaVersion=1");
  require(vendorSnapshot?.schemaVersion === 1, "locked.vendorSnapshot.schemaVersion=1");
  evidenceFile("buildInfo");
  evidenceFile("sourceLock", { committed: true });
  evidenceFile("abiManifest", { committed: true });
  evidenceFile("toolchainLock", { committed: true });
  evidenceFile("vendorSnapshot", { committed: true });
  evidenceFile("nagaCargoLock", { committed: true });
  const bundledEvidence = new Map(
    (Array.isArray(provenance.evidenceBundle) ? provenance.evidenceBundle : []).map((entry) => [entry?.key, entry])
  );
  for (const key of ["buildInfo", "sourceLock", "abiManifest", "toolchainLock", "vendorSnapshot", "nagaCargoLock"]) {
    const bundled = bundledEvidence.get(key);
    require(Boolean(bundled?.path), `evidenceBundle.${key}.path`);
    exact(bundled?.sha256, evidence[key]?.sha256, `evidenceBundle.${key}.sha256`);
    exact(bundled?.bytes, evidence[key]?.bytes, `evidenceBundle.${key}.bytes`);
  }

  require(commit(sourceLock?.upstream?.commit), "locked.sourceLock.upstream.commit");
  exact(vendorSnapshot?.root?.baseCommit, sourceLock?.upstream?.commit, "locked.vendorSnapshot.root.baseCommit");
  require(commit(vendorSnapshot?.root?.resultTree), "locked.vendorSnapshot.root.resultTree");
  require(sha(sourceLock?.patchSeriesSha256), "locked.sourceLock.patchSeriesSha256");
  require(Array.isArray(sourceLock?.patches) && sourceLock.patches.length > 0, "locked.sourceLock.patches");
  for (const [index, patch] of (sourceLock?.patches || []).entries()) {
    require(patch?.order === index + 1, `locked.sourceLock.patches[${index}].order`);
    require(sha(patch?.sha256), `locked.sourceLock.patches[${index}].sha256`);
    require(patch?.hashMode === "lf-normalized", `locked.sourceLock.patches[${index}].hashMode`);
  }

  require(abiManifest?.abiVersion === HOST_CORE_ABI_VERSION, `locked.abiManifest.abiVersion=${HOST_CORE_ABI_VERSION}`);
  require(
    (abiManifest?.sourceOnlyExportsPendingRebuild ?? []).length === 0,
    "locked.abiManifest.sourceOnlyExportsPendingRebuild must be empty for qualification"
  );
  exact(abiManifest?.upstreamCommit, sourceLock?.upstream?.commit, "locked.abiManifest.upstreamCommit");
  require(sha(String(abiManifest?.coreId || "").replace(/^sha256:/, "")), "locked.abiManifest.coreId");
  require(Array.isArray(abiManifest?.artifacts), "locked.abiManifest.artifacts");
  require(
    Array.isArray(abiManifest?.contractSources) && abiManifest.contractSources.length > 0,
    "locked.abiManifest.contractSources"
  );
  for (const [index, declared] of (abiManifest?.contractSources || []).entries()) {
    const observed = actualContractSources[declared?.path];
    require(Boolean(observed), `actualContractSources.${declared?.path || index}`);
    exact(observed?.path, declared?.path, `abi.contractSources[${index}].path`);
    exact(observed?.hashMode, declared?.hashMode || "raw", `abi.contractSources[${index}].hashMode`);
    exact(observed?.sha256, declared?.sha256, `abi.contractSources[${index}].sha256`);
    exact(observed?.size, declared?.size, `abi.contractSources[${index}].size`);
  }

  require(commit(buildInfo?.repository?.commit), "locked.buildInfo.repository.commit");
  require(buildInfo?.repository?.status === "", "locked.buildInfo.repository.status=clean");
  require(!Number.isNaN(Date.parse(buildInfo?.createdAt || "")), "locked.buildInfo.createdAt");
  exact(buildInfo?.source?.upstreamCommit, sourceLock?.upstream?.commit, "locked.buildInfo.source.upstreamCommit");
  exact(buildInfo?.source?.patchSeriesSha256, sourceLock?.patchSeriesSha256, "locked.buildInfo.source.patchSeriesSha256");
  exact(buildInfo?.source?.sourceLockSha256, evidence.sourceLock?.sha256, "locked.buildInfo.source.sourceLockSha256");
  exact(buildInfo?.source?.vendorSnapshotSha256, evidence.vendorSnapshot?.sha256, "locked.buildInfo.source.vendorSnapshotSha256");
  exact(buildInfo?.source?.vendorResultTree, vendorSnapshot?.root?.resultTree, "locked.buildInfo.source.vendorResultTree");
  exact(buildInfo?.toolchain?.lockSha256, evidence.toolchainLock?.sha256, "locked.buildInfo.toolchain.lockSha256");

  for (const [label, value] of [
    ["platform", toolchainLock?.platform],
    ["node.version", toolchainLock?.node?.version],
    ["emscripten.version", toolchainLock?.emscripten?.version],
    ["cmake.version", toolchainLock?.cmake?.version],
    ["ninja.version", toolchainLock?.ninja?.version],
    ["rust.rustcVersion", toolchainLock?.rust?.rustcVersion],
    ["rust.cargoVersion", toolchainLock?.rust?.cargoVersion],
    ["naga.crateVersion", toolchainLock?.naga?.crateVersion],
    ["naga.dependencyVersion", toolchainLock?.naga?.dependencyVersion],
  ]) require(typeof value === "string" && value.length > 0, `locked.toolchainLock.${label}`);
  for (const [label, value] of [
    ["emscripten.compilerCommit", toolchainLock?.emscripten?.compilerCommit],
    ["emscripten.emsdkCommit", toolchainLock?.emscripten?.emsdkCommit],
    ["rust.rustcCommit", toolchainLock?.rust?.rustcCommit],
    ["rust.cargoCommit", toolchainLock?.rust?.cargoCommit],
  ]) require(commit(value), `locked.toolchainLock.${label}`);

  const toolchainComparisons = [
    ["emscriptenVersion", toolchainLock?.emscripten?.version],
    ["emscriptenCompilerCommit", toolchainLock?.emscripten?.compilerCommit],
    ["emsdkCommit", toolchainLock?.emscripten?.emsdkCommit],
    ["cmakeVersion", toolchainLock?.cmake?.version],
    ["ninjaVersion", toolchainLock?.ninja?.version],
    ["rustcVersion", toolchainLock?.rust?.rustcVersion],
    ["rustcCommit", toolchainLock?.rust?.rustcCommit],
    ["cargoVersion", toolchainLock?.rust?.cargoVersion],
    ["nagaDependencyVersion", toolchainLock?.naga?.dependencyVersion],
    ["cargoLockSha256", toolchainLock?.naga?.cargoLockSha256],
  ];
  for (const [field, expected] of toolchainComparisons) {
    exact(buildInfo?.toolchain?.[field], expected, `locked.buildInfo.toolchain.${field}`);
  }
  exact(toolchainLock?.naga?.cargoLockSha256, evidence.nagaCargoLock?.normalizedSha256, "locked.toolchainLock.naga.cargoLockSha256");
  require(toolchainLock?.rust?.target === "wasm32-unknown-emscripten", "locked.toolchainLock.rust.target");
  for (const [label, value] of [
    ["node.sha256", toolchainLock?.node?.sha256],
    ["emscripten.emccSha256", toolchainLock?.emscripten?.emccSha256],
    ["emscripten.emcmakeSha256", toolchainLock?.emscripten?.emcmakeSha256],
    ["emscripten.clangxxSha256", toolchainLock?.emscripten?.clangxxSha256],
    ["cmake.sha256", toolchainLock?.cmake?.sha256],
    ["ninja.sha256", toolchainLock?.ninja?.sha256],
    ["rust.rustcSha256", toolchainLock?.rust?.rustcSha256],
    ["rust.cargoSha256", toolchainLock?.rust?.cargoSha256],
    ["rust.rustupSha256", toolchainLock?.rust?.rustupSha256],
    ["naga.cargoLockSha256", toolchainLock?.naga?.cargoLockSha256],
  ]) require(sha(value), `locked.toolchainLock.${label}`);

  require(Number.isInteger(buildInfo?.configure?.wasmMemoryPages) && buildInfo.configure.wasmMemoryPages > 0, "locked.buildInfo.configure.wasmMemoryPages");
  require(typeof buildInfo?.configure?.wasmCompileFlags === "string" && buildInfo.configure.wasmCompileFlags.length > 0, "locked.buildInfo.configure.wasmCompileFlags");
  require(Array.isArray(buildInfo?.configure?.cmakeArgs) && buildInfo.configure.cmakeArgs.length > 0, "locked.buildInfo.configure.cmakeArgs");
  require(sha(buildInfo?.configure?.cmakeCacheSha256), "locked.buildInfo.configure.cmakeCacheSha256");

  const artifactBySuffix = (artifacts, suffix) =>
    (Array.isArray(artifacts) ? artifacts : Object.values(artifacts || {})).find((entry) =>
      String(entry?.path || "").replaceAll("\\", "/").endsWith(suffix)
    );
  const jsAbi = artifactBySuffix(abiManifest?.artifacts, "cores/dolphin/dolphin-core-upstream.js");
  const wasmAbi = artifactBySuffix(abiManifest?.artifacts, "cores/dolphin/dolphin-core-upstream.wasm");
  const jsBuild = buildInfo?.artifacts?.js;
  const wasmBuild = buildInfo?.artifacts?.wasm;
  require(
    String(jsBuild?.path || "").replaceAll("\\", "/").endsWith("/dolphin-core-upstream.js"),
    "locked.buildInfo.artifacts.js.path"
  );
  require(
    String(wasmBuild?.path || "").replaceAll("\\", "/").endsWith("/dolphin-core-upstream.wasm"),
    "locked.buildInfo.artifacts.wasm.path"
  );
  require(actual.js?.path === "cores/dolphin/dolphin-core-upstream.js", "actualArtifacts.js.path");
  require(actual.wasm?.path === "cores/dolphin/dolphin-core-upstream.wasm", "actualArtifacts.wasm.path");
  require(jsAbi?.hashMode === "lf-normalized", "locked.abiManifest.artifacts.js.hashMode");
  require(jsBuild?.hashMode === "lf-normalized", "locked.buildInfo.artifacts.js.hashMode");
  require(wasmBuild?.hashMode === "raw", "locked.buildInfo.artifacts.wasm.hashMode");
  require(actual.js?.hashMode === "lf-normalized", "actualArtifacts.js.hashMode");
  require(actual.wasm?.hashMode === "raw", "actualArtifacts.wasm.hashMode");
  for (const [label, declared, observed] of [
    ["abi.js", jsAbi, actual.js],
    ["abi.wasm", wasmAbi, actual.wasm],
    ["buildInfo.js", jsBuild, { ...actual.js, size: actual.js?.rawSize }],
    ["buildInfo.wasm", wasmBuild, { ...actual.wasm, size: actual.wasm?.rawSize }],
  ]) {
    exact(declared?.sha256, observed?.sha256, `${label}.sha256`);
    exact(declared?.size, observed?.size, `${label}.size`);
  }
  exact(buildInfo?.coreId, `sha256:${actual.wasm?.sha256}`, "locked.buildInfo.coreId");
  exact(abiManifest?.coreId, `sha256:${actual.wasm?.sha256}`, "locked.abiManifest.coreId.actual");
  require(Array.isArray(buildInfo?.artifacts?.wasmSections) && buildInfo.artifacts.wasmSections.length > 0, "locked.buildInfo.artifacts.wasmSections");
  for (const [index, section] of (buildInfo?.artifacts?.wasmSections || []).entries()) {
    require(Number.isInteger(section?.id) && section.id >= 0, `locked.buildInfo.artifacts.wasmSections[${index}].id`);
    require(Number.isInteger(section?.size) && section.size >= 0, `locked.buildInfo.artifacts.wasmSections[${index}].size`);
    require(sha(section?.sha256), `locked.buildInfo.artifacts.wasmSections[${index}].sha256`);
  }

  return { verified: failures.length === 0, failures: [...new Set(failures)] };
}

export function assertServedArtifactIdentity(expectedArtifacts, servedArtifacts) {
  const names = Object.keys(expectedArtifacts || {});
  if (!names.length) throw new Error("No local application artifacts were provided for identity verification");
  const mismatches = [];
  for (const name of names) {
    const expected = expectedArtifacts[name];
    const served = servedArtifacts?.[name];
    if (!served) {
      mismatches.push(`${name}: missing from served origin`);
      continue;
    }
    if (expected.sha256 !== served.sha256 || expected.bytes !== served.bytes) {
      mismatches.push(
        `${name}: expected ${expected.sha256}/${expected.bytes}, got ${served.sha256}/${served.bytes}`
      );
    }
  }
  if (mismatches.length) throw new Error(`Served application identity mismatch: ${mismatches.join("; ")}`);
  return { verified: true, artifacts: servedArtifacts };
}

export function extractLocalModuleSpecifiers(source, relativePath) {
  const text = String(source || "");
  const specifiers = new Set();
  const extension = path.extname(relativePath).toLowerCase();
  const add = (specifier, allowBareRelative = false) => {
    if (!specifier || /^(?:[a-z]+:|#)/i.test(specifier)) return;
    if (!allowBareRelative && !specifier.startsWith(".") && !specifier.startsWith("/")) return;
    specifiers.add(specifier);
  };
  if (extension === ".html") {
    for (const match of text.matchAll(/<(?:script|link)\b[^>]*(?:src|href)=["']([^"']+)["'][^>]*>/gi)) {
      add(match[1], true);
    }
  } else {
    for (const match of text.matchAll(/\b(?:import|export)\s+(?:[^;"']*?\s+from\s*)?["']([^"']+)["']/g)) add(match[1]);
    for (const match of text.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) add(match[1]);
    for (const match of text.matchAll(/\bnew\s+URL\s*\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g)) add(match[1], true);
  }
  return [...specifiers].sort();
}

export function findFatalRuntimeEvidence({ consoleLines = [], statuses = [], renderer = {} }) {
  const evidence = [];
  const fatalPattern = /(?:webgpu[^\n]*(?:validation|device[ -]lost|uncaptured|real-clear error|show-image draw error|unavailable|\bfail(?:ed)?\b(?!\s*[:=]\s*0\b)|\bmissing\b(?!\s*[:=]\s*0\b)|threw|\berror\b(?!\s*[:=]\s*(?:0|none|<none>)\b))|emscripten abort|\baborted\(|webassembly\.(?:linkerror|runtimeerror)|(?:^|[^a-z])wasm[^\n]*(?:out of bounds|unreachable|abort|failed|error)|worker[^\n]*(?:uncaught|pageerror|rpc[^\n]*timed out)|status[^\n]*(?:failed|fatal))/i;
  const retainedStatuses = (renderer.statusHistory || []).map((entry) =>
    typeof entry === "string" ? entry : entry?.message
  );
  const retainedFatalStatuses = (renderer.fatalStatusHistory || []).map((entry) =>
    typeof entry === "string" ? entry : entry?.message
  );
  for (const line of [...consoleLines, ...statuses, ...retainedStatuses, ...retainedFatalStatuses]) {
    if (fatalPattern.test(String(line))) evidence.push(String(line));
  }
  for (const entry of renderer.errors || []) {
    if ([
      "validation",
      "uncaptured-error",
      "device-lost",
      "submit-error",
      "error-scope-failure",
      "real-clear-error",
      "show-image-draw-error",
      "wasm-link-error",
      "emscripten-abort",
    ].includes(entry.kind)) {
      evidence.push(`[renderer:${entry.kind}] ${entry.message}`);
    }
  }
  for (const line of renderer.emscriptenPrintErr || []) {
    if (fatalPattern.test(String(line))) evidence.push(`[emscripten-printErr] ${line}`);
  }
  if (
    renderer.requestedPresenterBackend === "webgpu" &&
    renderer.activePresenterBackend !== "webgpu"
  ) {
    evidence.push(
      `renderer fallback: requested presenter webgpu, active ${renderer.activePresenterBackend || "unknown"}`
    );
  }
  return [...new Set(evidence)];
}

export function parseBattleCheckpoint(framePayload) {
  const helper = String(framePayload?.ppcWasmHelperStats || "");
  const xfbHash = /\bvideo\s+xfb:\d+[^|]*\bhash:([0-9a-f]+)/i.exec(helper)?.[1]?.toLowerCase() || null;
  const loadedGeneration = Number(framePayload?.loadedCheckpointGeneration) || 0;
  const loadedTicks = Number(framePayload?.loadedCheckpointTicks);
  const loadedPpcPc = Number(framePayload?.loadedCheckpointPpcPc);
  const hasLoadedCheckpoint = loadedGeneration > 0 && Number.isFinite(loadedTicks) && Number.isFinite(loadedPpcPc);
  return {
    frame: Number(framePayload?.frame),
    coreTicks: hasLoadedCheckpoint ? loadedTicks : Number(framePayload?.coreTicks),
    ppcPc: hasLoadedCheckpoint ? loadedPpcPc : Number(framePayload?.ppcPc),
    checkpointObservationSource: hasLoadedCheckpoint ? "cpu-thread-after-load" : "legacy-worker-poll",
    loadedCheckpointGeneration: loadedGeneration,
    legacyCoreTicks: Number(framePayload?.coreTicks),
    legacyPpcPc: Number(framePayload?.ppcPc),
    xfbHash,
    width: Number(framePayload?.width),
    height: Number(framePayload?.height),
  };
}

export function assertBattleCheckpoint(checkpoint, expected = FIXED_MELEE_BATTLE_CHECKPOINT) {
  const required = ["frame", "coreTicks", "ppcPc", "xfbHash", "width", "height"];
  const missing = required.filter((field) => checkpoint?.[field] === null || checkpoint?.[field] === undefined || checkpoint?.[field] === "");
  if (missing.length) throw new Error(`Battle/XFB checkpoint is incomplete: ${missing.join(", ")}`);
  const coreTicksDeltaMin = Number.isFinite(Number(expected.coreTicksDeltaMin))
    ? Number(expected.coreTicksDeltaMin)
    : 0;
  const coreTicksDeltaMax = Number.isFinite(Number(expected.coreTicksDeltaMax))
    ? Number(expected.coreTicksDeltaMax)
    : 0;
  const coreTicksDelta = expected.coreTicks == null
    ? null
    : Number(checkpoint.coreTicks) - Number(expected.coreTicks);
  const mismatches = [];
  for (const field of required) {
    if (field === "coreTicks" && expected[field] != null) {
      if (
        !Number.isFinite(coreTicksDelta) ||
        coreTicksDelta < coreTicksDeltaMin ||
        coreTicksDelta > coreTicksDeltaMax
      ) {
        mismatches.push(
          `${field}: expected ${expected[field]}, got ${checkpoint[field]} ` +
          `(delta ${coreTicksDelta}, accepted ${coreTicksDeltaMin}..${coreTicksDeltaMax})`
        );
      }
    } else if (expected[field] != null && checkpoint[field] !== expected[field]) {
      mismatches.push(`${field}: expected ${expected[field]}, got ${checkpoint[field]}`);
    }
  }
  if (
    expected.checkpointObservationSource != null &&
    checkpoint.checkpointObservationSource !== expected.checkpointObservationSource
  ) {
    mismatches.push(
      `checkpointObservationSource: expected ${expected.checkpointObservationSource}, ` +
      `got ${checkpoint.checkpointObservationSource}`
    );
  }
  const minLoadedCheckpointGeneration = Number(expected.minLoadedCheckpointGeneration) || 0;
  if (Number(checkpoint.loadedCheckpointGeneration) < minLoadedCheckpointGeneration) {
    mismatches.push(
      `loadedCheckpointGeneration: expected >=${minLoadedCheckpointGeneration}, ` +
      `got ${checkpoint.loadedCheckpointGeneration}`
    );
  }
  if (mismatches.length) throw new Error(`Battle/XFB checkpoint mismatch: ${mismatches.join("; ")}`);
  return {
    ...checkpoint,
    expectedCoreTicks: expected.coreTicks ?? null,
    coreTicksDelta,
    coreTicksDeltaMin,
    coreTicksDeltaMax,
    verified: true,
  };
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
  const maxBlockCount = Number(value.maxBlockCount ?? (mode === "confirmation" ? 10 : blockCount));
  if (!Number.isInteger(maxBlockCount) || maxBlockCount < blockCount || maxBlockCount > 10) {
    throw new Error("maxBlockCount must be an integer from blockCount through 10");
  }
  if (mode === "screening" && maxBlockCount !== 2) {
    throw new Error("Screening maxBlockCount is fixed at 2");
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
    maxBlockCount,
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
  for (let blockIndex = 0; blockIndex < config.maxBlockCount; blockIndex += 1) {
    const order = blockIndex % 2 === 0 ? ["A", "B", "B", "A"] : ["B", "A", "A", "B"];
    const block = makeComparisonBlock(config, blockIndex + 1, order);
    if (blockIndex >= config.blockCount) block.status = "conditional";
    blocks.push(block);
  }
  return {
    schemaVersion: 1,
    mode: config.mode,
    initialValidBlocks: config.blockCount,
    maximumValidBlocks: config.maxBlockCount,
    maximumAttemptedBlocks: Math.ceil(config.maxBlockCount / 0.8),
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
  const invalidRate = blocks.length ? invalidBlocks.length / blocks.length : 0;

  let outcome = "INCOMPLETE";
  if (blocks.length >= config.blockCount && invalidRate > 0.2) {
    outcome = "INFRASTRUCTURE_INCONCLUSIVE";
  } else if (validBlocks.length >= config.blockCount) {
    const clearsEffect = medianEffectPercent >= config.minimumEffectPercent;
    const excludesZero = interval95.low > 0;
    const exactPermutationPass = permutationPValue <= 0.05;
    const resolvedReject = interval95.high < config.minimumEffectPercent;
    if (config.mode === "screening") {
      outcome = clearsEffect && medianEffectPercent > 0 ? "SCREENING_SIGNAL" : "SCREENING_REJECT";
    } else if (clearsEffect && excludesZero && exactPermutationPass) {
      outcome = "STATISTICAL_GATE_PASS";
    } else if (resolvedReject && exactPermutationPass) {
      outcome = "STATISTICAL_GATE_REJECT";
    } else if (validBlocks.length < config.maxBlockCount) {
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
    initialValidBlocks: config.blockCount,
    maximumValidBlocks: config.maxBlockCount,
    attemptedBlocks: blocks.length,
    validBlockCount: validBlocks.length,
    invalidBlockCount: invalidBlocks.length,
    invalidBlockRate: invalidRate,
    medianEffectPercent,
    interval95,
    permutationPValue,
    outcome,
    statisticalGatePassed: config.mode === "confirmation" && outcome === "STATISTICAL_GATE_PASS",
    promotable: false,
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

export function summarizeTimedMetricWindows(samples, steadyAfterSeconds) {
  const timedSamples = samples || [];
  const steadySamples = timedSamples.filter(
    (sample) => Number(sample.elapsedSeconds) >= Number(steadyAfterSeconds)
  );
  const summarize = (windowSamples) => ({
    gameSpeed: summarizeNumeric(windowSamples.map((sample) => numericValue(sample.gameSpeed))),
    coreFps: summarizeNumeric(windowSamples.map((sample) => numericValue(sample.coreFps))),
    presentationFps: summarizeNumeric(windowSamples.map((sample) => numericValue(sample.presentFps))),
    visualFps: summarizeNumeric(windowSamples.map((sample) => numericValue(sample.visualFps))),
  });
  return {
    fullTimedWindow: {
      startsAtSeconds: 0,
      sampleCount: timedSamples.length,
      metrics: summarize(timedSamples),
    },
    steadyStateWindow: {
      startsAfterSeconds: Number(steadyAfterSeconds),
      sampleCount: steadySamples.length,
      metrics: summarize(steadySamples),
    },
  };
}

export function summarizeCausalFairness(samples = [], { expectedInputEvents = 0 } = {}) {
  const timed = (samples || []).filter(Boolean);
  const first = timed[0] || {};
  const last = timed.at(-1) || {};
  const delta = (field) => {
    const before = Number(first[field]);
    const after = Number(last[field]);
    return Number.isFinite(before) && Number.isFinite(after) ? after - before : null;
  };
  const maximum = (field) => {
    const values = timed.map((sample) => Number(sample[field])).filter(Number.isFinite);
    return values.length ? Math.max(...values) : null;
  };
  const audioCounterFields = {
    workerMixCount: "causalAudioWorkerMixCount",
    workerRequestedFrames: "causalAudioWorkerRequestedFrames",
    workerReturnedFrames: "causalAudioWorkerReturnedFrames",
    workerEmptyMixCount: "causalAudioWorkerEmptyMixCount",
    pumpCount: "causalAudioPumpCount",
    pumpPendingSkipCount: "causalAudioPumpPendingSkipCount",
    pumpMissCount: "causalAudioPumpMissCount",
    underrunCount: "causalAudioUnderruns",
    overrunCount: "causalAudioOverruns",
  };
  const audioMaximumFields = {
    workerMixMaxMs: "causalAudioWorkerMixMaxMs",
    pumpGapMaxMs: "causalAudioPumpGapMaxMs",
    mixRoundTripMaxMs: "causalAudioMixRoundTripMaxMs",
  };
  const stageFields = {
    applied: "causalInputMarkerAppliedCount",
    polled: "causalInputMarkerExactCorePollCount",
    armed: "causalInputMarkerArmedCount",
    submitted: "causalInputMarkerSubmittedCount",
    completed: "causalInputMarkerCompletedCount",
  };
  const errorFields = {
    supersededCount: "causalInputMarkerSupersededCount",
    supersededArmedCount: "causalInputMarkerSupersededArmedCount",
    droppedInFlightCount: "causalInputMarkerDroppedInFlightCount",
    generationMismatchCount: "causalInputMarkerGenerationMismatchCount",
    generationUnavailableCount: "causalInputMarkerGenerationUnavailableCount",
    expiredCount: "causalInputMarkerExpiredCount",
    expiredInFlightCount: "causalInputMarkerExpiredInFlightCount",
  };
  const mapDeltas = (fields) => Object.fromEntries(
    Object.entries(fields).map(([name, field]) => [name, delta(field)])
  );
  const audioDeltas = mapDeltas(audioCounterFields);
  const stageDeltas = mapDeltas(stageFields);
  const errorDeltas = mapDeltas(errorFields);
  const gpuErrors = {
    wgpuErrorCount: delta("causalWgpuErrorCount"),
    gpuCompletionFailedCount: delta("causalGpuCompletionFailedCount"),
  };
  const expected = Math.max(0, Math.trunc(Number(expectedInputEvents) || 0));
  const requiredParityStages = ["applied", "polled", "submitted", "completed"];
  const parityPassed = expected === 0 || (
    last.causalInputMarkerEnabled === true &&
    requiredParityStages.every((name) => stageDeltas[name] === expected)
  );
  const failures = [];
  const validateDecisionDelta = (label, value) => {
    if (value === null) {
      failures.push(`missing ${label} counter delta`);
      return false;
    }
    if (value < 0) {
      failures.push(`reset ${label} counter delta=${value}`);
      return false;
    }
    return true;
  };
  validateDecisionDelta("audio empty-mix", audioDeltas.workerEmptyMixCount);
  validateDecisionDelta("WebAudio underrun", audioDeltas.underrunCount);
  for (const [name, value] of Object.entries(errorDeltas)) {
    validateDecisionDelta(`input marker ${name}`, value);
  }
  validateDecisionDelta("WGPU error", gpuErrors.wgpuErrorCount);
  validateDecisionDelta("GPU completion error", gpuErrors.gpuCompletionFailedCount);
  if (audioDeltas.workerEmptyMixCount > 0) {
    failures.push(`audio empty mixes=${audioDeltas.workerEmptyMixCount}`);
  }
  if (audioDeltas.underrunCount > 0) {
    failures.push(`new WebAudio underruns=${audioDeltas.underrunCount}`);
  }
  if (!parityPassed) {
    failures.push(
      `input marker parity expected=${expected} applied=${stageDeltas.applied} ` +
      `polled=${stageDeltas.polled} armed=${stageDeltas.armed} ` +
      `submitted=${stageDeltas.submitted} completed=${stageDeltas.completed}`
    );
  }
  for (const [name, value] of Object.entries(errorDeltas)) {
    if (value > 0) failures.push(`input marker ${name}=${value}`);
  }
  if (gpuErrors.wgpuErrorCount > 0) failures.push(`WGPU errors=${gpuErrors.wgpuErrorCount}`);
  if (gpuErrors.gpuCompletionFailedCount > 0) {
    failures.push(`GPU completion errors=${gpuErrors.gpuCompletionFailedCount}`);
  }
  return {
    sampleCount: timed.length,
    audio: {
      deltas: audioDeltas,
      extrema: {
        ...Object.fromEntries(
          Object.entries(audioMaximumFields).map(([name, field]) => [name, maximum(field)])
        ),
        scheduleLeadMinSeconds: summarizeNumeric(
          timed.map((sample) => sample.causalAudioScheduleLeadSeconds)
        )?.min ?? null,
        scheduleLeadMaxSeconds: maximum("causalAudioScheduleLeadSeconds"),
        scheduleDriftMinSeconds: summarizeNumeric(
          timed.map((sample) => sample.causalAudioScheduleDriftSeconds)
        )?.min ?? null,
        scheduleDriftMaxSeconds: maximum("causalAudioScheduleDriftSeconds"),
      },
    },
    inputMarker: {
      expectedCount: expected,
      enabled: last.causalInputMarkerEnabled === true,
      stageDeltas,
      errorDeltas,
      final: {
        pendingGeneration: Number(last.causalInputMarkerPendingGeneration) || 0,
        activeGeneration: Number(last.causalInputMarkerActiveGeneration) || 0,
        inFlightCount: Number(last.causalInputMarkerInFlightCount) || 0,
      },
      parityPassed,
    },
    gpuErrors,
    failures,
  };
}

export function classifyGateOutcome({
  failureCount = 0,
  qualificationEligible = false,
  comparisonMode = null,
  statisticalGatePassed = false,
  targetPassed = false,
}) {
  if (failureCount > 0) {
    return { verdict: "FAIL", exitCode: 1, qualificationPassed: false, promotable: false };
  }
  const experimentEligible = comparisonMode == null
    ? true
    : comparisonMode === "confirmation" && statisticalGatePassed;
  const qualificationPassed = Boolean(qualificationEligible && targetPassed && experimentEligible);
  if (!qualificationPassed) {
    return { verdict: "NON_QUALIFYING", exitCode: 2, qualificationPassed: false, promotable: false };
  }
  return {
    verdict: "PASS",
    exitCode: 0,
    qualificationPassed: true,
    promotable: comparisonMode === "confirmation" && statisticalGatePassed,
  };
}

export function evaluateRunValidity({ invalidReasons = [], failures = [], consoleErrors = [] }) {
  const reasons = [
    ...invalidReasons,
    ...failures.map((failure) => `run failure: ${failure}`),
    ...consoleErrors.map((error) => `console error: ${error}`),
  ].filter(Boolean);
  const uniqueReasons = [...new Set(reasons)];
  return { valid: uniqueReasons.length === 0, invalidReasons: uniqueReasons };
}

export function summarizeJitMetrics(samples = []) {
  const maximumField = (name) => Math.max(0, ...samples.map((sample) => Number(sample?.[name]) || 0));
  const maximumHelper = (pattern) => {
    let maximum = 0;
    for (const sample of samples) {
      const match = pattern.exec(String(sample?.helper || ""));
      if (match) maximum = Math.max(maximum, Number(match[1]) || 0);
    }
    return maximum;
  };
  const exportedCompileCount = maximumField("ppcWasmBlockCompileCount");
  const exportedRunCount = maximumField("ppcWasmBlockRunCount");
  const helperAttemptCount = maximumHelper(/\bjit attempts:(\d+)/);
  const helperCompileCount = maximumHelper(/\bcompiled:(\d+)/);
  const emitFailureCount = maximumHelper(/\bemitfail:(\d+)/);
  const compileFailureCount = maximumHelper(/\bcompilefail:(\d+)/);
  const activeSampleCount = samples.filter((sample) => /\bjit:on\b/.test(String(sample?.helper || ""))).length;
  return {
    exportedCompileCount,
    exportedRunCount,
    helperAttemptCount,
    helperCompileCount,
    emitFailureCount,
    compileFailureCount,
    activeSampleCount,
    runToCompileRatio: exportedCompileCount > 0 ? exportedRunCount / exportedCompileCount : null,
    countersConsistent: exportedCompileCount === helperCompileCount,
  };
}

export function evaluateMetricsModeEvidence({ requested, diagnostics = {}, samples = [] } = {}) {
  const enabled = String(requested) === "1";
  const failures = [];
  const counters = ["helperStatsCalls", "profileStatsCalls", "profileTimeSamples"];
  if (diagnostics.enabled !== enabled) {
    failures.push(`requested metrics=${enabled ? 1 : 0}, renderer reported enabled=${diagnostics.enabled}`);
  }
  for (const name of counters) {
    const value = Number(diagnostics[name]);
    if (enabled ? !(value > 0) : value !== 0) {
      failures.push(`metrics=${enabled ? 1 : 0} activation mismatch: ${name}=${diagnostics[name]}`);
    }
  }
  const marker = `metrics:${enabled ? "on" : "off"}`;
  if (!samples.some((sample) => String(sample.helper || "").includes(marker))) {
    failures.push(`metrics=${enabled ? 1 : 0} activation marker ${marker} was not sampled`);
  }
  if (enabled) {
    if (samples.some((sample) => sample.causalTelemetrySchemaVersion !== CAUSAL_TELEMETRY_SCHEMA_VERSION)) {
      failures.push(
        `missing or unsupported causal telemetry schema (expected ${CAUSAL_TELEMETRY_SCHEMA_VERSION})`
      );
    }
  } else if (
    samples.some(
      (sample) => sample.causalTelemetrySchemaVersion != null || sample.causalTelemetry != null
    )
  ) {
    failures.push("metrics=0 activation mismatch: causal telemetry was present");
  }
  return { enabled, failures };
}

export function evaluateSoftwareRasterInstrumentationEvidence({ required = false, samples = [] } = {}) {
  if (!required) return { required: false, activated: false, maxima: {}, failures: [] };

  const rasterSamples = samples
    .map((sample) => sample?.causalTelemetry?.softwareRaster)
    .filter((value) => value && typeof value === "object");
  const fields = [
    "rasterTraversalCount",
    "rasterTraversalTimedSampleCount",
    "tevPixelCount",
    "tevTimedSampleCount",
    "textureSampleCount",
    "textureTimedSampleCount",
    "fifoAgeSampleCount",
    "xfbGenerationCount",
    "frameGenerationCount",
    "sampledSourceFrameCount",
  ];
  const maxima = Object.fromEntries(
    fields.map((field) => [
      field,
      Math.max(0, ...rasterSamples.map((sample) => Number(sample[field]) || 0)),
    ])
  );
  const missing = fields.filter((field) => !(maxima[field] > 0));
  const profileEnabled = rasterSamples.some((sample) => sample.profileEnabled === true);
  const failures = [];
  if (!profileEnabled) failures.push("software raster profileEnabled=true was not sampled");
  if (missing.length) failures.push(`software raster counters did not activate: ${missing.join(", ")}`);
  return {
    required: true,
    activated: profileEnabled && missing.length === 0,
    maxima,
    failures,
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

export function resolveCoreArtifactPath(root, urlValue) {
  const requested = new URL(urlValue, "http://127.0.0.1/")
    .searchParams.get("coreid")
    ?.toLowerCase()
    .replace(/^sha256:/, "") ?? "";
  if (!requested) {
    return path.join(root, "cores", "dolphin", "dolphin-core-upstream.wasm");
  }
  if (!/^[0-9a-f]{64}$/.test(requested)) {
    throw new Error("coreid must be a SHA-256 content hash");
  }
  return path.join(
    root,
    "build",
    "core-candidates",
    requested,
    "dolphin-core-upstream.wasm"
  );
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

function numericValue(value) {
  const number = Number.parseFloat(String(value ?? "").replace("%", ""));
  return Number.isFinite(number) ? number : NaN;
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
