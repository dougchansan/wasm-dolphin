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
  // Phase 1 (t=3..200s): A + Start spam to advance through dialogs, attract
  //   cutscene skip, title, main menu. Reaches character select around t~200.
  // Phase 2 (t=200..400s): A + Start spam + occasional D-Right + Z. D-Right
  //   moves the character-select cursor; Z confirms/cancels. Once a char is
  //   picked, A starts the match. Reaches stage select.
  // Phase 3 (t=400..600s): A spam only — the validator is now in-game or
  //   on the results screen; we just want to keep something happening.
  for (let t = 3; t <= 600; t += 3) {
    const key = (index % 2 === 0) ? "x" : "Enter";
    events.push(`down:${t}:${key}`);
    events.push(`down:${t + 1}:${key}`);
    events.push(`up:${t + 1.5}:${key}`);
    // Phase 2: every 4th iteration, also tap a directional key + Z so the
    // character-select cursor moves and any "ready"/"back" prompt can be
    // dismissed in case A alone isn't enough.
    if (t >= 200 && t < 400 && index % 4 === 0) {
      events.push(`down:${t + 0.5}:ArrowRight`);
      events.push(`up:${t + 0.7}:ArrowRight`);
      events.push(`down:${t + 2}:z`);
      events.push(`up:${t + 2.2}:z`);
    }
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
url.searchParams.set("pacing", process.env.PACING || "smooth");
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
  url.searchParams.set("queue", process.env.QUEUE_SIZE || "4");
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

// Optional persistent user-data-dir, so IndexedDB (e.g. Day-7 JIT cache)
// and other origin-scoped storage survive across probe runs.
const persistUserDataDir = process.env.PROBE_PERSIST_DIR || null;
const persistBrowserData = persistUserDataDir
  ? path.resolve(persistUserDataDir)
  : null;

const chromiumLaunchArgs = [
  "--autoplay-policy=no-user-gesture-required",
  "--enable-webgl",
  "--enable-unsafe-webgpu",
  "--enable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling"
];

const browser = persistBrowserData
  ? await chromium.launchPersistentContext(persistBrowserData, {
      channel: process.env.BROWSER_CHANNEL || "chrome",
      headless: !headed,
      args: chromiumLaunchArgs
    }).catch(async (error) => {
      console.warn(`Failed persistent context; falling back to bundled chromium: ${error.message}`);
      return chromium.launchPersistentContext(persistBrowserData, { headless: !headed });
    })
  : await (browserName === "firefox"
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
          args: chromiumLaunchArgs
        })).catch(async (error) => {
      console.warn(`Failed ${browserName} channel; falling back to bundled chromium: ${error.message}`);
      return chromium.launch({ headless: !headed });
    });

// launchPersistentContext returns a BrowserContext (not Browser). Both
// expose .newPage()/.on() with the same signatures we need below, so we
// can treat them uniformly. Same applies to teardown via .close().
const page = persistBrowserData
  ? await browser.newPage()
  : await browser.newPage({ viewport: { width: 1280, height: 900 } });
if (persistBrowserData) {
  await page.setViewportSize({ width: 1280, height: 900 });
}
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

// Long-animation-frame entries (Chrome 123+) tell us when the main
// thread blocked the next paint by >50 ms. Each entry has startTime,
// duration, blockingDuration, renderStart, paintTime, presentationTime.
// We push them through page.exposeFunction so we can persist them with
// the rest of the run artifacts. Empty array if the browser doesn't
// support PerformanceLongAnimationFrameTiming.
const longAnimationFrames = [];
await page.exposeFunction("__menuProgressReportLoAF", (entry) => {
  longAnimationFrames.push(entry);
});

try {
  await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.evaluate(() => {
    const panel = document.querySelector("#debugPanel");
    const toggle = document.querySelector("#debugToggle");
    if (panel?.hidden) toggle?.click();
    // Install LoAF observer. Browsers that don't support
    // "long-animation-frame" (older Chrome, Firefox, Safari) throw —
    // swallow the error so the rest of the probe still runs.
    try {
      const obs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          window.__menuProgressReportLoAF({
            startTime: e.startTime,
            duration: e.duration,
            renderStart: e.renderStart,
            paintTime: e.paintTime,
            presentationTime: e.presentationTime,
            blockingDuration: e.blockingDuration,
          });
        }
      });
      obs.observe({ type: "long-animation-frame", buffered: true });
    } catch (err) {
      // Not all browsers support LoAF. Validator still works; this just
      // skips the long-frame detail capture.
    }
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
  if (longAnimationFrames.length) {
    await writeFile(
      path.join(outDir, "long-animation-frames.json"),
      JSON.stringify(longAnimationFrames, null, 2)
    );
  }
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
  const smoothness = computeSmoothnessSummary(samples);
  const renderingHealth = computeRenderingHealth(samples, hashes, overall, smoothness);
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
    smoothness,
    renderingHealth,
    // Keep the flat averageX fields for backward compat with downstream tooling.
    averageGameSpeed: overall.averageGameSpeed,
    averagePresentFps: overall.averagePresentFps,
    averageCoreFps: overall.averageCoreFps,
    averageVisualFps: overall.averageVisualFps,
    finalSample: samples.at(-1),
  };
}

// Aggregate pass/fail health signal across the run. Each check returns
// { name, passed, value, threshold, detail } so the summary doubles as a
// human-readable report and a CI-friendly assertion. The thresholds aim
// for the user-stated bar: "every frame renders as fast as possible like
// perfect 60 Hz no dropping frames or slowing the game down."
function computeRenderingHealth(samples, hashes, overall, smoothness) {
  const checks = [];
  const last = samples.at(-1);

  // 1. Game makes visible progress (catches "boot-and-stick" regressions).
  checks.push({
    name: "progression",
    passed: hashes.size >= 20,
    value: hashes.size,
    threshold: 20,
    detail: "distinct canvas hashes across the run",
  });

  // 2. Average game speed close to 100% post-warmup. <85% means the
  //    emulator can't keep up with NTSC 60 Hz.
  const speed = Number(overall.averageGameSpeed) || 0;
  checks.push({
    name: "game-speed",
    passed: speed >= 85,
    value: Number(speed.toFixed(1)),
    threshold: 85,
    detail: "overall average gameSpeed % (post-warmup)",
  });

  // 3. Drop rate stays low. Each "drop" is a paint interval > 24 ms (one
  //    full 60 Hz frame late). 5% is the loose cutoff; user-perceived
  //    "smooth" needs to stay near 2-3%.
  const dropRate = smoothness?.dropRatePercent ?? 0;
  checks.push({
    name: "drop-rate",
    passed: dropRate <= 5,
    value: dropRate,
    threshold: 5,
    detail: "% of paint intervals > 24 ms (long-frame threshold)",
  });

  // 4. Worst single paint gap. The user-reported 2 s freezes are caught
  //    here. <500 ms is "no single freeze longer than a coin flip".
  const maxGap = smoothness?.lifetimeMaxIntervalMs ?? 0;
  checks.push({
    name: "max-gap",
    passed: maxGap <= 500,
    value: maxGap,
    threshold: 500,
    detail: "ms — worst single gap between successive paints (lifetime)",
  });

  // 5. 60 Hz target hit rate. With p99 of intervals in <20 ms band, the
  //    emulator is painting on-cadence 99 % of the time.
  const fastPct = smoothness?.fastIntervalPercent ?? 0;
  checks.push({
    name: "fast-interval",
    passed: fastPct >= 90,
    value: fastPct,
    threshold: 90,
    detail: "% of paint intervals < 20 ms (within one 60 Hz slot + slack)",
  });

  // 6. No solid-color frames (all-black or all-clear). A render-corruption
  //    canary: visibleHash == 0 or a stable single-color hash for >3
  //    consecutive samples is a hard fail. We check the most common
  //    hash count vs total — if one hash dominates (>40% of samples)
  //    something is stuck.
  const hashCounts = new Map();
  for (const s of samples) {
    if (!s.visibleHash) continue;
    hashCounts.set(s.visibleHash, (hashCounts.get(s.visibleHash) || 0) + 1);
  }
  const dominantHashCount = Math.max(0, ...hashCounts.values());
  const dominantHashShare =
    samples.length > 0 ? (dominantHashCount / samples.length) * 100 : 0;
  checks.push({
    name: "no-stuck-frame",
    passed: dominantHashShare <= 40,
    value: Number(dominantHashShare.toFixed(1)),
    threshold: 40,
    detail: "% of samples sharing the single most-common canvas hash",
  });

  const passed = checks.filter((c) => c.passed).length;
  const failed = checks.filter((c) => !c.passed);
  return {
    passed: failed.length === 0,
    passedChecks: passed,
    totalChecks: checks.length,
    failedChecks: failed.map((c) => c.name),
    checks,
  };
}

// Compile the lifetime smoothness picture across the run. Uses the
// last sample's lifetime counters (they're monotonically increasing,
// so the last sample sees the whole run) plus per-sample drop counts
// from the helper string.
function computeSmoothnessSummary(samples) {
  if (!samples.length) return null;
  const last = samples.at(-1);
  const lifetimeMaxIntervalMs = Number(last.presentationLifetimeMaxIntervalMs) || 0;
  const lifetimeDropCount = Number(last.presentationLifetimeDropCount) || 0;
  const lifetimeFrameCount = Number(last.presentationLifetimeFrameCount) || 0;
  const intervalStddevMs = Number(last.presentationIntervalStddevMs) || 0;
  const histogram = Array.isArray(last.presentationIntervalHistogram)
    ? last.presentationIntervalHistogram
    : null;
  const buckets = Array.isArray(last.presentationIntervalHistogramBuckets)
    ? last.presentationIntervalHistogramBuckets
    : null;
  const histogramTotal = histogram
    ? histogram.reduce((a, b) => a + (b || 0), 0)
    : 0;
  // Translate the histogram into percentage-of-frames-in-each-bucket so
  // the summary is readable across runs of different length.
  let histogramPercent = null;
  if (histogram && buckets && histogramTotal > 0) {
    histogramPercent = histogram.map((count, i) => {
      const label =
        i < buckets.length
          ? `<${buckets[i]}ms`
          : `>=${buckets[buckets.length - 1]}ms`;
      const pct = (100 * (count || 0)) / histogramTotal;
      return { label, count: count || 0, percent: Number(pct.toFixed(2)) };
    });
  }
  const dropRate =
    lifetimeFrameCount > 0
      ? Number(((100 * lifetimeDropCount) / lifetimeFrameCount).toFixed(2))
      : 0;
  // "Smooth 60Hz" interpretation: under 60Hz target, 99% of intervals
  // should fall in <20ms (i.e., not miss a 16.67ms slot by more than a
  // few ms slack). Drop rate (intervals >24ms) tells us how often we
  // miss a full frame's worth.
  const fastIntervalPct = histogramPercent
    ? histogramPercent
        .filter((b) => /^<(8|12|16|20)ms$/.test(b.label))
        .reduce((a, b) => a + b.percent, 0)
    : null;
  return {
    lifetimeFrameCount,
    lifetimeMaxIntervalMs: Number(lifetimeMaxIntervalMs.toFixed(1)),
    lifetimeDropCount,
    dropRatePercent: dropRate,
    intervalStddevMs: Number(intervalStddevMs.toFixed(2)),
    fastIntervalPercent: fastIntervalPct !== null ? Number(fastIntervalPct.toFixed(2)) : null,
    histogram: histogramPercent,
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
    // Structured worker stats (set by app.js's handleFrame). Reading via
    // window is cheaper than DOM scraping and preserves numeric fields
    // (histogram array, lifetime counters, stddev) without round-tripping
    // through textContent.
    const info = window.__lastFrameInfo || {};
    // Parse drop/underrun out of the helper string. These are emitted as
    // "drop:N underrun:N" inside the worker's ppcWasmHelperStats. The
    // structured fields aren't yet surfaced separately to the DOM but the
    // helper string is always available.
    const helperStr = read("#ppcWasmHelperStats");
    const helperDropMatch = /\bdrop:(\d+)/.exec(helperStr);
    const helperUnderrunMatch = /\bunderrun:(\d+)/.exec(helperStr);
    const helperLongMatch = /\blong:(\d+)/.exec(helperStr);
    const helperRawFpsMatch = /\braw:(\d+)/.exec(helperStr);
    return {
      elapsedSeconds,
      frame: read("#frameCounter"),
      presentFps: read("#fpsCounter"),
      visualFps: read("#visualFpsCounter"),
      coreFps: read("#coreFpsCounter"),
      gameSpeed: read("#gameSpeedCounter"),
      gap: read("#presentationGapCounter"),
      helper: helperStr,
      coreMode: read("#coreMode"),
      mountNote: read("#mountNote"),
      gameTitle: read("#gameTitle"),
      statusPill: read("#statusPill"),
      input: read("#inputSource"),
      jitBlockRunCount,
      jitBlockCompileCount,
      visibleHash,
      visibleError,
      // Structured smoothness fields (Phase A).
      presentationRawFps: Number(info.presentationRawFps) || 0,
      presentationP95IntervalMs: Number(info.presentationP95IntervalMs) || 0,
      presentationMaxIntervalMs: Number(info.presentationMaxIntervalMs) || 0,
      presentationLifetimeMaxIntervalMs:
        Number(info.presentationLifetimeMaxIntervalMs) || 0,
      presentationLifetimeDropCount:
        Number(info.presentationLifetimeDropCount) || 0,
      presentationLifetimeFrameCount:
        Number(info.presentationLifetimeFrameCount) || 0,
      presentationIntervalStddevMs:
        Number(info.presentationIntervalStddevMs) || 0,
      presentationIntervalHistogram: Array.isArray(info.presentationIntervalHistogram)
        ? info.presentationIntervalHistogram.slice()
        : null,
      presentationIntervalHistogramBuckets: Array.isArray(
        info.presentationIntervalHistogramBuckets
      )
        ? info.presentationIntervalHistogramBuckets.slice()
        : null,
      // Parsed from helper string (worker doesn't surface these to DOM yet).
      helperDropCount: helperDropMatch ? Number(helperDropMatch[1]) : 0,
      helperUnderrunCount: helperUnderrunMatch ? Number(helperUnderrunMatch[1]) : 0,
      helperLongFrameCount: helperLongMatch ? Number(helperLongMatch[1]) : 0,
      helperRawFps: helperRawFpsMatch ? Number(helperRawFpsMatch[1]) : 0,
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
