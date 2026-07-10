import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  FIXED_MELEE_BATTLE_FIXTURE,
  assertBattleCheckpoint,
  assertRunProvenance,
  assertServedArtifactIdentity,
  buildComparisonTasklist,
  buildReplacementBlock,
  collectRunMetadata,
  classifyGateOutcome,
  describeFile,
  evaluateQualificationProvenance,
  evaluateRunValidity,
  parseBattleCheckpoint,
  parseProfileMetrics,
  recordsToCsv,
  summarizeComparison,
  summarizeTimedMetricWindows,
  validateComparisonConfig,
  verifyFileFixture,
} from "./perf-artifacts.mjs";

const root = process.cwd();
const cli = parseArgs(process.argv.slice(2));

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
  const settleSeconds = numberEnv("SETTLE_SECONDS", 2);
  const tolerance = cli.tolerance ?? numberEnv("PERF_DROP_TOLERANCE", 0.05);
  const strict = cli.strict || process.env.PERF_STRICT === "1";
  const targetMode = normalizeTargetMode(cli.targetMode || process.env.PERF_TARGET_MODE || "fail");
  const requireBaseline = cli.requireBaseline || process.env.PERF_REQUIRE_BASELINE === "1";
  const baselinePath = cli.baseline || process.env.PERF_BASELINE || "";
  const headed = process.env.PERF_PROBE_HEADED === "1";
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
    const buildProvenance = await collectBuildProvenance();
    const context = {
      baseUrl,
      buildProvenance,
      chromium,
      coreArtifact,
      corePath,
      durationSeconds,
      headed,
      outDir,
      romFixture,
      romPath,
      sampleMs,
      saveFixture,
      saveStatePath,
      saveStateUrl,
      servedApplication,
      settleSeconds,
      strict,
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
  const invalidReasons = [];
  let browser = null;
  let manifest = null;
  let saveStateLoad = null;
  let finalScreenshotCaptured = false;
  const url = new URL(context.baseUrl);
  for (const [key, value] of Object.entries(scenario.params)) url.searchParams.set(key, value);
  url.searchParams.set("probe", `${scenario.name}-${Date.now()}`);

  try {
    browser = await launchBrowser(context.chromium, context.headed);
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
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
      browserChannel: process.env.BROWSER_CHANNEL || "chrome",
      browserVersion,
      browserExecutable: context.chromium.executablePath(),
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
      inputScript: "none",
      sceneLabel: FIXED_MELEE_BATTLE_FIXTURE.sceneLabel,
      artifactDescriptions: {
        rom: context.romFixture,
        core: context.coreArtifact,
        saveState: context.saveFixture,
      },
    });
    manifest.schemaVersion = 2;
    manifest.benchmark.inputScriptMode = "none";
    manifest.benchmark.timingStartsAfterVerifiedLoad = true;
    manifest.benchmark.settleSeconds = context.settleSeconds;
    manifest.benchmark.cacheState = scenario.experiment?.cacheState || "cold-ephemeral";
    manifest.browser.profileId = `${manifest.benchmark.cacheState}:${scenario.experiment?.runId || scenario.name}:${manifest.startedAt}`;
    manifest.hostCore = context.buildProvenance.hostCore;
    manifest.eventSchema = { version: "1" };
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
    const response = await page.evaluate((saveUrl) => window.__loadStateFile(saveUrl), context.saveStateUrl);
    saveStateLoad = { attemptedAt, readiness, pauseResponse, response, loaded: Boolean(response?.loaded) };
    if (!saveStateLoad.loaded) {
      throw new Error(`Save-state load failed: ${response?.error || JSON.stringify(response)}`);
    }
    const battleCheckpoint = assertBattleCheckpoint(parseBattleCheckpoint(response));
    manifest.fixture.battleCheckpoint = battleCheckpoint;
    await resumeAfterBattleCheckpoint(page);
    saveStateLoad.postLoadProgress = await waitForPostLoadProgress(page);
    await page.waitForTimeout(context.settleSeconds * 1000);
    manifest.fixture.saveStateLoaded = true;
    manifest.fixture.loadResult = saveStateLoad;
    manifest.benchmark.timingStartedAt = new Date().toISOString();
    assertRunProvenance(manifest);
    await writeFile(path.join(scenarioDir, "manifest.json"), JSON.stringify(manifest, null, 2));

    const startedAt = Date.now();
    const totalSamples = Math.ceil((context.durationSeconds * 1000) / context.sampleMs);
    for (let index = 0; index <= totalSamples; index += 1) {
      const elapsedSeconds = (Date.now() - startedAt) / 1000;
      const sample = deriveCoreRates(
        await readSample(page, elapsedSeconds),
        samples.at(-1),
        Number(saveStateLoad.response?.coreTicksPerSecond) || 0
      );
      samples.push({ ...sample, ...parseProfileMetrics(sample.helper, sample.profile) });
      if (index % Math.max(1, Math.round(10000 / context.sampleMs)) === 0) {
        console.log(
          `[perf-gate] ${scenario.name} t=${elapsedSeconds.toFixed(1)} ` +
          `frame=${sample.frame} present=${sample.presentFps} core=${sample.coreFps} ` +
          `visual=${sample.visualFps} speed=${sample.gameSpeed}`
        );
      }
      if (index < totalSamples) await page.waitForTimeout(context.sampleMs);
    }
    finalScreenshotCaptured = await saveScreenshot(page, scenarioDir, "final.png");
  } catch (error) {
    invalidReasons.push(error.message || String(error));
    consoleLines.push(`[probe-error] ${error.stack || error.message}`);
    if (browser) {
      const pages = browser.contexts().flatMap((browserContext) => browserContext.pages());
      if (pages[0]) await saveScreenshot(pages[0], scenarioDir, "error.png");
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  if (!samples.length) invalidReasons.push("no timed samples were collected");
  if (!saveStateLoad?.loaded) invalidReasons.push("fixed battle save did not load before timing");
  if (!finalScreenshotCaptured && samples.length) invalidReasons.push("final screenshot was not captured");

  const summary = summarizeScenario(
    scenario,
    url.href,
    samples,
    scenarioDir,
    consoleLines,
    consoleErrors,
    invalidReasons
  );
  if (manifest) {
    manifest.finishedAt = new Date().toISOString();
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
    };
    summary.qualification = manifest.qualification;
    await writeFile(path.join(scenarioDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  }
  await Promise.all([
    writeFile(path.join(scenarioDir, "console.log"), consoleLines.join("\n")),
    writeFile(path.join(scenarioDir, "samples.json"), JSON.stringify(samples, null, 2)),
    writeFile(path.join(scenarioDir, "samples.csv"), recordsToCsv(samples)),
    writeFile(path.join(scenarioDir, "events.jsonl"), runEventsJsonl(manifest, saveStateLoad, samples)),
    writeFile(path.join(scenarioDir, "summary.json"), JSON.stringify(summary, null, 2)),
  ]);
  return summary;
}

function summarizeScenario(scenario, url, samples, scenarioDir, consoleLines, consoleErrors, invalidReasons) {
  const timedWindow = samples;
  const windows = summarizeTimedMetricWindows(samples, scenario.assertAfterSeconds);
  const steadyStateWindow = windows.steadyStateWindow;
  const final = samples.at(-1) || {};
  const helperText = timedWindow.map((sample) => sample.helper || "").join(" | ");
  const fullTimedWindow = windows.fullTimedWindow.metrics;
  const steadyState = steadyStateWindow.metrics;
  const metrics = {
    fullTimedWindow,
    steadyState,
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
    underrun: maxRegex(helperText, /underrun:(\d+)/g),
    drop: maxRegex(helperText, /drop:(\d+)/g),
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
  for (const name of ["disable", "regalloc", "smearcompile", "blockmerge", "shortprefix", "fastmemhoist", "nogamepad", "nojitcache"]) {
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
  const response = await page.evaluate(async () => {
    const host = window.__host;
    if (!host?.adapter?.request) throw new Error("Validator cannot synchronously pause the active adapter");
    return host.adapter.request("validationSetCorePaused", { paused: true });
  });
  if (!response?.paused || response?.coreStateName !== "Paused") {
    throw new Error(`Core did not enter paused state before fixed save load: ${JSON.stringify(response)}`);
  }
  return response;
}

async function resumeAfterBattleCheckpoint(page) {
  const response = await page.evaluate(async () => {
    const host = window.__host;
    if (!host?.adapter?.request) throw new Error("Validator cannot resume the active adapter");
    const result = await host.adapter.request("validationSetCorePaused", { paused: false });
    host.adapter.applyFrame?.(result);
    host.adapter.onStatus?.("Save state loaded (Running)");
    return result;
  });
  if (response?.coreStateName !== "Running") {
    throw new Error(`Core did not resume after battle checkpoint: ${JSON.stringify(response)}`);
  }
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
      frame: Number(info.frame) || Number(read("#frameCounter")) || 0,
      presentFps: Number(info.presentationFps) || Number(read("#fpsCounter")) || 0,
      visualFps: Number(info.visualChangeFps) || Number(read("#visualFpsCounter")) || 0,
      coreFps: read("#coreFpsCounter"),
      gameSpeed: read("#gameSpeedCounter"),
      gap: read("#presentationGapCounter"),
      wasmJit: read("#ppcWasmJit"),
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
    };
  }, elapsedSeconds);
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
  const channel = process.env.BROWSER_CHANNEL || "chrome";
  try {
    return await chromium.launch({ channel, headless: !headed, args });
  } catch (error) {
    console.warn(`Unable to launch ${channel}; falling back to bundled Chromium: ${error.message}`);
    return chromium.launch({ headless: !headed, args });
  }
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
  const paths = {
    index: "index.html",
    app: "src/app.js",
    worker: "src/upstream-discio-worker.js",
    coreJs: "cores/dolphin/dolphin-core-upstream.js",
    coreWasm: "cores/dolphin/dolphin-core-upstream.wasm",
  };
  const expectedArtifacts = {};
  const servedArtifacts = {};
  for (const [name, relativePath] of Object.entries(paths)) {
    const localPath = path.join(root, ...relativePath.split("/"));
    expectedArtifacts[name] = name === "coreWasm"
      ? coreArtifact
      : await describeFile(localPath, { hash: true });
    const url = new URL(relativePath, baseUrl);
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`Served application artifact missing: ${url.href} returned ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    servedArtifacts[name] = {
      url: url.href,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }
  const identity = assertServedArtifactIdentity(expectedArtifacts, servedArtifacts);
  const rootResponse = await fetch(baseUrl, { cache: "no-store" });
  return {
    ...identity,
    baseUrl,
    isolationHeaders: {
      coop: rootResponse.headers.get("cross-origin-opener-policy"),
      coep: rootResponse.headers.get("cross-origin-embedder-policy"),
    },
  };
}

async function collectBuildProvenance() {
  const buildInfoPath = path.join(root, "cores", "dolphin", "build-info.json");
  let buildInfo = {};
  if (existsSync(buildInfoPath)) {
    try {
      buildInfo = JSON.parse(await readFile(buildInfoPath, "utf8"));
    } catch (error) {
      throw new Error(`Invalid core build provenance ${buildInfoPath}: ${error.message}`);
    }
  }
  const patchHashes = parseListEnv("PATCH_HASHES", readPath(buildInfo, "patches.hashes") || []);
  return {
    buildInfoPath: existsSync(buildInfoPath) ? buildInfoPath : null,
    hostCore: {
      abiVersion: process.env.HOST_CORE_ABI_VERSION || readPath(buildInfo, "hostCore.abiVersion") || null,
    },
    upstream: {
      dolphinSha: process.env.UPSTREAM_DOLPHIN_SHA || readPath(buildInfo, "upstream.dolphinSha") || null,
    },
    patches: { hashes: patchHashes },
    toolchain: {
      node: process.version,
      emscripten: process.env.EMSCRIPTEN_VERSION || readPath(buildInfo, "toolchain.emscripten") || null,
      cmake: process.env.CMAKE_VERSION || readPath(buildInfo, "toolchain.cmake") || null,
      ninja: process.env.NINJA_VERSION || readPath(buildInfo, "toolchain.ninja") || null,
      rust: process.env.RUST_VERSION || readPath(buildInfo, "toolchain.rust") || null,
      naga: process.env.NAGA_VERSION || readPath(buildInfo, "toolchain.naga") || null,
    },
  };
}

function parseListEnv(name, fallback) {
  const value = process.env[name];
  if (!value) return Array.isArray(fallback) ? fallback.map(String) : [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // Accept a comma-separated list for PowerShell convenience.
  }
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
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
    manifestPath: run.manifestPath,
    summaryPath: run.summaryPath,
    samplesPath: run.samplesPath,
    eventsPath: run.eventsPath,
  })));
}

function runEventsJsonl(manifest, saveStateLoad, samples) {
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
  events.push(...samples.map((sample, index) => ({ schemaVersion: 1, event: "sample", index, ...sample })));
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
  return path.isAbsolute(value) ? value : path.join(root, ".omx", value);
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

function parseArgs(args) {
  const parsed = {
    baseline: "",
    baseUrl: "",
    comparisonConfig: "",
    duration: undefined,
    outDir: "",
    requireBaseline: false,
    rom: "",
    sampleMs: undefined,
    saveState: "",
    strict: false,
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
    else if (arg === "--require-baseline") parsed.requireBaseline = true;
    else if (arg === "--rom") parsed.rom = requiredArg(args, ++index, arg);
    else if (arg === "--sample-ms") parsed.sampleMs = numberArg(args, ++index, arg);
    else if (arg === "--save-state") parsed.saveState = requiredArg(args, ++index, arg);
    else if (arg === "--strict") parsed.strict = true;
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
