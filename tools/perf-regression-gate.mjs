import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const cli = parseArgs(process.argv.slice(2));
const outDir = path.join(root, ".omx", cli.outDir || process.env.OUT_DIR || `perf-regression-gate-${Date.now()}`);
const baseUrl = cli.baseUrl || process.env.BASE_URL || "http://127.0.0.1:8082/";
const romPath =
  cli.rom || process.env.ROM || "F:/Games/GameCube/Super Smash Bros. Melee (USA) (En,Ja) (v1.02).iso";
const durationSeconds = cli.duration ?? numberEnv("DURATION", 190);
const sampleMs = cli.sampleMs ?? numberEnv("SAMPLE_MS", 1000);
const tolerance = cli.tolerance ?? numberEnv("PERF_DROP_TOLERANCE", 0.05);
const strict = cli.strict || process.env.PERF_STRICT === "1";
const targetMode = normalizeTargetMode(cli.targetMode || process.env.PERF_TARGET_MODE || "fail");
const requireBaseline = cli.requireBaseline || process.env.PERF_REQUIRE_BASELINE === "1";
const baselinePath = cli.baseline || process.env.PERF_BASELINE || "";
const scenarios = selectedScenarios();
const inputScript = parseInputScript(
  process.env.INPUT_SCRIPT ||
    // Drives Melee from boot through the save dialog, attract cutscene, title
    // skip, main menu, 1P mode, Regular Match -> reaches the character select
    // screen by ~t=200s. Each X press = GameCube A; Enter = Start.
    "down:8:x,up:9:x,down:30:Enter,up:31:Enter,down:50:Enter,up:51:Enter,down:75:Enter,up:76:Enter,down:100:x,up:101:x,down:120:x,up:121:x,down:140:x,up:141:x,down:160:x,up:161:x,down:180:x,up:181:x,down:200:x,up:201:x"
);

if (!existsSync(romPath)) {
  throw new Error(`Missing Melee ISO: ${romPath}`);
}

const { chromium } = await importPlaywright();
await mkdir(outDir, { recursive: true });
const localServer = await ensureAppServer();

if (requireBaseline && !baselinePath) {
  throw new Error("PERF_BASELINE or --baseline is required in regression-guard mode");
}
const baseline = await readBaseline(baselinePath);
const results = [];
for (const scenario of scenarios) {
  results.push(await runScenario(scenario));
}
if (localServer) {
  await new Promise((resolve) => localServer.close(resolve));
}

const comparison = compareToBaseline(results, baseline);
const failed = results.flatMap((result) => result.failures).concat(comparison.failures);
const warnings = results.flatMap((result) => result.warnings).concat(comparison.warnings);
const report = {
  verdict: failed.length === 0 ? "PASS" : "FAIL",
  generatedAt: new Date().toISOString(),
  baseUrl,
  romPath,
  durationSeconds,
  sampleMs,
  tolerance,
  strict,
  targetMode,
  requireBaseline,
  baselinePath,
  failures: failed,
  warnings,
  results,
  comparison
};

await writeFile(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (failed.length > 0) {
  process.exitCode = 1;
}

async function runScenario(scenario) {
  const scenarioDir = path.join(outDir, scenario.name);
  await mkdir(scenarioDir, { recursive: true });
  const consoleLines = [];
  const scenarioInputScript = inputScript.map((event) => ({ ...event, sent: false }));
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("console", (message) => consoleLines.push(`[${message.type()}] ${message.text()}`));
  page.on("pageerror", (error) => consoleLines.push(`[pageerror] ${error.stack || error.message}`));

  const url = new URL(baseUrl);
  for (const [key, value] of Object.entries(scenario.params)) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set("probe", `${scenario.name}-${Date.now()}`);

  const samples = [];
  try {
    await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 30000 });
    await ensureDebugOpen(page);
    await page.setInputFiles("#romInput", romPath);
    await page.click("#screen");
    await waitForMount(page, scenarioDir);

    const startedAt = Date.now();
    const totalSamples = Math.ceil((durationSeconds * 1000) / sampleMs);
    for (let index = 0; index <= totalSamples; index += 1) {
      const elapsedSeconds = (Date.now() - startedAt) / 1000;
      for (const event of scenarioInputScript.filter((candidate) => !candidate.sent && candidate.second <= elapsedSeconds)) {
        event.sent = true;
        if (event.action === "down") {
          await page.keyboard.down(event.key);
        } else {
          await page.keyboard.up(event.key);
        }
        await saveScreenshot(page, scenarioDir, `${String(event.index).padStart(2, "0")}-${event.action}-${safeKeyName(event.key)}.png`);
      }

      const sample = await readSample(page, elapsedSeconds);
      samples.push(sample);
      if (index % Math.max(1, Math.round(10000 / sampleMs)) === 0) {
        console.log(
          `${scenario.name} t=${elapsedSeconds.toFixed(1)} frame=${sample.frame} present=${sample.presentFps} core=${sample.coreFps} speed=${sample.gameSpeed} hash=${sample.visibleHash} changed=${sample.visibleChanged}`
        );
      }
      await page.waitForTimeout(sampleMs);
    }

    await saveScreenshot(page, scenarioDir, "final.png");
  } catch (error) {
    consoleLines.push(`[probe-error] ${error.stack || error.message}`);
    await saveScreenshot(page, scenarioDir, "error.png");
  } finally {
    await writeFile(path.join(scenarioDir, "console.log"), consoleLines.join("\n")).catch(() => {});
    await browser.close();
  }

  const summary = summarizeScenario(scenario, url.href, samples, scenarioDir, consoleLines);
  await writeFile(path.join(scenarioDir, "samples.json"), JSON.stringify(samples, null, 2));
  await writeFile(path.join(scenarioDir, "summary.json"), JSON.stringify(summary, null, 2));
  return summary;
}

async function ensureAppServer() {
  try {
    const response = await fetch(baseUrl, { cache: "no-store" });
    if (response.ok) return null;
  } catch {
    // Fall through and start a local server when BASE_URL points at localhost.
  }

  const url = new URL(baseUrl);
  const localHosts = new Set(["127.0.0.1", "localhost", "::1"]);
  if (url.protocol !== "http:" || !localHosts.has(url.hostname)) {
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

function summarizeScenario(scenario, url, samples, scenarioDir, consoleLines) {
  const after = samples.filter((sample) => sample.elapsedSeconds >= scenario.assertAfterSeconds);
  const tail = after.length ? after : samples.slice(-20);
  const final = samples.at(-1) || {};
  const helperTail = tail.map((sample) => sample.helper || "").join(" | ");
  const metrics = {
    minPresentFps: minMetric(tail, "presentFps"),
    minCoreFps: minMetric(tail, "coreFps"),
    minGameSpeed: minMetric(tail, "gameSpeed"),
    maxGapMs: maxRegex(tail.map((sample) => sample.gap || "").join(" "), /(\d+(?:\.\d+)?)\s+max/g),
    maxXfbDtMs: maxRegex(helperTail, /xfb_dt:[^|]*max:(\d+(?:\.\d+)?)/g),
    maxGlError: lastMatch(helperTail, /glerr:(0x[0-9a-f]+)/gi) || "unknown",
    emitfail: maxRegex(helperTail, /emitfail:(\d+)/g),
    compilefail: maxRegex(helperTail, /compilefail:(\d+)/g),
    underrun: maxRegex(helperTail, /underrun:(\d+)/g),
    drop: maxRegex(helperTail, /drop:(\d+)/g),
    visibleChangedCount: tail.filter((sample) => sample.visibleChanged).length,
    readableCanvasSamples: tail.filter((sample) => sample.visibleHash && !sample.visibleError).length
  };

  const failures = [];
  const warnings = [];
  const scenarioIssue = scenario.required || strict ? failures : warnings;
  const targetIssue = shouldFailScenarioTargets(scenario) ? failures : warnings;
  if (!samples.length) scenarioIssue.push(`${scenario.name}: no samples collected`);
  if (!String(final.mountNote || "").includes("Dolphin")) scenarioIssue.push(`${scenario.name}: Dolphin did not mount`);
  if (metrics.emitfail > 0) failures.push(`${scenario.name}: emitfail=${metrics.emitfail}`);
  if (metrics.compilefail > 0) failures.push(`${scenario.name}: compilefail=${metrics.compilefail}`);
  if (metrics.minPresentFps < scenario.thresholds.minPresentFps) {
    targetIssue.push(`${scenario.name}: min present FPS ${metrics.minPresentFps} < ${scenario.thresholds.minPresentFps}`);
  }
  if (metrics.minCoreFps < scenario.thresholds.minCoreFps) {
    targetIssue.push(`${scenario.name}: min core FPS ${metrics.minCoreFps} < ${scenario.thresholds.minCoreFps}`);
  }
  if (metrics.minGameSpeed < scenario.thresholds.minGameSpeed) {
    targetIssue.push(`${scenario.name}: min game speed ${metrics.minGameSpeed}% < ${scenario.thresholds.minGameSpeed}%`);
  }
  if (metrics.maxGapMs > scenario.thresholds.maxGapMs) {
    targetIssue.push(`${scenario.name}: max frame gap ${metrics.maxGapMs}ms > ${scenario.thresholds.maxGapMs}ms`);
  }
  if (scenario.thresholds.requireVisibleChange && metrics.visibleChangedCount === 0) {
    targetIssue.push(`${scenario.name}: no visible canvas hash changes after ${scenario.assertAfterSeconds}s`);
  }
  if (scenario.thresholds.requireNoGlError && metrics.maxGlError !== "0x0") {
    scenarioIssue.push(`${scenario.name}: GL error ${metrics.maxGlError}`);
  }
  if (consoleLines.some((line) => /\[pageerror\]|\[probe-error\]/i.test(line))) {
    scenarioIssue.push(`${scenario.name}: browser console has page/probe errors`);
  }

  return {
    name: scenario.name,
    required: scenario.required,
    url,
    outDir: scenarioDir,
    screenshot: path.join(scenarioDir, "final.png"),
    samplesPath: path.join(scenarioDir, "samples.json"),
    summaryPath: path.join(scenarioDir, "summary.json"),
    sampleCount: samples.length,
    assertAfterSeconds: scenario.assertAfterSeconds,
    thresholds: scenario.thresholds,
    metrics,
    final,
    tail: samples.slice(-15),
    failures,
    warnings
  };
}

function compareToBaseline(results, baselineReport) {
  const failures = [];
  const warnings = [];
  if (!baselineReport) {
    return { failures, warnings, compared: [] };
  }

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
      { key: "maxGapMs", direction: "max" }
    ];
    const row = { name: result.name, metrics: {} };
    for (const { key, direction } of checks) {
      const before = Number(base.metrics?.[key] || 0);
      const after = Number(result.metrics?.[key] || 0);
      if (direction === "min") {
        const allowed = before * (1 - tolerance);
        row.metrics[key] = { before, after, allowed, direction };
        if (before > 0 && after < allowed) {
          failures.push(`${result.name}: ${key} dropped from ${before} to ${after} (allowed >= ${allowed.toFixed(1)})`);
        }
      } else {
        const allowed = before * (1 + tolerance);
        row.metrics[key] = { before, after, allowed, direction };
        if (before > 0 && after > allowed) {
          failures.push(`${result.name}: ${key} regressed from ${before} to ${after} (allowed <= ${allowed.toFixed(1)})`);
        }
      }
    }
    compared.push(row);
  }
  return { failures, warnings, compared };
}

async function waitForMount(page, scenarioDir) {
  for (let second = 0; second <= 180; second += 1) {
    const mounted = await page.evaluate(() => {
      const coreMode = document.querySelector("#coreMode")?.textContent?.trim() ?? "";
      const mountNote = document.querySelector("#mountNote")?.textContent?.trim() ?? "";
      const status = document.querySelector("#statusPill")?.textContent?.trim() ?? "";
      return { mounted: coreMode === "Dolphin" && mountNote.includes("Dolphin"), coreMode, mountNote, status };
    });
    if (mounted.mounted) {
      return;
    }
    if (/failed|error/i.test(mounted.status)) {
      await saveScreenshot(page, scenarioDir, "mount-error.png");
      throw new Error(`Core mount failed: ${mounted.status}`);
    }
    await page.waitForTimeout(1000);
  }
  await saveScreenshot(page, scenarioDir, "mount-timeout.png");
  throw new Error("Timed out waiting for Dolphin upstream core mount");
}

async function readSample(page, elapsedSeconds) {
  return page.evaluate((elapsedSeconds) => {
    const read = (selector) => document.querySelector(selector)?.textContent?.trim() ?? "";
    const screen = document.querySelector("#screen");
    const state = (window.__perfGateState ??= {
      canvas: document.createElement("canvas"),
      context: null,
      lastHash: 0
    });
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
      frame: read("#frameCounter"),
      presentFps: read("#fpsCounter"),
      visualFps: read("#visualFpsCounter"),
      coreFps: read("#coreFpsCounter"),
      gameSpeed: read("#gameSpeedCounter"),
      gap: read("#presentationGapCounter"),
      wasmJit: read("#ppcWasmJit"),
      helper: read("#ppcWasmHelperStats"),
      profile: read("#frameProfileStats"),
      coreTicks: read("#coreTicks"),
      ppcPc: read("#ppcPc"),
      status: read("#adapterStatus"),
      statusPill: read("#statusPill"),
      coreMode: read("#coreMode"),
      gameTitle: read("#gameTitle"),
      mountNote: read("#mountNote"),
      input: read("#inputSource"),
      visibleHash,
      visibleError,
      visibleChanged
    };
  }, elapsedSeconds);
}

function selectedScenarios() {
  const all = [
    {
      name: "software-stable",
      required: true,
      assertAfterSeconds: numberEnv("ASSERT_AFTER_SECONDS", 170),
      params: {
        core: "upstream",
        video: "software",
        cpu: "dual",
        speed: "1",
        present: "full",
        presenter: "webgpu",
        pacing: "direct",
        wasmjit: "1",
        jittier: "guarded",
        jitwarmup: "700",
        oc: "1",
        queue: "2",
        fastsw: "1",
        metrics: "1"
      },
      thresholds: {
        minPresentFps: numberEnv("SOFTWARE_MIN_PRESENT_FPS", 50),
        minCoreFps: numberEnv("SOFTWARE_MIN_CORE_FPS", 55),
        minGameSpeed: numberEnv("SOFTWARE_MIN_GAME_SPEED", 95),
        maxGapMs: numberEnv("SOFTWARE_MAX_GAP_MS", 90),
        requireVisibleChange: true,
        requireNoGlError: true
      }
    },
    {
      name: "ogl-hardware",
      required: false,
      assertAfterSeconds: numberEnv("ASSERT_AFTER_SECONDS", 170),
      params: {
        core: "upstream",
        video: "ogl",
        cpu: "dual",
        speed: "1",
        present: "half",
        presenter: "webgl",
        oglproxy: process.env.OGL_PROXY_MODE || "proxy",
        wasmjit: "2",
        jittier: "mixed",
        jitwarmup: "700",
        oc: "1",
        queue: "8",
        fastsw: "1",
        metrics: "1"
      },
      thresholds: {
        minPresentFps: numberEnv("OGL_MIN_PRESENT_FPS", 1),
        minCoreFps: numberEnv("OGL_MIN_CORE_FPS", 45),
        minGameSpeed: numberEnv("OGL_MIN_GAME_SPEED", 80),
        maxGapMs: numberEnv("OGL_MAX_GAP_MS", 600),
        requireVisibleChange: true,
        requireNoGlError: false
      }
    }
  ];
  const requested = (process.env.PERF_SCENARIOS || all.map((scenario) => scenario.name).join(","))
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  return all.filter((scenario) => requested.includes(scenario.name));
}

function shouldFailScenarioTargets(scenario) {
  if (strict) return true;
  return targetMode === "fail" && scenario.required;
}

function normalizeTargetMode(value) {
  if (value === "fail" || value === "warn") return value;
  throw new Error(`Invalid target mode "${value}". Use "fail" or "warn".`);
}

async function importPlaywright() {
  const local = path.join(root, ".omx", "browser-probe", "node_modules", "playwright", "index.mjs");
  if (existsSync(local)) {
    return import(pathToFileURL(local).href);
  }
  return import("playwright");
}

async function launchBrowser() {
  const args = [
    "--autoplay-policy=no-user-gesture-required",
    "--enable-webgl",
    "--enable-unsafe-webgpu",
    "--ignore-gpu-blocklist",
    "--use-angle=d3d11"
  ];
  const channel = process.env.BROWSER_CHANNEL || "chrome";
  try {
    return await chromium.launch({ channel, headless: true, args });
  } catch (error) {
    if (!channel) throw error;
    console.warn(`Unable to launch ${channel}; falling back to bundled Chromium: ${error.message}`);
    return chromium.launch({ headless: true, args });
  }
}

async function ensureDebugOpen(page) {
  await page.evaluate(() => {
    const panel = document.querySelector("#debugPanel");
    const toggle = document.querySelector("#debugToggle");
    if (panel?.hidden) toggle?.click();
  });
}

async function saveScreenshot(page, scenarioDir, name) {
  try {
    await page.screenshot({ path: path.join(scenarioDir, name), timeout: 5000 });
  } catch {
    // Screenshot failures are captured indirectly by missing artifact paths in the report.
  }
}

async function readBaseline(filePath) {
  if (!filePath) return null;
  return JSON.parse(await readFile(filePath, "utf8"));
}

function parseInputScript(script) {
  return String(script || "")
    .split(",")
    .map((entry, index) => {
      const [action, secondText, ...keyParts] = entry.trim().split(":");
      if (!entry.trim()) return null;
      const second = Number.parseFloat(secondText);
      const key = keyParts.join(":");
      if (!["down", "up"].includes(action) || !Number.isFinite(second) || !key) {
        throw new Error(`Invalid INPUT_SCRIPT entry "${entry}"`);
      }
      return { action, second, key, index, sent: false };
    })
    .filter(Boolean)
    .sort((a, b) => a.second - b.second || a.index - b.index);
}

function minMetric(samples, key) {
  const values = samples.map((sample) => parseNumber(sample[key])).filter(Number.isFinite);
  return values.length ? Math.min(...values) : 0;
}

function parseNumber(value) {
  const parsed = Number.parseFloat(String(value ?? "").replace("%", ""));
  return Number.isFinite(parsed) ? parsed : NaN;
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
  for (const match of text.matchAll(regex)) {
    latest = match[1];
  }
  return latest;
}

function safeKeyName(key) {
  return key.replace(/[^a-z0-9_-]+/gi, "_");
}

function numberEnv(name, fallback) {
  const value = Number.parseFloat(process.env[name] || "");
  return Number.isFinite(value) ? value : fallback;
}

function parseArgs(args) {
  const parsed = {
    baseline: "",
    baseUrl: "",
    duration: undefined,
    outDir: "",
    requireBaseline: false,
    rom: "",
    sampleMs: undefined,
    strict: false,
    targetMode: "",
    tolerance: undefined
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--baseline") parsed.baseline = requiredArg(args, ++index, arg);
    else if (arg === "--base-url") parsed.baseUrl = requiredArg(args, ++index, arg);
    else if (arg === "--duration") parsed.duration = numberArg(args, ++index, arg);
    else if (arg === "--out-dir") parsed.outDir = requiredArg(args, ++index, arg);
    else if (arg === "--require-baseline") parsed.requireBaseline = true;
    else if (arg === "--rom") parsed.rom = requiredArg(args, ++index, arg);
    else if (arg === "--sample-ms") parsed.sampleMs = numberArg(args, ++index, arg);
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
