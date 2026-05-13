// Playwright validator that boots Melee through the GameCube intro, save
// dialog, attract cutscene, title, main menu, and into character select.
// Captures screenshots at every input event, every 4s, plus a per-second HUD
// + canvas-hash log so we can tell which menu screens were reached.
//
//   node tools/menu-progress-validate.mjs --duration 360
//
// Env: ROM (default smash melee path), BASE_URL, OGL_PROXY_MODE, HEADED=1.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const args = parseArgs(process.argv.slice(2));
const baseUrl = args.baseUrl || process.env.BASE_URL || "http://127.0.0.1:8082/";
const romPath = args.rom || process.env.ROM ||
  "F:/Games/GameCube/Super Smash Bros. Melee (USA) (En,Ja) (v1.02).iso";
const durationSeconds = args.duration ?? Number(process.env.DURATION || 360);
const sampleMs = args.sampleMs ?? Number(process.env.SAMPLE_MS || 1000);
const screenshotEverySeconds = args.shotEvery ?? Number(process.env.SHOT_EVERY || 4);
const oglProxy = process.env.OGL_PROXY_MODE || "proxy";
const videoMode = process.env.VIDEO || "ogl"; // "ogl" or "software"
const headed = process.env.HEADED === "1" || args.headed;
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = args.outDir
  ? path.resolve(args.outDir)
  : path.join(root, ".omx", "menu-progress", stamp);

if (!existsSync(romPath)) throw new Error(`Missing Melee ISO: ${romPath}`);

// Default Melee input script. Each X press = GC A, Enter = Start, WASD = stick.
// Tuned for proxy mode (~38% game speed): real-time elapsed must be ~2.6x of
// what the in-game animation length would be at 100%.
//
// Stage timeline (real seconds, proxy speed):
//   t=10–14: "Press Start" save dialog  → Enter
//   t=20–25: GameCube boot beep advance → A spam
//   t=30–80: attract cutscene             → A spam to skip
//   t=90–110: title "Press Start"         → Enter
//   t=120–150: Main menu (top option = 1P)→ A
//   t=160–195: 1P modes (Regular Match)   → A
//   t=205–240: Stage / character select   → A again to push through
// Aggressive input script: press A (X) AND Start (Enter) repeatedly with
// short intervals so attract-mode skips and dialogs auto-advance. With JIT
// off the emulator runs ~190% speed in headless Chrome, so what reads as
// real-second N here is roughly emulator-second N*2. Press both keys often
// enough that whichever screen Melee is on gets unstuck.
function makeAggressiveInputScript() {
  const events = [];
  let index = 0;
  for (let t = 3; t <= 600; t += 3) {
    // Alternate A and Start so dialogs (need A) and title (need Start) both advance.
    const key = (index % 2 === 0) ? "x" : "Enter";
    events.push(`down:${t}:${key}`);
    events.push(`down:${t + 1}:${key}`);
    events.push(`up:${t + 1.5}:${key}`);
    index += 1;
  }
  return events.join(",");
}
const defaultInputScript = makeAggressiveInputScript();

const inputScript = parseInputScript(process.env.INPUT_SCRIPT || defaultInputScript);

const { chromium, firefox } = await importPlaywright();
const browserName = (process.env.BROWSER || "chromium").toLowerCase();
const browserEngine = browserName === "firefox" ? firefox : chromium;
await mkdir(outDir, { recursive: true });
console.log(`[menu-progress] outDir=${outDir} duration=${durationSeconds}s headed=${headed}`);

const url = new URL(baseUrl);
url.searchParams.set("core", "upstream");
url.searchParams.set("video", videoMode);
url.searchParams.set("cpu", process.env.CPU || "dual");
url.searchParams.set("speed", "1");
url.searchParams.set("presenter", process.env.PRESENTER || (videoMode === "software" ? "webgpu" : "webgl"));
url.searchParams.set("pacing", process.env.PACING || "direct");
// Use the safer guarded JIT for both backends. The "mixed" tier compiles
// more aggressive patterns that proved fine for boot dialogs but appear to
// corrupt some post-boot CPU code paths under the browser pthread layout
// (cutscene scene rendering went all-black with mixed but boot dialogs
// renderered fine).
url.searchParams.set("jittier", process.env.JITTIER || "guarded");
if (videoMode === "ogl") {
  url.searchParams.set("present", process.env.PRESENT || "half");
  url.searchParams.set("oglproxy", oglProxy);
  // forcejit only when explicitly requested; defaults to no-JIT for OGL
  // since we're trying to isolate whether JIT corruption was hiding the
  // post-boot 3D-rendering black output.
  if (process.env.FORCEJIT === "1") url.searchParams.set("forcejit", "1");
  url.searchParams.set("queue", "8");
} else {
  url.searchParams.set("present", process.env.PRESENT || "full");
  url.searchParams.set("wasmjit", process.env.WASMJIT ?? "1");
  url.searchParams.set("queue", process.env.QUEUE_SIZE || "2");
  url.searchParams.set("jitwarmup", process.env.JITWARMUP || "700");
}
url.searchParams.set("oc", process.env.OC || "1");
url.searchParams.set("fastsw", process.env.FASTSW || "1");
if (process.env.DISABLE) url.searchParams.set("disable", process.env.DISABLE);
if (process.env.OGLSAB) url.searchParams.set("oglsab", process.env.OGLSAB);
url.searchParams.set("metrics", "1");
url.searchParams.set("probe", `menu-progress-${Date.now()}`);

const consoleLines = [];
const samples = [];
const milestoneLog = [];
const distinctHashes = new Map(); // hash → { firstAt, screenshot }

const browser = await (browserName === "firefox"
  ? firefox.launch({
      headless: !headed,
      firefoxUserPrefs: {
        // Mirror what serve.mjs gives us — Firefox needs explicit COOP/COEP
        // and SharedArrayBuffer enabled for the pthread WASM core.
        "dom.postMessage.sharedArrayBuffer.withCOOP_COEP": true,
        "javascript.options.shared_memory": true,
        // Enable WebGL2 (default on, but explicit so we don't fight the user).
        "webgl.force-enabled": true
      }
    })
  : chromium.launch({
      channel: process.env.BROWSER_CHANNEL || "chrome",
      headless: !headed,
      args: [
        "--autoplay-policy=no-user-gesture-required",
        "--enable-webgl",
        "--enable-unsafe-webgpu",
        "--enable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling"
      ]
    })).catch(async (error) => {
  console.warn(`Failed ${browserName} channel; falling back to bundled chromium: ${error.message}`);
  return chromium.launch({ headless: !headed });
});

const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("console", (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => consoleLines.push(`[pageerror] ${e.stack || e.message}`));
// Worker console capture. The Dolphin upstream core runs in a Web Worker; its
// console.log (including the C++ per-frame ring-buffer drain and disable-mask
// status messages) is not surfaced by page.on("console"). Listen at the
// browser-context level so each spawned worker is wired up automatically.
const seenWorkers = new WeakSet();
function attachWorker(worker) {
  if (seenWorkers.has(worker)) return;
  seenWorkers.add(worker);
  const label = `worker:${worker.url()?.split("/").pop() || "?"}`;
  worker.on("console", (m) => consoleLines.push(`[${label}:${m.type()}] ${m.text()}`));
  worker.on("pageerror", (e) =>
    consoleLines.push(`[${label}:pageerror] ${e.stack || e.message}`));
}
const browserContext = page.context();
for (const w of browserContext.serviceWorkers?.() ?? []) attachWorker(w);
browserContext.on("serviceworker", attachWorker);
page.on("worker", attachWorker);
for (const w of page.workers?.() ?? []) attachWorker(w);

const scriptState = inputScript.map((event) => ({ ...event, sent: false }));

try {
  await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.evaluate(() => {
    const panel = document.querySelector("#debugPanel");
    const toggle = document.querySelector("#debugToggle");
    if (panel?.hidden) toggle?.click();
  });
  await page.setInputFiles("#romInput", romPath);
  await page.click("#screen");
  console.log(`[menu-progress] mounting ROM…`);
  await waitForMount(page);

  await capture(page, "00-mounted.png");
  milestoneLog.push({ t: 0, event: "mounted" });

  const startedAt = Date.now();
  const totalSamples = Math.ceil((durationSeconds * 1000) / sampleMs);
  let lastShotSecond = -screenshotEverySeconds;
  for (let index = 0; index <= totalSamples; index += 1) {
    const elapsed = (Date.now() - startedAt) / 1000;
    for (const event of scriptState.filter((c) => !c.sent && c.second <= elapsed)) {
      event.sent = true;
      if (event.action === "down") await page.keyboard.down(event.key);
      else await page.keyboard.up(event.key);
      const tag = `${String(event.index).padStart(2, "0")}-t${Math.round(elapsed)}-${event.action}-${safeKey(event.key)}.png`;
      await capture(page, tag);
      milestoneLog.push({ t: elapsed.toFixed(1), event: `${event.action} ${event.key}`, screenshot: tag });
    }

    const sample = await readSample(page, elapsed);
    samples.push(sample);

    if (sample.visibleHash && !distinctHashes.has(sample.visibleHash)) {
      const hashShot = `hash-${sample.visibleHash.toString(16)}-t${Math.round(elapsed)}.png`;
      await capture(page, hashShot);
      distinctHashes.set(sample.visibleHash, { firstAt: elapsed, screenshot: hashShot });
      milestoneLog.push({ t: elapsed.toFixed(1), event: `new-hash 0x${sample.visibleHash.toString(16)}`, screenshot: hashShot });
    }

    if (elapsed - lastShotSecond >= screenshotEverySeconds) {
      lastShotSecond = elapsed;
      await capture(page, `t${String(Math.round(elapsed)).padStart(3, "0")}.png`);
    }

    if (index % 10 === 0) {
      console.log(
        `[menu-progress] t=${elapsed.toFixed(1).padStart(5)} ` +
        `frame=${sample.frame} present=${sample.presentFps} core=${sample.coreFps} ` +
        `speed=${sample.gameSpeed} visualFps=${sample.visualFps} ` +
        `hash=0x${(sample.visibleHash || 0).toString(16)} ` +
        `distinct=${distinctHashes.size} mode=${sample.coreMode || "-"} ` +
        `status="${(sample.statusPill || "").slice(0, 40)}"`
      );
    }

    await page.waitForTimeout(sampleMs);
  }

  await capture(page, "zz-final.png");
} catch (error) {
  consoleLines.push(`[probe-error] ${error.stack || error.message}`);
  await capture(page, "zz-error.png");
} finally {
  await writeFile(path.join(outDir, "console.log"), consoleLines.join("\n")).catch(() => {});
  await writeFile(path.join(outDir, "samples.json"), JSON.stringify(samples, null, 2));
  await writeFile(path.join(outDir, "milestones.json"), JSON.stringify(milestoneLog, null, 2));
  await writeFile(
    path.join(outDir, "distinct-hashes.json"),
    JSON.stringify(
      [...distinctHashes.entries()].map(([hash, info]) => ({
        hash: `0x${hash.toString(16)}`, firstAt: info.firstAt, screenshot: info.screenshot
      })),
      null,
      2
    )
  );
  const summary = summarize(samples, distinctHashes);
  await writeFile(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(`\n[menu-progress] done: ${JSON.stringify(summary, null, 2)}`);
  console.log(`[menu-progress] ${distinctHashes.size} distinct canvas hashes across ${samples.length} samples`);
  console.log(`[menu-progress] artifacts: ${outDir}`);
  await browser.close();
}

function summarize(samples, hashes) {
  // Skip the initial 20% (boot warmup) when computing averages — same as
  // before. But also split on JIT engagement so a JIT-on regression doesn't
  // hide in a single overall average.
  const after = samples.slice(Math.floor(samples.length * 0.2));
  const jitStartIndex = findJitEngagementIndex(samples);
  const overall = computeBucket(after);
  let preJit = null;
  let postJit = null;
  if (jitStartIndex >= 0) {
    // Indexes are over the full samples array — translate to the post-warmup
    // window where useful. preJit = samples 20%..jitStart-1, postJit = jitStart..end
    // (with no warmup trim on postJit; the JIT engagement itself is the boundary).
    const warmupCutoff = Math.floor(samples.length * 0.2);
    const preFrom = warmupCutoff;
    const preTo = Math.max(preFrom, jitStartIndex);
    preJit = computeBucket(samples.slice(preFrom, preTo));
    postJit = computeBucket(samples.slice(jitStartIndex));
  }
  return {
    sampleCount: samples.length,
    distinctCanvasHashes: hashes.size,
    jitEngaged: jitStartIndex >= 0,
    jitEngagementSampleIndex: jitStartIndex,
    jitEngagementElapsedSeconds:
      jitStartIndex >= 0 ? samples[jitStartIndex]?.elapsedSeconds ?? null : null,
    overall,
    preJit,
    postJit,
    // Keep the flat averageX fields for backward compat with downstream tooling.
    averageGameSpeed: overall.averageGameSpeed,
    averagePresentFps: overall.averagePresentFps,
    averageCoreFps: overall.averageCoreFps,
    averageVisualFps: overall.averageVisualFps,
    finalSample: samples.at(-1),
  };
}

function findJitEngagementIndex(samples) {
  // First sample where any of: statusPill briefly says "JIT enabled", helper
  // stats include `jit:on`, or block compile count goes nonzero. Whichever
  // wins, we treat as the start of the "post-JIT" regime.
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i];
    if (typeof s.statusPill === "string" && s.statusPill.includes("JIT enabled")) return i;
    if (typeof s.helper === "string" && /(?:^|\s)jit:on\b/i.test(s.helper)) return i;
    if ((s.jitBlockCompileCount || 0) > 0) return i;
  }
  return -1;
}

function computeBucket(window) {
  if (!window.length) {
    return {
      sampleCount: 0,
      averageGameSpeed: 0,
      averagePresentFps: 0,
      averageCoreFps: 0,
      averageVisualFps: 0,
    };
  }
  const speeds = window.map((s) => parseFloat(String(s.gameSpeed).replace("%", ""))).filter(Number.isFinite);
  const presents = window.map((s) => parseFloat(s.presentFps)).filter(Number.isFinite);
  const cores = window.map((s) => parseFloat(s.coreFps)).filter(Number.isFinite);
  const visuals = window.map((s) => parseFloat(s.visualFps)).filter(Number.isFinite);
  return {
    sampleCount: window.length,
    averageGameSpeed: avg(speeds),
    averagePresentFps: avg(presents),
    averageCoreFps: avg(cores),
    averageVisualFps: avg(visuals),
  };
}

function avg(arr) {
  if (!arr.length) return 0;
  return Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2));
}

async function waitForMount(page) {
  for (let second = 0; second <= 180; second += 1) {
    const state = await page.evaluate(() => ({
      coreMode: document.querySelector("#coreMode")?.textContent?.trim() ?? "",
      mountNote: document.querySelector("#mountNote")?.textContent?.trim() ?? "",
      status: document.querySelector("#statusPill")?.textContent?.trim() ?? "",
    }));
    if (state.coreMode === "Dolphin" && state.mountNote.includes("Dolphin")) return;
    if (/failed|error/i.test(state.status)) {
      throw new Error(`Mount failed: ${state.status}`);
    }
    await page.waitForTimeout(1000);
  }
  throw new Error("Timed out waiting for Dolphin mount");
}

async function readSample(page, elapsedSeconds) {
  return page.evaluate((elapsedSeconds) => {
    const read = (sel) => document.querySelector(sel)?.textContent?.trim() ?? "";
    const screen = document.querySelector("#screen");
    const state = (window.__menuProgressState ??= {
      canvas: document.createElement("canvas"),
      context: null,
    });
    state.canvas.width = 64;
    state.canvas.height = 48;
    state.context ??= state.canvas.getContext("2d", { alpha: false, willReadFrequently: true });
    let visibleHash = 0, visibleError = "";
    try {
      state.context.drawImage(screen, 0, 0, state.canvas.width, state.canvas.height);
      const bytes = state.context.getImageData(0, 0, state.canvas.width, state.canvas.height).data;
      let hash = 2166136261;
      // Hash every pixel for sensitivity to scene changes.
      for (let index = 0; index < bytes.length; index += 4) {
        hash ^= bytes[index]; hash = Math.imul(hash, 16777619);
        hash ^= bytes[index + 1]; hash = Math.imul(hash, 16777619);
        hash ^= bytes[index + 2]; hash = Math.imul(hash, 16777619);
      }
      // Bucket the hash to ignore tiny variations.
      visibleHash = (hash >>> 0) & 0xfffffff0;
    } catch (e) { visibleError = e.message || String(e); }
    // ppcWasmJit element is rendered as "runCount / compileCount" with locale
    // group separators. Parse the second integer as the JIT block compile total.
    const jitText = read("#ppcWasmJit");
    const jitParts = jitText.split("/").map((part) => part.replace(/[^0-9]+/g, ""));
    const jitBlockRunCount = Number.parseInt(jitParts[0] || "0", 10) || 0;
    const jitBlockCompileCount = Number.parseInt(jitParts[1] || "0", 10) || 0;
    return {
      elapsedSeconds,
      frame: read("#frameCounter"),
      presentFps: read("#fpsCounter"),
      visualFps: read("#visualFpsCounter"),
      coreFps: read("#coreFpsCounter"),
      gameSpeed: read("#gameSpeedCounter"),
      gap: read("#presentationGapCounter"),
      helper: read("#ppcWasmHelperStats"),
      coreMode: read("#coreMode"),
      mountNote: read("#mountNote"),
      gameTitle: read("#gameTitle"),
      statusPill: read("#statusPill"),
      input: read("#inputSource"),
      jitBlockRunCount,
      jitBlockCompileCount,
      visibleHash,
      visibleError,
    };
  }, elapsedSeconds);
}

async function capture(page, name) {
  try { await page.screenshot({ path: path.join(outDir, name), timeout: 5000 }); } catch {}
}

async function importPlaywright() {
  const local = path.join(root, ".omx", "browser-probe", "node_modules", "playwright", "index.mjs");
  if (existsSync(local)) return import(pathToFileURL(local).href);
  return import("playwright");
}

function parseInputScript(script) {
  return String(script || "")
    .split(",")
    .map((entry, index) => {
      if (!entry.trim()) return null;
      const [action, secondText, ...keyParts] = entry.trim().split(":");
      const second = Number.parseFloat(secondText);
      const key = keyParts.join(":");
      if (!["down", "up"].includes(action) || !Number.isFinite(second) || !key) {
        throw new Error(`Invalid INPUT_SCRIPT entry "${entry}"`);
      }
      return { action, second, key, index };
    })
    .filter(Boolean)
    .sort((a, b) => a.second - b.second || a.index - b.index);
}

function safeKey(key) { return key.replace(/[^a-z0-9_-]+/gi, "_"); }

function parseArgs(argv) {
  const out = { headed: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--rom") out.rom = argv[++i];
    else if (a === "--duration") out.duration = Number(argv[++i]);
    else if (a === "--sample-ms") out.sampleMs = Number(argv[++i]);
    else if (a === "--shot-every") out.shotEvery = Number(argv[++i]);
    else if (a === "--base-url") out.baseUrl = argv[++i];
    else if (a === "--out-dir") out.outDir = argv[++i];
    else if (a === "--headed") out.headed = true;
    else throw new Error(`Unknown arg: ${a}`);
  }
  return out;
}
