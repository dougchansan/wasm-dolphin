// Playwright validator that boots Melee through the GameCube intro, save
// dialog, attract cutscene, title, main menu, and into character select.
// Captures screenshots at every input event, every 4s, plus a per-second HUD
// + canvas-hash log so we can tell which menu screens were reached.
//
//   node tools/menu-progress-validate.mjs --duration 360
//
// Env: ROM (default smash melee path), BASE_URL, OGL_PROXY_MODE, HEADED=1.

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

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
// Optional: load a Dolphin .sav (served by the dev server) once the
// core is running. SAVE_STATE_URL = path under the dev server (e.g.
// /__savestate_probe.sav); SAVE_STATE_AT = seconds into the run to do
// it (must be after boot — Core must be running for State::LoadAs).
const saveStateUrl = process.env.SAVE_STATE_URL || "";
const saveStateAt = Number(process.env.SAVE_STATE_AT || 30);
let saveStateDone = false;
// Capture a version-matched state at SAVE_STATE_CAPTURE_AT (write the
// .sav into outDir for reuse), then reload it from the worker FS at
// SAVE_STATE_RELOAD_AT to prove a deterministic round-trip.
const ssCaptureAt = Number(process.env.SAVE_STATE_CAPTURE_AT || 0);
const ssReloadAt = Number(process.env.SAVE_STATE_RELOAD_AT || 0);
let ssCaptureDone = false;
let ssReloadDone = false;

const { chromium, firefox } = await importPlaywright();
const browserName = (process.env.BROWSER || "chromium").toLowerCase();
const browserEngine = browserName === "firefox" ? firefox : chromium;
await mkdir(outDir, { recursive: true });
console.log(`[menu-progress] outDir=${outDir} duration=${durationSeconds}s headed=${headed}`);

const url = new URL(baseUrl);
url.searchParams.set("core", "upstream");
url.searchParams.set("video", videoMode);
url.searchParams.set("cpu", process.env.CPU || "dual");
// §28cx: honor a SPEED override so throughput A/Bs can run unthrottled
// (?speed=unlimited) — at speed=1 a faster JIT just idles in throttle and
// the gameSpeed% pins at 100%, hiding headroom. Unthrottled, gameSpeed% IS
// the raw throughput. Defaults to "1" (every existing caller unchanged).
url.searchParams.set("speed", process.env.SPEED || "1");
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
  // forcejit keeps the JIT engaged through the post-activation stall
  // fuse — required to actually exercise the mixed tier (its larger
  // one-time compile burst otherwise trips the guarded-tuned fuse).
  if (process.env.FORCEJIT === "1") url.searchParams.set("forcejit", "1");
}
url.searchParams.set("oc", process.env.OC || "1");
url.searchParams.set("fastsw", process.env.FASTSW || "1");
if (process.env.DISABLE) url.searchParams.set("disable", process.env.DISABLE);
if (process.env.REDISPATCH) url.searchParams.set("redispatch", process.env.REDISPATCH);
if (process.env.BLOCKMERGE) url.searchParams.set("blockmerge", process.env.BLOCKMERGE);
if (process.env.REGALLOC) url.searchParams.set("regalloc", process.env.REGALLOC);
if (process.env.SHORTPREFIX) url.searchParams.set("shortprefix", process.env.SHORTPREFIX);
if (process.env.SMEARCOMPILE) url.searchParams.set("smearcompile", process.env.SMEARCOMPILE);
if (process.env.OGLSAB) url.searchParams.set("oglsab", process.env.OGLSAB);
// §28cx in-page main-thread profiler passthrough (?mainprof=1). Headless can
// only validate the tooling emits — real-Chrome contention is the authoritative
// signal — but it confirms activation and dumps the audio-pump cadence +
// LoAF script-attribution snapshot at end of run (mainprofile.json).
if (process.env.MAINPROF) url.searchParams.set("mainprof", process.env.MAINPROF);
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

// Chrome DevTools Protocol tracing. JS-level stall loggers showed
// blockingDuration:0 on most long-anim-frame entries — the bottleneck
// is browser-internal (GPU process, compositor, viz). CDP tracing
// captures those layers. Trace output is openable in Chrome's
// DevTools Performance panel or chrome://tracing.
//
// Categories chosen for OGL paint-stall hunting:
//   gpu                                      — GPU process commands & sync
//   cc                                       — compositor frame scheduling
//   viz                                      — display compositor
//   blink.user_timing                        — our performance.mark spots
//   devtools.timeline / devtools.timeline.frame — render scheduling
//   v8.execute                               — V8 work attribution
//   disabled-by-default-* are heavyweight but necessary for GPU detail
//
// Opt-in via PROBE_TRACE=1 to keep default runs cheap (trace files are
// large — ~50 MB for a 90s run).
let cdpSession = null;
const traceEnabled = process.env.PROBE_TRACE === "1";
if (traceEnabled) {
  try {
    cdpSession = await page.context().newCDPSession(page);
  } catch (err) {
    console.warn(`[menu-progress] CDP session failed: ${err.message}`);
    cdpSession = null;
  }
}

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

// Audio capture (Phase C). The page's AudioController exposes itself as
// window.__audio. The validator unmutes it after mount, attaches an
// AnalyserNode to the gain output, and periodically samples the audio
// envelope (peak amplitude + RMS) so we can assert "audio is producing
// non-silent output during gameplay scenes".
const audioSamples = []; // { tSec, peak, rms }
await page.exposeFunction("__menuProgressReportAudio", (sample) => {
  audioSamples.push(sample);
});

// Input-latency probe (Phase C). PerformanceEventTiming reports each
// input event with both arrival time and handler-processing time. With
// a low durationThreshold the observer surfaces every keypress the
// validator dispatches, letting us compute p50/p95/max input-to-handler
// latency. True input-to-paint latency would need GPU scanout timing
// (out of scope); processingStart-startTime is a decent proxy.
const inputEvents = []; // { startTime, processingStart, duration, name }
// Boot timeline marks (Day 13). Wall-clock ms from t0 (ROM upload start).
// Declared at module scope so the `finally` block can still see them
// if the try-body bails out partway through boot.
let bootMarks = null;
await page.exposeFunction("__menuProgressReportInputEvent", (entry) => {
  inputEvents.push(entry);
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
    // Input-event observer (Phase C). durationThreshold:0 captures every
    // input event regardless of handler cost. Lets us measure validator
    // keypress → handler latency. Same swallow-on-error pattern.
    try {
      const obs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          window.__menuProgressReportInputEvent({
            startTime: e.startTime,
            processingStart: e.processingStart,
            processingEnd: e.processingEnd,
            duration: e.duration,
            name: e.name,
          });
        }
      });
      obs.observe({ type: "event", durationThreshold: 0, buffered: true });
    } catch (err) {
      // PerformanceEventTiming not supported — input latency stays empty.
    }
  });
  // Boot timeline (Day 13). All times are wall-clock ms from "ROM upload
  // dispatched", so we know exactly where each second of startup goes.
  const bootT0 = Date.now();
  bootMarks = { uploadDispatched: 0 };
  await page.setInputFiles("#romInput", romPath);
  bootMarks.uploadComplete = Date.now() - bootT0;
  await page.click("#screen");
  bootMarks.screenClicked = Date.now() - bootT0;
  console.log(`[menu-progress] mounting ROM…`);
  await waitForMount(page);
  bootMarks.mountComplete = Date.now() - bootT0;
  // First-visible-content milestone: poll the canvas hash once a second
  // until we see something other than the all-zeros boot frame. This
  // captures "time-to-first-pixels", separate from "core mounted".
  bootMarks.firstVisibleContentAt = null;
  for (let attempt = 0; attempt < 30; attempt++) {
    const hashHex = await page.evaluate(() => {
      const screen = document.querySelector("#screen");
      if (!screen) return "no-screen";
      const c = document.createElement("canvas");
      c.width = 32; c.height = 24;
      const ctx = c.getContext("2d", { alpha: false, willReadFrequently: true });
      try {
        ctx.drawImage(screen, 0, 0, c.width, c.height);
        const bytes = ctx.getImageData(0, 0, c.width, c.height).data;
        // Quick non-zero check — if every R/G/B pixel is < 16, treat as
        // "still black" and keep polling.
        let bright = 0;
        for (let i = 0; i < bytes.length; i += 4) {
          if (bytes[i] > 16 || bytes[i + 1] > 16 || bytes[i + 2] > 16) bright++;
        }
        return bright > 5 ? "bright" : "black";
      } catch { return "err"; }
    });
    if (hashHex === "bright") {
      bootMarks.firstVisibleContentAt = Date.now() - bootT0;
      break;
    }
    await page.waitForTimeout(500);
  }

  // Start CDP tracing after mount so the trace covers steady-state +
  // gameplay, not the boot wasm-instantiate spike (already covered by
  // LoAF entries from Phase A). Categories chosen for OGL paint-stall
  // hunting — see the cdpSession block above for the rationale.
  if (cdpSession) {
    try {
      await cdpSession.send("Tracing.start", {
        transferMode: "ReturnAsStream",
        traceConfig: {
          recordMode: "recordContinuously",
          // Minimal categories for compositor / GPU stall diagnosis.
          // Each additional category multiplies trace size. cc + viz +
          // gpu + toplevel give us frame scheduling + GPU command flow
          // without the huge blink/devtools.timeline event volumes.
          includedCategories: [
            "cc",
            "viz",
            "gpu",
            "toplevel",
            "devtools.timeline.frame",
          ],
        },
      });
      console.log("[menu-progress] CDP trace started");
    } catch (err) {
      console.warn(`[menu-progress] Tracing.start failed: ${err.message}`);
      cdpSession = null;
    }
  }

  // Phase C: install the audio probe. Unmute (audio defaults to muted),
  // attach an AnalyserNode to the audio graph, and poll envelope
  // every 250 ms. Wrapped in a single page.evaluate so it runs cleanly
  // even if AudioContext isn't available (older browsers) — failures
  // just leave audioSamples empty.
  await page.evaluate(() => {
    try {
      const audio = window.__audio;
      if (!audio) return;
      void audio.setMuted(false);
      // ensureContext is async; the actual AudioContext + gain node is
      // created on first call. Trigger it now so the analyser can hook
      // in. We don't await — the validator's RAF-driven sampling will
      // start working as soon as the graph is up.
      void audio.ensureContext();
      const installAnalyser = () => {
        if (!audio.context || !audio.gain) {
          setTimeout(installAnalyser, 50);
          return;
        }
        const analyser = audio.context.createAnalyser();
        analyser.fftSize = 2048;
        // Tap the post-gain stage so muted runs read 0 (sanity check
        // for the unmute path), but unmuted runs see real samples.
        audio.gain.connect(analyser);
        const buf = new Float32Array(analyser.fftSize);
        const t0 = performance.now();
        setInterval(() => {
          analyser.getFloatTimeDomainData(buf);
          let peak = 0;
          let sumSq = 0;
          for (let i = 0; i < buf.length; i++) {
            const v = buf[i];
            const absV = v < 0 ? -v : v;
            if (absV > peak) peak = absV;
            sumSq += v * v;
          }
          const rms = Math.sqrt(sumSq / buf.length);
          window.__menuProgressReportAudio({
            tSec: (performance.now() - t0) / 1000,
            peak: Number(peak.toFixed(6)),
            rms: Number(rms.toFixed(6)),
          });
        }, 250);
      };
      installAnalyser();
    } catch (err) {
      // Browser doesn't support what we need — validator falls back to
      // running without audio samples, the assertion just becomes a
      // "not measured" rather than a fail.
    }
  });

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

    if (saveStateUrl && !saveStateDone && elapsed >= saveStateAt) {
      saveStateDone = true;
      console.log(`[menu-progress] loading save state ${saveStateUrl} at t=${elapsed.toFixed(1)}…`);
      try {
        const r = await page.evaluate((u) => window.__loadStateFile(u), saveStateUrl);
        console.log(`[menu-progress] loadStateFile -> ${JSON.stringify(r)}`);
      } catch (e) {
        console.log(`[menu-progress] loadStateFile threw: ${e?.message || e}`);
      }
      await page.waitForTimeout(1500);
      await capture(page, `savestate-loaded-t${Math.round(elapsed)}.png`);
    }

    if (ssCaptureAt > 0 && !ssCaptureDone && elapsed >= ssCaptureAt) {
      ssCaptureDone = true;
      console.log(`[menu-progress] capturing save state at t=${elapsed.toFixed(1)}…`);
      await capture(page, `pre-savestate-t${Math.round(elapsed)}.png`);
      try {
        const r = await page.evaluate(() => window.__saveStateFile());
        if (r && r.saved && r.b64) {
          const buf = Buffer.from(r.b64, "base64");
          const outPath = path.join(outDir, "core-native-state.sav");
          await writeFile(outPath, buf);
          console.log(`[menu-progress] saved state -> ${outPath} (${buf.length} B, rc ok)`);
        } else {
          console.log(`[menu-progress] saveStateFile failed: ${JSON.stringify(r)}`);
        }
      } catch (e) {
        console.log(`[menu-progress] saveStateFile threw: ${e?.message || e}`);
      }
    }

    if (ssReloadAt > 0 && !ssReloadDone && elapsed >= ssReloadAt) {
      ssReloadDone = true;
      console.log(`[menu-progress] reloading captured state (FS) at t=${elapsed.toFixed(1)}…`);
      await capture(page, `pre-reload-t${Math.round(elapsed)}.png`);
      try {
        const r = await page.evaluate(() => window.__loadStateFileFs("/savestate_out.sav"));
        console.log(`[menu-progress] loadStateFileFs -> ${JSON.stringify(r)}`);
      } catch (e) {
        console.log(`[menu-progress] loadStateFileFs threw: ${e?.message || e}`);
      }
      await page.waitForTimeout(1500);
      await capture(page, `savestate-reloaded-t${Math.round(elapsed)}.png`);
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
  // Stop CDP tracing and stream the trace file out before browser
  // teardown. Trace is a JSON of trace events; size ~10-50 MB for a
  // 90-second run with our category set. Openable in Chrome DevTools
  // Performance panel (drag the file in) or chrome://tracing.
  if (cdpSession) {
    try {
      const tracePath = path.join(outDir, "chrome-trace.json.gz");
      const traceDone = new Promise((resolve, reject) => {
        cdpSession.once("Tracing.tracingComplete", async (event) => {
          try {
            const handle = event.stream;
            // Stream-decode CDP base64 chunks → gzip → file. Avoids
            // accumulating the whole trace (often >1 GB) in memory.
            const gzip = createGzip();
            const out = createWriteStream(tracePath);
            const piped = pipeline(gzip, out);
            let raw = 0;
            for (;;) {
              const res = await cdpSession.send("IO.read", { handle, size: 1 << 20 });
              if (res.data) {
                const buf = res.base64Encoded
                  ? Buffer.from(res.data, "base64")
                  : Buffer.from(res.data);
                raw += buf.length;
                if (!gzip.write(buf)) {
                  await new Promise((r) => gzip.once("drain", r));
                }
              }
              if (res.eof) break;
            }
            gzip.end();
            await piped;
            await cdpSession.send("IO.close", { handle });
            const { size: gzSize } = await stat(tracePath);
            console.log(
              `[menu-progress] CDP trace saved: ${tracePath} ` +
              `(${(raw / 1048576).toFixed(1)} MB raw, ${(gzSize / 1048576).toFixed(1)} MB gzipped). ` +
              `Open with: gunzip < chrome-trace.json.gz > trace.json ; then load in Chrome DevTools Performance panel.`
            );
            resolve();
          } catch (err) {
            reject(err);
          }
        });
      });
      await cdpSession.send("Tracing.end");
      await traceDone;
    } catch (err) {
      console.warn(`[menu-progress] CDP trace stop failed: ${err.message}`);
    }
  }
  await writeFile(path.join(outDir, "console.log"), consoleLines.join("\n")).catch(() => {});
  await writeFile(path.join(outDir, "samples.json"), JSON.stringify(samples, null, 2));
  await writeFile(path.join(outDir, "milestones.json"), JSON.stringify(milestoneLog, null, 2));
  if (longAnimationFrames.length) {
    await writeFile(
      path.join(outDir, "long-animation-frames.json"),
      JSON.stringify(longAnimationFrames, null, 2)
    );
  }
  if (audioSamples.length) {
    await writeFile(
      path.join(outDir, "audio-samples.json"),
      JSON.stringify(audioSamples, null, 2)
    );
  }
  if (inputEvents.length) {
    await writeFile(
      path.join(outDir, "input-events.json"),
      JSON.stringify(inputEvents, null, 2)
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
  const summary = summarize(samples, distinctHashes, {
    audioSamples,
    longAnimationFrames,
    inputEvents,
    bootMarks,
  });
  await writeFile(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(`\n[menu-progress] done: ${JSON.stringify(summary, null, 2)}`);
  console.log(`[menu-progress] ${distinctHashes.size} distinct canvas hashes across ${samples.length} samples`);
  console.log(`[menu-progress] artifacts: ${outDir}`);
  // §28cx: dump the in-page main-thread profiler snapshot if it was enabled.
  if (process.env.MAINPROF) {
    try {
      const mp = await page.evaluate(() => window.__mainProfile?.summary?.() ?? null);
      if (mp) {
        await writeFile(path.join(outDir, "mainprofile.json"), JSON.stringify(mp, null, 2));
        console.log(`\n[mainprof] snapshot:\n${JSON.stringify(mp, null, 2)}`);
      } else {
        console.log("[mainprof] window.__mainProfile not present (profiler did not activate)");
      }
    } catch (e) {
      console.log(`[mainprof] capture threw: ${e?.message || e}`);
    }
  }
  await browser.close();
}

function summarize(samples, hashes, extras = {}) {
  const { audioSamples = [], longAnimationFrames = [], inputEvents = [], bootMarks = null } =
    extras;
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
  const audioSummary = computeAudioSummary(audioSamples);
  const inputLatency = computeInputLatencySummary(inputEvents);
  const boot = computeBootSummary(bootMarks, samples);
  const renderingHealth = computeRenderingHealth(
    samples,
    hashes,
    overall,
    smoothness,
    audioSummary,
    longAnimationFrames,
    inputLatency,
    boot
  );
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
    audio: audioSummary,
    inputLatency,
    boot,
    renderingHealth,
    // Keep the flat averageX fields for backward compat with downstream tooling.
    averageGameSpeed: overall.averageGameSpeed,
    averagePresentFps: overall.averagePresentFps,
    averageCoreFps: overall.averageCoreFps,
    averageVisualFps: overall.averageVisualFps,
    finalSample: samples.at(-1),
  };
}

// Summarize the audio-envelope samples collected from the AnalyserNode.
// Each entry is { tSec, peak, rms } at 4 Hz. We report: total samples,
// active sample count (rms above silence floor), peak-rms-ever-seen,
// and "audio was producing sound for N % of the run".
function computeAudioSummary(audioSamples) {
  if (!audioSamples?.length) {
    return {
      enabled: false,
      sampleCount: 0,
      activeSamples: 0,
      activePercent: 0,
      peakRms: 0,
      peakAmplitude: 0,
    };
  }
  const SILENCE_RMS = 0.001; // ~-60 dBFS — well below any real audio
  let activeSamples = 0;
  let peakRms = 0;
  let peakAmplitude = 0;
  for (const s of audioSamples) {
    if (s.rms > SILENCE_RMS) activeSamples += 1;
    if (s.rms > peakRms) peakRms = s.rms;
    if (s.peak > peakAmplitude) peakAmplitude = s.peak;
  }
  return {
    enabled: true,
    sampleCount: audioSamples.length,
    activeSamples,
    activePercent: Number(((100 * activeSamples) / audioSamples.length).toFixed(2)),
    peakRms: Number(peakRms.toFixed(6)),
    peakAmplitude: Number(peakAmplitude.toFixed(6)),
  };
}

// Boot timeline. Breaks the cold-start cost into named phases so we know
// which one is slowest. Times are wall-clock ms from "ROM upload
// dispatched" (the t0 of the validator's interaction with the page).
function computeBootSummary(bootMarks, samples) {
  if (!bootMarks) return null;
  const jitSampleIdx = samples.findIndex(
    (s) => (s.jitBlockCompileCount || 0) > 0 || /JIT enabled/.test(s.statusPill || "")
  );
  const jitEngagementBootMs =
    jitSampleIdx >= 0
      ? Math.round((samples[jitSampleIdx].elapsedSeconds || 0) * 1000) + (bootMarks.mountComplete || 0)
      : null;
  return {
    // Phase durations (ms each). null for first-visible if we never saw
    // bright pixels within the 15 s polling window.
    uploadMs: bootMarks.uploadComplete ?? null,
    clickMs: bootMarks.screenClicked != null && bootMarks.uploadComplete != null
      ? bootMarks.screenClicked - bootMarks.uploadComplete
      : null,
    mountMs: bootMarks.mountComplete != null && bootMarks.screenClicked != null
      ? bootMarks.mountComplete - bootMarks.screenClicked
      : null,
    firstVisibleMs: bootMarks.firstVisibleContentAt != null && bootMarks.mountComplete != null
      ? bootMarks.firstVisibleContentAt - bootMarks.mountComplete
      : null,
    // Cumulative milestones (ms from t0 = upload dispatched).
    timeline: {
      uploadComplete: bootMarks.uploadComplete ?? null,
      screenClicked: bootMarks.screenClicked ?? null,
      mountComplete: bootMarks.mountComplete ?? null,
      firstVisibleContent: bootMarks.firstVisibleContentAt ?? null,
      jitEngagement: jitEngagementBootMs,
    },
  };
}

// Summarize input-event latency. Each entry is a PerformanceEventTiming
// record: startTime (event arrival), processingStart (handler began),
// processingEnd, duration. We compute p50/p95/max of
// processingStart - startTime as "input-to-handler" latency. Note this
// isn't the true input-to-paint metric (would need GPU scanout time)
// but it's the largest controllable slice of the round trip.
function computeInputLatencySummary(inputEvents) {
  // Only count keyboard inputs the validator dispatched (keydown/keyup).
  // Mouse events from Playwright orchestration shouldn't pollute the
  // input-latency channel.
  const keys = inputEvents.filter(
    (e) => e.name === "keydown" || e.name === "keyup"
  );
  if (!keys.length) {
    return {
      enabled: false,
      sampleCount: 0,
      p50Ms: 0,
      p95Ms: 0,
      maxMs: 0,
    };
  }
  const latencies = keys
    .map((e) => Math.max(0, e.processingStart - e.startTime))
    .sort((a, b) => a - b);
  const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))];
  return {
    enabled: true,
    sampleCount: latencies.length,
    p50Ms: Number(pct(0.5).toFixed(2)),
    p95Ms: Number(pct(0.95).toFixed(2)),
    maxMs: Number(latencies[latencies.length - 1].toFixed(2)),
  };
}

// Aggregate pass/fail health signal across the run. Each check returns
// { name, passed, value, threshold, detail } so the summary doubles as a
// human-readable report and a CI-friendly assertion. The thresholds aim
// for the user-stated bar: "every frame renders as fast as possible like
// perfect 60 Hz no dropping frames or slowing the game down."
function computeRenderingHealth(samples, hashes, overall, smoothness, audio, loafEntries, inputLatency, boot) {
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
  //    here. Split into "boot phase" (first 5 s) and "runtime" (after).
  //    Boot phase always pays a wasm-instantiate + initial-JIT spike;
  //    we report it for visibility but don't fail on it. Runtime stalls
  //    are the real user-perceived freezes.
  const maxGap = smoothness?.lifetimeMaxIntervalMs ?? 0;
  const maxGapAtMs = smoothness?.lifetimeMaxIntervalAtMs ?? 0;
  // performance.now() = ms since page load. waitForMount typically
  // takes ~3 s, so anything <5000 ms is boot phase.
  const maxGapInBoot = maxGapAtMs > 0 && maxGapAtMs < 5000;
  checks.push({
    name: "max-gap-boot",
    passed: true, // never fails — boot stalls are expected
    value: maxGapInBoot ? maxGap : 0,
    threshold: null,
    detail: `ms — worst gap during boot phase (first 5 s). ${
      maxGapInBoot ? "(this run)" : "(no boot stall this run)"
    }`,
    informational: true,
  });
  // The asserting check: post-boot stalls. Threshold 500 ms = "no single
  // freeze longer than a coin flip". The user-reported 2 s in-game
  // freeze would fail this check.
  const runtimeMaxGap = maxGapInBoot ? 0 : maxGap;
  checks.push({
    name: "runtime-max-gap",
    passed: runtimeMaxGap <= 500,
    value: runtimeMaxGap,
    threshold: 500,
    detail: maxGapInBoot
      ? `ms — no post-boot stall (worst gap was at t=${(maxGapAtMs / 1000).toFixed(1)}s in boot)`
      : `ms — worst gap post-boot at t=${(maxGapAtMs / 1000).toFixed(1)}s`,
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

  // 7. Audio is producing sound. Headless probes may not have working
  //    audio output (Chrome's autoplay policy, missing audio device),
  //    so this check is skipped — not failed — when audio wasn't
  //    measured at all. When measured, at least 5 % of samples must
  //    have RMS above the silence floor.
  if (audio?.enabled) {
    checks.push({
      name: "audio-presence",
      passed: audio.activePercent >= 5,
      value: audio.activePercent,
      threshold: 5,
      detail:
        `% of audio samples above silence floor (peak rms = ${audio.peakRms})`,
    });
  } else {
    checks.push({
      name: "audio-presence",
      passed: true, // not measured — not failed
      value: 0,
      threshold: 5,
      detail: "skipped — audio probe didn't capture any samples",
      skipped: true,
    });
  }

  // 8. Input handler latency. p95 input-to-handler should stay below
  //    32 ms (two 60 Hz slots — fast enough that nobody notices).
  if (inputLatency?.enabled) {
    checks.push({
      name: "input-latency",
      passed: inputLatency.p95Ms <= 32,
      value: inputLatency.p95Ms,
      threshold: 32,
      detail: `ms — p95 input event arrival -> handler start (n=${inputLatency.sampleCount})`,
    });
  } else {
    checks.push({
      name: "input-latency",
      passed: true,
      value: 0,
      threshold: 32,
      detail: "skipped — no input events observed",
      skipped: true,
    });
  }

  // 9. Main-thread blocking frames are rare. PerformanceLongAnimationFrame
  //    entries report whenever a frame took >50 ms on the main thread.
  //    A few per minute is normal during JIT engagement; many sustained
  //    long frames indicate a thrash.
  const loafCount = loafEntries?.length ?? 0;
  const runSeconds = samples.length > 0
    ? (samples.at(-1)?.elapsedSeconds || samples.length)
    : 1;
  const loafPerMinute = (60 * loafCount) / Math.max(1, runSeconds);
  checks.push({
    name: "long-anim-frames",
    passed: loafPerMinute <= 10,
    value: Number(loafPerMinute.toFixed(2)),
    threshold: 10,
    detail: `count of >50 ms main-thread frames per minute (total ${loafCount})`,
  });

  // 10. Boot snappiness. Headline number: time from ROM upload to
  //     first visible (non-black) pixel on the canvas. 5 s is the
  //     loose cutoff — under that "feels snappy"; over feels laggy.
  //     We split phases in the boot block above so a fail here can
  //     pinpoint whether it's mount, wasm-instantiate, or first paint
  //     that's slow.
  if (boot && boot.timeline?.firstVisibleContent != null) {
    const ms = boot.timeline.firstVisibleContent;
    checks.push({
      name: "boot-snappy",
      passed: ms <= 5000,
      value: ms,
      threshold: 5000,
      detail:
        `ms from ROM upload to first visible pixel ` +
        `(mount=${boot.mountMs}ms first-paint=${boot.firstVisibleMs}ms)`,
    });
  } else if (boot) {
    checks.push({
      name: "boot-snappy",
      passed: false,
      value: -1,
      threshold: 5000,
      detail: "first visible pixel never observed within 15 s polling window",
    });
  } else {
    checks.push({
      name: "boot-snappy",
      passed: true,
      value: 0,
      threshold: 5000,
      detail: "skipped — no boot timeline data",
      skipped: true,
    });
  }

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
  const lifetimeMaxIntervalAtMs = Number(last.presentationLifetimeMaxIntervalAtMs) || 0;
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
    // performance.now() timestamp of when the worst gap happened.
    // The validator's elapsedSeconds is measured from Date.now() at probe
    // start, performance.now() is measured from page load — they're on
    // different clocks. We use this only to bucket "boot phase" vs
    // "post-boot", not for precise correlation.
    lifetimeMaxIntervalAtMs: Number(lifetimeMaxIntervalAtMs.toFixed(0)),
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
      presentationLifetimeMaxIntervalAtMs:
        Number(info.presentationLifetimeMaxIntervalAtMs) || 0,
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
