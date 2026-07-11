import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  CAUSAL_TELEMETRY_SCHEMA_VERSION,
  flattenCausalTelemetry
} from "../src/causal-telemetry.js";

import {
  FIXED_MELEE_BATTLE_FIXTURE,
  PERF_EVENT_SCHEMA_VERSION,
  assertBattleCheckpoint,
  assertRunProvenance,
  assertServedArtifactIdentity,
  buildComparisonTasklist,
  buildReplacementBlock,
  collectRunMetadata,
  classifyGateOutcome,
  describeFile,
  evaluateMetricsModeEvidence,
  evaluateSoftwareRasterInstrumentationEvidence,
  evaluateQualificationProvenance,
  evaluateRunValidity,
  expectedBattleCheckpointForParams,
  extractLocalModuleSpecifiers,
  findFatalRuntimeEvidence,
  fixedWorkPollDelayMs,
  parseBattleCheckpoint,
  parsePostLoadInputScript,
  parseProfileMetrics,
  recordsToCsv,
  selectNextFixedWorkBenchmarkAction,
  selectNextPostLoadBenchmarkAction,
  serializePostLoadInputScript,
  summarizeCausalFairness,
  summarizeFixedEmulatedWork,
  summarizeComparison,
  summarizeJitMetrics,
  summarizeTimedMetricWindows,
  validateComparisonConfig,
  validateLockedBuildProvenance,
  verifyFileFixture,
} from "./perf-artifacts.mjs";

const root = process.cwd();
const cli = parseArgs(process.argv.slice(2));
const FIXED_WORK_POLL_INTERVAL_MS = 100;

await main().catch((error) => {
  console.error(`[perf-gate] ${error.stack || error.message}`);
  process.exitCode = 1;
});

async function main() {
  const romPath = path.resolve(requiredFixturePath(cli.rom || process.env.ROM, "Melee ISO", "--rom or ROM"));
  const saveStatePath = path.resolve(
    requiredFixturePath(cli.saveState || process.env.SAVE_STATE_PATH, "Kirby-vs-Link save state", "--save-state or SAVE_STATE_PATH")
  );
  rejectMenuDrivingConfiguration();

  const outDir = resolveOutDir(cli.outDir || process.env.OUT_DIR || `perf-regression-gate-${Date.now()}`);
  const baseUrl = cli.baseUrl || process.env.BASE_URL || "http://127.0.0.1:8082/";
  const durationSeconds = cli.duration ?? numberEnv("DURATION", 60);
  const sampleMs = cli.sampleMs ?? numberEnv("SAMPLE_MS", 1000);
  const targetCoreSeconds = optionalPositiveNumber(
    cli.targetCoreSeconds ?? process.env.PERF_TARGET_CORE_SECONDS,
    "--target-core-seconds or PERF_TARGET_CORE_SECONDS"
  );
  if (targetCoreSeconds != null && (!(durationSeconds > 0) || !(sampleMs > 0))) {
    throw new Error("Fixed emulated work requires positive duration and sample interval values");
  }
  const postLoadInputScript = parsePostLoadInputScript(
    cli.perfInputScript ?? process.env.PERF_INPUT_SCRIPT,
    { durationSeconds }
  );
  const postLoadInputScriptCanonical = serializePostLoadInputScript(postLoadInputScript);
  const settleSeconds = numberEnv("SETTLE_SECONDS", 2);
  const tolerance = cli.tolerance ?? numberEnv("PERF_DROP_TOLERANCE", 0.05);
  const strict = cli.strict || process.env.PERF_STRICT === "1";
  const targetMode = normalizeTargetMode(cli.targetMode || process.env.PERF_TARGET_MODE || "fail");
  const requireBaseline = cli.requireBaseline || process.env.PERF_REQUIRE_BASELINE === "1";
  const baselinePath = cli.baseline || process.env.PERF_BASELINE || "";
  const headed = process.env.PERF_PROBE_HEADED === "1";
  const continueInvalidCheckpoint = process.env.PERF_CONTINUE_INVALID_CHECKPOINT === "1";
  const corePath = path.join(root, "cores", "dolphin", "dolphin-core-upstream.wasm");

  if (requireBaseline && !baselinePath) {
    throw new Error("PERF_BASELINE or --baseline is required in regression-guard mode");
  }

  await mkdir(outDir, { recursive: true });
  const [romFixture, saveFixture, coreArtifact] = await Promise.all([
    verifyFileFixture(romPath, {
      label: "Melee ISO",
      expectedSha256: FIXED_MELEE_BATTLE_FIXTURE.isoSha256,
    }),
    verifyFileFixture(saveStatePath, {
      label: "Kirby-vs-Link save state",
      expectedSha256: FIXED_MELEE_BATTLE_FIXTURE.saveStateSha256,
    }),
    describeFile(corePath, { hash: true }),
  ]);
  const stagedSave = await stageSaveState(saveStatePath, saveFixture.sha256);
  const saveStateUrl = `/.omx/perf-fixtures/${path.basename(stagedSave)}`;
  const comparisonConfig = await readComparisonConfig(cli.comparisonConfig || process.env.PERF_COMPARISON_CONFIG);
  const baseline = await readBaseline(baselinePath);
  const { chromium } = await importPlaywright();
  const localServer = await ensureAppServer(baseUrl);

  try {
    await verifyServedFixture(new URL(saveStateUrl, baseUrl), saveFixture.sha256);
    const servedApplication = await verifyServedApplication(baseUrl, coreArtifact);
    const buildProvenance = await collectBuildProvenance(coreArtifact);
    const context = {
      baseUrl,
      buildProvenance,
      chromium,
      continueInvalidCheckpoint,
      coreArtifact,
      corePath,
      durationSeconds,
      headed,
      outDir,
      postLoadInputScript,
      postLoadInputScriptCanonical,
      romFixture,
      romPath,
      sampleMs,
      saveFixture,
      saveStatePath,
      saveStateUrl,
      servedApplication,
      settleSeconds,
      strict,
      targetCoreSeconds,
      targetMode,
    };

    const execution = comparisonConfig
      ? await runComparison(comparisonConfig, context)
      : await runSinglePass(context);
    const comparison = comparisonConfig
      ? execution.comparison
      : compareToBaseline(execution.results, baseline, tolerance);
    const runFailures = execution.results.flatMap((result) =>
      (result.failures || []).map((failure) => `${result.name}: ${failure}`)
    );
    const targetFailures = execution.results.flatMap((result) =>
      (result.targetFailures || []).map((failure) => `${result.name}: ${failure}`)
    );
    const invalidFailures = execution.results.flatMap((result) =>
      (result.invalidReasons || []).map((reason) => `${result.name}: ${reason}`)
    );
    const comparisonFailures = [];
    const comparisonWarnings = [];
    if (comparisonConfig) {
      if (comparison.outcome === "INFRASTRUCTURE_INCONCLUSIVE") {
        comparisonFailures.push("Comparison stopped because the invalid-block limit was exceeded");
      } else if (["NEEDS_MORE_BLOCKS", "INCONCLUSIVE", "INCOMPLETE"].includes(comparison.outcome)) {
        comparisonWarnings.push(`Comparison outcome: ${comparison.outcome}; no promotion is allowed`);
      }
    } else {
      comparisonFailures.push(...comparison.failures);
      comparisonWarnings.push(...comparison.warnings);
    }
    const failures = [...new Set([...invalidFailures, ...runFailures, ...comparisonFailures])];
    const warnings = [
      ...execution.results.flatMap((result) => result.warnings || []),
      ...comparisonWarnings,
      ...(headed ? [] : ["Runs were headless and cannot qualify performance or audio/compositor claims"]),
    ];
    const qualificationEligible = execution.results.length > 0 && execution.results.every(
      (result) => result.qualification?.eligible === true
    );
    const gateOutcome = classifyGateOutcome({
      failureCount: failures.length,
      qualificationEligible,
      comparisonMode: comparisonConfig?.mode || null,
      statisticalGatePassed: Boolean(comparisonConfig && comparison.statisticalGatePassed),
      targetPassed: targetFailures.length === 0,
    });
    if (comparisonConfig) {
      comparison.qualificationEligible = qualificationEligible;
      comparison.promotable = gateOutcome.promotable;
      comparison.qualificationPassed = gateOutcome.qualificationPassed;
      await writeFile(path.join(outDir, "comparison.json"), JSON.stringify(comparison, null, 2));
    }
    const report = {
      schemaVersion: 2,
      verdict: gateOutcome.verdict,
      qualificationPassed: gateOutcome.qualificationPassed,
      qualificationEligible,
      generatedAt: new Date().toISOString(),
      scene: FIXED_MELEE_BATTLE_FIXTURE.sceneLabel,
      baseUrl,
      durationSeconds,
      targetCoreSeconds,
      sampleMs,
      settleSeconds,
      headed,
      tolerance,
      strict,
      targetMode,
      requireBaseline,
      baselinePath: baselinePath || null,
      fixture: {
        rom: romFixture,
        saveState: saveFixture,
        stagedSaveStateUrl: saveStateUrl,
        core: coreArtifact,
      },
      servedApplication,
      tasklistPath: execution.tasklistPath || null,
      failures,
      warnings,
      results: execution.results,
      comparison,
    };
    await writeFile(path.join(outDir, "runs.csv"), runSummaryCsv(execution.results));
    await writeFile(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = gateOutcome.exitCode;
  } finally {
    if (localServer) await new Promise((resolve) => localServer.close(resolve));
  }
}

async function runSinglePass(context) {
  const results = [];
  for (const scenario of selectedScenarios()) {
    results.push(await runScenario(scenario, context));
  }
  return { results, tasklistPath: null };
}

async function runComparison(configValue, context) {
  const config = validateComparisonConfig(configValue);
  const tasklist = buildComparisonTasklist(config);
  const tasklistPath = path.join(context.outDir, "tasklist.json");
  const results = [];
  let nextBlockIndex = 0;
  let replacementNumber = 0;
  let validBlockCount = 0;
  const baseScenario = selectedScenarios()[0];

  await writeFile(tasklistPath, JSON.stringify(tasklist, null, 2));
  while (
    validBlockCount < tasklist.maximumValidBlocks &&
    nextBlockIndex < tasklist.blocks.length &&
    results.length / 4 < tasklist.maximumAttemptedBlocks
  ) {
    if (validBlockCount >= tasklist.initialValidBlocks) {
      const current = summarizeComparison(config, results);
      if (current.outcome !== "NEEDS_MORE_BLOCKS" && current.outcome !== "INCOMPLETE") break;
    }
    const block = tasklist.blocks[nextBlockIndex++];
    block.status = "running";
    await writeFile(tasklistPath, JSON.stringify(tasklist, null, 2));
    const blockResults = [];
    for (const task of block.runs) {
      task.status = "running";
      await writeFile(tasklistPath, JSON.stringify(tasklist, null, 2));
      const scenario = {
        ...baseScenario,
        name: task.runId,
        required: false,
        params: { ...baseScenario.params, ...task.params },
        experiment: task,
      };
      if (task.cacheState === "disabled") scenario.params.nojitcache = "1";
      const result = await runScenario(scenario, context);
      results.push(result);
      blockResults.push(result);
      task.status = result.valid ? "complete" : "invalid";
      task.invalidReasons = result.invalidReasons;
      await writeFile(tasklistPath, JSON.stringify(tasklist, null, 2));
    }
    const blockReport = summarizeComparison(config, blockResults).blocks[0];
    block.status = blockReport?.valid ? "complete" : "invalid";
    block.invalidReasons = blockReport?.invalidReasons || ["Block did not produce a comparison result"];
    if (block.status === "complete") {
      validBlockCount += 1;
    } else {
      if (results.length / 4 < tasklist.maximumAttemptedBlocks) {
        replacementNumber += 1;
        const replacement = buildReplacementBlock(config, block, replacementNumber);
        tasklist.blocks.splice(nextBlockIndex, 0, replacement);
      }
    }
    await writeFile(tasklistPath, JSON.stringify(tasklist, null, 2));
    const current = summarizeComparison(config, results);
    if (current.outcome === "INFRASTRUCTURE_INCONCLUSIVE") break;
  }

  const comparison = summarizeComparison(config, results);
  await writeFile(path.join(context.outDir, "comparison.json"), JSON.stringify(comparison, null, 2));
  await writeFile(path.join(context.outDir, "comparison.csv"), comparisonCsv(comparison, results, config));
  tasklist.status = comparison.outcome;
  tasklist.finishedAt = new Date().toISOString();
  await writeFile(tasklistPath, JSON.stringify(tasklist, null, 2));
  return { results, comparison, tasklistPath };
}

async function runScenario(scenario, context) {
  const scenarioDir = path.join(context.outDir, scenario.name);
  await mkdir(scenarioDir, { recursive: true });
  const consoleLines = [];
  const consoleErrors = [];
  const samples = [];
  const inputEvents = [];
  const invalidReasons = [];
  let browser = null;
  let page = null;
  let browserLaunch = null;
  let manifest = null;
  let saveStateLoad = null;
  let renderer = null;
  let finalScreenshotCaptured = false;
  let fixedEmulatedWork = {
    enabled: context.targetCoreSeconds != null,
    targetCoreSeconds: context.targetCoreSeconds,
    wallTimeCapSeconds: context.durationSeconds,
    pollIntervalMs: context.targetCoreSeconds != null ? FIXED_WORK_POLL_INTERVAL_MS : null,
    reachedTarget: false,
  };
  const url = new URL(context.baseUrl);
  for (const [key, value] of Object.entries(scenario.params)) url.searchParams.set(key, value);
  url.searchParams.set("probe", `${scenario.name}-${Date.now()}`);

  try {
    browserLaunch = await launchBrowser(context.chromium, context.headed);
    browser = browserLaunch.browser;
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const recordConsole = (scope, message) => {
      const line = `[${scope}${message.type()}] ${message.text()}`;
      consoleLines.push(line);
      if (message.type() === "error") consoleErrors.push(line);
    };
    page.on("console", (message) => recordConsole("", message));
    page.on("pageerror", (error) => {
      const line = `[pageerror] ${error.stack || error.message}`;
      consoleLines.push(line);
      consoleErrors.push(line);
    });
    page.on("worker", (worker) => {
      const label = `worker:${worker.url()?.split("/").pop() || "?"}`;
      worker.on("console", (message) => recordConsole(`${label}:`, message));
      worker.on("pageerror", (error) => {
        const line = `[${label}:pageerror] ${error.stack || error.message}`;
        consoleLines.push(line);
        consoleErrors.push(line);
      });
    });
    const browserVersion = browser.version();
    manifest = await collectRunMetadata({
      root,
      url: url.href,
      browserName: "chromium",
      browserChannel: browserLaunch.actualChannel,
      browserVersion,
      browserExecutable: browserLaunch.executablePath,
      headed: context.headed,
      durationSeconds: context.durationSeconds,
      sampleMs: context.sampleMs,
      screenshotEverySeconds: 0,
      captureScreenshots: true,
      showDebugPanel: false,
      romPath: context.romPath,
      corePath: context.corePath,
      saveStateUrl: context.saveStateUrl,
      saveStatePath: context.saveStatePath,
      saveStateAt: 0,
      inputScript: context.postLoadInputScriptCanonical || "none",
      sceneLabel: FIXED_MELEE_BATTLE_FIXTURE.sceneLabel,
      artifactDescriptions: {
        rom: context.romFixture,
        core: context.coreArtifact,
        saveState: context.saveFixture,
      },
    });
    manifest.schemaVersion = 2;
    manifest.browser.requestedChannel = browserLaunch.requestedChannel;
    manifest.browser.actualChannel = browserLaunch.actualChannel;
    manifest.browser.executablePath = browserLaunch.executablePath;
    manifest.browser.launchSource = browserLaunch.source;
    manifest.benchmark.inputScriptMode = context.postLoadInputScript.length
      ? "post-load-only"
      : "none";
    manifest.benchmark.inputScriptEventCount = context.postLoadInputScript.length;
    manifest.benchmark.inputScriptScheduleOrigin = context.postLoadInputScript.length
      ? "after-first-timed-sample"
      : null;
    manifest.benchmark.timingStartsAfterVerifiedLoad = true;
    manifest.benchmark.settleSeconds = context.settleSeconds;
    manifest.benchmark.fixedEmulatedWork = fixedEmulatedWork;
    manifest.benchmark.cacheState = scenario.experiment?.cacheState || "cold-ephemeral";
    manifest.benchmark.continueInvalidCheckpoint = context.continueInvalidCheckpoint;
    manifest.browser.profileId = `${manifest.benchmark.cacheState}:${scenario.experiment?.runId || scenario.name}:${manifest.startedAt}`;
    manifest.buildProvenance = structuredClone(context.buildProvenance.buildProvenance);
    manifest.buildProvenance.evidenceBundle = await packageBuildProvenance(
      scenarioDir,
      context.buildProvenance.rawEvidenceFiles
    );
    manifest.buildProvenance.verification = validateLockedBuildProvenance(manifest.buildProvenance);
    manifest.hostCore = context.buildProvenance.hostCore;
    manifest.eventSchema = { version: PERF_EVENT_SCHEMA_VERSION };
    manifest.causalTelemetrySchema = { version: CAUSAL_TELEMETRY_SCHEMA_VERSION };
    manifest.upstream = context.buildProvenance.upstream;
    manifest.patches = context.buildProvenance.patches;
    manifest.toolchain = context.buildProvenance.toolchain;
    manifest.servedApplication = context.servedApplication;
    manifest.experiment = scenario.experiment || null;
    manifest.fixture = {
      sceneLabel: FIXED_MELEE_BATTLE_FIXTURE.sceneLabel,
      isoVerified: true,
      saveStateVerified: true,
      saveStateLoaded: false,
      battleCheckpoint: { verified: false },
      expectedIsoSha256: FIXED_MELEE_BATTLE_FIXTURE.isoSha256,
      expectedSaveStateSha256: FIXED_MELEE_BATTLE_FIXTURE.saveStateSha256,
    };
    await writeFile(path.join(scenarioDir, "manifest.json"), JSON.stringify(manifest, null, 2));

    await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 30000 });
    manifest.browser.userAgent = await page.evaluate(() => navigator.userAgent);
    manifest.browser.webgpuAdapter = await readWebGpuAdapter(page);
    manifest.qualification = evaluateQualificationProvenance(manifest);
    await page.setInputFiles("#romInput", context.romPath);
    await page.click("#screen");
    await waitForMount(page, scenarioDir);
    const readiness = await waitForCoreReady(page);
    const pauseResponse = await pauseForBattleCheckpoint(page);
    const attemptedAt = new Date().toISOString();
    const response = await loadStateFileWithTimeout(page, context.saveStateUrl);
    saveStateLoad = { attemptedAt, readiness, pauseResponse, response, loaded: Boolean(response?.loaded) };
    if (!saveStateLoad.loaded) {
      throw new Error(`Save-state load failed: ${response?.error || JSON.stringify(response)}`);
    }
    renderer = withExpectedRendererIdentity(await readRendererDiagnostics(page), scenario.params);
    manifest.renderer = renderer;
    const observedBattleCheckpoint = parseBattleCheckpoint(response);
    let battleCheckpoint;
    try {
      battleCheckpoint = assertBattleCheckpoint(
        observedBattleCheckpoint,
        expectedBattleCheckpointForParams(scenario.params)
      );
    } catch (error) {
      if (!context.continueInvalidCheckpoint) throw error;
      invalidReasons.push(error.message || String(error));
      battleCheckpoint = {
        ...observedBattleCheckpoint,
        verified: false,
        diagnosticContinuation: true,
        error: error.message || String(error)
      };
    }
    manifest.fixture.battleCheckpoint = battleCheckpoint;
    await resumeAfterBattleCheckpoint(page);
    saveStateLoad.postLoadProgress = await waitForPostLoadProgress(page);
    renderer = withExpectedRendererIdentity(await readRendererDiagnostics(page), scenario.params);
    manifest.renderer = renderer;
    await page.waitForTimeout(context.settleSeconds * 1000);
    manifest.fixture.saveStateLoaded = true;
    manifest.fixture.loadResult = saveStateLoad;
    manifest.benchmark.timingStartedAt = new Date().toISOString();
    await writeFile(path.join(scenarioDir, "manifest.json"), JSON.stringify(manifest, null, 2));

    const startedAt = Date.now();
    const wallTimeCapMs = context.durationSeconds * 1000;
    const fixedWorkEnabled = context.targetCoreSeconds != null;
    const totalSamples = fixedWorkEnabled
      ? Math.floor(wallTimeCapMs / context.sampleMs)
      : Math.ceil(wallTimeCapMs / context.sampleMs);
    let sampleIndex = 0;
    let inputIndex = 0;
    let fixedWorkBaseline = null;
    const collectTimedSample = async (elapsedSeconds) => {
      const sample = deriveCoreRates(
        await readSample(page, elapsedSeconds),
        samples.at(-1),
        Number(saveStateLoad.response?.coreTicksPerSecond) || 0
      );
      const record = {
        ...sample,
        ...parseProfileMetrics(sample.helper, sample.profile),
        ...flattenCausalTelemetry(sample.causalTelemetry)
      };
      samples.push(record);
      return record;
    };
    while (fixedWorkEnabled || sampleIndex <= totalSamples || inputIndex < context.postLoadInputScript.length) {
      const schedule = {
        sampleIndex,
        totalSamples,
        sampleMs: context.sampleMs,
        inputIndex,
        inputEvents: context.postLoadInputScript,
      };
      const action = fixedWorkEnabled
        ? selectNextFixedWorkBenchmarkAction({ ...schedule, wallTimeCapMs })
        : selectNextPostLoadBenchmarkAction(schedule);
      const deadline = startedAt + action.atMs;
      let progressAtAction = null;
      if (fixedWorkBaseline) {
        const progress = await waitForFixedEmulatedWorkProgress(page, {
          baseline: fixedWorkBaseline,
          coreTicksPerSecond: fixedEmulatedWork.coreTicksPerSecond,
          deadlineMs: deadline,
          pollIntervalMs: FIXED_WORK_POLL_INTERVAL_MS,
          targetCoreSeconds: context.targetCoreSeconds,
          wallTimeCapSeconds: context.durationSeconds,
        });
        progressAtAction = progress;
        fixedEmulatedWork = progress.summary;
        manifest.benchmark.fixedEmulatedWork = fixedEmulatedWork;
        if (progress.summary.reachedTarget) {
          const elapsedSeconds = (Date.now() - startedAt) / 1000;
          await collectTimedSample(elapsedSeconds);
          break;
        }
      } else {
        await page.waitForTimeout(Math.max(0, deadline - Date.now()));
      }
      const elapsedSeconds = (Date.now() - startedAt) / 1000;

      if (action.type === "wall-time-cap") {
        await collectTimedSample(elapsedSeconds);
        fixedEmulatedWork = progressAtAction.summary;
        manifest.benchmark.fixedEmulatedWork = fixedEmulatedWork;
        break;
      }

      if (action.type === "input") {
        const dispatchStartedSeconds = elapsedSeconds;
        if (action.event.action === "down") await page.keyboard.down(action.event.key);
        else await page.keyboard.up(action.event.key);
        const deliveredSeconds = (Date.now() - startedAt) / 1000;
        inputEvents.push({
          action: action.event.action,
          key: action.event.key,
          sourceIndex: action.event.index,
          scheduledSeconds: action.event.second,
          dispatchStartedSeconds,
          deliveredSeconds,
          latenessMs: Math.max(0, deliveredSeconds * 1000 - action.atMs),
          afterBaselineSample: samples.length > 0,
        });
        inputIndex += 1;
        continue;
      }

      const sample = await collectTimedSample(elapsedSeconds);
      if (sampleIndex === 0) {
        manifest.benchmark.timingBaselineEstablishedAt = new Date().toISOString();
        if (fixedWorkEnabled) {
          const coreTicksPerSecond = Number(sample.coreTicksPerSecond) ||
            Number(saveStateLoad.response?.coreTicksPerSecond) || 0;
          fixedWorkBaseline = fixedWorkObservation(sample);
          fixedEmulatedWork = summarizeFixedEmulatedWork({
            targetCoreSeconds: context.targetCoreSeconds,
            coreTicksPerSecond,
            baseline: fixedWorkBaseline,
            observation: fixedWorkBaseline,
            wallTimeCapSeconds: context.durationSeconds,
            pollIntervalMs: FIXED_WORK_POLL_INTERVAL_MS,
          });
          manifest.benchmark.fixedEmulatedWork = fixedEmulatedWork;
        }
        if (!context.continueInvalidCheckpoint) assertRunProvenance(manifest);
      } else if (fixedWorkEnabled) {
        fixedEmulatedWork = action.atMs >= wallTimeCapMs && progressAtAction
          ? progressAtAction.summary
          : summarizeFixedEmulatedWork({
            targetCoreSeconds: context.targetCoreSeconds,
            coreTicksPerSecond: fixedEmulatedWork.coreTicksPerSecond,
            baseline: fixedWorkBaseline,
            observation: fixedWorkObservation(sample),
            wallTimeCapSeconds: context.durationSeconds,
            pollIntervalMs: FIXED_WORK_POLL_INTERVAL_MS,
          });
        manifest.benchmark.fixedEmulatedWork = fixedEmulatedWork;
      }
      if (sampleIndex % Math.max(1, Math.round(10000 / context.sampleMs)) === 0) {
        console.log(
          `[perf-gate] ${scenario.name} t=${elapsedSeconds.toFixed(1)} ` +
          `frame=${sample.frame} present=${sample.presentFps} core=${sample.coreFps} ` +
          `visual=${sample.visualFps} speed=${sample.gameSpeed}`
        );
      }
      sampleIndex += 1;
      if (fixedWorkEnabled && (fixedEmulatedWork.reachedTarget || action.atMs >= wallTimeCapMs)) {
        break;
      }
    }
    manifest.benchmark.inputScriptDeliveredEventCount = inputEvents.length;
    finalScreenshotCaptured = await saveScreenshot(page, scenarioDir, "final.png");
    await page.waitForTimeout(100);
    renderer = withExpectedRendererIdentity(await readRendererDiagnostics(page), scenario.params);
    manifest.renderer = renderer;
  } catch (error) {
    invalidReasons.push(error.message || String(error));
    consoleLines.push(`[probe-error] ${error.stack || error.message}`);
    if (page && !page.isClosed() && !renderer) {
      try {
        renderer = withExpectedRendererIdentity(await readRendererDiagnostics(page), scenario.params);
      } catch (diagnosticError) {
        consoleLines.push(
          `[renderer-diagnostics-error] ${diagnosticError.stack || diagnosticError.message}`
        );
      }
    }
    if (browser) {
      const pages = browser.contexts().flatMap((browserContext) => browserContext.pages());
      if (pages[0]) await saveScreenshot(pages[0], scenarioDir, "error.png");
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  if (!samples.length) invalidReasons.push("no timed samples were collected");
  invalidReasons.push(
    ...evaluateMetricsModeEvidence({
      requested: scenario.params.metrics,
      diagnostics: renderer?.metrics,
      samples,
    }).failures
  );
  const softwareRasterInstrumentation = evaluateSoftwareRasterInstrumentationEvidence({
    required: scenario.params.video === "software" && String(scenario.params.metrics) === "1",
    samples,
  });
  invalidReasons.push(...softwareRasterInstrumentation.failures);
  if (!saveStateLoad?.loaded) invalidReasons.push("fixed battle save did not load before timing");
  if (inputEvents.length !== context.postLoadInputScript.length) {
    invalidReasons.push(
      `post-load input delivered ${inputEvents.length}/${context.postLoadInputScript.length} events`
    );
  }
  if (inputEvents.some((event) => !event.afterBaselineSample)) {
    invalidReasons.push("post-load input was delivered before the timed baseline sample");
  }
  if (fixedEmulatedWork.enabled && fixedEmulatedWork.deltasValid !== true) {
    invalidReasons.push("fixed emulated work did not produce valid non-negative tick/frame/time deltas");
  }
  if (fixedEmulatedWork.enabled && fixedEmulatedWork.reachedTarget !== true) {
    invalidReasons.push(
      `fixed emulated work target was not reached before the ${context.durationSeconds}s wall-time cap`
    );
  }
  if (!finalScreenshotCaptured && samples.length) invalidReasons.push("final screenshot was not captured");
  const fatalEvidence = findFatalRuntimeEvidence({
    consoleLines,
    statuses: samples.flatMap((sample) => [sample.status, sample.statusPill]).filter(Boolean),
    renderer: renderer || {},
  });
  invalidReasons.push(...fatalEvidence.map((entry) => `fatal runtime evidence: ${entry}`));

  const summary = summarizeScenario(
    scenario,
    url.href,
    samples,
    scenarioDir,
    consoleLines,
    consoleErrors,
    invalidReasons,
    { expectedInputEvents: context.postLoadInputScript.length }
  );
  summary.metrics.softwareRasterInstrumentation = softwareRasterInstrumentation;
  summary.metrics.fixedEmulatedWork = fixedEmulatedWork;
  summary.fixedEmulatedWork = fixedEmulatedWork;
  summary.postLoadInput = {
    mode: context.postLoadInputScript.length ? "post-load-only" : "none",
    scheduledEventCount: context.postLoadInputScript.length,
    deliveredEventCount: inputEvents.length,
    events: inputEvents,
  };
  if (manifest) {
    manifest.finishedAt = new Date().toISOString();
    manifest.benchmark.fixedEmulatedWork = fixedEmulatedWork;
    if (renderer) manifest.renderer = renderer;
    manifest.fixture.saveStateLoaded = Boolean(saveStateLoad?.loaded);
    manifest.fixture.loadResult = saveStateLoad;
    manifest.qualification = evaluateQualificationProvenance(manifest);
    try {
      assertRunProvenance(manifest);
    } catch (error) {
      if (!summary.invalidReasons.includes(error.message)) summary.invalidReasons.push(error.message);
      summary.valid = false;
    }
    manifest.result = {
      valid: summary.valid,
      invalidReasons: summary.invalidReasons,
      sampleCount: samples.length,
      summaryFile: "summary.json",
      samplesFile: "samples.json",
      eventsFile: "events.jsonl",
      consoleFile: "console.log",
      screenshotFile: finalScreenshotCaptured ? "final.png" : null,
      fixedEmulatedWork,
    };
    summary.qualification = manifest.qualification;
    await writeFile(path.join(scenarioDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  }
  await Promise.all([
    writeFile(path.join(scenarioDir, "console.log"), consoleLines.join("\n")),
    writeFile(path.join(scenarioDir, "samples.json"), JSON.stringify(samples, null, 2)),
    writeFile(path.join(scenarioDir, "samples.csv"), recordsToCsv(samples)),
    writeFile(
      path.join(scenarioDir, "events.jsonl"),
      runEventsJsonl(manifest, saveStateLoad, inputEvents, samples)
    ),
    writeFile(path.join(scenarioDir, "summary.json"), JSON.stringify(summary, null, 2)),
  ]);
  return summary;
}

function summarizeScenario(
  scenario,
  url,
  samples,
  scenarioDir,
  consoleLines,
  consoleErrors,
  invalidReasons,
  { expectedInputEvents = 0 } = {}
) {
  const timedWindow = samples;
  const windows = summarizeTimedMetricWindows(samples, scenario.assertAfterSeconds);
  const steadyStateWindow = windows.steadyStateWindow;
  const final = samples.at(-1) || {};
  const helperText = timedWindow.map((sample) => sample.helper || "").join(" | ");
  const fullTimedWindow = windows.fullTimedWindow.metrics;
  const steadyState = steadyStateWindow.metrics;
  const causalFairness = summarizeCausalFairness(timedWindow, { expectedInputEvents });
  const metrics = {
    fullTimedWindow,
    steadyState,
    jit: summarizeJitMetrics(timedWindow),
    // Compatibility aliases now explicitly point at the complete timed
    // window. Consumers that exclude warmup must request steadyState.*.
    gameSpeed: fullTimedWindow.gameSpeed,
    coreFps: fullTimedWindow.coreFps,
    presentationFps: fullTimedWindow.presentationFps,
    visualFps: fullTimedWindow.visualFps,
    minPresentFps: fullTimedWindow.presentationFps?.min || 0,
    minCoreFps: fullTimedWindow.coreFps?.min || 0,
    minGameSpeed: fullTimedWindow.gameSpeed?.min || 0,
    maxGapMs: maxRegex(timedWindow.map((sample) => sample.gap || "").join(" "), /(\d+(?:\.\d+)?)\s+max/g),
    maxXfbDtMs: Math.max(0, ...timedWindow.map((sample) => sample.coreXfbMaxIntervalMs || 0)),
    maxGlError: lastMatch(helperText, /glerr:(0x[0-9a-f]+)/gi) || "unknown",
    emitfail: maxRegex(helperText, /emitfail:(\d+)/g),
    compilefail: maxRegex(helperText, /compilefail:(\d+)/g),
    presentationUnderrun: maxRegex(helperText, /underrun:(\d+)/g),
    // Deprecated alias retained so existing artifact readers do not break.
    underrun: maxRegex(helperText, /underrun:(\d+)/g),
    drop: maxRegex(helperText, /drop:(\d+)/g),
    causalFairness,
    visibleChangedCount: timedWindow.filter((sample) => sample.visibleChanged).length,
    readableCanvasSamples: timedWindow.filter((sample) => sample.visibleHash && !sample.visibleError).length,
  };
  const failures = [];
  const warnings = [];
  const targetFailures = [];
  const targetIssue = (message) => {
    targetFailures.push(message);
    (shouldFailScenarioTargets(scenario) ? failures : warnings).push(message);
  };
  if (metrics.emitfail > 0) failures.push(`emitfail=${metrics.emitfail}`);
  if (metrics.compilefail > 0) failures.push(`compilefail=${metrics.compilefail}`);
  failures.push(...causalFairness.failures);
  if (metrics.minPresentFps < scenario.thresholds.minPresentFps) {
    targetIssue(`min present FPS ${metrics.minPresentFps} < ${scenario.thresholds.minPresentFps}`);
  }
  if (metrics.minCoreFps < scenario.thresholds.minCoreFps) {
    targetIssue(`min core FPS ${metrics.minCoreFps} < ${scenario.thresholds.minCoreFps}`);
  }
  if (metrics.minGameSpeed < scenario.thresholds.minGameSpeed) {
    targetIssue(`min game speed ${metrics.minGameSpeed}% < ${scenario.thresholds.minGameSpeed}%`);
  }
  if (metrics.maxGapMs > scenario.thresholds.maxGapMs) {
    targetIssue(`max frame gap ${metrics.maxGapMs}ms > ${scenario.thresholds.maxGapMs}ms`);
  }
  if (scenario.thresholds.requireVisibleChange && metrics.visibleChangedCount === 0) {
    targetIssue("no visible canvas hash changes during the timed window");
  }
  if (scenario.thresholds.requireNoGlError && metrics.maxGlError !== "0x0") {
    invalidReasons.push(`GL error ${metrics.maxGlError}`);
  }
  if (!String(final.mountNote || "").includes("Dolphin")) invalidReasons.push("Dolphin did not mount");
  if (consoleLines.some((line) => /\[probe-error\]/i.test(line)) && !invalidReasons.length) {
    invalidReasons.push("probe error was recorded");
  }
  const runValidity = evaluateRunValidity({ invalidReasons, failures, consoleErrors });
  return {
    name: scenario.name,
    runId: scenario.experiment?.runId || scenario.name,
    blockId: scenario.experiment?.blockId || null,
    arm: scenario.experiment?.arm || null,
    armName: scenario.experiment?.armName || null,
    valid: runValidity.valid,
    invalidReasons: runValidity.invalidReasons,
    required: scenario.required,
    url,
    outDir: scenarioDir,
    manifestPath: path.join(scenarioDir, "manifest.json"),
    screenshot: path.join(scenarioDir, "final.png"),
    samplesPath: path.join(scenarioDir, "samples.json"),
    eventsPath: path.join(scenarioDir, "events.jsonl"),
    summaryPath: path.join(scenarioDir, "summary.json"),
    sampleCount: samples.length,
    timedWindow: {
      ...windows.fullTimedWindow,
    },
    steadyStateWindow: {
      ...steadyStateWindow,
    },
    thresholds: scenario.thresholds,
    metrics,
    final,
    failures,
    targetFailures,
    warnings,
  };
}

function selectedScenarios() {
  const softwareParams = {
    core: "upstream",
    video: process.env.VIDEO || "software",
    cpu: process.env.CPU || "dual",
    speed: process.env.SPEED || "1",
    present: process.env.PRESENT || "full",
    presenter: process.env.PRESENTER || "webgpu",
    pacing: process.env.PACING || "tick",
    wasmjit: process.env.WASMJIT ?? "1",
    jittier: process.env.JITTIER || "guarded",
    jitwarmup: process.env.JITWARMUP || "700",
    oc: process.env.OC || "1",
    queue: process.env.QUEUE_SIZE || "2",
    fastsw: process.env.FASTSW || "1",
    metrics: process.env.METRICS || "1",
  };
  for (const name of ["disable", "regalloc", "smearcompile", "blockmerge", "shortprefix", "fastmemhoist", "nogamepad", "nojitcache", "xfbfast", "gpucomplete", "inputlatency", "inputphoton", "inputphotonsize", "inputphotonx", "inputphotony", "wgpustatecache", "wgpuubocache", "wgpugeompack", "wgpuuploadmb", "wgpureplayms", "swtevfast", "swtevshadow"]) {
    const envName = name.toUpperCase();
    if (process.env[envName] != null) softwareParams[name] = process.env[envName];
  }
  const all = [
    {
      name: "software-stable",
      required: true,
      assertAfterSeconds: numberEnv("ASSERT_AFTER_SECONDS", 5),
      params: softwareParams,
      thresholds: {
        minPresentFps: numberEnv("SOFTWARE_MIN_PRESENT_FPS", 50),
        minCoreFps: numberEnv("SOFTWARE_MIN_CORE_FPS", 55),
        minGameSpeed: numberEnv("SOFTWARE_MIN_GAME_SPEED", 95),
        maxGapMs: numberEnv("SOFTWARE_MAX_GAP_MS", 90),
        requireVisibleChange: true,
        requireNoGlError: false,
      },
    },
    {
      name: "ogl-hardware",
      required: false,
      assertAfterSeconds: numberEnv("ASSERT_AFTER_SECONDS", 5),
      params: {
        ...softwareParams,
        video: "ogl",
        presenter: "webgl",
        present: "half",
        oglproxy: process.env.OGL_PROXY_MODE || "proxy",
        wasmjit: process.env.OGL_WASMJIT || "0",
        jittier: "mixed",
        queue: "8",
      },
      thresholds: {
        minPresentFps: numberEnv("OGL_MIN_PRESENT_FPS", 1),
        minCoreFps: numberEnv("OGL_MIN_CORE_FPS", 45),
        minGameSpeed: numberEnv("OGL_MIN_GAME_SPEED", 80),
        maxGapMs: numberEnv("OGL_MAX_GAP_MS", 600),
        requireVisibleChange: true,
        requireNoGlError: false,
      },
    },
  ];
  const requested = (process.env.PERF_SCENARIOS || "software-stable")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const selected = all.filter((scenario) => requested.includes(scenario.name));
  if (!selected.length) throw new Error(`PERF_SCENARIOS did not select a known scenario: ${requested.join(",")}`);
  return selected;
}

async function waitForMount(page, scenarioDir) {
  for (let second = 0; second <= 180; second += 1) {
    const mounted = await page.evaluate(() => {
      const coreMode = document.querySelector("#coreMode")?.textContent?.trim() ?? "";
      const mountNote = document.querySelector("#mountNote")?.textContent?.trim() ?? "";
      const status = document.querySelector("#statusPill")?.textContent?.trim() ?? "";
      return { mounted: coreMode === "Dolphin" && mountNote.includes("Dolphin"), coreMode, mountNote, status };
    });
    if (mounted.mounted) return;
    if (/failed|error/i.test(mounted.status)) {
      await saveScreenshot(page, scenarioDir, "mount-error.png");
      throw new Error(`Core mount failed: ${mounted.status}`);
    }
    await page.waitForTimeout(1000);
  }
  await saveScreenshot(page, scenarioDir, "mount-timeout.png");
  throw new Error("Timed out waiting for Dolphin upstream core mount");
}

async function waitForCoreReady(page) {
  let readiness = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    readiness = await page.evaluate(() => {
      const info = window.__lastFrameInfo || {};
      return {
        frame: Number(info.frame) || 0,
        coreTicks: Number(info.coreTicks) || 0,
        running: Boolean(info.running),
      };
    });
    if (readiness.running && readiness.frame >= 30 && readiness.coreTicks > 0) return readiness;
    await page.waitForTimeout(250);
  }
  throw new Error(`Core did not become ready for save-state load: ${JSON.stringify(readiness)}`);
}

async function pauseForBattleCheckpoint(page) {
  const response = await requestWorkerRpc(page, "validationSetCorePaused", { paused: true });
  if (!response?.paused || response?.coreStateName !== "Paused") {
    throw new Error(`Core did not enter paused state before fixed save load: ${JSON.stringify(response)}`);
  }
  return response;
}

async function resumeAfterBattleCheckpoint(page) {
  const response = await page.evaluate(async ({ timeoutMs }) => {
    const host = window.__host;
    if (!host?.adapter?.request) throw new Error("Validator cannot resume the active adapter");
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Worker RPC validationSetCorePaused timed out after ${timeoutMs} ms`)),
        timeoutMs
      );
      Promise.resolve(host.adapter.request("validationSetCorePaused", { paused: false })).then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error) => { clearTimeout(timer); reject(error); }
      );
    });
    host.adapter.applyFrame?.(result);
    host.adapter.onStatus?.("Save state loaded (Running)");
    return result;
  }, { timeoutMs: workerRpcTimeoutMs() });
  if (response?.coreStateName !== "Running") {
    throw new Error(`Core did not resume after battle checkpoint: ${JSON.stringify(response)}`);
  }
}

async function readRendererDiagnostics(page) {
  const diagnostics = await requestWorkerRpc(page, "rendererDiagnostics");
  return diagnostics || {
    requestedVideoBackend: null,
    activeVideoBackend: "unknown",
    requestedPresenterBackend: null,
    activePresenterBackend: "unknown",
    errors: [],
    statusHistory: [],
  };
}

async function requestWorkerRpc(page, type, payload = {}) {
  return page.evaluate(async ({ type, payload, timeoutMs }) => {
    const adapter = window.__host?.adapter;
    if (!adapter?.request) throw new Error(`Active adapter does not expose worker RPC ${type}`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Worker RPC ${type} timed out after ${timeoutMs} ms`)),
        timeoutMs
      );
      Promise.resolve(adapter.request(type, payload)).then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error) => { clearTimeout(timer); reject(error); }
      );
    });
  }, { type, payload, timeoutMs: workerRpcTimeoutMs() });
}

async function loadStateFileWithTimeout(page, saveUrl) {
  return page.evaluate(async ({ saveUrl, timeoutMs }) => {
    if (typeof window.__loadStateFile !== "function") {
      throw new Error("Fixed-state loader is unavailable");
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Worker RPC loadStateFile timed out after ${timeoutMs} ms`)),
        timeoutMs
      );
      Promise.resolve(window.__loadStateFile(saveUrl)).then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error) => { clearTimeout(timer); reject(error); }
      );
    });
  }, { saveUrl, timeoutMs: Math.max(workerRpcTimeoutMs(), 30000) });
}

function workerRpcTimeoutMs() {
  return Math.max(1000, numberEnv("PERF_WORKER_RPC_TIMEOUT_MS", 10000));
}

function withExpectedRendererIdentity(diagnostics, params = {}) {
  const expectedVideoBackend = expectedDolphinVideoBackend(params.video);
  const expectedRequestedPresenterBackend = normalizePresenterIdentity(params.presenter);
  const expectedActivePresenterBackend = expectedVideoBackend === "OGL"
    ? "ogl"
    : expectedRequestedPresenterBackend;
  return {
    ...diagnostics,
    expectedVideoBackend,
    expectedRequestedPresenterBackend,
    expectedActivePresenterBackend,
  };
}

function expectedDolphinVideoBackend(value) {
  const normalized = String(value || "software").toLowerCase();
  if (normalized === "ogl") return "OGL";
  if (normalized === "null") return "Null";
  if (normalized === "webgpu") return "WebGPU";
  if (["wgpu", "webgpu-real", "webgpu2"].includes(normalized)) return "WebGPU-Real";
  return "Software Renderer";
}

function normalizePresenterIdentity(value) {
  const normalized = String(value || "webgl").toLowerCase();
  if (["webgpu", "wgpu"].includes(normalized)) return "webgpu";
  if (["2d", "canvas"].includes(normalized)) return "2d";
  return "webgl";
}

async function waitForPostLoadProgress(page) {
  let first = null;
  let latest = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    latest = await page.evaluate(() => {
      const info = window.__lastFrameInfo || {};
      return {
        frame: Number(info.frame) || 0,
        coreTicks: Number(info.coreTicks) || 0,
        running: Boolean(info.running),
      };
    });
    if (latest.running && latest.frame > 0 && latest.coreTicks > 0) {
      if (first && (latest.frame !== first.frame || latest.coreTicks !== first.coreTicks)) {
        return { first, latest };
      }
      first ||= latest;
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`Core made no verified progress after save-state load: ${JSON.stringify({ first, latest })}`);
}

async function readSample(page, elapsedSeconds) {
  return page.evaluate((elapsedSeconds) => {
    const read = (selector) => document.querySelector(selector)?.textContent?.trim() ?? "";
    const info = window.__lastFrameInfo || {};
    const observedAtMs = performance.now();
    const screen = document.querySelector("#screen");
    const state = (window.__perfGateState ??= { canvas: document.createElement("canvas"), context: null, lastHash: 0 });
    let visibleHash = 0;
    let visibleError = "";
    try {
      state.canvas.width = 96;
      state.canvas.height = 72;
      state.context ??= state.canvas.getContext("2d", { alpha: false, willReadFrequently: true });
      state.context.drawImage(screen, 0, 0, state.canvas.width, state.canvas.height);
      const bytes = state.context.getImageData(0, 0, state.canvas.width, state.canvas.height).data;
      let hash = 2166136261;
      for (let index = 0; index < bytes.length; index += 16) {
        hash ^= bytes[index];
        hash = Math.imul(hash, 16777619);
        hash ^= bytes[index + 1] ?? 0;
        hash = Math.imul(hash, 16777619);
        hash ^= bytes[index + 2] ?? 0;
        hash = Math.imul(hash, 16777619);
      }
      visibleHash = hash >>> 0;
    } catch (error) {
      visibleError = error instanceof Error ? error.message : String(error);
    }
    const visibleChanged = Boolean(visibleHash && state.lastHash && visibleHash !== state.lastHash);
    if (visibleHash) state.lastHash = visibleHash;
    return {
      elapsedSeconds,
      observedAtMs,
      frame: Number(info.frame) || Number(read("#frameCounter")) || 0,
      presentFps: Number(info.presentationFps) || Number(read("#fpsCounter")) || 0,
      visualFps: Number(info.visualChangeFps) || Number(read("#visualFpsCounter")) || 0,
      coreFps: read("#coreFpsCounter"),
      gameSpeed: read("#gameSpeedCounter"),
      gap: read("#presentationGapCounter"),
      wasmJit: read("#ppcWasmJit"),
      ppcWasmBlockCompileCount: Number(info.ppcWasmBlockCompileCount) || 0,
      ppcWasmBlockRunCount: Number(info.ppcWasmBlockRunCount) || 0,
      helper: info.ppcWasmHelperStats || read("#ppcWasmHelperStats"),
      profile: info.frameProfileStats || read("#frameProfileStats"),
      coreTicks: Number(info.coreTicks) || Number(read("#coreTicks")) || 0,
      coreTicksPerSecond: Number(info.coreTicksPerSecond) || 0,
      ppcPc: Number(info.ppcPc) || read("#ppcPc"),
      status: read("#adapterStatus"),
      statusPill: read("#statusPill"),
      coreMode: read("#coreMode"),
      gameTitle: read("#gameTitle"),
      mountNote: read("#mountNote"),
      input: read("#inputSource"),
      visibleHash,
      visibleError,
      visibleChanged,
      causalTelemetry: info.causalTelemetry || window.__causalTelemetry || null,
    };
  }, elapsedSeconds);
}

function fixedWorkObservation(value) {
  return {
    coreTicks: Number(value?.coreTicks),
    frame: Number(value?.frame),
    observedAtMs: Number(value?.observedAtMs),
  };
}

async function readFixedWorkProgress(page) {
  return page.evaluate(() => {
    const info = window.__lastFrameInfo || {};
    return {
      coreTicks: Number(info.coreTicks) || 0,
      frame: Number(info.frame) || 0,
      observedAtMs: performance.now(),
    };
  });
}

async function waitForFixedEmulatedWorkProgress(page, {
  baseline,
  coreTicksPerSecond,
  deadlineMs,
  pollIntervalMs,
  targetCoreSeconds,
  wallTimeCapSeconds,
}) {
  while (true) {
    const delayMs = fixedWorkPollDelayMs({
      nowMs: Date.now(),
      deadlineMs,
      pollIntervalMs,
    });
    if (delayMs > 0) await page.waitForTimeout(delayMs);
    const observation = await readFixedWorkProgress(page);
    const summary = summarizeFixedEmulatedWork({
      targetCoreSeconds,
      coreTicksPerSecond,
      baseline,
      observation,
      wallTimeCapSeconds,
      pollIntervalMs,
    });
    if (summary.reachedTarget || Date.now() >= deadlineMs) {
      return { observation, summary };
    }
  }
}

function deriveCoreRates(sample, previous, fallbackTicksPerSecond = 0) {
  if (!previous) return { ...sample, coreFps: null, gameSpeed: null };
  const elapsed = Number(sample.elapsedSeconds) - Number(previous.elapsedSeconds);
  const frameDelta = Number(sample.frame) - Number(previous.frame);
  const tickDelta = Number(sample.coreTicks) - Number(previous.coreTicks);
  if (elapsed <= 0 || frameDelta < 0 || tickDelta < 0) return sample;
  const coreTicksPerSecond = sample.coreTicksPerSecond || fallbackTicksPerSecond;
  return {
    ...sample,
    coreTicksPerSecond,
    coreFps: frameDelta / elapsed,
    gameSpeed:
      coreTicksPerSecond > 0
        ? (tickDelta * 100) / (coreTicksPerSecond * elapsed)
        : sample.gameSpeed,
  };
}

async function readWebGpuAdapter(page) {
  return page.evaluate(async () => {
    if (!navigator.gpu) return { available: false };
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return { available: true, selected: false };
      const info = adapter.info || {};
      return {
        available: true,
        selected: true,
        vendor: info.vendor || null,
        architecture: info.architecture || null,
        device: info.device || null,
        description: info.description || null,
        features: [...adapter.features].sort(),
        limits: {
          maxTextureDimension2D: adapter.limits.maxTextureDimension2D,
          maxBufferSize: adapter.limits.maxBufferSize,
          maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
        },
      };
    } catch (error) {
      return { available: true, selected: false, error: error.message || String(error) };
    }
  });
}

async function launchBrowser(chromium, headed) {
  const args = [
    "--autoplay-policy=no-user-gesture-required",
    "--enable-webgl",
    "--enable-unsafe-webgpu",
    "--enable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling",
  ];
  if (process.env.PERF_PROBE_AGGRESSIVE_GPU === "1") {
    args.push("--ignore-gpu-blocklist", "--use-angle=d3d11");
  }
  const requestedChannel = process.env.BROWSER_CHANNEL || "chrome";
  const configuredExecutable = process.env.BROWSER_EXECUTABLE
    ? path.resolve(process.env.BROWSER_EXECUTABLE)
    : findInstalledBrowserExecutable(requestedChannel);
  if (configuredExecutable) {
    try {
      const browser = await chromium.launch({
        executablePath: configuredExecutable,
        headless: !headed,
        args,
      });
      return {
        browser,
        requestedChannel,
        actualChannel: process.env.BROWSER_EXECUTABLE ? "custom-executable" : requestedChannel,
        executablePath: configuredExecutable,
        source: process.env.BROWSER_EXECUTABLE ? "configured-executable" : "installed-executable",
      };
    } catch (error) {
      console.warn(`Unable to launch ${configuredExecutable}; falling back to bundled Chromium: ${error.message}`);
    }
  }
  const executablePath = path.resolve(chromium.executablePath());
  const browser = await chromium.launch({ executablePath, headless: !headed, args });
  return {
    browser,
    requestedChannel,
    actualChannel: "bundled-chromium",
    executablePath,
    source: "playwright-bundled",
  };
}

function findInstalledBrowserExecutable(channel) {
  const candidates = [];
  if (process.platform === "win32") {
    const roots = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean);
    const suffix = /edge/i.test(channel)
      ? path.join("Microsoft", "Edge", "Application", "msedge.exe")
      : path.join("Google", "Chrome", "Application", "chrome.exe");
    candidates.push(...roots.map((base) => path.join(base, suffix)));
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
    );
  } else {
    candidates.push("/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser");
  }
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

async function importPlaywright() {
  const configured = process.env.PLAYWRIGHT_MODULE
    ? path.resolve(process.env.PLAYWRIGHT_MODULE)
    : null;
  if (configured) {
    if (!existsSync(configured)) throw new Error(`PLAYWRIGHT_MODULE does not exist: ${configured}`);
    return import(pathToFileURL(configured).href);
  }
  const local = path.join(root, ".omx", "browser-probe", "node_modules", "playwright", "index.mjs");
  return existsSync(local) ? import(pathToFileURL(local).href) : import("playwright");
}

async function ensureAppServer(baseUrl) {
  try {
    const response = await fetch(baseUrl, { cache: "no-store" });
    if (response.ok) return null;
  } catch {
    // Start the repository server below when the requested origin is local.
  }
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" || !new Set(["127.0.0.1", "localhost", "::1"]).has(url.hostname)) {
    throw new Error(`Unable to reach BASE_URL ${baseUrl}`);
  }
  const { server } = await import("./serve.mjs");
  const port = Number.parseInt(url.port || "80", 10);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, url.hostname, resolve);
  });
  return server;
}

async function stageSaveState(saveStatePath, sha256) {
  const directory = path.join(root, ".omx", "perf-fixtures");
  const destination = path.join(directory, `${sha256}.sav`);
  await mkdir(directory, { recursive: true });
  if (path.resolve(saveStatePath) !== path.resolve(destination)) await copyFile(saveStatePath, destination);
  await verifyFileFixture(destination, { label: "staged Kirby-vs-Link save state", expectedSha256: sha256 });
  return destination;
}

async function verifyServedFixture(url, expectedSha256) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Save-state fixture is not served at ${url.href}: HTTP ${response.status}`);
  const sha256 = createHash("sha256").update(Buffer.from(await response.arrayBuffer())).digest("hex");
  if (sha256 !== expectedSha256) {
    throw new Error(`Served save-state SHA-256 mismatch: expected ${expectedSha256}, got ${sha256}`);
  }
}

async function verifyServedApplication(baseUrl, coreArtifact) {
  const roots = [
    "index.html",
    "src/app.js",
    "src/upstream-discio-worker.js",
    "cores/dolphin/dolphin-core-upstream.js",
  ];
  const optionalRuntimeAssets = ["cores/dolphin/prebuilt-jit-cache.bin"];
  for (const asset of optionalRuntimeAssets) {
    if (existsSync(path.join(root, ...asset.split("/")))) roots.push(asset);
  }
  const paths = await collectLocalServedClosure(roots);
  const expectedArtifacts = {};
  const servedArtifacts = {};
  for (const relativePath of paths) {
    const localPath = path.join(root, ...relativePath.split("/"));
    expectedArtifacts[relativePath] = relativePath === "cores/dolphin/dolphin-core-upstream.wasm"
      ? coreArtifact
      : await describeFile(localPath, { hash: true });
    const url = new URL(relativePath, baseUrl);
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`Served application artifact missing: ${url.href} returned ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    servedArtifacts[relativePath] = {
      url: url.href,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }
  const identity = assertServedArtifactIdentity(expectedArtifacts, servedArtifacts);
  const manifestText = JSON.stringify(
    Object.fromEntries(paths.map((relativePath) => [relativePath, {
      bytes: expectedArtifacts[relativePath].bytes,
      sha256: expectedArtifacts[relativePath].sha256,
    }])),
    null,
    2
  );
  const rootResponse = await fetch(baseUrl, { cache: "no-store" });
  return {
    ...identity,
    baseUrl,
    roots,
    dependencyCount: paths.length,
    manifestSha256: createHash("sha256").update(manifestText).digest("hex"),
    isolationHeaders: {
      coop: rootResponse.headers.get("cross-origin-opener-policy"),
      coep: rootResponse.headers.get("cross-origin-embedder-policy"),
    },
  };
}

async function collectLocalServedClosure(rootPaths) {
  const queued = [...new Set(rootPaths.map(normalizeServedPath))];
  const discovered = new Set();
  while (queued.length) {
    const relativePath = queued.shift();
    if (discovered.has(relativePath)) continue;
    const localPath = path.resolve(root, ...relativePath.split("/"));
    if (!localPath.startsWith(`${path.resolve(root)}${path.sep}`) && localPath !== path.resolve(root)) {
      throw new Error(`Served dependency escapes repository root: ${relativePath}`);
    }
    if (!existsSync(localPath)) throw new Error(`Served dependency is missing locally: ${relativePath}`);
    discovered.add(relativePath);
    const extension = path.extname(relativePath).toLowerCase();
    if (![".html", ".js", ".mjs"].includes(extension)) continue;
    const source = await readFile(localPath, "utf8");
    for (const specifier of extractLocalModuleSpecifiers(source, relativePath)) {
      const dependency = resolveServedSpecifier(relativePath, specifier);
      if (!discovered.has(dependency)) queued.push(dependency);
    }
  }
  return [...discovered].sort();
}

function resolveServedSpecifier(importer, specifier) {
  const clean = specifier.split(/[?#]/, 1)[0];
  const joined = clean.startsWith("/")
    ? clean.slice(1)
    : path.posix.join(path.posix.dirname(importer), clean);
  return normalizeServedPath(joined);
}

function normalizeServedPath(value) {
  const normalized = path.posix.normalize(String(value).replaceAll("\\", "/")).replace(/^\.\//, "");
  if (!normalized || normalized === "." || normalized.startsWith("../")) {
    throw new Error(`Invalid served dependency path: ${value}`);
  }
  return normalized;
}

async function collectBuildProvenance(coreArtifact) {
  const buildInfoRelative = [
    "cores/dolphin/dolphin-core-upstream.build.json",
    "cores/dolphin/build-info.json",
  ].find((candidate) => existsSync(path.join(root, ...candidate.split("/")))) ||
    "cores/dolphin/dolphin-core-upstream.build.json";
  const evidenceSpecs = {
    buildInfo: { relativePath: buildInfoRelative, committed: false },
    sourceLock: { relativePath: "provenance/dolphin-source.lock.json", committed: true },
    abiManifest: { relativePath: "provenance/dolphin-core-abi-v1.json", committed: true },
    toolchainLock: { relativePath: "provenance/wasm-toolchain.lock.json", committed: true },
    vendorSnapshot: { relativePath: "provenance/dolphin-vendor-snapshot-v1.json", committed: true },
    nagaCargoLock: { relativePath: "tools/naga-spirv-wgsl/Cargo.lock", committed: true, json: false },
  };
  const loadedEntries = await Promise.all(
    Object.entries(evidenceSpecs).map(async ([key, spec]) => [key, await loadBuildEvidence(spec)])
  );
  const loaded = Object.fromEntries(loadedEntries);
  const jsPath = path.join(root, "cores", "dolphin", "dolphin-core-upstream.js");
  const actualArtifacts = {
    js: await describeBuildArtifact(jsPath, "lf-normalized"),
    wasm: {
      path: "cores/dolphin/dolphin-core-upstream.wasm",
      size: coreArtifact.bytes,
      rawSize: coreArtifact.bytes,
      sha256: coreArtifact.sha256,
      hashMode: "raw",
    },
  };
  const evidenceFiles = Object.fromEntries(
    Object.entries(loaded).map(([key, entry]) => [key, entry.metadata])
  );
  const locked = {
    buildInfo: loaded.buildInfo.value,
    sourceLock: loaded.sourceLock.value,
    abiManifest: loaded.abiManifest.value,
    toolchainLock: loaded.toolchainLock.value,
    vendorSnapshot: loaded.vendorSnapshot.value,
  };
  const actualContractSources = Object.fromEntries(
    await Promise.all((locked.abiManifest?.contractSources || []).map(async (entry) => {
      const relativePath = normalizeEvidencePath(entry?.path);
      return [
        relativePath,
        await describeBuildArtifact(
          path.join(root, ...relativePath.split("/")),
          entry?.hashMode || "raw"
        ),
      ];
    }))
  );
  const untrustedEnvironmentOverrides = Object.fromEntries(
    [
      "DOLPHIN_BUILD_INFO_PATH",
      "HOST_CORE_ABI_VERSION",
      "UPSTREAM_DOLPHIN_SHA",
      "PATCH_HASHES",
      "EMSCRIPTEN_VERSION",
      "EMSCRIPTEN_DIGEST",
      "CMAKE_VERSION",
      "CMAKE_DIGEST",
      "NINJA_VERSION",
      "NINJA_DIGEST",
      "RUST_VERSION",
      "RUST_DIGEST",
      "NAGA_VERSION",
      "NAGA_DIGEST",
    ].filter((name) => process.env[name] != null).map((name) => [name, String(process.env[name]).slice(0, 500)])
  );
  const buildProvenance = {
    source: buildInfoRelative,
    locked,
    actualArtifacts,
    actualContractSources,
    evidenceFiles,
    untrustedEnvironmentOverrides,
    verification: null,
  };
  buildProvenance.verification = validateLockedBuildProvenance(buildProvenance);
  return {
    buildProvenance,
    rawEvidenceFiles: Object.entries(loaded)
      .filter(([, entry]) => entry.raw != null)
      .map(([key, entry]) => ({ key, relativePath: entry.metadata.path, raw: entry.raw })),
    hostCore: { abiVersion: locked.abiManifest?.abiVersion ?? null },
    upstream: { dolphinSha: locked.sourceLock?.upstream?.commit ?? null },
    patches: { hashes: (locked.sourceLock?.patches || []).map((patch) => patch.sha256) },
    toolchain: locked.toolchainLock || null,
  };
}

async function loadBuildEvidence({ relativePath, committed, json = true }) {
  const absolutePath = path.join(root, ...relativePath.split("/"));
  if (!existsSync(absolutePath)) {
    return {
      raw: null,
      value: null,
      metadata: {
        path: relativePath,
        exists: false,
        bytes: null,
        sha256: null,
        normalizedSha256: null,
        trackedAtHead: false,
        matchesHead: false,
        committedRequired: committed,
      },
    };
  }
  const raw = await readFile(absolutePath, "utf8");
  let value = null;
  if (json) {
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Invalid build evidence ${relativePath}: ${error.message}`);
    }
  }
  const rawBuffer = Buffer.from(raw);
  const normalizedBuffer = Buffer.from(raw.replace(/\r\n/g, "\n"));
  const head = spawnSync("git", ["show", `HEAD:${relativePath}`], {
    cwd: root,
    encoding: "buffer",
    windowsHide: true,
  });
  const headNormalized = head.status === 0
    ? Buffer.from(head.stdout.toString("utf8").replace(/\r\n/g, "\n"))
    : null;
  const normalizedSha256 = sha256Buffer(normalizedBuffer);
  return {
    raw,
    value,
    metadata: {
      path: relativePath,
      exists: true,
      bytes: rawBuffer.byteLength,
      sha256: sha256Buffer(rawBuffer),
      normalizedSha256,
      trackedAtHead: head.status === 0,
      matchesHead: Boolean(headNormalized && sha256Buffer(headNormalized) === normalizedSha256),
      committedRequired: committed,
    },
  };
}

function normalizeEvidencePath(value) {
  const normalized = path.posix.normalize(String(value || "").replaceAll("\\", "/"));
  if (!normalized || normalized === "." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    throw new Error(`Invalid build evidence path: ${value}`);
  }
  return normalized;
}

async function describeBuildArtifact(filePath, hashMode) {
  const relativePath = path.relative(root, filePath).replaceAll("\\", "/");
  if (!existsSync(filePath)) {
    return { path: relativePath, size: null, rawSize: null, sha256: null, hashMode };
  }
  const bytes = await readFile(filePath);
  const hashBytes = hashMode === "lf-normalized"
    ? Buffer.from(bytes.toString("utf8").replace(/\r\n/g, "\n"))
    : bytes;
  return {
    path: relativePath,
    size: hashBytes.byteLength,
    rawSize: bytes.byteLength,
    sha256: sha256Buffer(hashBytes),
    hashMode,
  };
}

async function packageBuildProvenance(scenarioDir, rawEvidenceFiles) {
  const destinationDir = path.join(scenarioDir, "build-provenance");
  await mkdir(destinationDir, { recursive: true });
  const packaged = [];
  for (const entry of rawEvidenceFiles || []) {
    const name = `${entry.key}-${path.basename(entry.relativePath)}`;
    const destination = path.join(destinationDir, name);
    await writeFile(destination, entry.raw);
    packaged.push({
      key: entry.key,
      sourcePath: entry.relativePath,
      path: `build-provenance/${name}`,
      bytes: Buffer.byteLength(entry.raw),
      sha256: sha256Buffer(Buffer.from(entry.raw)),
    });
  }
  return packaged;
}

function sha256Buffer(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function saveScreenshot(page, scenarioDir, name) {
  try {
    await page.screenshot({ path: path.join(scenarioDir, name), timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function readComparisonConfig(filePath) {
  if (!filePath) return null;
  const resolved = path.resolve(filePath);
  const parsed = JSON.parse(await readFile(resolved, "utf8"));
  return validateComparisonConfig(parsed);
}

async function readBaseline(filePath) {
  if (!filePath) return null;
  return JSON.parse(await readFile(path.resolve(filePath), "utf8"));
}

function compareToBaseline(results, baselineReport, tolerance) {
  const failures = [];
  const warnings = [];
  if (!baselineReport) return { failures, warnings, compared: [] };
  const baselineByName = new Map((baselineReport.results || []).map((result) => [result.name, result]));
  const compared = [];
  for (const result of results) {
    const base = baselineByName.get(result.name);
    if (!base) {
      warnings.push(`${result.name}: missing from baseline`);
      continue;
    }
    const checks = [
      { key: "minPresentFps", direction: "min" },
      { key: "minCoreFps", direction: "min" },
      { key: "minGameSpeed", direction: "min" },
      { key: "visibleChangedCount", direction: "min" },
      { key: "maxGapMs", direction: "max" },
    ];
    const row = { name: result.name, metrics: {} };
    for (const { key, direction } of checks) {
      const before = Number(base.metrics?.[key] || 0);
      const after = Number(result.metrics?.[key] || 0);
      const allowed = direction === "min" ? before * (1 - tolerance) : before * (1 + tolerance);
      row.metrics[key] = { before, after, allowed, direction };
      if (before > 0 && ((direction === "min" && after < allowed) || (direction === "max" && after > allowed))) {
        failures.push(`${result.name}: ${key} regressed from ${before} to ${after}`);
      }
    }
    compared.push(row);
  }
  return { failures, warnings, compared };
}

function comparisonCsv(comparison, results, config) {
  const runRows = results.map((run) => ({
    recordType: "run",
    runId: run.runId,
    blockId: run.blockId,
    arm: run.arm,
    armName: run.armName,
    valid: run.valid,
    invalidReasons: run.invalidReasons,
    primaryMetric: config.primaryMetric,
    primaryValue: readPath(run, config.primaryMetric),
  }));
  const blockRows = comparison.blocks.map((block) => ({
    recordType: "block",
    blockId: block.blockId,
    valid: block.valid,
    invalidReasons: block.invalidReasons,
    meanA: block.meanA,
    meanB: block.meanB,
    rawEffect: block.rawEffect,
    effectPercent: block.effectPercent,
  }));
  return recordsToCsv([...runRows, ...blockRows]);
}

function runSummaryCsv(results) {
  return recordsToCsv(results.map((run) => ({
    runId: run.runId,
    blockId: run.blockId,
    arm: run.arm,
    armName: run.armName,
    valid: run.valid,
    qualificationEligible: run.qualification?.eligible,
    invalidReasons: run.invalidReasons,
    fullGameSpeedMean: run.metrics.fullTimedWindow?.gameSpeed?.mean,
    fullCoreFpsMean: run.metrics.fullTimedWindow?.coreFps?.mean,
    fullPresentationFpsMean: run.metrics.fullTimedWindow?.presentationFps?.mean,
    fullVisualFpsMean: run.metrics.fullTimedWindow?.visualFps?.mean,
    steadyGameSpeedMean: run.metrics.steadyState?.gameSpeed?.mean,
    steadyCoreFpsMean: run.metrics.steadyState?.coreFps?.mean,
    steadyPresentationFpsMean: run.metrics.steadyState?.presentationFps?.mean,
    steadyVisualFpsMean: run.metrics.steadyState?.visualFps?.mean,
    fixedWorkTargetCoreSeconds: run.metrics.fixedEmulatedWork?.targetCoreSeconds,
    fixedWorkActualCoreTickDelta: run.metrics.fixedEmulatedWork?.actualCoreTickDelta,
    fixedWorkActualFrameDelta: run.metrics.fixedEmulatedWork?.actualFrameDelta,
    fixedWorkElapsedWallSeconds: run.metrics.fixedEmulatedWork?.elapsedWallSeconds,
    fixedWorkReachedTarget: run.metrics.fixedEmulatedWork?.reachedTarget,
    fixedWorkThroughputGameSpeedPercent:
      run.metrics.fixedEmulatedWork?.throughputGameSpeedPercent,
    fixedWorkThroughputCoreFps: run.metrics.fixedEmulatedWork?.throughputCoreFps,
    manifestPath: run.manifestPath,
    summaryPath: run.summaryPath,
    samplesPath: run.samplesPath,
    eventsPath: run.eventsPath,
  })));
}

function runEventsJsonl(manifest, saveStateLoad, inputEvents, samples) {
  const events = [];
  if (manifest) {
    events.push({
      schemaVersion: 1,
      event: "run-manifest",
      startedAt: manifest.startedAt,
      runId: manifest.experiment?.runId || null,
      blockId: manifest.experiment?.blockId || null,
      arm: manifest.experiment?.arm || null,
    });
  }
  if (saveStateLoad) {
    events.push({ schemaVersion: 1, event: "save-state-loaded", ...saveStateLoad });
  }
  if (manifest?.benchmark?.timingStartedAt) {
    events.push({
      schemaVersion: 1,
      event: "timing-started",
      at: manifest.benchmark.timingStartedAt,
      afterVerifiedLoad: true,
    });
  }
  const timedEvents = [
    ...inputEvents.map((inputEvent) => ({
      schemaVersion: 1,
      event: "post-load-input",
      ...inputEvent,
      sortSeconds: inputEvent.deliveredSeconds,
      sortOrder: 1,
    })),
    ...samples.map((sample, index) => ({
      schemaVersion: 1,
      event: "sample",
      index,
      ...sample,
      sortSeconds: sample.elapsedSeconds,
      sortOrder: 0,
    })),
  ].sort((left, right) =>
    left.sortSeconds - right.sortSeconds || left.sortOrder - right.sortOrder
  );
  events.push(...timedEvents.map(({ sortSeconds, sortOrder, ...event }) => event));
  return events.map((event) => JSON.stringify(event)).join("\n") + (events.length ? "\n" : "");
}

function rejectMenuDrivingConfiguration() {
  const inputScript = process.env.INPUT_SCRIPT;
  if (inputScript != null && !/^(?:\s*|none|off)$/i.test(inputScript)) {
    throw new Error("perf:gate only supports INPUT_SCRIPT=none; menu/character-select scripts are forbidden");
  }
  if (process.env.SAVE_STATE_AT != null && Number(process.env.SAVE_STATE_AT) !== 0) {
    throw new Error("perf:gate requires SAVE_STATE_AT=0 so timing begins after the fixed battle loads");
  }
}

function shouldFailScenarioTargets(scenario) {
  if (cli.strict || process.env.PERF_STRICT === "1") return true;
  return normalizeTargetMode(cli.targetMode || process.env.PERF_TARGET_MODE || "fail") === "fail" && scenario.required;
}

function normalizeTargetMode(value) {
  if (value === "fail" || value === "warn") return value;
  throw new Error(`Invalid target mode "${value}". Use "fail" or "warn".`);
}

function requiredFixturePath(value, label, source) {
  if (!value) throw new Error(`${label} is required; set ${source}`);
  return value;
}

function resolveOutDir(value) {
  if (path.isAbsolute(value)) return value;
  const normalized = String(value).replaceAll("\\", "/").replace(/^\.\//, "");
  return normalized === ".omx" || normalized.startsWith(".omx/")
    ? path.join(root, ...normalized.split("/"))
    : path.join(root, ".omx", value);
}

function maxRegex(text, regex) {
  let max = 0;
  for (const match of text.matchAll(regex)) {
    const value = Number.parseFloat(match[1]);
    if (Number.isFinite(value)) max = Math.max(max, value);
  }
  return max;
}

function lastMatch(text, regex) {
  let latest = "";
  for (const match of text.matchAll(regex)) latest = match[1];
  return latest;
}

function readPath(value, dottedPath) {
  return dottedPath.split(".").reduce((current, key) => current?.[key], value);
}

function numberEnv(name, fallback) {
  const value = Number.parseFloat(process.env[name] || "");
  return Number.isFinite(value) ? value : fallback;
}

function optionalPositiveNumber(value, source) {
  if (value == null || String(value).trim() === "") return null;
  const number = Number.parseFloat(String(value));
  if (!Number.isFinite(number) || !(number > 0)) {
    throw new Error(`${source} requires a positive finite numeric value`);
  }
  return number;
}

function parseArgs(args) {
  const parsed = {
    baseline: "",
    baseUrl: "",
    comparisonConfig: "",
    duration: undefined,
    outDir: "",
    perfInputScript: undefined,
    requireBaseline: false,
    rom: "",
    sampleMs: undefined,
    saveState: "",
    strict: false,
    targetCoreSeconds: undefined,
    targetMode: "",
    tolerance: undefined,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--baseline") parsed.baseline = requiredArg(args, ++index, arg);
    else if (arg === "--base-url") parsed.baseUrl = requiredArg(args, ++index, arg);
    else if (arg === "--comparison-config") parsed.comparisonConfig = requiredArg(args, ++index, arg);
    else if (arg === "--duration") parsed.duration = numberArg(args, ++index, arg);
    else if (arg === "--out-dir") parsed.outDir = requiredArg(args, ++index, arg);
    else if (arg === "--perf-input-script") parsed.perfInputScript = requiredArg(args, ++index, arg);
    else if (arg === "--require-baseline") parsed.requireBaseline = true;
    else if (arg === "--rom") parsed.rom = requiredArg(args, ++index, arg);
    else if (arg === "--sample-ms") parsed.sampleMs = numberArg(args, ++index, arg);
    else if (arg === "--save-state") parsed.saveState = requiredArg(args, ++index, arg);
    else if (arg === "--strict") parsed.strict = true;
    else if (arg === "--target-core-seconds") parsed.targetCoreSeconds = numberArg(args, ++index, arg);
    else if (arg === "--target-mode") parsed.targetMode = requiredArg(args, ++index, arg);
    else if (arg === "--tolerance") parsed.tolerance = numberArg(args, ++index, arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function requiredArg(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function numberArg(args, index, flag) {
  const value = Number.parseFloat(requiredArg(args, index, flag));
  if (!Number.isFinite(value)) throw new Error(`${flag} requires a numeric value`);
  return value;
}
