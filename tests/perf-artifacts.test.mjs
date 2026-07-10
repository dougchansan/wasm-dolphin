import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FIXED_MELEE_BATTLE_FIXTURE,
  assertBattleCheckpoint,
  assertRunProvenance,
  assertServedArtifactIdentity,
  buildComparisonTasklist,
  buildReplacementBlock,
  classifyGateOutcome,
  evaluateQualificationProvenance,
  evaluateRunValidity,
  extractLocalModuleSpecifiers,
  findFatalRuntimeEvidence,
  parseProfileMetrics,
  parseBattleCheckpoint,
  recordsToCsv,
  summarizeComparison,
  summarizeNumeric,
  summarizeTimedMetricWindows,
  validateLockedBuildProvenance,
  verifyFileFixture,
} from "../tools/perf-artifacts.mjs";

test("profile parser separates core, XFB, publish, and JS presentation costs", () => {
  const helper =
    "video xfb:10 coreprof xfb_dt:16.7 avg:17.1 max:41.2 decode:1.3 avg:1.4 max:2.8 " +
    "vo_sync:0.1/max4.2 vo_pub:1.5/max3.1 vo_total:1.6/max5.0 " +
    "swxfb:0.9 conv:0.8 copy:0.1 sz:640x480->480 | jit:on";
  const frame =
    "loop:0.35 pump:0.02 run:0.10 api:0.03 cap:0.50 copy:0.40 " +
    "present:1.90 draw:1.20 hash:0.08 paced:0.04 copy:73.2MB/s cap:30 shown:29";

  assert.deepEqual(parseProfileMetrics(helper, frame), {
    coreXfbIntervalMs: 16.7,
    coreXfbAverageIntervalMs: 17.1,
    coreXfbMaxIntervalMs: 41.2,
    coreXfbDecodeMs: 1.3,
    coreXfbAverageDecodeMs: 1.4,
    coreXfbMaxDecodeMs: 2.8,
    videoOutputSyncMs: 0.1,
    videoOutputMaxSyncMs: 4.2,
    videoOutputPublishMs: 1.5,
    videoOutputMaxPublishMs: 3.1,
    videoOutputTotalMs: 1.6,
    videoOutputMaxTotalMs: 5,
    softwareXfbTotalMs: 0.9,
    softwareXfbConvertMs: 0.8,
    softwareXfbCopyMs: 0.1,
    jsLoopMs: 0.35,
    jsPumpMs: 0.02,
    jsRunMs: 0.1,
    jsApiMs: 0.03,
    jsCaptureMs: 0.5,
    jsCopyMs: 0.4,
    jsPresentMs: 1.9,
    jsDrawMs: 1.2,
    jsHashMs: 0.08,
    jsPacedMs: 0.04,
    jsCopyMegabytesPerSecond: 73.2,
    jsCaptureCount: 30,
    jsPresentCount: 29,
  });
});

test("profile parser uses nulls when a backend does not emit a profile", () => {
  const parsed = parseProfileMetrics("jit:warmup", "-");
  assert.equal(parsed.coreXfbIntervalMs, null);
  assert.equal(parsed.softwareXfbTotalMs, null);
  assert.equal(parsed.jsPresentMs, null);
});

test("CSV output preserves arrays, commas, quotes, and newlines", () => {
  const csv = recordsToCsv([
    { run: 1, note: 'hello, "GPU"', histogram: [1, 2] },
    { run: 2, note: "line1\nline2", histogram: null },
  ]);
  assert.equal(
    csv,
    'run,note,histogram\n1,"hello, ""GPU""","[1,2]"\n2,"line1\nline2",\n'
  );
});

test("fixture verification rejects missing and hash-mismatched files", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wasm-dolphin-fixture-"));
  const fixturePath = path.join(directory, "fixture.sav");
  try {
    await assert.rejects(
      verifyFileFixture(fixturePath, { label: "battle save", expectedSha256: "0".repeat(64) }),
      /Missing battle save/
    );
    await writeFile(fixturePath, "Kirby versus Link");
    await assert.rejects(
      verifyFileFixture(fixturePath, { label: "battle save", expectedSha256: "0".repeat(64) }),
      /SHA-256 mismatch/
    );
    const expectedSha256 = createHash("sha256").update("Kirby versus Link").digest("hex");
    const verified = await verifyFileFixture(fixturePath, { label: "battle save", expectedSha256 });
    assert.equal(verified.verified, true);
    assert.equal(verified.sha256, expectedSha256);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fixed-battle provenance rejects missing fields and premature timing", () => {
  const manifest = validManifest();
  delete manifest.artifacts.core.sha256;
  assert.throws(() => assertRunProvenance(manifest), /artifacts\.core\.sha256/);

  const premature = validManifest();
  premature.benchmark.saveStateAt = 1;
  assert.throws(() => assertRunProvenance(premature), /saveStateAt=0/);

  const menuDriven = validManifest();
  menuDriven.benchmark.inputScriptMode = "scripted";
  assert.throws(() => assertRunProvenance(menuDriven), /inputScriptMode=none/);

  const labelOnly = validManifest();
  labelOnly.fixture.battleCheckpoint.verified = false;
  assert.throws(() => assertRunProvenance(labelOnly), /battle\/XFB checkpoint/);

  const unknownTelemetry = validManifest();
  unknownTelemetry.causalTelemetrySchema.version = 2;
  assert.throws(() => assertRunProvenance(unknownTelemetry), /Unsupported causal telemetry schema/);

  assert.equal(assertRunProvenance(validManifest()).fixture.saveStateLoaded, true);
});

test("served identity and observed battle checkpoint reject mismatches", () => {
  const local = { app: { sha256: "a".repeat(64), bytes: 12 } };
  assert.equal(assertServedArtifactIdentity(local, structuredClone(local)).verified, true);
  assert.throws(
    () => assertServedArtifactIdentity(local, { app: { sha256: "b".repeat(64), bytes: 12 } }),
    /identity mismatch/
  );

  const checkpoint = parseBattleCheckpoint({
    frame: 77,
    coreTicks: 123456,
    ppcPc: 0x80300000,
    width: 640,
    height: 480,
    ppcWasmHelperStats: "video xfb:77 640x480 hash:deadbeef nz:2048 | jit:off",
  });
  assert.equal(
    assertBattleCheckpoint(checkpoint, {
      frame: 77,
      coreTicks: 123456,
      xfbHash: "deadbeef",
      width: 640,
      height: 480,
    }).verified,
    true
  );
  assert.throws(
    () => assertBattleCheckpoint(checkpoint, { ...checkpoint, xfbHash: "bad0cafe" }),
    /xfbHash/
  );

  const fixed = {
    frame: 89,
    coreTicks: 15166162443,
    ppcPc: -2144030364,
    xfbHash: "4b2d0a3b",
    width: 640,
    height: 480,
  };
  assert.equal(assertBattleCheckpoint(fixed).verified, true);
  assert.equal(assertBattleCheckpoint({ ...fixed, frame: 95 }).verified, true);
  assert.throws(() => assertBattleCheckpoint({ ...fixed, coreTicks: fixed.coreTicks + 1 }), /coreTicks/);
});

test("battle checkpoint prefers the CPU-thread after-load capture and retains the legacy poll", () => {
  const checkpoint = parseBattleCheckpoint({
    frame: 77,
    coreTicks: 15166151316,
    ppcPc: -1,
    loadedCheckpointGeneration: 3,
    loadedCheckpointTicks: 15166162443,
    loadedCheckpointPpcPc: -2144030364,
    width: 640,
    height: 480,
    ppcWasmHelperStats: "video xfb:77 640x480 hash:4b2d0a3b nz:2048",
  });
  assert.equal(checkpoint.coreTicks, 15166162443);
  assert.equal(checkpoint.ppcPc, -2144030364);
  assert.equal(checkpoint.checkpointObservationSource, "cpu-thread-after-load");
  assert.equal(checkpoint.legacyCoreTicks, 15166151316);
  assert.equal(checkpoint.legacyPpcPc, -1);
});

test("served closure extraction includes core-host and detects a changed dependency", () => {
  assert.deepEqual(
    extractLocalModuleSpecifiers(
      'import { EmulatorHost } from "./core-host.js";\nnew Worker(new URL("./worker.js", import.meta.url));\nnew URL("core.wasm", import.meta.url);',
      "src/app.js"
    ),
    ["./core-host.js", "./worker.js", "core.wasm"]
  );
  const expected = {
    "src/app.js": { sha256: "a".repeat(64), bytes: 100 },
    "src/core-host.js": { sha256: "b".repeat(64), bytes: 200 },
  };
  assert.throws(
    () => assertServedArtifactIdentity(expected, {
      ...expected,
      "src/core-host.js": { sha256: "c".repeat(64), bytes: 200 },
    }),
    /core-host\.js/
  );
});

test("all retained WebGPU, WASM LinkError, and fallback evidence is fatal", () => {
  const evidence = findFatalRuntimeEvidence({
    consoleLines: [
      "[webgpu-exec] VALIDATION: bind group layout mismatch",
      "WebAssembly.LinkError: import object field is not callable",
    ],
    statuses: [
      "WebGPU real-clear error: command encoder invalid",
      "webgpu-show-image draw error: texture destroyed",
      "status failed: WebAssembly RuntimeError",
    ],
    renderer: {
      requestedPresenterBackend: "webgpu",
      activePresenterBackend: "webgl",
      errors: [{ kind: "device-lost", message: "destroyed" }],
      emscriptenPrintErr: [
        "Aborted(out of bounds memory access)",
        "WebGPU validation error: bind group incompatible",
      ],
      statusHistory: [{ message: "worker RPC rendererDiagnostics timed out after 10000 ms" }],
      fatalStatusHistory: [{ message: "WebGPU uncaptured validation error: stale status" }],
    },
  });
  assert.ok(evidence.some((line) => line.includes("VALIDATION")));
  assert.ok(evidence.some((line) => line.includes("WebAssembly.LinkError")));
  assert.ok(evidence.some((line) => line.includes("real-clear error")));
  assert.ok(evidence.some((line) => line.includes("show-image draw error")));
  assert.ok(evidence.some((line) => line.includes("device-lost")));
  assert.ok(evidence.some((line) => line.includes("renderer fallback")));
  assert.ok(evidence.some((line) => line.includes("emscripten-printErr")));
  assert.ok(evidence.some((line) => line.includes("timed out")));
  assert.ok(evidence.some((line) => line.includes("stale status")));
});

test("successful WebGPU counters are not mistaken for fatal evidence", () => {
  const evidence = findFatalRuntimeEvidence({
    consoleLines: [
      "[webgpu-shader] ok=33 fail=0 (stage=0 xlat=1 id=143) firstErr=<none>",
      "[webgpu-cmd-shader] module id=4 stage=2 compiled OK [ok=4 fail=0]",
      "[webgpu-pcfg] variant OK 13|bgra8unorm|null|rz0 [ok=3 fail=0]",
    ],
    statuses: [],
    renderer: { errors: [], emscriptenPrintErr: [], statusHistory: [], fatalStatusHistory: [] },
  });

  assert.deepEqual(evidence, []);
});

test("worker diagnostics structurally retain fatal catches and RPCs are bounded", async () => {
  const [workerSource, gateSource] = await Promise.all([
    readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8"),
    readFile(new URL("../tools/perf-regression-gate.mjs", import.meta.url), "utf8"),
  ]);
  for (const token of [
    "requestedVideoBackend",
    "activeVideoBackend",
    "requestedPresenterBackend",
    "activePresenterBackend",
    "fatalStatusHistory",
    'recordRendererError("real-clear-error"',
    'recordRendererError("show-image-draw-error"',
    'recordRendererError("wasm-link-error"',
  ]) assert.match(workerSource, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(gateSource, /Worker RPC \$\{type\} timed out after \$\{timeoutMs\} ms/);
  assert.match(gateSource, /requestWorkerRpc\(page, "rendererDiagnostics"\)/);
  assert.match(gateSource, /loadStateFileWithTimeout\(page/);
  assert.match(
    gateSource,
    /renderer = withExpectedRendererIdentity\(await readRendererDiagnostics\(page\), scenario\.params\);\s+manifest\.renderer = renderer;\s+const battleCheckpoint = assertBattleCheckpoint/
  );
});

test("locked build provenance rejects valid-looking source, toolchain, and JS mutations", () => {
  const provenance = validLockedBuildProvenance();
  assert.deepEqual(validateLockedBuildProvenance(provenance), { verified: true, failures: [] });

  const sourceMutation = structuredClone(provenance);
  sourceMutation.locked.buildInfo.source.upstreamCommit = "9".repeat(40);
  assert.equal(validateLockedBuildProvenance(sourceMutation).verified, false);

  const toolchainMutation = structuredClone(provenance);
  toolchainMutation.locked.buildInfo.toolchain.ninjaVersion = "1.13.0";
  assert.equal(validateLockedBuildProvenance(toolchainMutation).verified, false);

  const jsMutation = structuredClone(provenance);
  jsMutation.actualArtifacts.js.sha256 = "0".repeat(64);
  const jsResult = validateLockedBuildProvenance(jsMutation);
  assert.equal(jsResult.verified, false);
  assert.ok(jsResult.failures.some((failure) => failure.includes("js.sha256")));

  const pendingRebuild = structuredClone(provenance);
  pendingRebuild.locked.abiManifest.sourceOnlyExportsPendingRebuild = ["_GetLastLoadedCoreTicksLow"];
  const pendingResult = validateLockedBuildProvenance(pendingRebuild);
  assert.equal(pendingResult.verified, false);
  assert.ok(pendingResult.failures.some((failure) => failure.includes("sourceOnlyExportsPendingRebuild")));
});

test("qualification requires clean git, exact video/presenter identity, and locked evidence", () => {
  const manifest = validManifest();
  manifest.browser.headed = false;
  manifest.browser.profileId = "ephemeral-run-1";
  manifest.browser.executablePath = "C:/Chrome/chrome.exe";
  manifest.browser.actualChannel = "chrome";
  manifest.renderer = {
    expectedVideoBackend: "Software Renderer",
    requestedVideoBackend: "Software Renderer",
    activeVideoBackend: "Software Renderer",
    expectedRequestedPresenterBackend: "webgpu",
    expectedActivePresenterBackend: "webgpu",
    requestedPresenterBackend: "webgpu",
    activePresenterBackend: "webgpu",
    adapter: { selected: true, vendor: "test-vendor" },
    device: { created: true },
  };
  manifest.benchmark.cacheState = "cold";
  manifest.hostCore = { abiVersion: 1 };
  manifest.eventSchema = { version: 1 };
  manifest.causalTelemetrySchema = { version: 1 };
  manifest.buildProvenance = validLockedBuildProvenance();
  manifest.upstream = { dolphinSha: manifest.buildProvenance.locked.sourceLock.upstream.commit };
  manifest.patches = { hashes: manifest.buildProvenance.locked.sourceLock.patches.map((patch) => patch.sha256) };
  manifest.toolchain = manifest.buildProvenance.locked.toolchainLock;
  assert.equal(evaluateQualificationProvenance(manifest).eligible, false);
  assert.ok(evaluateQualificationProvenance(manifest).missing.includes("browser.headed=true"));
  manifest.browser.headed = true;
  assert.equal(evaluateQualificationProvenance(manifest).eligible, true);

  const dirty = structuredClone(manifest);
  dirty.git.dirty = true;
  assert.ok(evaluateQualificationProvenance(dirty).missing.includes("git.dirty=false"));

  const videoMismatch = structuredClone(manifest);
  videoMismatch.renderer.activeVideoBackend = "WebGPU-Real";
  assert.ok(
    evaluateQualificationProvenance(videoMismatch).missing.includes(
      "renderer.activeVideoBackend=Software Renderer"
    )
  );

  const forgedEnvironment = structuredClone(manifest);
  forgedEnvironment.buildProvenance.untrustedEnvironmentOverrides = {
    UPSTREAM_DOLPHIN_SHA: "9".repeat(40),
    HOST_CORE_ABI_VERSION: "999",
  };
  assert.equal(evaluateQualificationProvenance(forgedEnvironment).eligible, true);

  const forgedManifest = structuredClone(manifest);
  forgedManifest.buildProvenance.locked.buildInfo.source.patchSeriesSha256 = "8".repeat(64);
  forgedManifest.buildProvenance.verification.verified = true;
  assert.equal(evaluateQualificationProvenance(forgedManifest).eligible, false);
});

test("headless, screening, and unresolved statistics cannot report qualification success", () => {
  assert.deepEqual(classifyGateOutcome({
    qualificationEligible: false,
    targetPassed: true,
  }), { verdict: "NON_QUALIFYING", exitCode: 2, qualificationPassed: false, promotable: false });
  assert.equal(classifyGateOutcome({
    qualificationEligible: true,
    targetPassed: true,
    comparisonMode: "screening",
    statisticalGatePassed: true,
  }).verdict, "NON_QUALIFYING");
  assert.equal(classifyGateOutcome({
    qualificationEligible: true,
    targetPassed: true,
    comparisonMode: "confirmation",
    statisticalGatePassed: false,
  }).exitCode, 2);
  assert.deepEqual(classifyGateOutcome({
    qualificationEligible: true,
    targetPassed: true,
    comparisonMode: "confirmation",
    statisticalGatePassed: true,
  }), { verdict: "PASS", exitCode: 0, qualificationPassed: true, promotable: true });
});

test("comparison run validity includes assertions and page/worker console errors", () => {
  assert.deepEqual(evaluateRunValidity({}), { valid: true, invalidReasons: [] });
  const result = evaluateRunValidity({
    invalidReasons: ["save load failed"],
    failures: ["compilefail=1"],
    consoleErrors: ["[worker:core:error] device lost"],
  });
  assert.equal(result.valid, false);
  assert.deepEqual(result.invalidReasons, [
    "save load failed",
    "run failure: compilefail=1",
    "console error: [worker:core:error] device lost",
  ]);
});

test("comparison tasklist alternates complete four-run blocks and is bounded", () => {
  const config = comparisonConfig({ mode: "screening", blockCount: 2 });
  const tasklist = buildComparisonTasklist(config);
  assert.deepEqual(tasklist.blocks.map((block) => block.order), [
    ["A", "B", "B", "A"],
    ["B", "A", "A", "B"],
  ]);
  assert.equal(tasklist.blocks.flatMap((block) => block.runs).length, 8);
  assert.equal(tasklist.maximumAttemptedBlocks, 3);
  assert.throws(
    () => buildComparisonTasklist(comparisonConfig({ mode: "screening", blockCount: 3 })),
    /exactly 2/
  );
  assert.throws(
    () => buildComparisonTasklist(comparisonConfig({ mode: "confirmation", blockCount: 11 })),
    /5 to 10/
  );

  const confirmation = buildComparisonTasklist(comparisonConfig({ mode: "confirmation", blockCount: 5 }));
  assert.equal(confirmation.blocks.length, 10);
  assert.equal(confirmation.blocks.filter((block) => block.status === "pending").length, 5);
  assert.equal(confirmation.blocks.filter((block) => block.status === "conditional").length, 5);
});

test("replacement blocks preserve the complete invalid block order", () => {
  const config = comparisonConfig({ mode: "confirmation", blockCount: 5 });
  const invalid = buildComparisonTasklist(config).blocks[0];
  const replacement = buildReplacementBlock(config, invalid);
  assert.deepEqual(replacement.order, invalid.order);
  assert.equal(replacement.replaces, invalid.blockId);
  assert.equal(replacement.runs.length, 4);
  assert.ok(replacement.runs.every((run) => run.blockId === replacement.blockId));
});

test("screening block effects are sign-normalized but never promotable", () => {
  const config = comparisonConfig({ mode: "screening", blockCount: 2 });
  const runs = makeRuns(config, [
    { a: [100, 102], b: [110, 112] },
    { a: [101, 103], b: [111, 113] },
  ]);
  const report = summarizeComparison(config, runs);
  assert.equal(report.validBlockCount, 2);
  assert.equal(report.outcome, "SCREENING_SIGNAL");
  assert.equal(report.promotable, false);
  assert.ok(report.medianEffectPercent > 8);

  const lowerIsBetter = { ...config, direction: "lower" };
  const lowerReport = summarizeComparison(lowerIsBetter, makeRuns(lowerIsBetter, [
    { a: [20, 20], b: [10, 10] },
    { a: [22, 22], b: [11, 11] },
  ]));
  assert.ok(lowerReport.medianEffectPercent > 0);
});

test("confirmation extends beyond five blocks until exact permutation evidence resolves", () => {
  const passing = comparisonConfig({ mode: "confirmation", blockCount: 5 });
  const fiveBlockReport = summarizeComparison(
    passing,
    makeRuns(passing, Array.from({ length: 5 }, (_, index) => ({
      a: [100 + index, 100 + index],
      b: [108 + index, 108 + index],
    })))
  );
  assert.equal(fiveBlockReport.permutationPValue, 0.0625);
  assert.equal(fiveBlockReport.outcome, "NEEDS_MORE_BLOCKS");
  assert.equal(fiveBlockReport.promotable, false);

  const passReport = summarizeComparison(
    passing,
    makeRuns(passing, Array.from({ length: 6 }, (_, index) => ({
      a: [100 + index, 100 + index],
      b: [108 + index, 108 + index],
    })))
  );
  assert.equal(passReport.outcome, "STATISTICAL_GATE_PASS");
  assert.equal(passReport.statisticalGatePassed, true);
  assert.equal(passReport.promotable, false);
  assert.ok(passReport.permutationPValue <= 0.05);
  assert.ok(passReport.interval95.low > 0);

  const unresolved = comparisonConfig({ mode: "confirmation", blockCount: 10 });
  const unresolvedReport = summarizeComparison(
    unresolved,
    makeRuns(unresolved, Array.from({ length: 10 }, (_, index) => ({
      a: [100, 100],
      b: index % 2 === 0 ? [102, 102] : [98, 98],
    })))
  );
  assert.equal(unresolvedReport.outcome, "INCONCLUSIVE");
  assert.equal(unresolvedReport.promotable, false);
  assert.ok(unresolvedReport.interval95.low <= 0);
  assert.ok(unresolvedReport.interval95.high >= 0);
});

test("one invalid run invalidates its whole block and trips the screening stop", () => {
  const config = comparisonConfig({ mode: "screening", blockCount: 2 });
  const runs = makeRuns(config, [
    { a: [100, 100], b: [104, 104] },
    { a: [100, 100], b: [104, 104] },
  ]);
  runs[1].valid = false;
  runs[1].invalidReasons = ["browser crashed"];
  const report = summarizeComparison(config, runs);
  assert.equal(report.invalidBlockCount, 1);
  assert.equal(report.validBlockCount, 1);
  assert.equal(report.outcome, "INFRASTRUCTURE_INCONCLUSIVE");
});

test("numeric summaries retain the full run distribution", () => {
  assert.deepEqual(summarizeNumeric([1, 2, 3, 4, "bad"]), {
    count: 4,
    min: 1,
    mean: 2.5,
    p50: 2.5,
    p95: 3.8499999999999996,
    p99: 3.9699999999999998,
    max: 4,
  });
});

test("full timed metrics never silently discard the pre-steady-state window", () => {
  const windows = summarizeTimedMetricWindows([
    { elapsedSeconds: 0, gameSpeed: 50, coreFps: 30, presentFps: 20, visualFps: 10 },
    { elapsedSeconds: 5, gameSpeed: 100, coreFps: 60, presentFps: 40, visualFps: 20 },
  ], 5);
  assert.equal(windows.fullTimedWindow.sampleCount, 2);
  assert.equal(windows.fullTimedWindow.metrics.gameSpeed.mean, 75);
  assert.equal(windows.steadyStateWindow.sampleCount, 1);
  assert.equal(windows.steadyStateWindow.metrics.gameSpeed.mean, 100);
});

function validLockedBuildProvenance() {
  const hashes = {
    toolchainLock: "a".repeat(64),
    vendorSnapshot: "b".repeat(64),
    cargoLock: "c".repeat(64),
    buildInfo: "d".repeat(64),
    sourceLock: "e".repeat(64),
    abiManifest: "f".repeat(64),
    patchSeries: "9".repeat(64),
    patch: "8".repeat(64),
    js: "7".repeat(64),
    wasm: "6".repeat(64),
    cmakeCache: "5".repeat(64),
    section: "4".repeat(64),
  };
  const upstreamCommit = "1".repeat(40);
  const toolchainLock = {
    schemaVersion: 1,
    platform: "win32-x64",
    node: { version: "24.12.0", sha256: hashes.patch },
    emscripten: {
      version: "5.0.7",
      compilerCommit: "2".repeat(40),
      emsdkCommit: "3".repeat(40),
      emccSha256: hashes.patch,
      emcmakeSha256: hashes.patch,
      clangxxSha256: hashes.patch,
    },
    cmake: { version: "4.3.2", sha256: hashes.patch },
    ninja: { version: "1.13.0.git.kitware.jobserver-pipe-1", sha256: hashes.patch },
    rust: {
      target: "wasm32-unknown-emscripten",
      rustcVersion: "1.97.0-nightly",
      rustcCommit: "4".repeat(40),
      rustcSha256: hashes.patch,
      cargoVersion: "1.97.0-nightly",
      cargoCommit: "5".repeat(40),
      cargoSha256: hashes.patch,
      rustupSha256: hashes.patch,
    },
    naga: { crateVersion: "0.1.0", dependencyVersion: "26.0.0", cargoLockSha256: hashes.cargoLock },
  };
  const sourceLock = {
    schemaVersion: 1,
    upstream: { commit: upstreamCommit },
    patchSeriesSha256: hashes.patchSeries,
    patches: [{ order: 1, path: "patches/one.patch", hashMode: "lf-normalized", sha256: hashes.patch }],
  };
  const abiManifest = {
    schemaVersion: 1,
    abiVersion: 1,
    coreId: `sha256:${hashes.wasm}`,
    upstreamCommit,
    artifacts: [
      {
        path: "cores/dolphin/dolphin-core-upstream.js",
        hashMode: "lf-normalized",
        size: 123,
        sha256: hashes.js,
      },
      {
        path: "cores/dolphin/dolphin-core-upstream.wasm",
        size: 456,
        sha256: hashes.wasm,
      },
    ],
    contractSources: [
      {
        path: "src/upstream-worker-protocol.js",
        hashMode: "lf-normalized",
        size: 42,
        sha256: hashes.section,
      },
    ],
  };
  const vendorSnapshot = {
    schemaVersion: 1,
    root: { baseCommit: upstreamCommit, resultTree: "5".repeat(40) },
  };
  const buildInfo = {
    schemaVersion: 1,
    createdAt: "2026-07-09T00:00:00.000Z",
    coreId: `sha256:${hashes.wasm}`,
    repository: { commit: "6".repeat(40), status: "" },
    source: {
      upstreamCommit,
      patchSeriesSha256: hashes.patchSeries,
      sourceLockSha256: hashes.sourceLock,
      vendorSnapshotSha256: hashes.vendorSnapshot,
      vendorResultTree: vendorSnapshot.root.resultTree,
    },
    toolchain: {
      lockSha256: hashes.toolchainLock,
      emscriptenVersion: toolchainLock.emscripten.version,
      emscriptenCompilerCommit: toolchainLock.emscripten.compilerCommit,
      emsdkCommit: toolchainLock.emscripten.emsdkCommit,
      cmakeVersion: toolchainLock.cmake.version,
      ninjaVersion: toolchainLock.ninja.version,
      rustcVersion: toolchainLock.rust.rustcVersion,
      rustcCommit: toolchainLock.rust.rustcCommit,
      cargoVersion: toolchainLock.rust.cargoVersion,
      nagaDependencyVersion: toolchainLock.naga.dependencyVersion,
      cargoLockSha256: toolchainLock.naga.cargoLockSha256,
    },
    configure: {
      wasmMemoryPages: 24576,
      wasmCompileFlags: "-O3 -pthread -msimd128 -flto",
      cmakeArgs: ["-DCMAKE_BUILD_TYPE=Release"],
      cmakeCacheSha256: hashes.cmakeCache,
    },
    artifacts: {
      js: {
        path: "C:/build/dolphin-core-upstream.js",
        hashMode: "lf-normalized",
        size: 123,
        sha256: hashes.js,
      },
      wasm: {
        path: "C:/build/dolphin-core-upstream.wasm",
        hashMode: "raw",
        size: 456,
        sha256: hashes.wasm,
      },
      wasmSections: [{ id: 1, size: 32, sha256: hashes.section }],
    },
  };
  const evidenceFiles = {
    buildInfo: evidence("cores/dolphin/dolphin-core-upstream.build.json", hashes.buildInfo, false),
    sourceLock: evidence("provenance/dolphin-source.lock.json", hashes.sourceLock),
    abiManifest: evidence("provenance/dolphin-core-abi-v1.json", hashes.abiManifest),
    toolchainLock: evidence("provenance/wasm-toolchain.lock.json", hashes.toolchainLock),
    vendorSnapshot: evidence("provenance/dolphin-vendor-snapshot-v1.json", hashes.vendorSnapshot),
    nagaCargoLock: {
      ...evidence("tools/naga-spirv-wgsl/Cargo.lock", hashes.cargoLock),
      normalizedSha256: hashes.cargoLock,
    },
  };
  const provenance = {
    source: "cores/dolphin/dolphin-core-upstream.build.json",
    locked: { buildInfo, sourceLock, abiManifest, toolchainLock, vendorSnapshot },
    actualArtifacts: {
      js: { path: "cores/dolphin/dolphin-core-upstream.js", hashMode: "lf-normalized", size: 123, rawSize: 123, sha256: hashes.js },
      wasm: { path: "cores/dolphin/dolphin-core-upstream.wasm", hashMode: "raw", size: 456, rawSize: 456, sha256: hashes.wasm },
    },
    actualContractSources: {
      "src/upstream-worker-protocol.js": {
        path: "src/upstream-worker-protocol.js",
        hashMode: "lf-normalized",
        size: 42,
        sha256: hashes.section,
      },
    },
    evidenceFiles,
    evidenceBundle: Object.entries(evidenceFiles).map(([key, entry]) => ({
      key,
      path: `build-provenance/${key}.json`,
      bytes: entry.bytes,
      sha256: entry.sha256,
    })),
    untrustedEnvironmentOverrides: {},
  };
  provenance.verification = validateLockedBuildProvenance(provenance);
  return provenance;
}

function evidence(pathname, sha256, committed = true) {
  return {
    path: pathname,
    exists: true,
    bytes: 100,
    sha256,
    normalizedSha256: sha256,
    trackedAtHead: committed,
    matchesHead: committed,
  };
}

function validManifest() {
  return {
    git: { commit: "abc123", dirty: false },
    browser: { version: "143.0", headed: false },
    benchmark: {
      url: "http://127.0.0.1:8082/?video=software",
      sceneLabel: FIXED_MELEE_BATTLE_FIXTURE.sceneLabel,
      saveStateAt: 0,
      inputScriptMode: "none",
    },
    artifacts: {
      rom: { sha256: FIXED_MELEE_BATTLE_FIXTURE.isoSha256 },
      core: { sha256: "1".repeat(64) },
      saveState: { sha256: FIXED_MELEE_BATTLE_FIXTURE.saveStateSha256 },
    },
    fixture: {
      isoVerified: true,
      saveStateVerified: true,
      saveStateLoaded: true,
      battleCheckpoint: { verified: true },
    },
    causalTelemetrySchema: { version: 1 },
    servedApplication: { verified: true, manifestSha256: "e".repeat(64) },
  };
}

function comparisonConfig(overrides = {}) {
  return {
    mode: "screening",
    blockCount: 2,
    primaryMetric: "metrics.gameSpeed.mean",
    direction: "higher",
    minimumEffectPercent: 3,
    hypothesis: "Candidate improves game speed.",
    armA: { name: "baseline", params: { fastsw: 1 } },
    armB: { name: "candidate", params: { fastsw: 2 } },
    ...overrides,
  };
}

function makeRuns(config, valuesByBlock) {
  const tasklist = buildComparisonTasklist(config);
  return tasklist.blocks.slice(0, valuesByBlock.length).flatMap((block, blockIndex) => {
    const values = valuesByBlock[blockIndex];
    const next = { A: [...values.a], B: [...values.b] };
    return block.runs.map((task) => ({
      ...task,
      valid: true,
      invalidReasons: [],
      metrics: { gameSpeed: { mean: next[task.arm].shift() } },
    }));
  });
}
