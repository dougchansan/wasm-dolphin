import { DEFAULT_UPSTREAM_CORE_URL, WORKERFS_MOUNT_DIR, sanitizeDiscFileName } from "./upstream-worker-protocol.js";
import { parseDolHeader } from "./dol.js";

// Day-25: mark this thread. The discio worker owns the WebGPU device
// (createWebGpuPresenter runs here). WebGPU objects aren't shareable
// across Emscripten pthreads, so the real GPU pipeline's wgpu calls
// must run on THIS thread. C++ probes `self.__dolphinDiscioWorker`
// via EM_ASM at Initialize/Draw/ShowImage to confirm it's on the
// device-owning thread. Pthreads have their own `self` without it.
self.__dolphinDiscioWorker = true;

let coreUrl = DEFAULT_UPSTREAM_CORE_URL;
let moduleInstance = null;
let api = null;
let mounted = false;
let inputMask = 0;
let workerOwnsCanvas = false;
let renderCanvas = null;
let renderContext = null;
let renderImageData = null;
let renderGpu = null;
let renderGl = null;
let renderGlState = null;
let renderUploadBuffer = null;
let renderRequiresUploadCopy = false;
let preferredPresenterBackend = "webgl";
let presentationLoopActive = false;
let presentedFrame = 0;
let lastPresentedCoreFrame = -1;
let presentationFps = 0;
let presentationRawFps = 0;
let presentationLoopFps = 0;
let presentationAverageIntervalMs = 0;
let presentationP95IntervalMs = 0;
let presentationMaxIntervalMs = 0;
let presentationLongFrameCount = 0;
// Lifetime smoothness counters (never reset). presentationMaxIntervalMs
// resets every 500 ms FPS window, so a transient freeze between windows
// would be invisible. These four persist across the full run so the
// validator can summarize "worst single gap" and full inter-frame
// distribution shape. presentationLifetimeMaxIntervalAtMs is the
// performance.now() timestamp of when the worst gap happened — lets
// the validator distinguish boot-phase stalls (early) from gameplay
// stalls (late).
let presentationLifetimeMaxIntervalMs = 0;
let presentationLifetimeMaxIntervalAtMs = 0;
let presentationLifetimeDropCount = 0;
let presentationLifetimeFrameCount = 0;
// Welford online stddev for inter-frame intervals across the whole run.
let presentationIntervalMean = 0;
let presentationIntervalM2 = 0;
let presentationIntervalCount = 0;
// Fixed-width histogram (ms buckets) of inter-frame intervals — captures
// distribution shape (bimodal, periodic jitter) that p95 alone misses.
// Buckets: 0-8, 8-12, 12-16, 16-20, 20-24, 24-33, 33-50, 50-100, 100-200, 200+
const PRESENTATION_HISTOGRAM_BUCKETS_MS = [8, 12, 16, 20, 24, 33, 50, 100, 200];
const presentationIntervalHistogram = new Uint32Array(
  PRESENTATION_HISTOGRAM_BUCKETS_MS.length + 1
);
let visualChangeFps = 0;
let visualFrameHash = 0;
let lastVisualFrameHash = 0;
let lastOglSwapCount = 0;
let oglGlError = 0;
let visualSampleSource = "none";
let visualChangesSincePresentationFps = 0;
let framesSincePresentationFps = 0;
let loopsSincePresentationFps = 0;
let intervalSumSincePresentationFps = 0;
let intervalSamplesSincePresentationFps = [];
let maxIntervalSincePresentationFps = 0;
let longFramesSincePresentationFps = 0;
let lastPresentationFpsTime = 0;
let lastPresentedAt = 0;
let lastHostPumpTime = 0;
let renderBackend = "none";
let frameProfileStats = "-";
let profileWindow = createProfileWindow();
// Stall-logger state.
let worstLoopMsLogged = 0;
let stallCount = 0;
let worstSignalWaitMs = 0;
let signalStallCount = 0;
let presentationChannel = null;
let frameSignalHeap = null;
let frameSignalIndex = -1;
let frameSignalValue = 0;
let frameSignalWaitPending = false;
let ppcWasmJitRequested = false;
let ppcWasmJitForce = false;
let ppcWasmJitActive = false;
let ppcWasmJitDisabledForSession = false;
let ppcWasmJitCooldownUntilFrame = 0;
let ppcWasmJitEnabledAtFrame = 0;
// Day-21: presentation fps captured immediately before the JIT
// engaged. The disable guard fuses the JIT only if presentation
// regressed materially below this baseline (i.e. the JIT itself hurt),
// not merely because the renderer is slow.
let ppcWasmJitPreEngageFps = 0;
// §28s: renderer-agnostic core-liveness tracker for the JIT fuse.
// presentationFps is structurally ~0 in the WebGPU-presenter path
// (it counts the legacy canvas-blit, not DIAG_EFB_TO_CANVAS), so the
// old `catastrophic = presentationFps < FLOOR` net mis-fired every
// fuse window even at a healthy 60 coreFps → JIT thrash → cutscene
// black-flash. The real "JIT froze emulation" signal is the core
// frame counter not advancing in wall-clock time.
let ppcWasmJitFuseLastFrame = -1;
let ppcWasmJitFuseLastTime = 0;
let ppcWasmJitTier = "guarded";
let ppcWasmJitWarmupFrames = 3600;
let pacedPresentationActive = false;
let nextPacedPresentationTime = 0;
let pacedPresentationTimer = 0;
let pacedPresentationRaf = 0;
let frameQueue = [];
let presentationQueueLimit = 8;
let presentationQueueTarget = 4;
let pacedPresentationPrimed = false;
let pacedPresentationStartedAt = 0;
let presentationPacingMode = "smooth";
let inputStateSabView = null;
let lastInputStateGeneration = 0;
// Detached OGL mode: worker owns a standalone OffscreenCanvas for the GL
// backend (no transferControlToOffscreen, no compositor binding). After
// each GL swap the worker transferToImageBitmap()s the canvas and posts
// the bitmap to main thread, which drawImages it onto the visible canvas.
let detachedOglCanvas = null;
let detachedOglFrameCount = 0;
// SAB pixel transport state (Day-5). When enabled, the worker copies
// s_framebuffer bytes into oglPixelSabView per OGL swap and increments
// oglMetaSabView[0] atomically. Main thread reads the counter on RAF and
// putImageDatas to the visible canvas, bypassing the WebGPU presenter.
let oglPixelSabView = null;
let oglMetaSabView = null;
let oglSabWidth = 0;
let oglSabHeight = 0;
let oglSabEnabledForLoad = false;
// Boot-stall watchdog state. Detects the "core CPU is frozen but canvas
// still updates" pattern (Chrome IntensiveWakeUpThrottling clamping the
// worker's setTimeout below 1Hz, starving pumpHostJobs).
let watchdogLastCoreTicks = -1;
let watchdogStallCount = 0;
let watchdogRecoveryCount = 0;
let watchdogFireCount = 0;
const WATCHDOG_STALL_THRESHOLD = 2; // 2 x 500ms = 1s of frozen coreTicks
let presentationUnderrunCount = 0;
let presentationDroppedFrameCount = 0;
let presentationUnderrunsSinceFps = 0;
let presentationDropsSinceFps = 0;
let presentationWindowUnderrunCount = 0;
let presentationWindowDropCount = 0;
let lastCapturedCoreFrame = -1;
let coreBoot = {
  attempted: false,
  accepted: false,
  path: "",
  skippedReason: ""
};

const MIN_FULL_BOOT_BYTES = 16 * 1024 * 1024;
const LONG_PRESENTATION_FRAME_MS = 24;
const PACED_PRESENTATION_INTERVAL_MS = 1000 / 60;
// Default queue depth (smooth pacing) — 4 absorbs typical paint-time jitter
// (~3 long-frames/s under JIT compile bursts and worker contention) without
// stalling the paced loop. At target=1, steady-state queue depth is ~1-2
// frames; the extra headroom only kicks in on transient spikes. Empirically
// (Day 8) bumping 2→4 lifted presentFps from ~26 to ~55 at the same actual
// paint rate (rawFps=59) — the gap was metric-induced via p95-clamping on
// underrun/drop events.
const DEFAULT_PRESENTATION_QUEUE = 4;
const MIN_PRESENTATION_QUEUE = 2;
const MAX_PRESENTATION_QUEUE = 12;
const VISUAL_HASH_SAMPLE_STRIDE_BYTES = 256;
// §28ao: was 3600 (=60 s @60fps) → the JIT stayed OFF for the first
// minute of a cold run, executing all PPC on the slow interpreter —
// the dominant "not smooth / slow boot" cause (agent-confirmed). 300
// (~5 s) front-loads the one-time compile burst to the GC IPL screen
// (player just watching) instead of the menus. The post-activation
// stall fuse + cooldown already guard against JIT destabilisation.
const DEFAULT_WASM_JIT_WARMUP_XFB_FRAMES = 300;
const WASM_JIT_MIN_STABLE_PRESENTATION_FPS = 25;
const WASM_JIT_MAX_STABLE_PRESENTATION_GAP_MS = 80;
const WASM_JIT_MIN_ACTIVE_FRAMES_BEFORE_FUSE = 240;
// Day-21: regression-relative fuse. Keep the JIT unless presentation
// fell to < 65% of its pre-engage rate (a regression the JIT itself
// introduced) and the baseline was high enough to trust, OR fps is
// catastrophically low in absolute terms (a real freeze). The old
// absolute fps/gap floor mis-fused the JIT whenever the CPU software
// rasteriser — not the JIT — was the fps bottleneck.
const WASM_JIT_REGRESSION_FRACTION = 0.65;
const WASM_JIT_REGRESSION_MIN_BASELINE_FPS = 18;
const WASM_JIT_ABSOLUTE_FLOOR_FPS = 6;
const WASM_JIT_POST_ACTIVATION_STALL_THRESHOLD_MS = 5000;
const WASM_JIT_POST_ACTIVATION_GRACE_FRAMES = 300;
// After a temporary degraded-presentation disable, wait this many video frames
// before allowing the JIT to re-engage. ~5 seconds at 60fps.
const WASM_JIT_DEGRADED_COOLDOWN_FRAMES = 300;

self.addEventListener("message", async (event) => {
  const data = event.data ?? {};
  // Forward detachedOglFrame messages from Dolphin's GPU pthread to main.
  // The C++ Swap path posts the bitmap from whichever pthread owns the
  // canvas (Emscripten transfers Module.canvas to the GPU pthread on first
  // access, detaching it from the discio-worker side). The pthread's
  // postMessage lands on its parent (this discio worker), so we forward
  // it on to main where the upstream-worker-adapter handles it.
  if (data && data.type === "detachedOglFrame" && data.bitmap) {
    try {
      self.postMessage(
        { type: "detachedOglFrame", bitmap: data.bitmap, width: data.width, height: data.height },
        [data.bitmap]
      );
    } catch (err) {
      try { data.bitmap.close(); } catch {}
    }
    return;
  }
  const { id, type, payload = {} } = data;

  try {
    const result = await handleMessage(type, payload);
    postResult(id, result);
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

async function handleMessage(type, payload) {
  switch (type) {
    case "load":
      if (payload.inputStateSab instanceof SharedArrayBuffer) {
        inputStateSabView = new Int32Array(payload.inputStateSab);
        lastInputStateGeneration = 0;
      }
      // SAB pixel transport: set up shared views once. The worker's
      // presentation loop will copy s_framebuffer bytes into oglPixelSabView
      // per OGL swap and bump oglMetaSabView[0] atomically — main thread
      // reads the counter in its existing RAF loop and putImageDatas.
      if (payload.oglPixelSab instanceof SharedArrayBuffer &&
          payload.oglMetaSab instanceof SharedArrayBuffer) {
        oglPixelSabView = new Uint8Array(payload.oglPixelSab);
        oglMetaSabView = new Int32Array(payload.oglMetaSab);
        oglSabWidth = payload.oglSabWidth | 0;
        oglSabHeight = payload.oglSabHeight | 0;
      }
      await loadCore({
        coreUrl: payload.coreUrl,
        canvas: payload.canvas,
        videoBackend: payload.videoBackend,
        cpuThread: payload.cpuThread,
        cpuCore: payload.cpuCore,
        ppcWasmJit: payload.ppcWasmJit,
        ppcWasmJitForce: payload.ppcWasmJitForce,
        ppcWasmJitTier: payload.ppcWasmJitTier,
        ppcWasmJitWarmupFrames: payload.ppcWasmJitWarmupFrames,
        ppcProfile: payload.ppcProfile,
        cpuOverclock: payload.cpuOverclock,
        emulationSpeed: payload.emulationSpeed,
        presentationScale: payload.presentationScale,
        presentationQueueSize: payload.presentationQueueSize,
        presentationPacing: payload.presentationPacing,
        presenterBackend: payload.presenterBackend,
        oglProxyMode: payload.oglProxyMode,
        oglTestClear: payload.oglTestClear,
        fastSoftwareRaster: payload.fastSoftwareRaster,
        cachedInterpreterDisableMask: payload.cachedInterpreterDisableMask,
        oglSabEnabled: oglPixelSabView !== null
      });
      return metadataPayload();
    case "mountFile":
      return mountFile(payload.file);
    case "setInputMask":
      inputMask = payload.mask >>> 0;
      api?.setInputMask(inputMask);
      return {};
    case "setInputState":
      inputMask = payload.mask >>> 0;
      api?.setInputState?.({
        mask: inputMask,
        stickX: payload.stickX,
        stickY: payload.stickY,
        cStickX: payload.cStickX,
        cStickY: payload.cStickY,
        triggerLeft: payload.triggerLeft,
        triggerRight: payload.triggerRight,
        analogA: payload.analogA,
        analogB: payload.analogB
      });
      return {};
    case "runFrame":
      if (!presentationLoopActive) {
        api?.pumpHostJobs?.();
      }
      if (!coreBoot.accepted && !presentationLoopActive) {
        api?.runFrame();
      }
      return framePayload();
    case "reset":
      api?.reset();
      api?.setInputMask(inputMask);
      return framePayload();
    case "bootProbe":
      return { bootProbe: bootProbePayload(metadataPayload()) };
    case "saveState":
      return { saved: Boolean(api?.saveState(payload.slot | 0)) };
    case "loadState":
      return { loaded: Boolean(api?.loadState(payload.slot | 0)), ...framePayload() };
    case "loadStateFile": {
      // Write the .sav bytes into the Emscripten FS, then ask the core
      // to State::LoadAs it. Dolphin save states are build/version
      // locked — a state from a different Dolphin will be rejected by
      // LoadAs's version check (logged, not a crash). We pump a few
      // frames so the loaded state actually renders.
      if (!api?.loadStateFile || !moduleInstance?.FS) {
        return { loaded: false, error: "no loadStateFile/FS" };
      }
      // payload.fsPath: load an existing FS file in place (e.g. the
      // one SaveStateFile just wrote) — proves a version-matched
      // round-trip with zero serving. Else write payload.bytes first.
      const path = payload.fsPath || "/savestate.sav";
      if (!payload.fsPath) {
        try {
          const bytes = payload.bytes instanceof Uint8Array
            ? payload.bytes
            : new Uint8Array(payload.bytes);
          moduleInstance.FS.writeFile(path, bytes);
        } catch (e) {
          return { loaded: false, error: `FS.writeFile: ${e?.message || e}` };
        }
      }
      const beforeState = api?.getCoreStateName?.() ?? "";
      const rc = api.loadStateFile(path) | 0;
      // LoadAs runs on the autonomous CPU pthread (RunFrame doesn't
      // step the core) — wait real wall-clock time so the restore
      // actually takes effect before we sample/screenshot.
      await new Promise((r) => setTimeout(r, 1200));
      const afterState = api?.getCoreStateName?.() ?? "";
      // §27 diagnostic (JS-only, served live, no rebuild): open a
      // post-load watchdog window so drainWebGpuCmdRing logs whether
      // the producer ring keeps advancing (producer alive) vs the
      // consumer going stale, to localize the savestate-load desync.
      self._postLoadProbeT0 = Date.now();
      self._postLoadProbeUntil = self._postLoadProbeT0 + 35000;
      self._postLoadProbeLast = 0;
      console.log(`[loadStateFile] path=${path} rc=${rc} ` +
        `before='${beforeState}' after='${afterState}' ` +
        `frame=${api?.getFrame?.() ?? -1}`);
      return { loaded: rc === 1, rc, beforeState, afterState,
               ...framePayload() };
    }
    case "saveStateFile": {
      // SaveStateFile queues SaveToFileSync onto the autonomous Dolphin
      // CPU pthread (the discio worker's RunFrame does NOT step the
      // core — it's just a present tick). So we must WAIT real
      // wall-clock time for that pthread to run the job + write the
      // file; pumping runFrame did nothing and returned in <10 ms
      // (§24 size=0). handleMessage is async → await real timeouts so
      // the CPU/dump pthreads get scheduled.
      if (!api?.saveStateFile || !moduleInstance?.FS) {
        return { saved: false, error: "no saveStateFile/FS" };
      }
      const path = "/savestate_out.sav";
      try { moduleInstance.FS.unlink(path); } catch (e) {}
      const rc = api.saveStateFile(path) | 0;
      let prev = -1, stable = 0, size = 0;
      // up to ~8 s real time (40 × 200 ms); a Melee state is ~tens of
      // MB so allow generous time for DoState + zstd on the pthread.
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 200));
        try {
          const st = moduleInstance.FS.stat(path);
          size = st.size | 0;
          if (size > 0 && size === prev) { if (++stable >= 3) break; }
          else stable = 0;
          prev = size;
        } catch (e) { /* not written yet */ }
      }
      let bytes = null;
      try {
        if (size > 0) bytes = moduleInstance.FS.readFile(path); // Uint8Array
      } catch (e) {
        return { saved: false, rc, error: `readFile: ${e?.message || e}` };
      }
      console.log(`[saveStateFile] path=${path} rc=${rc} size=${size} ` +
        `frame=${api?.getFrame?.() ?? -1}`);
      const ab = bytes ? bytes.buffer.slice(bytes.byteOffset,
                                            bytes.byteOffset + bytes.byteLength)
                       : null;
      return ab
        ? { saved: true, rc, size, bytes: ab, transfer: [ab] }
        : { saved: false, rc, size, error: "empty/no state file" };
    }
    case "mixAudio": {
      if (!api?.mixAudio || !api?.audioBuffer || !moduleInstance?.HEAPU8) {
        return {
          available: false,
          frames: 0,
          channels: 2,
          sampleRate: 48000,
          samples: null,
          stats: api?.getAudioStats?.() || "audio:unavailable"
        };
      }
      const requested = Math.max(1, Math.min(4096, payload.frames | 0));
      const channels = Math.max(1, Math.min(2, api.audioChannels?.() || 2));
      const sampleRate = Math.max(8000, api.audioSampleRate?.() || 48000);
      const maxFrames = Math.max(1, api.audioBufferFrames?.() || 4096);
      const mixed = Math.max(0, Math.min(maxFrames, api.mixAudio(requested) | 0));
      const pointer = api.audioBuffer();
      const samples =
        mixed > 0 && pointer
          ? new Int16Array(moduleInstance.HEAPU8.buffer, pointer, mixed * channels).slice()
          : null;
      return {
        available: mixed > 0,
        frames: mixed,
        channels,
        sampleRate,
        samples,
        stats: api.getAudioStats?.() || ""
      };
    }
    case "setAudioMuted":
      api?.setAudioMuted?.(payload.muted ? 1 : 0);
      return {};
    default:
      throw new Error(`Unknown upstream worker message: ${type}`);
  }
}

async function loadCore({
  coreUrl: nextCoreUrl = DEFAULT_UPSTREAM_CORE_URL,
  canvas = null,
  videoBackend = "Software Renderer",
  cpuThread = false,
  cpuCore = "cached",
  ppcWasmJit = false,
  ppcWasmJitForce: requestedPpcWasmJitForce = false,
  ppcWasmJitTier: requestedPpcWasmJitTier = "guarded",
  ppcWasmJitWarmupFrames: requestedPpcWasmJitWarmupFrames = DEFAULT_WASM_JIT_WARMUP_XFB_FRAMES,
  ppcProfile = false,
  cpuOverclock = 1,
  emulationSpeed = 1,
  presentationScale = 1,
  presentationQueueSize = DEFAULT_PRESENTATION_QUEUE,
  presentationPacing = "smooth",
  presenterBackend = "webgl",
  oglProxyMode = "proxy",
  oglTestClear = false,
  fastSoftwareRaster = 0,
  cachedInterpreterDisableMask = 0,
  oglSabEnabled = false
} = {}) {
  if (moduleInstance) {
    return moduleInstance;
  }
  oglSabEnabledForLoad = Boolean(oglSabEnabled);

  const normalizedOglProxyMode = normalizeOglProxyMode(oglProxyMode);
  // SAB mode behaves like readback (worker fills s_framebuffer via readback)
  // but pipes pixels via SAB+main-thread putImageData instead of running a
  // WebGPU presenter on a transferred OffscreenCanvas. So we force-enable
  // readback when SAB is on, regardless of the user's oglproxy choice.
  const readbackOgl =
    videoBackend === "OGL" && (normalizedOglProxyMode === "readback" || oglSabEnabledForLoad);
  // Detached mode: when no canvas was transferred but we're on the OGL
  // worker path, create a standalone OffscreenCanvas for the GL backend.
  // Standalone OCs aren't bound to any DOM element so commit/captureStream
  // problems don't apply. Worker reads back pixels per frame and posts an
  // ImageBitmap to the main thread, which paints the visible canvas via
  // drawImage. This is the architecture that works in the user's
  // environment when transferControlToOffscreen-based paths fail.
  const detachedOgl =
    videoBackend === "OGL" && !readbackOgl && !canvas && typeof OffscreenCanvas === "function";
  let moduleCanvas;
  if (videoBackend === "OGL") {
    if (readbackOgl && typeof OffscreenCanvas === "function") {
      moduleCanvas = new OffscreenCanvas(320, 240);
    } else if (detachedOgl) {
      moduleCanvas = new OffscreenCanvas(640, 480);
      detachedOglCanvas = moduleCanvas;
    } else {
      moduleCanvas = canvas;
    }
  }
  if (moduleCanvas) {
    moduleCanvas.id = "canvas";
  }

  if (canvas) {
    canvas.id = "canvas";
    workerOwnsCanvas = true;
    postStatus(`Worker received canvas: ${canvas.constructor?.name || typeof canvas}`);
  } else if (detachedOgl) {
    postStatus("Worker DETACHED OGL: standalone OffscreenCanvas, frames posted via ImageBitmap");
  } else {
    postStatus(`Worker received NO canvas (videoBackend=${videoBackend}, oglProxy=${normalizedOglProxyMode})`);
  }

  if (canvas && videoBackend === "OGL" && !readbackOgl) {
    renderCanvas = canvas;
    renderBackend = "ogl";
    postStatus("Worker OGL path: canvas attached, awaiting WebGL2 context creation");
  } else if (detachedOgl) {
    renderCanvas = moduleCanvas;
    renderBackend = "ogl";
    // Detached mode still "owns" a canvas (the standalone OffscreenCanvas);
    // it's just not the user's visible one. Without this, the presentation
    // loop never starts (it gates on workerOwnsCanvas) and presentFrame is
    // never called, so no frames flow through the pipeline.
    workerOwnsCanvas = true;
  } else if (oglSabEnabledForLoad && moduleCanvas) {
    // SAB pixel transport: the standalone moduleCanvas hosts the GL backend
    // and we publish pixels to main via the SAB. Same workerOwnsCanvas
    // promotion as detached mode — otherwise the presentation loop won't
    // start and we'll never call publishOglSabFrame.
    //
    // renderBackend = "ogl" is critical: it routes the presentation loop
    // through the OGL branch (which dedups on OGL-swap-count) instead of
    // the generic frameSignal branch (which dedups on coreFrame). OGL
    // bypasses XFB, so coreFrame doesn't tick per visible swap, and the
    // dedup would reject every paint except the first — pthread reports
    // 1000s of swaps but the visible canvas only updates once.
    renderCanvas = moduleCanvas;
    renderBackend = "ogl";
    workerOwnsCanvas = true;
    postStatus("Worker SAB OGL: standalone OffscreenCanvas, pixels via SharedArrayBuffer");
  }

  if (canvas && (videoBackend !== "OGL" || readbackOgl)) {
    preferredPresenterBackend = normalizePresenterBackend(presenterBackend);
    await setupSoftwarePresenter(canvas, preferredPresenterBackend);
  }

  coreUrl = new URL(nextCoreUrl, self.location.href).href;
  const imported = await import(coreUrl);
  const factory = imported.default ?? imported.createDolphinCore ?? self.createDolphinCore;

  if (typeof factory !== "function") {
    throw new Error("Upstream Dolphin bundle did not expose createDolphinCore");
  }

  // Pre-fetch the wasm binary so we can both (a) hand it to Emscripten via
  // wasmBinary (skips its internal fetch) and (b) fingerprint it for the
  // JIT-cache cross-build invalidation. Single localhost fetch instead of
  // a double-fetch + extra hash pass.
  const { wasmBinary, fingerprint: buildFingerprint } =
      await fetchWasmAndFingerprint(coreUrl);
  // Reconcile IDB cache against this build's fingerprint before we touch
  // the cache map. If the build changed since the previous session, clear
  // the stale modules so we don't carry forward dead entries forever.
  await reconcileJitCacheWithBuild(buildFingerprint);

  // Day-15 (wasm-dolphin) WebGPU video backend: when the user selects
  // `?video=webgpu`, the existing WebGPU presenter (createWebGpuPresenter)
  // has already acquired a WGPUDevice and configured the canvas context.
  // Hand that same device to Emscripten via `preinitializedWebGPUDevice`
  // so the C++ side can pull it with `emscripten_webgpu_get_device()` and
  // reuse the existing context rather than acquiring a second device.
  const preinitializedWebGPUDevice =
    (videoBackend === "WebGPU" || videoBackend === "WebGPU-Real") && renderGpu
      ? renderGpu.device
      : undefined;

  moduleInstance = await factory({
    noInitialRun: true,
    canvas: videoBackend === "OGL" ? moduleCanvas || undefined : undefined,
    wasmBinary,
    // worker_owned_webgl must be true for any OGL run. The C++ side gates
    // its worker-context path, the InitBackendInfo probe-skip, and per-Swap
    // commit-frame handling on this flag. With it false, the standard
    // emscripten_webgl_create_context path produces a degenerate proxied
    // context (debug_bits=3, no GLctx) whose draw calls silently drop —
    // GP fifo stays empty and the visible canvas stays black.
    dolphinOglWorkerWebGl: videoBackend === "OGL",
    dolphinOglReadbackPresent: readbackOgl,
    dolphinOglTestClear: Boolean(oglTestClear),
    dolphinFastSoftwareRaster: Math.min(2, Math.max(0, Number(fastSoftwareRaster) || 0)),
    preinitializedWebGPUDevice,
    locateFile: (path) => new URL(path, coreUrl).href,
    print: (message) => postStatus(message),
    printErr: (message) => postStatus(message),
    onAbort: (reason) => postStatus(`Emscripten abort: ${reason}`)
  });

  // Day-16: `?video=webgpu` runs the Software→WebGPU-presenter hybrid.
  // The C++ Software path writes XFB into s_framebuffer; the existing
  // JS WebGPU presenter uploads + blits those bytes via a real
  // wgpuRenderPass. Plays Melee end-to-end today.
  if (videoBackend === "WebGPU" && renderGpu) {
    postStatus("WebGPU video backend: Software→WebGPU presenter hybrid (day-16)");
  }
  // Day-17: `?video=wgpu` activates the real WebGPU video backend in
  // C++. No Software bridge. WebGPUGfx drives the canvas directly via
  // wgpu API calls. Early phases: clear-colour or partial frames while
  // pipeline pieces (textures, shaders, draw calls) come online.
  if (videoBackend === "WebGPU-Real" && renderGpu) {
    postStatus("WebGPU video backend: real C++ render path active (day-17, under construction)");
  }

  api = bindApi(moduleInstance);
  // Day-7 persistent JIT cache (Phase A — message channel only). Push the
  // master cache map (currently empty) to every pthread worker so the
  // pre-js receiver on each pthread can stash it on Module._dolphinJitCache.
  // The EM_JS compile body will then consult the local cache on each
  // pthread, instantiate cached Modules locally, and avoid the cross-thread
  // table problem from Day 6. Phase B adds cache lookup in the EM_JS;
  // Phase C adds IndexedDB persistence.
  installDolphinJitCacheChannel(moduleInstance);
  api.setVideoBackend?.(videoBackend);
  api.setCpuThread?.(Boolean(cpuThread));
  api.setCpuCore?.(cpuCore);
  ppcWasmJitRequested = Boolean(ppcWasmJit);
  ppcWasmJitForce = Boolean(requestedPpcWasmJitForce);
  ppcWasmJitActive = false;
  ppcWasmJitDisabledForSession = false;
  ppcWasmJitCooldownUntilFrame = 0;
  ppcWasmJitEnabledAtFrame = 0;
  ppcWasmJitTier = requestedPpcWasmJitTier === "mixed" ? "mixed" : "guarded";
  ppcWasmJitWarmupFrames = normalizePpcWasmJitWarmupFrames(requestedPpcWasmJitWarmupFrames);
  console.log(`[s28-jittier] worker init: requested=${JSON.stringify(requestedPpcWasmJitTier)} ` +
    `→ resolved ppcWasmJitTier=${ppcWasmJitTier} (engage will call ` +
    `setPpcWasmJitEnabled(${ppcWasmJitTier === "mixed" ? 2 : 1}))`);
  api.setPpcWasmJitEnabled?.(0);
  api.setPpcProfileEnabled?.(ppcProfile ? 1 : 0);
  api.setCpuOverclock?.(Number(cpuOverclock));
  api.setEmulationSpeed?.(Number(emulationSpeed));
  api.setPresentationScale?.(Number(presentationScale));
  api.setFastSoftwareRaster?.(Math.min(2, Math.max(0, Number(fastSoftwareRaster) || 0)));
  const disableMask = (Number(cachedInterpreterDisableMask) || 0) >>> 0;
  if (disableMask !== 0 && api.setCachedInterpreterDisableMask) {
    api.setCachedInterpreterDisableMask(disableMask);
    postStatus(`CachedInterpreter disable mask = 0x${disableMask.toString(16)}`);
  }
  startFrameRingDrainLoop();
  configurePresentationQueue(presentationQueueSize);
  presentationPacingMode = presentationPacing === "direct" ? "direct" : "smooth";
  api.coreInit?.();
  startPresentationLoop();

  if (!moduleInstance.FS?.filesystems?.WORKERFS) {
    throw new Error("Upstream Dolphin bundle was not built with WORKERFS");
  }

  return moduleInstance;
}

function bindApi(module) {
  const cwrap = module.cwrap.bind(module);
  const ccall = module.ccall.bind(module);
  const optionalCwrap = (name, returnType, argTypes = []) =>
    typeof module[`_${name}`] === "function" ? cwrap(name, returnType, argTypes) : null;

  return {
    mountDisc: (path) => ccall("MountDisc", "number", ["string"], [path]),
    coreInit: optionalCwrap("CoreInit", "number", []),
    setVideoBackend:
      typeof module._SetVideoBackend === "function"
        ? (backend) => ccall("SetVideoBackend", "number", ["string"], [backend])
        : null,
    setCpuThread:
      typeof module._SetCpuThread === "function"
        ? (enabled) => ccall("SetCpuThread", "number", ["number"], [enabled ? 1 : 0])
        : null,
    setCpuCore:
      typeof module._SetCpuCore === "function"
        ? (core) => ccall("SetCpuCore", "number", ["string"], [core])
        : null,
    setPpcWasmJitEnabled:
      typeof module._SetPpcWasmJitEnabled === "function"
        ? (enabled) =>
            // §28bi: pass the integer tier through. `enabled ? 1 : 0`
            // boolean-coerced it, collapsing 2 (mixed) → 1 (guarded),
            // so the core's `s_wasm_jit_direct_only = enabled < 2` was
            // ALWAYS true ⇒ the mixed tier has been structurally
            // impossible. 0=off, 1=guarded, 2=mixed.
            ccall("SetPpcWasmJitEnabled", null, ["number"], [enabled | 0])
        : null,
    setPpcProfileEnabled:
      typeof module._SetPpcProfileEnabled === "function"
        ? (enabled) => ccall("SetPpcProfileEnabled", null, ["number"], [enabled ? 1 : 0])
        : null,
    setCpuOverclock:
      typeof module._SetCpuOverclock === "function"
        ? (factor) => ccall("SetCpuOverclock", "number", ["number"], [Number(factor) || 1])
        : null,
    setEmulationSpeed:
      typeof module._SetEmulationSpeed === "function"
        ? (factor) => ccall("SetEmulationSpeed", "number", ["number"], [Number(factor)])
        : null,
    setPresentationScale:
      typeof module._SetPresentationScale === "function"
        ? (scale) => ccall("SetPresentationScale", "number", ["number"], [Number(scale)])
        : null,
    setFastSoftwareRaster:
      typeof module._SetFastSoftwareRaster === "function"
        ? (mode) => ccall("SetFastSoftwareRaster", "number", ["number"], [mode | 0])
        : null,
    setCachedInterpreterDisableMask:
      typeof module._SetCachedInterpreterDisableMask === "function"
        ? (mask) =>
            ccall("SetCachedInterpreterDisableMask", "number", ["number"], [(mask >>> 0)])
        : null,
    getCachedInterpreterDisableMask:
      typeof module._GetCachedInterpreterDisableMask === "function"
        ? () => ccall("GetCachedInterpreterDisableMask", "number", [], []) >>> 0
        : null,
    getFrameRingEntryPtr:
      typeof module._GetFrameRingEntryPtr === "function"
        ? () => ccall("GetFrameRingEntryPtr", "number", [], []) >>> 0
        : null,
    getFrameRingCapacity:
      typeof module._GetFrameRingCapacity === "function"
        ? () => ccall("GetFrameRingCapacity", "number", [], []) | 0
        : null,
    getFrameRingEntrySize:
      typeof module._GetFrameRingEntrySize === "function"
        ? () => ccall("GetFrameRingEntrySize", "number", [], []) | 0
        : null,
    getFrameRingHead:
      typeof module._GetFrameRingHead === "function"
        ? () => ccall("GetFrameRingHead", "number", [], []) >>> 0
        : null,
    bootDisc:
      typeof module._BootDisc === "function"
        ? (path) => ccall("BootDisc", "number", ["string"], [path])
        : null,
    stopCore: optionalCwrap("StopCore", null, []),
    pumpHostJobs: optionalCwrap("PumpHostJobs", null, []),
    getCoreState: optionalCwrap("GetCoreState", "number", []),
    getCoreStateName: optionalCwrap("GetCoreStateName", "string", []),
    getCoreStatus: optionalCwrap("GetCoreStatus", "string", []),
    getCoreTitle: optionalCwrap("GetCoreTitle", "string", []),
    getCoreTicksLow: optionalCwrap("GetCoreTicksLow", "number", []),
    getCoreTicksHigh: optionalCwrap("GetCoreTicksHigh", "number", []),
    getCoreTicksPerSecond: optionalCwrap("GetCoreTicksPerSecond", "number", []),
    getPpcPc: optionalCwrap("GetPPCPC", "number", []),
    getCpuCoreName: optionalCwrap("GetCPUCoreName", "string", []),
    getPpcWasmBlockCompileCount: optionalCwrap("GetPpcWasmBlockCompileCount", "number", []),
    getPpcWasmBlockRunCount: optionalCwrap("GetPpcWasmBlockRunCount", "number", []),
    getPpcWasmHelperStats: optionalCwrap("GetPpcWasmHelperStats", "string", []),
    getPpcProfileStats: optionalCwrap("GetPpcProfileStats", "string", []),
    getVideoStats: optionalCwrap("GetVideoStats", "string", []),
    reset: cwrap("Reset", null, []),
    setInputMask: cwrap("SetInputMask", null, ["number"]),
    setInputState:
      typeof module._SetInputState === "function"
        ? (state) =>
            ccall(
              "SetInputState",
              null,
              ["number", "number", "number", "number", "number", "number", "number", "number", "number"],
              [
                state.mask >>> 0,
                state.stickX | 0,
                state.stickY | 0,
                state.cStickX | 0,
                state.cStickY | 0,
                state.triggerLeft | 0,
                state.triggerRight | 0,
                state.analogA | 0,
                state.analogB | 0
              ]
            )
        : null,
    runFrame: cwrap("RunFrame", null, []),
    frameWidth: cwrap("FrameWidth", "number", []),
    frameHeight: cwrap("FrameHeight", "number", []),
    frameBuffer: cwrap("FrameBuffer", "number", []),
    saveState: cwrap("SaveState", "number", ["number"]),
    loadState: cwrap("LoadState", "number", ["number"]),
    loadStateFile: optionalCwrap("LoadStateFile", "number", ["string"]),
    saveStateFile: optionalCwrap("SaveStateFile", "number", ["string"]),
    getFrame: cwrap("GetFrame", "number", []),
    getFrameSignalPtr: optionalCwrap("GetFrameSignalPtr", "number", []),
    getGameId: cwrap("GetGameId", "string", []),
    getGameTitle: cwrap("GetGameTitle", "string", []),
    getMakerId: cwrap("GetMakerId", "string", []),
    getPlatform: cwrap("GetPlatform", "string", []),
    getRegion: cwrap("GetRegion", "string", []),
    getDiscNumber: cwrap("GetDiscNumber", "number", []),
    getApploaderDate: cwrap("GetApploaderDate", "string", []),
    getApploaderSize: cwrap("GetApploaderSize", "number", []),
    getBootDolOffset: cwrap("GetBootDolOffset", "number", []),
    getBootDolSize: cwrap("GetBootDolSize", "number", []),
    getFstOffset: cwrap("GetFstOffset", "number", []),
    getFstSize: cwrap("GetFstSize", "number", []),
    getRawSize: cwrap("GetRawSize", "number", []),
    getDataSize: cwrap("GetDataSize", "number", []),
    getRootEntryCount: cwrap("GetRootEntryCount", "number", []),
    getRootEntryName: cwrap("GetRootEntryName", "string", ["number"]),
    getRootEntryPath: cwrap("GetRootEntryPath", "string", ["number"]),
    getRootEntryIsDirectory: cwrap("GetRootEntryIsDirectory", "number", ["number"]),
    getRootEntryOffset: cwrap("GetRootEntryOffset", "number", ["number"]),
    getRootEntrySize: cwrap("GetRootEntrySize", "number", ["number"]),
    readDisc: cwrap("ReadDisc", "number", ["number", "number", "number"]),
    audioSampleRate: optionalCwrap("AudioSampleRate", "number", []),
    audioChannels: optionalCwrap("AudioChannels", "number", []),
    audioBufferFrames: optionalCwrap("AudioBufferFrames", "number", []),
    audioBuffer: optionalCwrap("AudioBuffer", "number", []),
    mixAudio: optionalCwrap("MixAudio", "number", ["number"]),
    setAudioMuted: optionalCwrap("SetAudioMuted", "number", ["number"]),
    getAudioStats: optionalCwrap("GetAudioStats", "string", [])
  };
}

async function mountFile(file) {
  await loadCore(coreUrl);

  if (!file) {
    throw new Error("No disc file was provided to the upstream worker");
  }

  const fs = moduleInstance.FS;
  const safeName = sanitizeDiscFileName(file.name);
  const path = `${WORKERFS_MOUNT_DIR}/${safeName}`;

  try {
    fs.mkdir(WORKERFS_MOUNT_DIR);
  } catch {
    // Mount point may already exist.
  }

  if (mounted) {
    fs.unmount(WORKERFS_MOUNT_DIR);
    mounted = false;
  }

  fs.mount(fs.filesystems.WORKERFS, { blobs: [{ name: safeName, data: file }] }, WORKERFS_MOUNT_DIR);
  mounted = true;

  const accepted = api.mountDisc(path);
  if (!accepted) {
    throw new Error("Upstream Dolphin DiscIO rejected the selected disc");
  }

  coreBoot = {
    attempted: false,
    accepted: false,
    path,
    skippedReason: ""
  };
  frameQueue = [];
  resetPresentationBuffer();
  lastCapturedCoreFrame = -1;
  lastPresentedCoreFrame = -1;
  lastPresentedAt = 0;
  presentedFrame = 0;

  if (api.bootDisc && file.size >= MIN_FULL_BOOT_BYTES) {
    coreBoot.attempted = true;
    coreBoot.accepted = Boolean(api.bootDisc(path));
    api.pumpHostJobs?.();
  } else if (api.bootDisc) {
    coreBoot.skippedReason = `Disc image is too small for full CPU boot (${file.size} bytes)`;
  }

  const metadata = metadataPayload();
  return {
    ...metadata,
    bootProbe: bootProbePayload(metadata),
    path,
    ...framePayload()
  };
}

function configurePresentationQueue(size) {
  const requested = Number(size);
  presentationQueueLimit = Number.isFinite(requested)
    ? Math.round(Math.min(MAX_PRESENTATION_QUEUE, Math.max(MIN_PRESENTATION_QUEUE, requested)))
    : DEFAULT_PRESENTATION_QUEUE;
  presentationQueueTarget = 1;
}

function resetPresentationBuffer() {
  pacedPresentationPrimed = false;
  pacedPresentationStartedAt = performance.now();
  presentationFps = 0;
  presentationRawFps = 0;
  presentationAverageIntervalMs = 0;
  presentationP95IntervalMs = 0;
  presentationMaxIntervalMs = 0;
  presentationLongFrameCount = 0;
  visualChangeFps = 0;
  visualFrameHash = 0;
  lastVisualFrameHash = 0;
  lastOglSwapCount = 0;
  oglGlError = 0;
  visualSampleSource = "none";
  visualChangesSincePresentationFps = 0;
  framesSincePresentationFps = 0;
  intervalSumSincePresentationFps = 0;
  intervalSamplesSincePresentationFps = [];
  maxIntervalSincePresentationFps = 0;
  longFramesSincePresentationFps = 0;
  lastPresentationFpsTime = performance.now();
  presentationUnderrunCount = 0;
  presentationDroppedFrameCount = 0;
  presentationUnderrunsSinceFps = 0;
  presentationDropsSinceFps = 0;
  presentationWindowUnderrunCount = 0;
  presentationWindowDropCount = 0;
}

function metadataPayload() {
  const rootEntryCount = api?.getRootEntryCount() ?? -1;
  return {
    width: api?.frameWidth() ?? 320,
    height: api?.frameHeight() ?? 240,
    frame: api?.getFrame() ?? 0,
    gameId: api?.getGameId() ?? "",
    title: api?.getGameTitle() ?? "",
    makerId: api?.getMakerId() ?? "",
    platform: api?.getPlatform() ?? "",
    region: api?.getRegion() ?? "",
    discNumber: api?.getDiscNumber() ?? -1,
    apploaderDate: api?.getApploaderDate() ?? "",
    apploaderSize: api?.getApploaderSize() ?? -1,
    bootDolOffset: api?.getBootDolOffset() ?? -1,
    bootDolSize: api?.getBootDolSize() ?? -1,
    fstOffset: api?.getFstOffset() ?? -1,
    fstSize: api?.getFstSize() ?? -1,
    rawSize: api?.getRawSize() ?? -1,
    dataSize: api?.getDataSize() ?? -1,
    rootEntryCount,
    rootEntries: readRootEntries(rootEntryCount),
    fullCore: Boolean(api?.bootDisc),
    coreBoot,
    coreState: api?.getCoreState?.() ?? -1,
    coreStateName: api?.getCoreStateName?.() ?? "",
    coreStatus: api?.getCoreStatus?.() ?? "",
    coreTitle: api?.getCoreTitle?.() ?? "",
    coreTicks: readCoreTicks(),
    coreTicksPerSecond: readCoreTicksPerSecond(),
    ppcPc: api?.getPpcPc?.() ?? 0,
    cpuCoreName: api?.getCpuCoreName?.() ?? "",
    ppcWasmBlockCompileCount: api?.getPpcWasmBlockCompileCount?.() ?? 0,
    ppcWasmBlockRunCount: api?.getPpcWasmBlockRunCount?.() ?? 0,
    ppcWasmHelperStats: joinedStats(
      api?.getPpcWasmHelperStats?.(),
      api?.getVideoStats?.(),
      api?.getPpcProfileStats?.()
    )
  };
}

function bootProbePayload(metadata) {
  const milestones = [];

  if (!api || !moduleInstance || !metadata.gameId) {
    return {
      attempted: false,
      status: "blocked",
      blocker: "No mounted disc",
      milestones
    };
  }

  milestones.push(`Disc mounted: ${metadata.gameId}`);

  if (metadata.bootDolOffset < 0 || metadata.bootDolSize < 0) {
    return {
      attempted: true,
      status: "blocked",
      blocker: "Boot DOL location is unavailable",
      milestones
    };
  }

  milestones.push(`Boot DOL located at ${formatHex(metadata.bootDolOffset)}`);

  try {
    const headerBytes = readDiscBytes(metadata.bootDolOffset, Math.min(0x100, metadata.bootDolSize));
    const dol = parseDolHeader(headerBytes);
    milestones.push(`Boot DOL entry parsed: ${formatHex(dol.entryPoint)}`);
    milestones.push(`${dol.loadSections.length} DOL load sections discovered`);

    if (metadata.fullCore) {
      milestones.push(`Dolphin core state: ${metadata.coreStateName || "unknown"}`);

      if (!coreBoot.attempted && coreBoot.skippedReason) {
        return {
          attempted: true,
          status: "blocked",
          blocker: coreBoot.skippedReason,
          milestones,
          dol,
          coreState: metadata.coreState,
          coreStateName: metadata.coreStateName,
          coreStatus: metadata.coreStatus,
          coreTitle: metadata.coreTitle
        };
      }

      return {
        attempted: true,
        status: coreBoot.accepted ? "boot-submitted" : "blocked",
        blocker: coreBoot.accepted
          ? "Dolphin core boot was submitted; waiting for rendered frames and controller input"
          : metadata.coreStatus || "Dolphin core rejected the boot request",
        milestones,
        dol,
        coreState: metadata.coreState,
        coreStateName: metadata.coreStateName,
        coreStatus: metadata.coreStatus,
        coreTitle: metadata.coreTitle
      };
    }

    return {
      attempted: true,
      status: "blocked",
      blocker: "PowerPC CPU, memory map, and scheduler are not integrated yet",
      milestones,
      dol
    };
  } catch (error) {
    return {
      attempted: true,
      status: "failed",
      blocker: error instanceof Error ? error.message : String(error),
      milestones
    };
  }
}

function readDiscBytes(offset, length) {
  const pointer = moduleInstance._malloc(length);

  if (!pointer) {
    throw new Error("Unable to allocate DOL read buffer");
  }

  try {
    const read = api.readDisc(offset, length, pointer);
    if (read <= 0) {
      throw new Error("Unable to read boot DOL bytes");
    }

    return moduleInstance.HEAPU8.slice(pointer, pointer + read);
  } finally {
    moduleInstance._free(pointer);
  }
}

function readRootEntries(rootEntryCount) {
  if (!api || rootEntryCount <= 0) {
    return [];
  }

  const limit = Math.min(rootEntryCount, 256);
  const entries = [];

  for (let index = 0; index < limit; index += 1) {
    entries.push({
      name: api.getRootEntryName(index),
      path: api.getRootEntryPath(index),
      directory: Boolean(api.getRootEntryIsDirectory(index)),
      offset: api.getRootEntryOffset(index),
      size: api.getRootEntrySize(index)
    });
  }

  return entries;
}

function framePayload() {
  if (!moduleInstance || !api) {
    return { frameBuffer: null };
  }

  maybeEnablePpcWasmJit();
  const jitState = !ppcWasmJitRequested
    ? "off"
    : ppcWasmJitDisabledForSession
      ? "disabled"
      : ppcWasmJitActive
        ? "on"
        : "warmup";

  const width = api.frameWidth();
  const height = api.frameHeight();
  const pointer = api.frameBuffer();
  const length = width * height * 4;
  const ppcWasmHelperStats = api.getPpcWasmHelperStats?.();
  const ppcProfileStats = api.getPpcProfileStats?.();
  const videoStats = api.getVideoStats?.();
  if (renderBackend === "ogl") {
    // The videoStats `hash:` field is computed in DolphinWeb_OnXfb /
    // DolphinWeb_OnGlBackbuffer, not in DolphinWeb_OnOglSwap. For the OGL
    // path, OnXfb is bypassed (the GL backend draws straight to the canvas)
    // so the hash field is frozen on a stale snapshot from before OGL took
    // over. The OGL swap count, however, increments once per
    // DolphinWeb_OnOglSwap and is the only authoritative measure of frames
    // actually committed to the WebGL canvas. Prefer real pixel-readback
    // when available, otherwise count OGL swaps explicitly.
    const oglStats = parseOglSwapStats(videoStats);
    if (oglStats.readbackRgba) {
      recordVisualFrameHash(oglStats.readbackRgba);
      visualSampleSource = "ogl-readback";
    } else if (oglStats.swap > 0) {
      recordOglSwapDelta(oglStats.swap);
      visualSampleSource = "ogl-swap";
    } else {
      recordVisualFrameHash(parseVideoFrameHash(videoStats));
      visualSampleSource = "xfb-hash";
    }
    oglGlError = oglStats.glError;
  } else {
    visualSampleSource = "xfb-hash";
  }
  let frameBuffer = null;
  let transfer = [];

  if ((renderContext || renderGpu || renderGl) && !presentationLoopActive) {
    presentFrame(width, height, pointer, length);
  } else if (!workerOwnsCanvas) {
    const frameBytes = moduleInstance.HEAPU8.slice(pointer, pointer + length);
    frameBuffer = frameBytes.buffer;
    transfer = [frameBytes.buffer];
  }

  return {
    width,
    height,
    frame: api.getFrame(),
    coreTicks: readCoreTicks(),
    coreTicksPerSecond: readCoreTicksPerSecond(),
    ppcPc: api.getPpcPc?.() ?? 0,
    cpuCoreName: api.getCpuCoreName?.() ?? "",
    ppcWasmBlockCompileCount: api.getPpcWasmBlockCompileCount?.() ?? 0,
    ppcWasmBlockRunCount: api.getPpcWasmBlockRunCount?.() ?? 0,
    ppcWasmHelperStats: joinedStats(
      ppcWasmHelperStats,
      videoStats,
      ppcProfileStats,
      `jit:${jitState} warm:${ppcWasmJitWarmupFrames} present ${renderBackend} signal:${frameSignalHeap ? "wait" : "poll"} mode:${presentationPacingMode} fps:${presentationFps} raw:${presentationRawFps} loop:${presentationLoopFps} gap:${presentationP95IntervalMs}/${presentationMaxIntervalMs}ms long:${presentationLongFrameCount} queue:${frameQueue.length}/${presentationQueueLimit} underrun:${presentationWindowUnderrunCount} drop:${presentationWindowDropCount} frames:${presentedFrame} visualfps:${visualChangeFps} visualsrc:${visualSampleSource} wd:${watchdogRecoveryCount}/${watchdogFireCount}` +
      // §28v: extra on-screen telemetry for the user's screenshots —
      // JIT cache size/new-compiles (compile-burst visibility) +
      // WebGPU executor draw/miss/skip counters (render-health: is
      // geometry flowing into the EFB, are pipes/bind-groups missing,
      // are draws being poison-guard-skipped).
      ` jitc:${dolphinJitCacheMap.size}/${dolphinJitNewCompileCount}` +
      ` wgx:d${webGpuExecStats.drawIdx}/mp${webGpuExecStats.missPipe}` +
      `/mb${webGpuExecStats.missBg}/sk${webGpuExecStats.skipDraw}`
    ),
    frameProfileStats,
    presentedFrame,
    presentationFps,
    presentationRawFps,
    presentationAverageIntervalMs,
    presentationP95IntervalMs,
    presentationMaxIntervalMs,
    presentationLongFrameCount,
    // Lifetime smoothness fields (never reset). presentationMaxIntervalMs
    // above resets every 500 ms window; presentationLifetimeMaxIntervalMs
    // here is the worst single gap across the whole run.
    presentationLifetimeMaxIntervalMs,
    presentationLifetimeMaxIntervalAtMs,
    presentationLifetimeDropCount,
    presentationLifetimeFrameCount,
    presentationIntervalStddevMs:
      presentationIntervalCount > 1
        ? Math.sqrt(presentationIntervalM2 / (presentationIntervalCount - 1))
        : 0,
    presentationIntervalHistogram: Array.from(presentationIntervalHistogram),
    presentationIntervalHistogramBuckets: PRESENTATION_HISTOGRAM_BUCKETS_MS,
    visualChangeFps,
    visualFrameHash,
    visualSampleSource,
    oglGlError,
    frameBuffer,
    transfer
  };
}

function startPresentationLoop() {
  if (!workerOwnsCanvas || presentationLoopActive) {
    return;
  }

  presentationLoopActive = true;
  lastPresentationFpsTime = performance.now();
  configureFrameSignalWait();
  if (!frameSignalHeap && typeof MessageChannel === "function") {
    presentationChannel = new MessageChannel();
    presentationChannel.port1.onmessage = () => runPresentationLoop();
  }
  schedulePresentationLoop();
}

function schedulePresentationLoop() {
  if (!presentationLoopActive) {
    return;
  }

  if (coreBoot.accepted && renderBackend === "ogl" && frameSignalHeap) {
    // OGL fires DolphinWeb_OnOglSwap on every GL swap, which calls
    // PublishFrameSignal. Use Atomics.waitAsync on the same frame signal as
    // the software path: it is exempt from Chrome's worker setTimeout
    // throttling (IntensiveWakeUpThrottling clamps occluded-tab worker
    // timers to a 1s minimum, starving pumpHostJobs and freezing the core).
    // Lane W traced this as the root cause of "stuck at cutscene" reports
    // in real Chrome. The Playwright probe never reproduced because headless
    // has no occlusion-detected window.
    scheduleFrameSignalWait();
  } else if (coreBoot.accepted && renderBackend === "ogl") {
    scheduleOglPresentationPoll();
  } else if (coreBoot.accepted && frameSignalHeap) {
    if (presentationPacingMode !== "direct") {
      startPacedPresentation();
    }
    scheduleFrameSignalWait();
  } else if (presentationChannel) {
    presentationChannel.port2.postMessage(0);
  } else {
    setTimeout(() => runPresentationLoop(), 0);
  }
}

function scheduleOglPresentationPoll() {
  setTimeout(() => runPresentationLoop(), PACED_PRESENTATION_INTERVAL_MS);
}

function configureFrameSignalWait() {
  const signalPointer = api?.getFrameSignalPtr?.() ?? 0;
  const heap32 = moduleInstance?.HEAP32 ?? new Int32Array(moduleInstance?.HEAPU8?.buffer ?? new ArrayBuffer(0));
  if (
    signalPointer > 0 &&
    heap32?.buffer instanceof SharedArrayBuffer &&
    typeof Atomics?.waitAsync === "function"
  ) {
    frameSignalHeap = heap32;
    frameSignalIndex = signalPointer >> 2;
    frameSignalValue = Atomics.load(frameSignalHeap, frameSignalIndex);
  }
}

function scheduleFrameSignalWait() {
  if (!presentationLoopActive || frameSignalWaitPending || !frameSignalHeap || frameSignalIndex < 0) {
    return;
  }

  const currentSignal = Atomics.load(frameSignalHeap, frameSignalIndex);
  if (currentSignal !== frameSignalValue) {
    frameSignalValue = currentSignal;
    queueMicrotask(() => runPresentationLoop());
    return;
  }

  // 16ms timeout = ~60Hz fallback wake rate when the OGL render thread is
  // not bumping the frame signal. Earlier 8ms made the worker thread
  // compete with the EmuThread (cpu=dual mode) for CPU, regressing gameplay.
  // 50ms was too slow when the signal stalled; 16ms is the middle ground:
  // matches VI vsync rate so we never wait longer than one frame's worth.
  const wait = Atomics.waitAsync(frameSignalHeap, frameSignalIndex, currentSignal, 16);
  if (!wait.async) {
    setTimeout(() => runPresentationLoop(), 0);
    return;
  }

  frameSignalWaitPending = true;
  const waitStartedAt = performance.now();
  wait.value
    .catch(() => "error")
    .then(() => {
      frameSignalWaitPending = false;
      // Diagnostic: if signal wait took >200ms, the OGL pthread is stalled
      // (likely glReadPixels syncing on a deep GPU queue — texture loads on
      // scene transitions like character-select are the prime suspect).
      // discio's loop itself is fast; the long gap shows up as a paint-rate
      // stall because the signal that triggers the next paint doesn't tick.
      const waitMs = performance.now() - waitStartedAt;
      if (waitMs > 200) {
        signalStallCount += 1;
        const isNewWorst = waitMs > worstSignalWaitMs;
        if (isNewWorst || signalStallCount % 5 === 0) {
          if (isNewWorst) worstSignalWaitMs = waitMs;
          // eslint-disable-next-line no-console
          console.log(
            `[signal-stall#${signalStallCount}${isNewWorst ? "*" : ""}] ` +
            `waitMs=${waitMs.toFixed(0)} renderBackend=${renderBackend}`
          );
        }
      }
      if (!presentationLoopActive) {
        return;
      }
      frameSignalValue = Atomics.load(frameSignalHeap, frameSignalIndex);
      runPresentationLoop();
    });
}

function pollInputStateFromSab() {
  if (!inputStateSabView || !api?.setInputState) {
    return;
  }
  const generation = Atomics.load(inputStateSabView, 9);
  if (generation === lastInputStateGeneration) {
    return;
  }
  lastInputStateGeneration = generation;
  const mask = Atomics.load(inputStateSabView, 0) >>> 0;
  inputMask = mask;
  api.setInputState({
    mask,
    stickX: Atomics.load(inputStateSabView, 1),
    stickY: Atomics.load(inputStateSabView, 2),
    cStickX: Atomics.load(inputStateSabView, 3),
    cStickY: Atomics.load(inputStateSabView, 4),
    triggerLeft: Atomics.load(inputStateSabView, 5),
    triggerRight: Atomics.load(inputStateSabView, 6),
    analogA: Atomics.load(inputStateSabView, 7),
    analogB: Atomics.load(inputStateSabView, 8)
  });
}

function runPresentationLoop() {
  const stages = {};
  try {
    loopsSincePresentationFps += 1;
    if (moduleInstance && api) {
      pollInputStateFromSab();
      // Day-27: drain the cross-thread WebGPU command ring and replay
      // on renderGpu.device. No-op until the video pthread hands the
      // ring over (handleWebGpuCmdRing) and only matters for
      // ?video=wgpu. Cheap when empty (one atomic load).
      drainWebGpuCmdRing();
      const now = performance.now();
      const loopStartedAt = performance.now();
      // Pump host jobs every loop iteration. The previous 100ms rate-limit
      // capped pumpHostJobs at 10Hz post-boot, which starves CoreTiming when
      // the worker's loop is running fine but pumpHostJobs is the bottleneck
      // for game-clock progress. Pumping on every iteration (~60Hz when
      // healthy) lets the core advance even under Chrome's worker timer
      // throttling.
      const pumpStartedAt = performance.now();
      api.pumpHostJobs?.();
      stages.pump = performance.now() - pumpStartedAt;
      addProfileTime("pump", stages.pump);
      lastHostPumpTime = now;
      if (!coreBoot.accepted) {
        const runStartedAt = performance.now();
        api.runFrame?.();
        stages.run = performance.now() - runStartedAt;
        addProfileTime("run", stages.run);
      }

      const apiStartedAt = performance.now();
      const width = api.frameWidth();
      const height = api.frameHeight();
      const pointer = api.frameBuffer();
      const coreFrame = api.getFrame?.() ?? 0;
      stages.api = performance.now() - apiStartedAt;
      addProfileTime("api", stages.api);
      maybeEnablePpcWasmJit(coreFrame);
      const presentStartedAt = performance.now();
      if (cmdRingOwnsCanvas) {
        // The WebGPU hardware renderer presents the canvas itself via
        // the cmd-ring executor; skip the legacy CPU-framebuffer blit
        // (post-cutover that buffer is stale — it was overwriting the
        // real GPU frame every iteration).
      } else if (coreBoot.accepted && frameSignalHeap && renderBackend === "ogl") {
        // OGL bypasses XFB, so api.getFrame() doesn't increment per visible frame.
        // Use the OGL swap count (incremented in DolphinWeb_OnOglSwap) as the
        // present-deduplication key so each new GL swap registers as a new frame.
        const oglSwap = parseOglSwapStats(api.getVideoStats?.()).swap >>> 0;
        const oglFrameKey = oglSwap > 0 ? oglSwap : coreFrame;
        // Detached OGL bitmap capture now happens C++-side from the GPU
        // pthread (Emscripten.cpp Swap() does transferToImageBitmap +
        // self.postMessage), and the discio worker forwards via
        // handleDetachedOglFrame attached per-pthread in
        // installDolphinJitCacheChannel. The discio worker can't
        // transferToImageBitmap on detachedOglCanvas because Emscripten
        // transferred it to the GPU pthread — that's what Day-3 hit and
        // why we couldn't make worker-mode painting work then.
        presentFrame(width, height, pointer, width * height * 4, oglFrameKey);
      } else if (coreBoot.accepted && frameSignalHeap && presentationPacingMode === "direct") {
        presentFrame(width, height, pointer, width * height * 4, coreFrame);
      } else if (coreBoot.accepted && frameSignalHeap) {
        captureFrameForPacedPresentation(width, height, pointer, width * height * 4, coreFrame);
      } else if (coreFrame !== lastPresentedCoreFrame) {
        presentFrame(width, height, pointer, width * height * 4, coreFrame);
      }
      stages.present = performance.now() - presentStartedAt;
      updatePresentationFps();
      maybeDisablePpcWasmJit(coreFrame);
      const loopMs = performance.now() - loopStartedAt;
      stages.loop = loopMs;
      addProfileTime("loop", loopMs);
      // Stall logger: when a single loop iteration exceeds 100 ms, log a
      // per-stage breakdown. We always log the worst sample so far, and
      // additionally every 5th stall after that, so a sustained slow patch
      // surfaces in the console without overwhelming it.
      if (loopMs > 100) {
        stallCount += 1;
        const isNewWorst = loopMs > worstLoopMsLogged;
        if (isNewWorst || stallCount % 5 === 0) {
          if (isNewWorst) worstLoopMsLogged = loopMs;
          // eslint-disable-next-line no-console
          console.log(
            `[stall#${stallCount}${isNewWorst ? "*" : ""}] loop=${loopMs.toFixed(0)}ms ` +
            `pump=${(stages.pump ?? 0).toFixed(0)} ` +
            `api=${(stages.api ?? 0).toFixed(0)} ` +
            `present=${(stages.present ?? 0).toFixed(0)} ` +
            `coreFrame=${coreFrame} renderBackend=${renderBackend}`
          );
        }
      }
    }
  } catch (error) {
    postStatus(error instanceof Error ? error.message : String(error));
  } finally {
    schedulePresentationLoop();
  }
}

function maybeEnablePpcWasmJit(coreFrame = api?.getFrame?.() ?? 0) {
  if (
    !ppcWasmJitRequested ||
    ppcWasmJitActive ||
    ppcWasmJitDisabledForSession ||
    !api?.setPpcWasmJitEnabled
  ) {
    return;
  }

  // Warm-cache fast path. When Day-9 fingerprint matched and Day-7 loaded
  // enough cached modules to cover the initial compile burst, skip the
  // long warmup gate — there's no stability concern because the JIT
  // doesn't have to actually compile anything; it just instantiates from
  // cache. The MINIMUM_PRE_JIT_FRAMES floor is still respected so the
  // emulator gets through the first few video frames stably before we
  // change its compilation behavior.
  const MINIMUM_PRE_JIT_FRAMES = 30;
  const effectiveWarmup =
    dolphinJitCachePreWarmed && coreFrame >= MINIMUM_PRE_JIT_FRAMES
      ? MINIMUM_PRE_JIT_FRAMES
      : ppcWasmJitWarmupFrames;
  if ((coreFrame >>> 0) < effectiveWarmup) {
    return;
  }

  if ((coreFrame >>> 0) < ppcWasmJitCooldownUntilFrame) {
    return;
  }

  // Engage after warmup regardless of momentary presentation rate. Single-
  // window samples drop to 0 during multi-second core stalls and would
  // indefinitely block engage even when long-term throughput is healthy. The
  // post-engage guard (maybeDisablePpcWasmJit, ACTIVE_* thresholds) handles
  // catastrophic regression.

  // Day-21: snapshot the pre-engage presentation rate. The disable
  // guard judges the JIT by *regression vs this baseline*, not an
  // absolute fps floor. A heavy renderer (fastsw=0 full-res CPU
  // raster) caps present fps far below the old absolute threshold;
  // the JIT still speeds up PPC emulation in that regime, so fusing
  // it off there was strictly counterproductive (and flapped every
  // cooldown). Record the baseline so we only fuse when the JIT
  // itself made presentation worse.
  ppcWasmJitPreEngageFps = presentationFps;

  console.log(`[s28-jittier] ENGAGE: setPpcWasmJitEnabled(${ppcWasmJitTier === "mixed" ? 2 : 1}) ` +
    `(ppcWasmJitTier=${ppcWasmJitTier}) @frame ${coreFrame}`);
  api.setPpcWasmJitEnabled(ppcWasmJitTier === "mixed" ? 2 : 1);
  ppcWasmJitActive = true;
  ppcWasmJitEnabledAtFrame = coreFrame >>> 0;
  // §28s: re-arm the core-liveness tracker on every (re)engage so a
  // pre-cooldown (frame,time) pair can't compute a bogus low coreFps
  // across the cooldown gap on the first post-re-engage fuse check.
  ppcWasmJitFuseLastFrame = -1;
  const reason = dolphinJitCachePreWarmed && effectiveWarmup === MINIMUM_PRE_JIT_FRAMES
    ? `pre-warmed cache hit, JIT engaged at frame ${coreFrame}`
    : `JIT enabled after ${coreFrame} stable video frames`;
  postStatus(`Experimental WASM ${reason}`);
}

function maybeDisablePpcWasmJit(coreFrame = api?.getFrame?.() ?? 0) {
  if (!ppcWasmJitActive || ppcWasmJitForce || !api?.setPpcWasmJitEnabled) {
    return;
  }

  const framesSinceActivation = (coreFrame >>> 0) - ppcWasmJitEnabledAtFrame;

  // Detect multi-second post-activation stalls even during the grace period.
  // A stall exceeding WASM_JIT_POST_ACTIVATION_STALL_THRESHOLD_MS (5s) means the
  // compile burst blocked presentation long enough to produce a visible freeze.
  if (presentationMaxIntervalMs > WASM_JIT_POST_ACTIVATION_STALL_THRESHOLD_MS) {
    api.setPpcWasmJitEnabled(0);
    ppcWasmJitActive = false;
    ppcWasmJitDisabledForSession = true;
    postStatus(
      `Experimental WASM JIT disabled after post-activation stall ` +
        `(max_interval:${presentationMaxIntervalMs}ms at frame ${coreFrame})`
    );
    return;
  }

  if (framesSinceActivation < WASM_JIT_MIN_ACTIVE_FRAMES_BEFORE_FUSE) {
    return;
  }

  // Day-21: judge the JIT by regression vs the pre-engage baseline,
  // not an absolute fps floor. The absolute floor (fps>=25, gap<=40ms)
  // assumed a GPU-class renderer; with the CPU software rasteriser
  // (especially fastsw=0 full-res) present fps is renderer-capped well
  // below that even though the JIT is *helping* PPC throughput. The
  // old logic disabled the JIT every cooldown, making emulation slower
  // for no benefit — exactly the "feels slower" the user hit.
  //
  // Keep the JIT unless presentation dropped materially below where it
  // was right before the JIT engaged (a regression the JIT caused),
  // OR it's catastrophically slow in absolute terms (sub-floor — a
  // genuine freeze, not just a heavy renderer). The 5s post-activation
  // stall check above already handles compile-burst freezes.
  const baseline = ppcWasmJitPreEngageFps;
  const regressed =
    baseline >= WASM_JIT_REGRESSION_MIN_BASELINE_FPS &&
    presentationFps < baseline * WASM_JIT_REGRESSION_FRACTION;

  // §28s: "catastrophic" = the JIT genuinely FROZE emulation, judged
  // by the core frame counter vs wall-clock — NOT presentationFps
  // (structurally ~0 in the WebGPU presenter, which made the old
  // floor fire every window at a healthy 60 coreFps and thrash the
  // JIT, collapsing the intro cutscene into a black flash). Only
  // trip when ≥1.5 s of wall time elapsed AND effective core fps is
  // sub-floor (a true freeze; healthy ≈ 60).
  const nowMs = (typeof performance !== "undefined" ? performance.now()
                 : Date.now());
  const cf = coreFrame >>> 0;
  let catastrophic = false;
  if (ppcWasmJitFuseLastFrame >= 0) {
    const dtMs = nowMs - ppcWasmJitFuseLastTime;
    if (dtMs >= 1500) {
      const dFrames = (cf - ppcWasmJitFuseLastFrame) >>> 0;
      const coreFps = (dFrames * 1000) / dtMs;
      catastrophic = coreFps < WASM_JIT_ABSOLUTE_FLOOR_FPS;
      ppcWasmJitFuseLastFrame = cf;
      ppcWasmJitFuseLastTime = nowMs;
    }
  } else {
    ppcWasmJitFuseLastFrame = cf;
    ppcWasmJitFuseLastTime = nowMs;
  }

  if (!regressed && !catastrophic) {
    return;
  }

  api.setPpcWasmJitEnabled(0);
  ppcWasmJitActive = false;
  // Cooldown rather than permanent disable: degraded presentation often
  // recovers (post-cutscene transition, post-shader-compile spike). After the
  // cooldown frames pass the engage check can re-fire.
  ppcWasmJitCooldownUntilFrame = (coreFrame >>> 0) + WASM_JIT_DEGRADED_COOLDOWN_FRAMES;
  postStatus(
    `Experimental WASM JIT temporarily off ` +
      `(fps:${presentationFps} baseline:${baseline} ` +
      `${catastrophic ? "catastrophic" : "regressed"}; cooldown ` +
      `${WASM_JIT_DEGRADED_COOLDOWN_FRAMES} frames)`
  );
}

function normalizePpcWasmJitWarmupFrames(value) {
  const requested = Number(value);
  if (!Number.isFinite(requested)) {
    return DEFAULT_WASM_JIT_WARMUP_XFB_FRAMES;
  }
  return Math.round(Math.min(60000, Math.max(0, requested)));
}

function parseVideoFrameHash(videoStats) {
  const match = String(videoStats || "").match(/\shash:([0-9a-f]+)/i);
  if (!match) {
    return 0;
  }

  const parsed = Number.parseInt(match[1], 16);
  return Number.isFinite(parsed) ? parsed >>> 0 : 0;
}

function parseOglSwapStats(videoStats) {
  const text = String(videoStats || "");
  const swap = Number.parseInt(/\bogl_swap:(\d+)/i.exec(text)?.[1] || "", 10);
  const size = /\bbb:(\d+)x(\d+)/i.exec(text);
  const readbackRgba = Number.parseInt(/\brb:0x([0-9a-f]+)/i.exec(text)?.[1] || "", 16);
  // glerr is captured by GLContextEmscripten::Swap() right before
  // emscripten_webgl_commit_frame(). It surfaces any GL error left pending in
  // the queue at swap time; on the OGL path the error originates inside the
  // upstream Dolphin OGL backend's draw pipeline (not our presenter glue), so
  // 0x502 (GL_INVALID_OPERATION) is reported but not auto-cleared here.
  const glError = Number.parseInt(/\bglerr:0x([0-9a-f]+)/i.exec(text)?.[1] || "", 16);

  return {
    swap: Number.isFinite(swap) ? swap >>> 0 : 0,
    width: size ? Math.max(0, Number.parseInt(size[1], 10) || 0) : 0,
    height: size ? Math.max(0, Number.parseInt(size[2], 10) || 0) : 0,
    readbackRgba: Number.isFinite(readbackRgba) ? readbackRgba >>> 0 : 0,
    glError: Number.isFinite(glError) ? glError >>> 0 : 0
  };
}

function recordOglSwapDelta(swapCount) {
  const current = swapCount >>> 0;
  if (!current) {
    return;
  }

  if (lastOglSwapCount > 0 && current > lastOglSwapCount) {
    visualChangesSincePresentationFps += current - lastOglSwapCount;
  }
  visualFrameHash = current;
  lastVisualFrameHash = current;
  lastOglSwapCount = current;
}

function captureFrameForPacedPresentation(width, height, pointer, length, coreFrame) {
  const captureStartedAt = performance.now();
  if (coreFrame === lastCapturedCoreFrame || width <= 0 || height <= 0 || pointer <= 0 || length <= 0) {
    return;
  }

  while (frameQueue.length >= presentationQueueLimit) {
    frameQueue.shift();
    presentationDroppedFrameCount += 1;
    presentationDropsSinceFps += 1;
  }

  const copyStartedAt = performance.now();
  const bytes = moduleInstance.HEAPU8.slice(pointer, pointer + length);
  addProfileTime("copy", performance.now() - copyStartedAt);
  addProfileBytes(length);

  frameQueue.push({
    bytes,
    coreFrame,
    height,
    width
  });
  lastCapturedCoreFrame = coreFrame;
  addProfileTime("capture", performance.now() - captureStartedAt);
}

function startPacedPresentation() {
  if (pacedPresentationActive) {
    return;
  }

  pacedPresentationActive = true;
  pacedPresentationStartedAt = performance.now();
  nextPacedPresentationTime = performance.now();
  schedulePacedPresentation();
}

function schedulePacedPresentation() {
  if (!pacedPresentationActive) {
    return;
  }

  const delay = Math.max(0, nextPacedPresentationTime - performance.now());
  pacedPresentationTimer = setTimeout(() => {
    pacedPresentationTimer = 0;
    runPacedPresentation();
  }, delay);
}

function runPacedPresentation(timestamp = performance.now()) {
  const pacedStartedAt = performance.now();
  try {
    const now = timestamp;
    if (!pacedPresentationPrimed) {
      if (frameQueue.length < presentationQueueTarget) {
        presentationUnderrunCount += 1;
        presentationUnderrunsSinceFps += 1;
        return;
      }
      pacedPresentationPrimed = true;
    }

    const queued = frameQueue.shift();
    if (queued) {
      presentFrameBytes(queued.width, queued.height, queued.bytes, queued.coreFrame);
    } else {
      presentationUnderrunCount += 1;
      presentationUnderrunsSinceFps += 1;
    }
  } catch (error) {
    postStatus(error instanceof Error ? error.message : String(error));
  } finally {
    const now = timestamp || performance.now();
    do {
      nextPacedPresentationTime += PACED_PRESENTATION_INTERVAL_MS;
    } while (nextPacedPresentationTime < now - PACED_PRESENTATION_INTERVAL_MS);
    schedulePacedPresentation();
    addProfileTime("paced", performance.now() - pacedStartedAt);
  }
}

function presentFrame(width, height, pointer, length, coreFrame = api?.getFrame?.() ?? 0) {
  const presentStartedAt = performance.now();
  if (coreFrame === lastPresentedCoreFrame) {
    updatePresentationFps();
    return;
  }

  const frameView =
    moduleInstance && pointer > 0 && length > 0
      ? new Uint8Array(moduleInstance.HEAPU8.buffer, pointer, length)
      : null;

  const drawStartedAt = performance.now();
  if (renderGpu) {
    drawFrameToWebGpu(width, height, pointer, length);
  } else if (renderGl) {
    drawFrameToWebGl(width, height, pointer, length);
  } else if (renderContext) {
    drawFrameToCanvas(width, height, pointer, length);
  }
  // SAB pixel transport: copy s_framebuffer bytes into the shared pixel
  // buffer and bump the generation counter atomically. Main thread reads
  // the counter on RAF and putImageDatas the SAB contents onto the visible
  // canvas. The drawFrame* path above is a no-op in SAB mode (no presenter
  // was set up), so this IS the visible-paint pipeline for OGL+SAB.
  if (frameView && oglPixelSabView && oglMetaSabView) {
    publishOglSabFrame(width, height, frameView);
  }
  addProfileTime("draw", performance.now() - drawStartedAt);

  const hashStartedAt = performance.now();
  recordVisualFrameHash(hashFrameBytes(frameView));
  addProfileTime("hash", performance.now() - hashStartedAt);
  recordPresentedFrame(coreFrame);
  addProfileTime("present", performance.now() - presentStartedAt);
}

let oglSabLastPublishMs = 0;
// Throttle on SAB writes. Each OGL swap fires the frame signal twice
// (OnGlBackbuffer + OnOglSwap, ~1 ms apart) and ogl_swap_count's relaxed
// memory ordering means the worker reads it racily — sometimes both wakes
// see the same count, sometimes adjacent counts. 14 ms catches the paired
// wakes reliably but caps SAB write-rate around 20 Hz. Lower values lift
// the write rate but trade gameSpeed (Day-10 measured 91% at 4 ms vs 100%
// at 14 ms — main-thread paint contention with worker's SAB reads).
const OGL_SAB_MIN_INTERVAL_MS = 14;

let oglSabWriteCount = 0;       // successful SAB writes (memcpy + gen bump)
let oglSabThrottleSkipCount = 0; // calls returned early by 14ms throttle
let oglSabLastReportMs = 0;
const OGL_SAB_REPORT_INTERVAL_MS = 5000;
function publishOglSabFrame(width, height, frameView) {
  // Throttle to ~60 Hz: without this cap, the worker drives glReadPixels
  // at 150-200 Hz (no presenter pacing in SAB mode), eating GPU pthread
  // time that the CPU emulation pthread could otherwise use. Empirically
  // dropped gameSpeed from 98 % to 67 %. Capping the publish rate keeps the
  // readback at human-visible cadence without saturating the pipeline.
  const now = performance.now();
  if (now - oglSabLastPublishMs < OGL_SAB_MIN_INTERVAL_MS) {
    oglSabThrottleSkipCount += 1;
    maybeReportOglSabRates(now);
    return;
  }
  oglSabLastPublishMs = now;

  // SAB allocation in core-host.js is sized to match this readback output
  // exactly (presentationScale × 320 × 240). On the rare path where sizes
  // diverge (e.g. presentation-scale change mid-run, currently not
  // supported), clip to the smaller buffer so we don't OOB.
  const sabBytes = oglPixelSabView.length;
  const fbBytes = frameView.length;
  const copyBytes = fbBytes < sabBytes ? fbBytes : sabBytes;
  if (copyBytes === 0) return;
  if (copyBytes === sabBytes && copyBytes === fbBytes) {
    // Common path: same-size memcpy via TypedArray.set, which compiles to
    // a SIMD memmove on Chrome.
    oglPixelSabView.set(frameView);
  } else {
    oglPixelSabView.set(frameView.subarray(0, copyBytes));
    if (copyBytes < sabBytes) {
      oglPixelSabView.fill(0, copyBytes);
    }
  }
  // Bump the generation; main thread polls this with Atomics.load on RAF.
  Atomics.add(oglMetaSabView, 0, 1);
  oglSabWriteCount += 1;
  maybeReportOglSabRates(now);
}
function maybeReportOglSabRates(now) {
  if (oglSabLastReportMs === 0) {
    oglSabLastReportMs = now;
    return;
  }
  const elapsed = now - oglSabLastReportMs;
  if (elapsed < OGL_SAB_REPORT_INTERVAL_MS) return;
  const writes = oglSabWriteCount;
  const skips = oglSabThrottleSkipCount;
  const writesPerSec = ((writes * 1000) / elapsed).toFixed(1);
  const skipsPerSec = ((skips * 1000) / elapsed).toFixed(1);
  const genValue = oglMetaSabView ? Atomics.load(oglMetaSabView, 0) : 0;
  // eslint-disable-next-line no-console
  console.log(
    `[ogl-sab] writes/s=${writesPerSec} skips/s=${skipsPerSec} ` +
    `gen=${genValue} renderBackend=${renderBackend} window=${(elapsed / 1000).toFixed(1)}s`
  );
  oglSabWriteCount = 0;
  oglSabThrottleSkipCount = 0;
  oglSabLastReportMs = now;
}

function presentFrameBytes(width, height, bytes, coreFrame) {
  const presentStartedAt = performance.now();
  if (coreFrame === lastPresentedCoreFrame) {
    updatePresentationFps();
    return;
  }

  const drawStartedAt = performance.now();
  if (renderGpu) {
    drawFrameBytesToWebGpu(width, height, bytes);
  } else if (renderGl) {
    drawFrameBytesToWebGl(width, height, bytes);
  } else if (renderContext) {
    drawFrameBytesToCanvas(width, height, bytes);
  }
  addProfileTime("draw", performance.now() - drawStartedAt);

  const hashStartedAt = performance.now();
  recordVisualFrameHash(hashFrameBytes(bytes));
  addProfileTime("hash", performance.now() - hashStartedAt);
  recordPresentedFrame(coreFrame);
  addProfileTime("present", performance.now() - presentStartedAt);
}

function hashFrameBytes(bytes) {
  if (!bytes?.byteLength) {
    return 0;
  }

  let hash = 2166136261;
  for (let index = 0; index < bytes.byteLength; index += VISUAL_HASH_SAMPLE_STRIDE_BYTES) {
    hash ^= bytes[index];
    hash = Math.imul(hash, 16777619);
    hash ^= bytes[index + 1] ?? 0;
    hash = Math.imul(hash, 16777619);
    hash ^= bytes[index + 2] ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  hash ^= bytes.byteLength;
  return hash >>> 0;
}

function recordVisualFrameHash(hash) {
  if (!hash) {
    return;
  }

  visualFrameHash = hash >>> 0;
  if (lastVisualFrameHash && visualFrameHash !== lastVisualFrameHash) {
    visualChangesSincePresentationFps += 1;
  }
  lastVisualFrameHash = visualFrameHash;
}

function recordPresentedFrame(coreFrame) {
  presentedFrame += 1;
  framesSincePresentationFps += 1;
  presentationLifetimeFrameCount += 1;
  lastPresentedCoreFrame = coreFrame;
  const now = performance.now();
  if (lastPresentedAt > 0) {
    const interval = now - lastPresentedAt;
    intervalSumSincePresentationFps += interval;
    intervalSamplesSincePresentationFps.push(interval);
    maxIntervalSincePresentationFps = Math.max(maxIntervalSincePresentationFps, interval);
    if (interval > LONG_PRESENTATION_FRAME_MS) {
      longFramesSincePresentationFps += 1;
    }
    // Lifetime stats (never reset).
    if (interval > presentationLifetimeMaxIntervalMs) {
      presentationLifetimeMaxIntervalMs = interval;
      presentationLifetimeMaxIntervalAtMs = now;
    }
    // Welford online: numerically-stable streaming mean+variance.
    presentationIntervalCount += 1;
    const delta = interval - presentationIntervalMean;
    presentationIntervalMean += delta / presentationIntervalCount;
    const delta2 = interval - presentationIntervalMean;
    presentationIntervalM2 += delta * delta2;
    // Bucket the interval. Last bucket is the "200+ ms" catch-all.
    let bucket = PRESENTATION_HISTOGRAM_BUCKETS_MS.length;
    for (let i = 0; i < PRESENTATION_HISTOGRAM_BUCKETS_MS.length; i++) {
      if (interval < PRESENTATION_HISTOGRAM_BUCKETS_MS[i]) {
        bucket = i;
        break;
      }
    }
    presentationIntervalHistogram[bucket] += 1;
    // Anything past the 24 ms "long frame" threshold counts as a dropped
    // frame for end-of-run reporting. The 24 ms threshold matches
    // LONG_PRESENTATION_FRAME_MS and corresponds to >1 frame at 60 Hz
    // (16.67 ms target + 7 ms slack).
    if (interval > LONG_PRESENTATION_FRAME_MS) {
      presentationLifetimeDropCount += 1;
    }
  }
  lastPresentedAt = now;
  updatePresentationFps();
}

function updatePresentationFps() {
  const now = performance.now();
  if (now - lastPresentationFpsTime >= 500) {
    const profileElapsedMs = now - lastPresentationFpsTime;
    const rawFps = Math.round((framesSincePresentationFps * 1000) / profileElapsedMs);
    presentationRawFps = rawFps;
    presentationP95IntervalMs = roundedPercentile(intervalSamplesSincePresentationFps, 0.95);
    presentationFps =
      presentationP95IntervalMs > 0
        ? Math.min(rawFps, Math.round(1000 / presentationP95IntervalMs))
        : rawFps;
    presentationLoopFps = Math.round((loopsSincePresentationFps * 1000) / profileElapsedMs);
    presentationAverageIntervalMs =
      framesSincePresentationFps > 1
        ? Math.round((intervalSumSincePresentationFps / (framesSincePresentationFps - 1)) * 10) / 10
        : 0;
    presentationMaxIntervalMs = Math.round(maxIntervalSincePresentationFps * 10) / 10;
    presentationLongFrameCount = longFramesSincePresentationFps;
    presentationWindowUnderrunCount = presentationUnderrunsSinceFps;
    presentationWindowDropCount = presentationDropsSinceFps;
    visualChangeFps = Math.round((visualChangesSincePresentationFps * 1000) / profileElapsedMs);
    frameProfileStats = formatProfileWindow(profileElapsedMs);
    profileWindow = createProfileWindow();
    framesSincePresentationFps = 0;
    loopsSincePresentationFps = 0;
    visualChangesSincePresentationFps = 0;
    intervalSumSincePresentationFps = 0;
    intervalSamplesSincePresentationFps = [];
    maxIntervalSincePresentationFps = 0;
    longFramesSincePresentationFps = 0;
    presentationUnderrunsSinceFps = 0;
    presentationDropsSinceFps = 0;
    lastPresentationFpsTime = now;
    checkBootStallWatchdog();
  }
}

function checkBootStallWatchdog() {
  if (!coreBoot.accepted || !api) {
    watchdogLastCoreTicks = -1;
    watchdogStallCount = 0;
    return;
  }
  const coreFrame = api.getFrame?.() ?? 0;
  // Skip watchdog during JIT post-activation grace - JIT compile bursts
  // legitimately freeze the CPU briefly.
  if (
    ppcWasmJitActive &&
    (coreFrame >>> 0) - ppcWasmJitEnabledAtFrame < WASM_JIT_POST_ACTIVATION_GRACE_FRAMES
  ) {
    watchdogStallCount = 0;
    return;
  }

  const currentTicks = readCoreTicks();
  // Strict equality - only fire on a true freeze (no tick progress at all).
  // Earlier "slow but advancing" threshold caused the watchdog to fire
  // continuously during legitimate slow scenes (boot loading, complex
  // cutscenes), and each recovery step (force-pump, re-schedule) ate CPU
  // that the EmuThread needed to make progress, creating a feedback loop.
  if (currentTicks === watchdogLastCoreTicks && currentTicks > 0) {
    watchdogStallCount += 1;
  } else {
    watchdogStallCount = 0;
  }
  watchdogLastCoreTicks = currentTicks;

  if (watchdogStallCount < WATCHDOG_STALL_THRESHOLD) return;

  const step = watchdogStallCount - WATCHDOG_STALL_THRESHOLD;
  watchdogRecoveryCount += 1;
  if (step === 0 && frameSignalHeap && frameSignalIndex >= 0) {
    Atomics.store(frameSignalHeap, frameSignalIndex, (coreFrame >>> 0) + 1);
    Atomics.notify(frameSignalHeap, frameSignalIndex);
  } else if (step === 1) {
    lastHostPumpTime = 0;
    api.pumpHostJobs?.();
  } else if (step === 2) {
    schedulePresentationLoop();
  } else if (step === 3) {
    watchdogFireCount += 1;
    postStatus("Boot stall detected: core not advancing. Try reloading.");
  }
}

function roundedPercentile(samples, percentile) {
  if (!samples.length) {
    return 0;
  }

  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * percentile) - 1));
  return Math.round(sorted[index] * 10) / 10;
}

function createProfileWindow() {
  return {
    apiCount: 0,
    apiMs: 0,
    captureCount: 0,
    captureMs: 0,
    copyBytes: 0,
    copyCount: 0,
    copyMs: 0,
    drawCount: 0,
    drawMs: 0,
    hashCount: 0,
    hashMs: 0,
    loopCount: 0,
    loopMs: 0,
    pacedCount: 0,
    pacedMs: 0,
    presentCount: 0,
    presentMs: 0,
    pumpCount: 0,
    pumpMs: 0,
    runCount: 0,
    runMs: 0
  };
}

function addProfileTime(name, elapsedMs) {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    return;
  }

  const msKey = `${name}Ms`;
  const countKey = `${name}Count`;
  if (!(msKey in profileWindow) || !(countKey in profileWindow)) {
    return;
  }

  profileWindow[msKey] += elapsedMs;
  profileWindow[countKey] += 1;
}

function addProfileBytes(byteLength) {
  if (Number.isFinite(byteLength) && byteLength > 0) {
    profileWindow.copyBytes += byteLength;
  }
}

function formatProfileWindow(elapsedMs) {
  const avg = (name) => {
    const total = profileWindow[`${name}Ms`] || 0;
    const count = profileWindow[`${name}Count`] || 0;
    if (!count) {
      return "0";
    }
    const value = total / count;
    return value >= 10 ? value.toFixed(1) : value.toFixed(2);
  };
  const copiedMbPerSecond =
    elapsedMs > 0 ? (profileWindow.copyBytes / 1048576 / (elapsedMs / 1000)).toFixed(1) : "0.0";

  return (
    `loop:${avg("loop")} pump:${avg("pump")} run:${avg("run")} api:${avg("api")} ` +
    `cap:${avg("capture")} copy:${avg("copy")} present:${avg("present")} ` +
    `draw:${avg("draw")} hash:${avg("hash")} paced:${avg("paced")} ` +
    `copy:${copiedMbPerSecond}MB/s cap:${profileWindow.captureCount} shown:${profileWindow.presentCount}`
  );
}

async function setupSoftwarePresenter(canvas, presenterBackend) {
  renderCanvas = canvas;
  renderContext = null;
  renderGpu = null;
  renderGl = null;
  renderGlState = null;
  renderImageData = null;
  renderUploadBuffer = null;
  renderRequiresUploadCopy = false;

  if (presenterBackend === "webgpu") {
    try {
      renderGpu = await createWebGpuPresenter(renderCanvas);
      renderBackend = "webgpu";
      postStatus("WebGPU presenter active");
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      postStatus(`WebGPU presenter unavailable: ${message}; falling back to WebGL`);
    }
  }

  if (presenterBackend !== "2d") {
    renderGl =
      renderCanvas.getContext("webgl2", softwareBlitContextAttributes()) ||
      renderCanvas.getContext("webgl", softwareBlitContextAttributes());
    if (renderGl) {
      renderBackend = "webgl";
      renderGlState = createSoftwareBlitter(renderGl);
      return;
    }
  }

  renderContext = renderCanvas.getContext("2d", { alpha: false });
  renderBackend = renderContext ? "2d" : "none";
  if (!renderContext) {
    throw new Error("Upstream software renderer could not create a worker canvas context");
  }
}

function normalizePresenterBackend(value) {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "webgpu" || normalized === "wgpu") {
    return "webgpu";
  }
  if (normalized === "2d" || normalized === "canvas") {
    return "2d";
  }
  return "webgl";
}

function normalizeOglProxyMode(value) {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "readback" || normalized === "bridge") {
    return "readback";
  }
  return normalized === "worker" || normalized === "offscreen" ? "worker" : "proxy";
}

async function createWebGpuPresenter(canvas) {
  const gpu = self.navigator?.gpu;
  const textureUsage = self.GPUTextureUsage;
  const shaderStage = self.GPUShaderStage;
  if (!gpu || !textureUsage || !shaderStage) {
    throw new Error("navigator.gpu is not available in this worker");
  }

  const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) {
    throw new Error("high-performance WebGPU adapter request returned null");
  }

  const device = await adapter.requestDevice();
  const format = typeof gpu.getPreferredCanvasFormat === "function" ? gpu.getPreferredCanvasFormat() : "bgra8unorm";
  const shaderModule = device.createShaderModule({
    label: "dolphin-xfb-presenter",
    code: `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
  var positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0)
  );
  var uvs = array<vec2f, 3>(
    vec2f(0.0, 1.0),
    vec2f(2.0, 1.0),
    vec2f(0.0, -1.0)
  );
  var output: VertexOutput;
  output.position = vec4f(positions[vertex_index], 0.0, 1.0);
  output.uv = uvs[vertex_index];
  return output;
}

@group(0) @binding(0) var frame_sampler: sampler;
@group(0) @binding(1) var frame_texture: texture_2d<f32>;

@fragment
fn fs(input: VertexOutput) -> @location(0) vec4f {
  return textureSample(frame_texture, frame_sampler, input.uv);
}
`
  });
  // Day-21: linear filtering on the XFB→canvas blit. The GameCube
  // XFB is 640x480; the visible canvas is usually larger, so nearest
  // sampling magnified every texel into a hard block — and that
  // compounded fastsw=1's already-half-res output into a very chunky
  // image. Linear costs nothing on the GPU and smooths the upscale,
  // closer to how Dolphin's other backends present. (Native res is
  // unchanged; this is purely the final present-stage filter.)
  const sampler = device.createSampler({
    label: "dolphin-xfb-linear",
    magFilter: "linear",
    minFilter: "linear"
  });
  const bindGroupLayout = device.createBindGroupLayout({
    label: "dolphin-xfb-bind-layout",
    entries: [
      {
        binding: 0,
        visibility: shaderStage.FRAGMENT,
        sampler: { type: "filtering" }
      },
      {
        binding: 1,
        visibility: shaderStage.FRAGMENT,
        texture: { sampleType: "float", viewDimension: "2d" }
      }
    ]
  });
  const pipeline = device.createRenderPipeline({
    label: "dolphin-xfb-presenter-pipeline",
    layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
    vertex: {
      module: shaderModule,
      entryPoint: "vs"
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fs",
      targets: [{ format }]
    },
    primitive: {
      topology: "triangle-list"
    }
  });
  const context = canvas.getContext("webgpu");
  if (!context) {
    throw new Error("OffscreenCanvas could not create a WebGPU context");
  }
  // Day-33 Phase C: configure the context up-front. Pre-cutover only
  // drawFrameBytesToWebGpu configured it (on the first XFB frame);
  // post-cutover that legacy path is dead, so the cmd-ring executor's
  // backbuffer pass (renderGpu.context.getCurrentTexture()) would
  // throw "context not configured" — silently swallowed, leaving the
  // visible canvas unpainted (the green). Idempotent re-configure
  // elsewhere is fine.
  try {
    context.configure({ device, format, alphaMode: "opaque" });
  } catch (e) {
    postStatus(`WebGPU context.configure failed: ${e?.message || e}`);
  }
  const state = {
    bindGroup: null,
    bindGroupLayout,
    canvasHeight: 0,
    canvasWidth: 0,
    context,
    device,
    format,
    pipeline,
    sampler,
    texture: null,
    textureHeight: 0,
    textureView: null,
    textureWidth: 0,
    uploadBuffer: null
  };

  device.lost.then((info) => {
    if (renderGpu?.device === device) {
      renderGpu = null;
      renderBackend = "webgpu-lost";
      postStatus(`WebGPU device lost: ${info?.message || info?.reason || "unknown"}`);
    }
  });

  return state;
}

// Day-17 (wasm-dolphin) C++ → JS bridge for the real WebGPU video
// backend (`?video=wgpu`). C++ `WebGPUGfx::PresentBackbuffer` calls
// `self.__dolphinWebGpuClear(r, g, b)` via EM_ASM to drive a real
// `wgpuRenderPass` clear on the canvas every frame. This replaces the
// Day-15 JS clear loop with a C++-owned render path; the next phases
// (17.3, 17.4) will extend this bridge with texture upload + blit so
// real game content reaches the canvas through the WebGPU backend.
//
// Why the bridge instead of issuing the render pass directly in C++:
// the canvas's WGPU context is configured on the discio worker's
// JS scope (via `createWebGpuPresenter`). Emscripten's webgpu.h
// exposes the device handle to C++, but the canvas surface is
// JS-side. Driving the pass through a `self`-scoped function keeps
// the surface bookkeeping in one place while letting C++ own the
// per-frame timing.
self.__dolphinWebGpuClear = function (r, g, b) {
  const gpu = renderGpu;
  if (!gpu || !gpu.context) return;
  try {
    const textureView = gpu.context.getCurrentTexture().createView();
    const encoder = gpu.device.createCommandEncoder({ label: "webgpu-real-clear" });
    const pass = encoder.beginRenderPass({
      label: "webgpu-real-clear-pass",
      colorAttachments: [{
        view: textureView,
        clearValue: { r, g, b, a: 1 },
        loadOp: "clear",
        storeOp: "store"
      }]
    });
    pass.end();
    gpu.device.queue.submit([encoder.finish()]);
  } catch (e) {
    postStatus(`WebGPU real-clear error: ${e?.message || e}`);
  }
};

function softwareBlitContextAttributes() {
  return {
    alpha: false,
    antialias: false,
    depth: false,
    preserveDrawingBuffer: false,
    stencil: false
  };
}

function createSoftwareBlitter(gl) {
  const program = createProgram(
    gl,
    `
attribute vec2 a_position;
attribute vec2 a_tex_coord;
varying vec2 v_tex_coord;

void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  v_tex_coord = a_tex_coord;
}
`,
    `
precision mediump float;
uniform sampler2D u_frame;
varying vec2 v_tex_coord;

void main() {
  gl_FragColor = texture2D(u_frame, v_tex_coord);
}
`
  );
  const buffer = gl.createBuffer();
  const texture = gl.createTexture();
  const vertices = new Float32Array([
    -1, 1, 0, 0,
    -1, -1, 0, 1,
    1, 1, 1, 0,
    1, -1, 1, 1
  ]);

  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

  const stride = 4 * Float32Array.BYTES_PER_ELEMENT;
  const position = gl.getAttribLocation(program, "a_position");
  const texCoord = gl.getAttribLocation(program, "a_tex_coord");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(texCoord);
  gl.vertexAttribPointer(texCoord, 2, gl.FLOAT, false, stride, 2 * Float32Array.BYTES_PER_ELEMENT);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.uniform1i(gl.getUniformLocation(program, "u_frame"), 0);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

  return {
    buffer,
    height: 0,
    program,
    texture,
    width: 0
  };
}

function createProgram(gl, vertexSource, fragmentSource) {
  const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`Software blitter shader link failed: ${gl.getProgramInfoLog(program)}`);
  }

  return program;
}

function createShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`Software blitter shader compile failed: ${gl.getShaderInfoLog(shader)}`);
  }

  return shader;
}

function drawFrameToWebGpu(width, height, pointer, length) {
  if (!renderCanvas || !renderGpu || width <= 0 || height <= 0 || pointer <= 0 || length <= 0) {
    return;
  }

  drawFrameBytesToWebGpu(width, height, new Uint8Array(moduleInstance.HEAPU8.buffer, pointer, length));
}

function drawFrameBytesToWebGpu(width, height, frameView) {
  if (!renderCanvas || !renderGpu || width <= 0 || height <= 0 || !frameView?.byteLength) {
    return;
  }

  const gpu = renderGpu;
  const textureUsage = self.GPUTextureUsage;
  if (!textureUsage) {
    return;
  }

  if (renderCanvas.width !== width || renderCanvas.height !== height) {
    renderCanvas.width = width;
    renderCanvas.height = height;
  }

  if (gpu.canvasWidth !== width || gpu.canvasHeight !== height) {
    gpu.context.configure({
      alphaMode: "opaque",
      device: gpu.device,
      format: gpu.format,
      usage: textureUsage.RENDER_ATTACHMENT
    });
    gpu.canvasWidth = width;
    gpu.canvasHeight = height;
  }

  if (gpu.textureWidth !== width || gpu.textureHeight !== height) {
    gpu.texture?.destroy?.();
    gpu.texture = gpu.device.createTexture({
      label: "dolphin-xfb-frame",
      size: { width, height, depthOrArrayLayers: 1 },
      format: "rgba8unorm",
      usage: textureUsage.COPY_DST | textureUsage.TEXTURE_BINDING
    });
    gpu.textureView = gpu.texture.createView();
    gpu.bindGroup = gpu.device.createBindGroup({
      label: "dolphin-xfb-bind-group",
      layout: gpu.bindGroupLayout,
      entries: [
        { binding: 0, resource: gpu.sampler },
        { binding: 1, resource: gpu.textureView }
      ]
    });
    gpu.textureWidth = width;
    gpu.textureHeight = height;
    gpu.uploadBuffer = null;
  }

  const rowBytes = width * 4;
  const bytesPerRow = alignTo(rowBytes, 256);
  const uploadView = webGpuUploadSource(gpu, frameView, rowBytes, bytesPerRow, height);
  gpu.device.queue.writeTexture(
    { texture: gpu.texture },
    uploadView,
    { bytesPerRow, rowsPerImage: height },
    { width, height, depthOrArrayLayers: 1 }
  );

  const encoder = gpu.device.createCommandEncoder({ label: "dolphin-xfb-presenter" });
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear",
        storeOp: "store",
        view: gpu.context.getCurrentTexture().createView()
      }
    ]
  });
  pass.setPipeline(gpu.pipeline);
  pass.setBindGroup(0, gpu.bindGroup);
  pass.draw(3);
  pass.end();
  gpu.device.queue.submit([encoder.finish()]);
}

function webGpuUploadSource(gpu, frameView, rowBytes, bytesPerRow, height) {
  if (rowBytes === bytesPerRow) {
    return frameView;
  }

  const requiredBytes = bytesPerRow * height;
  if (!gpu.uploadBuffer || gpu.uploadBuffer.byteLength !== requiredBytes) {
    gpu.uploadBuffer = new Uint8Array(requiredBytes);
  }

  for (let row = 0; row < height; row += 1) {
    const sourceOffset = row * rowBytes;
    const targetOffset = row * bytesPerRow;
    gpu.uploadBuffer.set(frameView.subarray(sourceOffset, sourceOffset + rowBytes), targetOffset);
  }
  return gpu.uploadBuffer;
}

function alignTo(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}

function drawFrameToWebGl(width, height, pointer, length) {
  if (!renderCanvas || !renderGl || !renderGlState || width <= 0 || height <= 0 || pointer <= 0 || length <= 0) {
    return;
  }

  drawFrameBytesToWebGl(width, height, new Uint8Array(moduleInstance.HEAPU8.buffer, pointer, length));
}

function drawFrameBytesToWebGl(width, height, frameView) {
  if (!renderCanvas || !renderGl || !renderGlState || width <= 0 || height <= 0 || !frameView?.byteLength) {
    return;
  }

  if (renderCanvas.width !== width || renderCanvas.height !== height) {
    renderCanvas.width = width;
    renderCanvas.height = height;
  }

  const gl = renderGl;
  const uploadView = uploadSource(frameView);

  gl.useProgram(renderGlState.program);
  gl.bindBuffer(gl.ARRAY_BUFFER, renderGlState.buffer);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, renderGlState.texture);
  gl.viewport(0, 0, width, height);

  try {
    if (renderGlState.width !== width || renderGlState.height !== height) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, uploadView);
      renderGlState.width = width;
      renderGlState.height = height;
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, uploadView);
    }
  } catch (error) {
    if (!renderRequiresUploadCopy) {
      renderRequiresUploadCopy = true;
      drawFrameBytesToWebGl(width, height, frameView);
      return;
    }
    throw error;
  }

  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  if (typeof gl.commit === "function") {
    gl.commit();
  }
}

function uploadSource(frameView) {
  if (!renderRequiresUploadCopy) {
    return frameView;
  }

  if (!renderUploadBuffer || renderUploadBuffer.byteLength !== frameView.byteLength) {
    renderUploadBuffer = new Uint8Array(frameView.byteLength);
  }
  renderUploadBuffer.set(frameView);
  return renderUploadBuffer;
}

function drawFrameToCanvas(width, height, pointer, length) {
  if (!renderCanvas || !renderContext || width <= 0 || height <= 0 || pointer <= 0 || length <= 0) {
    return;
  }

  drawFrameBytesToCanvas(width, height, new Uint8ClampedArray(moduleInstance.HEAPU8.buffer, pointer, length));
}

function drawFrameBytesToCanvas(width, height, frameView) {
  if (!renderCanvas || !renderContext || width <= 0 || height <= 0 || !frameView?.byteLength) {
    return;
  }

  if (renderCanvas.width !== width || renderCanvas.height !== height) {
    renderCanvas.width = width;
    renderCanvas.height = height;
    renderImageData = null;
  }

  if (!renderImageData || renderImageData.width !== width || renderImageData.height !== height) {
    renderImageData = renderContext.createImageData(width, height);
  }

  renderImageData.data.set(frameView);
  renderContext.putImageData(renderImageData, 0, 0);
}

function joinedStats(ppcStats, videoStats, ...extraStats) {
  return [ppcStats, videoStats ? `video ${videoStats}` : "", ...extraStats].filter(Boolean).join(" | ");
}

function readCoreTicks() {
  const low = api?.getCoreTicksLow?.() ?? 0;
  const high = api?.getCoreTicksHigh?.() ?? 0;
  return (high >>> 0) * 0x100000000 + (low >>> 0);
}

function readCoreTicksPerSecond() {
  const ticksPerSecond = api?.getCoreTicksPerSecond?.() ?? 486000000;
  return Number.isFinite(ticksPerSecond) && ticksPerSecond > 0 ? ticksPerSecond : 486000000;
}

function postResult(id, result) {
  const { transfer = [], ...payload } = result ?? {};
  self.postMessage({ id, ok: true, ...payload }, transfer);
}

function postStatus(message) {
  self.postMessage({
    type: "status",
    message: String(message)
  });
}

// Day-7 persistent JIT cache. The master cache lives here on the discio
// worker. We load it from IndexedDB at boot and persist new compiles back
// to IDB so the next session boots with a pre-warmed cache. At factory()
// return time we postMessage the cache to every pthread worker in the
// pool so each pthread can consult it from its EM_JS compile body. Each
// pthread instantiates cached Modules locally on its own wasmTable —
// bypassing the cross-pthread-table problem from Day 6.
const dolphinJitCacheMap = new Map(); // Map<hashHex, WebAssembly.Module>
const DOLPHIN_JIT_IDB_NAME = "dolphin-jit-cache";
const DOLPHIN_JIT_IDB_STORE = "modules";
const DOLPHIN_JIT_IDB_META = "metadata";
const DOLPHIN_JIT_IDB_VERSION = 2;
// §28u: 8192 was far too small for full Melee — the user's cache
// plateaued at ~8135 (cap hit) while still in the menus, so EVERY
// later 3D scene (intro/2nd cutscene, battle) exceeded the cap →
// `handleDolphinJitNewCompile` early-returns at line ~2858 → those
// blocks are never cached NOR persisted to IDB → they recompile
// from scratch on every run → perpetual compile-burst BLACK + speed
// collapse (img12 34 %, img19 57 %) on exactly the 3D scenes.
// Raising the cap 6× lets the cache cover the whole game; combined
// with the existing IDB persistence the cutscene/battle blocks now
// survive and pre-warm subsequent runs (no re-burst). Entries are
// small per-block WebAssembly.Modules (raw bytes live in IDB, not
// the Map) so 6× is a modest memory delta on a 1.36 GB-game tab.
const DOLPHIN_JIT_CACHE_MAX = 49152; // hard cap on in-memory entries
const DOLPHIN_JIT_FINGERPRINT_KEY = "buildFingerprint";
let dolphinJitIdb = null;
let dolphinJitIdbWritesPending = 0;
let dolphinJitIdbWriteCount = 0;
function openDolphinJitIdb() {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    let request;
    try {
      request = indexedDB.open(DOLPHIN_JIT_IDB_NAME, DOLPHIN_JIT_IDB_VERSION);
    } catch (err) {
      postStatus(`jit-cache: indexedDB.open failed: ${err?.message || err}`);
      resolve(null);
      return;
    }
    request.onupgradeneeded = (event) => {
      const db = request.result;
      // v1 → v2: add metadata store. The pre-v2 modules have no associated
      // build fingerprint, so clear them on upgrade — they'd otherwise be
      // treated as belonging to the current build and only grow stale.
      if (event.oldVersion < 2 && db.objectStoreNames.contains(DOLPHIN_JIT_IDB_STORE)) {
        db.deleteObjectStore(DOLPHIN_JIT_IDB_STORE);
      }
      if (!db.objectStoreNames.contains(DOLPHIN_JIT_IDB_STORE)) {
        db.createObjectStore(DOLPHIN_JIT_IDB_STORE);
      }
      if (!db.objectStoreNames.contains(DOLPHIN_JIT_IDB_META)) {
        db.createObjectStore(DOLPHIN_JIT_IDB_META);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      postStatus(`jit-cache: indexedDB.open error: ${request.error?.message || "unknown"}`);
      resolve(null);
    };
  });
}
function readDolphinJitMetadata(db, key) {
  return new Promise((resolve) => {
    if (!db) { resolve(null); return; }
    try {
      const tx = db.transaction(DOLPHIN_JIT_IDB_META, "readonly");
      const req = tx.objectStore(DOLPHIN_JIT_IDB_META).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}
function writeDolphinJitMetadata(db, key, value) {
  return new Promise((resolve) => {
    if (!db) { resolve(false); return; }
    try {
      const tx = db.transaction(DOLPHIN_JIT_IDB_META, "readwrite");
      const req = tx.objectStore(DOLPHIN_JIT_IDB_META).put(value, key);
      req.onsuccess = () => resolve(true);
      req.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}
function clearDolphinJitModulesStore(db) {
  return new Promise((resolve) => {
    if (!db) { resolve(false); return; }
    try {
      const tx = db.transaction(DOLPHIN_JIT_IDB_STORE, "readwrite");
      const req = tx.objectStore(DOLPHIN_JIT_IDB_STORE).clear();
      req.onsuccess = () => resolve(true);
      req.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}
async function loadDolphinJitCacheFromIdb(db) {
  if (!db) return 0;
  const entries = await new Promise((resolve) => {
    const out = [];
    try {
      const tx = db.transaction(DOLPHIN_JIT_IDB_STORE, "readonly");
      const store = tx.objectStore(DOLPHIN_JIT_IDB_STORE);
      const cursorReq = store.openCursor();
      cursorReq.onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor) {
          resolve(out);
          return;
        }
        out.push({ key: cursor.key, value: cursor.value });
        cursor.continue();
      };
      cursorReq.onerror = () => resolve(out);
      tx.onerror = () => resolve(out);
    } catch (err) {
      postStatus(`jit-cache: IDB load failed: ${err?.message || err}`);
      resolve(out);
    }
  });
  let loaded = 0;
  // §28ao: was a SEQUENTIAL `await WebAssembly.compile` per entry —
  // for a warm cache (10k+ blocks) that is a 5-20 s wall blocking the
  // whole boot ("title takes a while", agent-confirmed). Compile in
  // PARALLEL batches via Promise.allSettled (browser uses all cores);
  // warm-boot compile drops to ~1-3 s. Module is structured-cloneable
  // so each pthread still receives ready-to-instantiate Modules.
  const COMPILE_BATCH = 64;
  for (let i = 0; i < entries.length; i += COMPILE_BATCH) {
    if (dolphinJitCacheMap.size >= DOLPHIN_JIT_CACHE_MAX) break;
    const batch = [];
    for (const { key, value } of entries.slice(i, i + COMPILE_BATCH)) {
      if (!(value instanceof Uint8Array) && !(value instanceof ArrayBuffer)) continue;
      if (dolphinJitCacheMap.has(key)) continue;
      const buf = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
      batch.push({ key, p: WebAssembly.compile(buf) });
    }
    const res = await Promise.allSettled(batch.map((b) => b.p));
    for (let k = 0; k < res.length; k++) {
      if (res[k].status === "fulfilled") {
        dolphinJitCacheMap.set(batch[k].key, res[k].value);
        loaded += 1;
      }
      // rejected = corrupt entry; skipped, re-cached on next miss.
    }
  }
  return loaded;
}
function writeDolphinJitEntryToIdb(hash, bytes) {
  if (!dolphinJitIdb) return;
  try {
    const tx = dolphinJitIdb.transaction(DOLPHIN_JIT_IDB_STORE, "readwrite");
    tx.onabort = () => {
      if (!self._dolphinJitIdbTxAbortLogged) {
        self._dolphinJitIdbTxAbortLogged = true;
        postStatus(`jit-cache: IDB tx abort: ${tx.error?.message || "unknown"}`);
      }
    };
    const store = tx.objectStore(DOLPHIN_JIT_IDB_STORE);
    dolphinJitIdbWritesPending += 1;
    const req = store.put(bytes, hash);
    req.onsuccess = () => {
      dolphinJitIdbWritesPending -= 1;
      dolphinJitIdbWriteCount += 1;
      if (
        dolphinJitIdbWriteCount === 100 ||
        dolphinJitIdbWriteCount % 500 === 0
      ) {
        postStatus(
          `jit-cache: IDB writes=${dolphinJitIdbWriteCount} pending=${dolphinJitIdbWritesPending}`
        );
      }
    };
    req.onerror = () => {
      dolphinJitIdbWritesPending -= 1;
      if (!self._dolphinJitIdbWriteErrLogged) {
        self._dolphinJitIdbWriteErrLogged = true;
        postStatus(`jit-cache: IDB write error: ${req.error?.message || "unknown"}`);
      }
    };
  } catch (err) {
    if (!self._dolphinJitIdbWriteErrLogged) {
      self._dolphinJitIdbWriteErrLogged = true;
      postStatus(`jit-cache: IDB write threw: ${err?.message || err}`);
    }
  }
}
async function fetchWasmAndFingerprint(coreUrlValue) {
  // coreUrlValue points at the JS shim (dolphin-core-upstream.js). The
  // wasm sits beside it under the conventional name.
  const wasmUrl = new URL("dolphin-core-upstream.wasm", coreUrlValue).href;
  let buffer = null;
  let fingerprint = null;
  try {
    const resp = await fetch(wasmUrl);
    if (!resp.ok) {
      postStatus(`jit-cache: wasm fetch returned ${resp.status} (no fingerprint)`);
      return { wasmBinary: null, fingerprint: null };
    }
    buffer = await resp.arrayBuffer();
  } catch (err) {
    postStatus(`jit-cache: wasm fetch failed (${err?.message || err}); no fingerprint`);
    return { wasmBinary: null, fingerprint: null };
  }
  // Stride-64 FNV-1a over the full wasm. 8MB / 64 = 128K iters ≈ 1ms.
  // Wasm files have distinct bytes throughout (code section, data section,
  // import/export names), so any non-trivial build change moves the hash.
  const view = new Uint8Array(buffer);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < view.length; i += 64) {
    h ^= view[i];
    h = Math.imul(h, 16777619);
  }
  fingerprint = ((h ^ view.length) >>> 0).toString(16) + ":" + view.length.toString(16);
  return { wasmBinary: buffer, fingerprint };
}
// Open IDB eagerly so loadCore() doesn't pay the open latency. Module load
// is deferred until the build fingerprint is computed (after fetching the
// wasm) so we can skip / clear stale entries from a previous build.
const dolphinJitIdbReady = (async () => {
  dolphinJitIdb = await openDolphinJitIdb();
})();
// When the persistent JIT cache loaded a non-trivial number of modules
// for this build at boot, maybeEnablePpcWasmJit will skip the warmup
// frame gate and engage JIT essentially immediately. Without this,
// warm boots wait 700+ stable video frames (15+ seconds) before JIT
// kicks in, even though the cache could service the first compile
// burst near-instantly. Threshold is intentionally low (>= 50): the
// cache only needs to absorb the initial burst, not the whole game.
let dolphinJitCachePreWarmed = false;
const DOLPHIN_JIT_PREWARM_THRESHOLD = 50;
async function reconcileJitCacheWithBuild(fingerprint) {
  await dolphinJitIdbReady;
  if (!dolphinJitIdb) return 0;
  const stored = await readDolphinJitMetadata(dolphinJitIdb, DOLPHIN_JIT_FINGERPRINT_KEY);
  if (stored && fingerprint && stored !== fingerprint) {
    await clearDolphinJitModulesStore(dolphinJitIdb);
    postStatus(
      `jit-cache: build changed (${stored.slice(0, 8)} → ${fingerprint.slice(0, 8)}); cleared stale modules`
    );
  }
  if (fingerprint) {
    await writeDolphinJitMetadata(dolphinJitIdb, DOLPHIN_JIT_FINGERPRINT_KEY, fingerprint);
  }
  const loaded = await loadDolphinJitCacheFromIdb(dolphinJitIdb);
  if (loaded > 0) {
    postStatus(`jit-cache: loaded ${loaded} compiled modules from IndexedDB`);
  }
  if (loaded >= DOLPHIN_JIT_PREWARM_THRESHOLD) {
    dolphinJitCachePreWarmed = true;
    postStatus(
      `jit-cache: pre-warmed with ${loaded} modules; JIT warmup gate will be skipped on this session`
    );
  }
  return loaded;
}
let dolphinJitNewCompileCount = 0;
function handleDolphinJitNewCompile(event) {
  const data = event.data;
  if (!data || data.type !== "dolphin-jit-new-compile") return;
  dolphinJitNewCompileCount += 1;
  if (!data.hash || !data.bytes) return;
  if (dolphinJitCacheMap.has(data.hash)) return;
  if (dolphinJitCacheMap.size >= DOLPHIN_JIT_CACHE_MAX) return;
  // Reserve the slot synchronously so duplicate notifications dedupe even
  // before the async compile finishes. Replace with the real Module once
  // compilation completes. Async to keep discio off-critical-path. After
  // the compile lands, persist to IndexedDB so subsequent boots can
  // pre-warm without recompiling.
  dolphinJitCacheMap.set(data.hash, null);
  // Persist bytes synchronously (fire-and-forget IDB put). Storage format
  // is raw wasm bytes; we recompile at boot. WebAssembly.Module storage in
  // IDB proved unreliable empirically (put().oncomplete fires but
  // req.onsuccess never does, and the data doesn't survive). Bytes are
  // boring TypedArrays and clone reliably.
  writeDolphinJitEntryToIdb(data.hash, data.bytes);
  WebAssembly.compile(data.bytes).then((mod) => {
    dolphinJitCacheMap.set(data.hash, mod);
  }).catch((err) => {
    dolphinJitCacheMap.delete(data.hash);
    if (!self._dolphinJitNewCompileErrLogged) {
      self._dolphinJitNewCompileErrLogged = true;
      postStatus(`jit-cache: async compile-on-discio failed: ${err?.message || err}`);
    }
  });
  if (
    dolphinJitNewCompileCount === 1 ||
    dolphinJitNewCompileCount === 10 ||
    dolphinJitNewCompileCount % 100 === 0
  ) {
    postStatus(
      `jit-cache: discio recorded ${dolphinJitNewCompileCount} new compiles (cache size=${dolphinJitCacheMap.size})`
    );
  }
}
async function installDolphinJitCacheChannel(moduleInstance) {
  const pthread = moduleInstance?.PThread;
  if (!pthread) {
    postStatus("jit-cache: Module.PThread unavailable; persistent JIT cache disabled");
    return;
  }
  // dolphinJitCacheMap is already populated by loadCore() (which awaits
  // reconcileJitCacheWithBuild before reaching this call site), so we
  // can push immediately.
  const workers = [
    ...(pthread.runningWorkers || []),
    ...(pthread.unusedWorkers || [])
  ];
  if (!workers.length) {
    postStatus("jit-cache: no pthread workers visible at boot (PTHREAD_POOL_SIZE may be 0)");
    return;
  }
  // Send the cache to every worker. We send the same payload to running +
  // unused so when Dolphin assigns a fresh pthread to a previously-idle
  // worker, the cache is already installed. Also addEventListener so the
  // pthread's self.postMessage cache-miss notifications reach us alongside
  // Emscripten's worker.onmessage.
  let sent = 0;
  for (const w of workers) {
    try {
      w.postMessage({ type: "dolphin-jit-cache", cache: dolphinJitCacheMap });
      w.addEventListener("message", handleDolphinJitNewCompile);
      // Detached OGL: also catch detachedOglFrame postMessages from the
      // GPU pthread (whichever one owns the OffscreenCanvas after
      // Emscripten transfers it). C++ Swap() in Emscripten.cpp does the
      // transferToImageBitmap + postMessage from that pthread; we forward
      // it on to the main thread for drawImage onto the visible canvas.
      // This is the no-glReadPixels paint path — bypasses the multi-
      // second GPU-sync stalls the Chrome trace pinpointed.
      w.addEventListener("message", handleDetachedOglFrame);
      // Day-17 phase 4: catch `webgpu-show-image` payloads emitted by
      // `WebGPUGfx::ShowImage` (via EM_ASM postMessage) from whichever
      // pthread the GPU thread lands on. The discio worker owns the
      // WGPU presenter pipeline (`renderGpu` / drawFrameBytesToWebGpu),
      // so we route the XFB bytes to it here.
      w.addEventListener("message", handleWebGpuShowImage);
      // Day-27: catch the `webgpu-cmd-ring` hand-off from the video
      // pthread (WebGPUCommandStream::EnsureRing). Registers the
      // shared-memory command ring so the presentation loop can drain
      // + replay GPU commands on renderGpu.device.
      w.addEventListener("message", handleWebGpuCmdRing);
      sent += 1;
    } catch (err) {
      if (!self._dolphinJitChannelErrLogged) {
        self._dolphinJitChannelErrLogged = true;
        postStatus(`jit-cache: postMessage to pthread worker failed: ${err?.message || err}`);
      }
    }
  }
  postStatus(`jit-cache: pushed cache (${dolphinJitCacheMap.size} entries) to ${sent}/${workers.length} pthread workers`);
}

// Day-27: cross-thread WebGPU command ring. The video pthread can't
// own a WebGPU device (Day-26 wall), so WebGPUCommandStream records
// GPU commands into a ring in the shared wasm heap and the discio
// worker (which owns renderGpu.device + pumps its event loop)
// replays them here. This is the wire protocol for the remote WebGPU
// backend. Day-27 implements the transport + OP_CLEAR; the full
// AbstractGfx opcode set layers on next.
//
// Header layout (CmdRingHeader, 16 bytes @ headerPtr):
//   [0] u32 write (atomic)  [1] u32 read (atomic)
//   [2] u32 capacity        [3] u32 reserved
// Slot layout (CmdRecord, 32 bytes @ slotsPtr + i*32):
//   [0] u32 op   [1..7] 7 words (f32/u32 per opcode)
const WGPU_CMD_OP_NOP = 0;
const WGPU_CMD_OP_CLEAR = 1;
const WGPU_CMD_OP_CREATE_SHADER = 2;
const WGPU_CMD_OP_CREATE_PIPELINE = 3;
const WGPU_CMD_OP_DRAW_TEST = 4;
// Phase A (Day-33): full AbstractGfx opcode set. Wire form fixed by
// DESIGN-webgpu-command-protocol; consumer handlers land per-increment.
// §16: reused scratch for SET_BIND_GROUP dynamic offsets so the
// per-draw hot path (~1.5M calls/run) allocates nothing — a fresh
// array here stalled the consumer → ring backpressure → JIT
// catastrophic. Non-shared so no engine rejects it (cf. TextDecoder).
const WGPU_DYN_OFF_SCRATCH = new Uint32Array(4);
const WGPU_CMD_OP_CREATE_BUFFER = 5;
const WGPU_CMD_OP_UPLOAD_BUFFER = 6;
const WGPU_CMD_OP_CREATE_TEXTURE = 7;
const WGPU_CMD_OP_UPLOAD_TEXTURE = 8;
const WGPU_CMD_OP_CREATE_PIPELINE_CFG = 9;
const WGPU_CMD_OP_CREATE_SAMPLER = 10;
const WGPU_CMD_OP_CREATE_BIND_GROUP = 11;
const WGPU_CMD_OP_BEGIN_PASS = 12;
const WGPU_CMD_OP_SET_PIPELINE = 13;
const WGPU_CMD_OP_SET_BIND_GROUP = 14;
const WGPU_CMD_OP_SET_VERTEX_BUFFER = 15;
const WGPU_CMD_OP_SET_INDEX_BUFFER = 16;
const WGPU_CMD_OP_SET_VIEWPORT = 17;
const WGPU_CMD_OP_SET_SCISSOR = 18;
const WGPU_CMD_OP_DRAW = 19;
const WGPU_CMD_OP_DRAW_INDEXED = 20;
const WGPU_CMD_OP_END_PASS = 21;
const WGPU_CMD_OP_SUBMIT_PRESENT = 22;
const WGPU_CMD_OP_DESTROY = 23;
const WGPU_CMD_OP_BLIT_TEXTURE = 24;
let webGpuCmdRing = null;  // { headerI32, slotsBase, capacity, uploadBase }
// Day-28/29 resource object table: producer-assigned id → real GPU
// object built here on renderGpu.device. Phase A widens this to the
// full AbstractGfx resource set.
const webGpuObjects = {
  shaders: new Map(),
  pipelines: new Map(),
  buffers: new Map(),
  textures: new Map(),
  samplers: new Map(),
  bindGroups: new Map(),
  pipeTpl: new Map(),  // id → {desc, target, depthBase} template
  pipeVar: new Map(),  // `id|cFmt|dFmt` → GPURenderPipeline|null
  shaderOk: 0,
  shaderFail: 0
};
// Day-29: constant-colour test fragment shader the consumer pairs
// with a bridge-translated vertex shader to prove the pipeline/draw
// replay path. Real Dolphin pixel shaders arrive with the Day-30
// api_type→Vulkan flip; this FS just emits a recognisable colour so
// a successful pipeline+draw is visible on the canvas.
const WGPU_TEST_FS_WGSL =
  "@fragment fn main() -> @location(0) vec4<f32> " +
  "{ return vec4<f32>(0.13, 0.62, 0.91, 1.0); }";
let webGpuTestFsModule = null;
const webGpuTextDecoder =
  typeof TextDecoder === "function" ? new TextDecoder("utf-8") : null;

function handleWebGpuCmdRing(event) {
  const data = event.data;
  if (!data || data.type !== "webgpu-cmd-ring") return;
  const heap = moduleInstance?.HEAPU8;
  if (!heap || !(heap.buffer instanceof SharedArrayBuffer)) {
    postStatus("webgpu-cmd-ring: wasm heap is not shared; bridge disabled");
    return;
  }
  webGpuCmdRing = {
    headerI32: new Int32Array(heap.buffer, data.headerPtr, 4),
    headerU32: new Uint32Array(heap.buffer, data.headerPtr, 4),
    slotsBase: data.slotsPtr,
    capacity: data.capacity >>> 0,
    // Phase A: per-frame upload arena base (absolute wasm-heap
    // offset). UploadBuffer/UploadTexture src pointers are absolute
    // heap offsets into this region; the consumer reads them straight
    // from moduleInstance.HEAPU8 (zero-copy).
    uploadBase: (data.uploadPtr >>> 0) || 0,
    uploadSize: (data.uploadSize >>> 0) || 0
  };
  postStatus(
    `webgpu-cmd-ring: registered (cap=${data.capacity} upload=${
      (webGpuCmdRing.uploadSize / 1048576) | 0}MB) — GPU command bridge live`
  );
}

// Drain + replay pending commands on renderGpu.device. Called every
// presentation tick. Single-consumer; the producer (video pthread)
// publishes with a release store on `write`, we acquire-load it.
// Day-33 A4/A5: WebGPU texture-format codes (matches MapTexFormat in
// WebGPUTexture.cpp).
const WGPU_TEX_FORMAT = [
  "rgba8unorm", "bgra8unorm", "depth24plus", "depth32float",
  "depth24plus-stencil8", "rgba16float", "r16uint", "r32float",
  "rgb10a2unorm"
];
// §26: formats compatible with the fixed group-1 texture layout
// (sampleType:"float", filterable). Anything else bound there —
// r32float (EFB depth, unfilterable-float), r16uint (uint), depth* —
// is a validation error that poisons the whole frame submit.
const FILTERABLE_TEX_FORMATS = new Set([
  "rgba8unorm", "bgra8unorm", "rgba16float", "rgb10a2unorm"
]);

// Explicit fixed bind-group layouts mirroring the Day-22 translator
// SHADER_HEADER: group0 = UBOs b0..3, group1 = textures b0..7 +
// sampler b8, group2 = bbox storage b0. Created once; replaces
// layout:"auto" so bind groups are uniform across every TEV config.
function getFixedLayouts() {
  if (renderGpu._fixedLayouts) return renderGpu._fixedLayouts;
  const dev = renderGpu.device;
  const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
  // §16: the 4 group-0 UBOs are dynamic-offset — one bind group over
  // the per-draw uniform ring, the draw's slice selected by the offsets
  // on SET_BIND_GROUP. Fixes every draw seeing only the last upload.
  const l0 = dev.createBindGroupLayout({
    label: "dolphin-bg0-ubo",
    entries: [0, 1, 2, 3].map((b) => ({
      binding: b, visibility: VF,
      buffer: { type: "uniform", hasDynamicOffset: true }
    }))
  });
  // GX pixel path (Day-30 split): texture2DArray tex_0..7 at b0-7 +
  // shared sampler samp_ss at b8. Utility/framebuffer shaders
  // (FramebufferShaderGen EmitSamplerDeclarations) use a WIDER scheme:
  // fbtex{i} → SAMPLER_BINDING(i) (b0-7), fbsmp{i} → SAMPLER_BINDING(i+8)
  // (b8-15). GenerateEFBRestorePixelShader uses index 0+1, so fbsmp1
  // lands at @group(1) @binding(9). Declare b0-7 textures + b8-15
  // samplers so every SHADER_HEADER sampler binding the translator can
  // emit exists in the fixed layout (declaring bindings a given shader
  // omits is allowed; the reverse is the pipeline-build failure).
  const e1 = [];
  for (let i = 0; i < 8; i++) {
    e1.push({
      binding: i, visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: "float", viewDimension: "2d-array" }
    });
  }
  for (let i = 8; i < 16; i++) {
    e1.push({
      binding: i, visibility: GPUShaderStage.FRAGMENT,
      sampler: { type: "filtering" }
    });
  }
  const l1 = dev.createBindGroupLayout({ label: "dolphin-bg1-samp", entries: e1 });
  const l2 = dev.createBindGroupLayout({
    label: "dolphin-bg2-ssbo",
    entries: [{
      binding: 0, visibility: GPUShaderStage.FRAGMENT,
      buffer: { type: "storage" }
    }]
  });
  const pipelineLayout = dev.createPipelineLayout({
    label: "dolphin-pipeline-layout", bindGroupLayouts: [l0, l1, l2]
  });
  // Persistent dummies to pad bind-group entries the producer's blob
  // omits but the (now wider) fixed layout declares — WebGPU requires
  // a bind group to bind every layout binding. 1×1 2d-array texture +
  // a sampler; harmless when the shader never references them.
  const dummyTex = dev.createTexture({
    size: [1, 1, 1], format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
  });
  const dummyTexView = dummyTex.createView({ dimension: "2d-array" });
  const dummySampler = dev.createSampler({});
  renderGpu._fixedLayouts = { l0, l1, l2, pipelineLayout,
                              dummyTex, dummyTexView, dummySampler };
  return renderGpu._fixedLayouts;
}

// Build a GPUBindGroup from a CREATE_BIND_GROUP blob against the fixed
// layout for its group. blob: u32 magic 'WBG1', group, count, then
// count×{binding, kind, resId, off, size}. kind 0/3 = buffer,
// 1 = texture, 2 = sampler.
function replayCreateBindGroup(id, blobPtr, blobLen) {
  if (!renderGpu || !blobPtr || webGpuObjects.bindGroups.has(id)) return;
  const u = new Uint32Array(moduleInstance.HEAPU8.buffer, blobPtr, blobLen >>> 2);
  if (u[0] !== 0x57424731) return;
  const group = u[1], count = u[2];
  const layouts = getFixedLayouts();
  const layout = group === 0 ? layouts.l0 : group === 1 ? layouts.l1 : layouts.l2;
  // DIAG one-shot: for the first few group-1 (texture+sampler) bind
  // groups, dump each binding's resId and whether that texture exists
  // / its format+size. Reveals if textured GX draws sample the 1×1
  // dummy or a never-built id (→ black) vs real game textures.
  if (group === 1 && (self._wgBg1N = (self._wgBg1N || 0) + 1) <= 10) {
    let s = `[webgpu-DIAG-bg1] id=${id} count=${count}`;
    for (let i = 0; i < count; i++) {
      const b = u[3 + i * 5], k = u[3 + i * 5 + 1], r = u[3 + i * 5 + 2];
      if (k === 1) {
        const t = webGpuObjects.textures.get(r);
        s += ` b${b}:tex#${r}=${t ? `${t.format} ${t.tex.width}x${t.tex.height}` : "MISSING"}`;
      } else if (k === 2) {
        s += ` b${b}:samp#${r}=${webGpuObjects.samplers.get(r) ? "ok" : "MISSING"}`;
      }
    }
    console.log(s);
  }
  const entries = [];
  let srcTexId = -1;
  for (let i = 0; i < count; i++) {
    const base = 3 + i * 5;
    const binding = u[base], kind = u[base + 1], resId = u[base + 2];
    if (kind === 1) {
      if (binding === 0 && srcTexId < 0) srcTexId = resId;
      const t = webGpuObjects.textures.get(resId);
      if (!t) {
        // §28 diag: which texture ids are missing (→ whole draw
        // skipped → screen-specific black, e.g. difficulty-select
        // background)? Rate-limited tally of the missing resId.
        self._wgMiss = self._wgMiss || { n: 0, ids: {} };
        self._wgMiss.n++;
        self._wgMiss.ids[resId] = (self._wgMiss.ids[resId] || 0) + 1;
        if ((self._wgMiss.n & 0x3FFF) === 0) {
          const top = Object.entries(self._wgMiss.ids)
            .sort((a, b) => b[1] - a[1]).slice(0, 8)
            .map(([k, v]) => `tex#${k}:${v}`).join(" ");
          console.log(`[s28-missbg] n=${self._wgMiss.n} b${binding} ` +
            `top-missing=${top}`);
        }
        return;  // resource not ready — skip this frame
      }
      // §26: the fixed group-1 layout declares sampleType:"float"
      // (filterable). Binding a non-filterable / non-float texture
      // (the battle samples the EFB DEPTH as r32float; also uint /
      // depth formats) is a WebGPU validation error that poisons the
      // WHOLE frame's submit → black battle. Substitute the filterable
      // rgba8unorm dummy so the bind group stays layout-valid and the
      // frame renders (the one depth-sample effect is lost, not the
      // scene). Filterable-float formats l1 accepts:
      const FILTERABLE = FILTERABLE_TEX_FORMATS;
      if (!FILTERABLE.has(t.format)) {
        entries.push({ binding, resource: getFixedLayouts().dummyTexView });
      } else {
        entries.push({ binding, resource: t.view2dArray ||
          (t.view2dArray = t.tex.createView({ dimension: "2d-array" })) });
      }
    } else if (kind === 2) {
      const s = webGpuObjects.samplers.get(resId);
      if (!s) return;
      entries.push({ binding, resource: s });
    } else {
      const b = webGpuObjects.buffers.get(resId);
      if (!b) return;
      // §16: group-0 UBO entries carry a class-size window (blob size
      // field); the per-draw byte offset is a *dynamic* offset applied
      // at setBindGroup, so the entry itself is {offset:0,size}. size==0
      // (e.g. the bbox SSBO) ⇒ bind the whole buffer as before.
      const bsz = u[base + 4];
      entries.push({ binding, resource: bsz
        ? { buffer: b, offset: u[base + 3], size: bsz }
        : { buffer: b } });
    }
  }
  // The fixed group-1 layout declares b0-7 (texture) + b8-15 (sampler)
  // so utility shaders (e.g. EFBRestore's fbsmp1 @binding 9) build, but
  // the producer's blob only carries the bindings it actually uses.
  // WebGPU requires a bind group to bind EVERY layout binding — pad the
  // gaps with persistent dummies (never sampled when the shader omits
  // them).
  if (group === 1) {
    const have = new Set(entries.map((e) => e.binding));
    for (let b = 0; b < 16; b++) {
      if (have.has(b)) continue;
      entries.push(b < 8
        ? { binding: b, resource: layouts.dummyTexView }
        : { binding: b, resource: layouts.dummySampler });
    }
  }
  // Sidecar: bgId → its group-1 binding-0 source texture id, so the
  // [webgpu-DIAG-cpypass] probe can name what the EFB-copy draw samples.
  if (group === 1 && srcTexId >= 0) {
    self._wgBgTex = self._wgBgTex || {};
    self._wgBgTex[id] = srcTexId;
    // §28: full group-1 texture binding set (b0..b7) so we can see
    // what the black backdrop draw actually samples at every binding.
    self._wgBgAll = self._wgBgAll || {};
    let a = "";
    for (let i = 0; i < count; i++) {
      const bb = u[3 + i * 5], kk = u[3 + i * 5 + 1], rr = u[3 + i * 5 + 2];
      if (kk !== 1) continue;
      const tt = webGpuObjects.textures.get(rr);
      a += ` b${bb}=tex#${rr}` +
        (tt ? `(${tt.tex.width}x${tt.tex.height})` : "(?)");
      // §28: stash the backdrop's b1/b2 non-dummy textures so the
      // periodic DIAG-cpy readback dumps their content (is tex#5499
      // the real backdrop image, or also black?).
      if ((bb === 1 || bb === 2) && tt && !(tt.tex.width === 1)) {
        self._wgCpyExtra = self._wgCpyExtra || new Set();
        if (self._wgCpyExtra.size < 24) self._wgCpyExtra.add(rr);
      }
    }
    self._wgBgAll[id] = a;
  }
  try {
    webGpuObjects.bindGroups.set(id,
      renderGpu.device.createBindGroup({ layout, entries }));
  } catch (e) {
    if (!self._webGpuBgErr) {
      self._webGpuBgErr = true;
      console.log(`[webgpu-bg] createBindGroup group=${group} threw: ${e?.message || e}`);
    }
  }
}

// Day-33 grind: GPU texture-to-texture blit for the EFB→XFB resolve
// (and EFB copies). Same-format same-size → exact copyTextureToTexture;
// otherwise (the rgba8unorm EFB → bgra8unorm XFB resolve) a sampled
// fullscreen-triangle render pass that also handles the format
// conversion + src/dst sub-rect. Lazily built, pipeline cached per
// destination format.
let blitState = null;
function ensureBlitState() {
  if (blitState) return blitState;
  const dev = renderGpu.device;
  const module = dev.createShaderModule({
    label: "wgpu-blit",
    code: `
struct U { v: vec4<f32> };
@group(0) @binding(0) var t: texture_2d_array<f32>;
@group(0) @binding(1) var sm: sampler;
@group(0) @binding(2) var<uniform> u: U;
struct VO { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VO {
  var p = array<vec2<f32>,3>(vec2<f32>(-1.,-1.), vec2<f32>(3.,-1.), vec2<f32>(-1.,3.));
  let xy = p[vi];
  var o: VO;
  o.pos = vec4<f32>(xy, 0., 1.);
  let base = vec2<f32>((xy.x + 1.) * 0.5, (1. - xy.y) * 0.5);
  o.uv = base * u.v.xy + u.v.zw;
  return o;
}
@fragment fn fs(i: VO) -> @location(0) vec4<f32> {
  return textureSampleLevel(t, sm, i.uv, 0, 0.);
}` });
  const bgl = dev.createBindGroupLayout({
    label: "wgpu-blit-bgl",
    entries: [
      { binding: 0, visibility: 2 /*FRAGMENT*/,
        texture: { sampleType: "float", viewDimension: "2d-array" } },
      { binding: 1, visibility: 2, sampler: { type: "filtering" } },
      { binding: 2, visibility: 1 /*VERTEX*/, buffer: { type: "uniform" } }
    ]
  });
  blitState = {
    module, bgl,
    layout: dev.createPipelineLayout({ bindGroupLayouts: [bgl] }),
    sampler: dev.createSampler({
      magFilter: "linear", minFilter: "linear",
      addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" }),
    pipelines: new Map()
  };
  return blitState;
}
function ensureBlitPipeline(dstFmt) {
  const bs = ensureBlitState();
  let p = bs.pipelines.get(dstFmt);
  if (p) return p;
  try {
    p = renderGpu.device.createRenderPipeline({
      label: `wgpu-blit-${dstFmt}`,
      layout: bs.layout,
      vertex: { module: bs.module, entryPoint: "vs" },
      fragment: { module: bs.module, entryPoint: "fs",
                  targets: [{ format: dstFmt }] },
      primitive: { topology: "triangle-list" }
    });
    bs.pipelines.set(dstFmt, p);
  } catch (e) {
    if (!self._wgBlitPipeErr) {
      self._wgBlitPipeErr = true;
      console.log(`[webgpu-blit] pipeline(${dstFmt}) threw: ${e?.message || e}`);
    }
    return null;
  }
  return p;
}
function blitTexture(enc, s, d, sx, sy, sw, sh, dx, dy, dw, dh,
                     sLayer, sLevel, dLayer, dLevel) {
  const dev = renderGpu.device;
  const sameFmt = s.format === d.format;
  // Exact GPU copy: identical format + no scaling. Handles sub-rect /
  // layers / levels precisely (the common EFB→texture-cache copy, and
  // depth, which can't go through the sampled color blit).
  if (sameFmt && sw === dw && sh === dh) {
    try {
      enc.copyTextureToTexture(
        { texture: s.tex, mipLevel: sLevel, origin: { x: sx, y: sy, z: sLayer } },
        { texture: d.tex, mipLevel: dLevel, origin: { x: dx, y: dy, z: dLayer } },
        { width: sw, height: sh, depthOrArrayLayers: 1 });
    } catch (e) {
      if (!self._wgBlitCopyErr) {
        self._wgBlitCopyErr = true;
        console.log(`[webgpu-blit] copyTexture threw: ${e?.message || e}`);
      }
    }
    return;
  }
  if (s.format.startsWith("depth") || d.format.startsWith("depth")) return;
  const pipe = ensureBlitPipeline(d.format);
  if (!pipe) return;
  const sw0 = s.tex.width || 1, sh0 = s.tex.height || 1;
  // 16-byte uniform per blit (a handful/frame) so concurrent blits in
  // one submit never alias a shared buffer.
  const ubo = dev.createBuffer({ size: 16, usage: 0x40 | 0x8,
                                 mappedAtCreation: true });
  new Float32Array(ubo.getMappedRange()).set(
    [sw / sw0, sh / sh0, sx / sw0, sy / sh0]);
  ubo.unmap();
  try {
    const view = s.tex.createView({ dimension: "2d-array",
      baseArrayLayer: sLayer, arrayLayerCount: 1,
      baseMipLevel: sLevel, mipLevelCount: 1 });
    const bg = dev.createBindGroup({ layout: blitState.bgl, entries: [
      { binding: 0, resource: view },
      { binding: 1, resource: blitState.sampler },
      { binding: 2, resource: { buffer: ubo } } ] });
    const dview = d.tex.createView({ dimension: "2d",
      baseArrayLayer: dLayer, arrayLayerCount: 1,
      baseMipLevel: dLevel, mipLevelCount: 1 });
    const rp = enc.beginRenderPass({ label: "wgpu-blit-pass",
      colorAttachments: [{ view: dview, loadOp: "load", storeOp: "store" }] });
    rp.setPipeline(pipe);
    rp.setViewport(dx, dy, Math.max(1, dw), Math.max(1, dh), 0, 1);
    rp.setBindGroup(0, bg);
    rp.draw(3);
    rp.end();
    if (!self._wgBlitOnce) {
      self._wgBlitOnce = true;
      console.log(`[webgpu-blit] first blit ${s.format} ${sw0}x${sh0} ` +
        `src(${sx},${sy} ${sw}x${sh}) -> ${d.format} ` +
        `dst(${dx},${dy} ${dw}x${dh})`);
    }
  } catch (e) {
    if (!self._wgBlitErr) {
      self._wgBlitErr = true;
      console.log(`[webgpu-blit] render blit threw: ${e?.message || e}`);
    }
  }
}

// DIAGNOSTIC (revertible): after the producer's present, blit the raw
// EFB colour texture straight onto the canvas, bypassing the XFB-copy
// + present-blit chain. Isolates "geometry not visible": if the canvas
// then shows Melee geometry, the EFB is correct and the XFB/present
// chain (scale/UV) is the bug; if still uniform, the EFB itself is
// wrong (transform/depth). Flip to false to restore normal present.
const DIAG_EFB_TO_CANVAS = true;
// DIAGNOSTIC (revertible): force depthCompare "always" on every
// pipeline (see resolvePipeline) to bisect the black-EFB cause.
const DIAG_DEPTH_ALWAYS = false;  // §28ag: bisect done — dark 1P menu is NOT depth (still dark with depth bypassed) ⇒ blend/TEV/material/texture construct
// §28ad/§28af ROOT FIX: WebGPU can't carry Dolphin's reverse-Z in
// the viewport (Dawn rejects minDepth>maxDepth). Master enable for
// the per-PASS reverse-Z compensation (flip GX depth compare
// less↔greater + clear depth to far=0.0) — applied ONLY to
// reverse-Z passes (vp near>far); normal-Z menu/UI passes keep the
// GX compare + clear=1.0. See resolvePipeline / BEGIN_PASS (§28af).
// §28as REVERTED to true (paired with producer flag=true). flag=
// false rendered dark + hung even with fog decoupled (a 2nd
// coupling remains); back to the verified §28ao render+smooth
// state (flickers on mixed passes, root proven §28aq).
// §28at: coupling-(2) found & C++-decoupled (the depth-inversion
// cluster, api_type==Vulkan-gated). Producer flag now false →
// uniform normal-Z [0,1] viewports, no mixed reverse/normal pass.
// §28at: SINGLE convention = the reverse-Z one flag=true-3D proved
// works (dcv=0.0 + GEQUAL). Flip the GX compare for ALL rzRelevant
// draws (not per-pass-revZ — at flag=false every viewport is the
// same (0,1), so the §28af `&& revZ` gate never fires; the flip is
// applied uniformly via REVZ_COMPARE_FLIP_ALL below). One convention
// for every draw in every pass ⇒ the §28aq mixed-pass flicker is
// structurally impossible AND 3D/title renders (matches flag=true).
const REVZ_COMPARE_FLIP = true;
// §28aw: decisive dark-menu experiment — force FS textureSampleBias
// array-layer to 0 (menu textures are single-layer, bound 2d-array;
// a non-zero texgen layer ⇒ out-of-range sample ⇒ black). Gated so
// it's toggleable/revertible; kept only if menu renders AND title/3D
// does not regress.
// §28aw FALSIFIED: forcing menu FS textureSampleBias layer→0 left the
// menu identically dark (hash unchanged) ⇒ array-layer is NOT the
// root. Flag kept inert (false) as a documented negative result.
const S28AW_FORCE_TEXLAYER0 = false;
// §28ax CONFIRMED: const-magenta FILLED the menu ⇒ draws reach the
// framebuffer with valid full-screen geometry; the dark is purely
// FS-internal. §28ay: dolphin_fn_1_→white showed only sparse white
// lines + a dark-blue region (NOT the full menu) ⇒ the texture
// sample WAS ~0 (secondary) AND the TEV/PS-constant chain collapses
// the bulk output regardless (DOMINANT). Both flags reverted to
// false (diagnostic shader rewrites must never ship); findings in
// SESSION §28ax/§28ay. Next: pinpoint which TEV PS-constant/UBO
// member is delivered ~0 for the menu draw.
const S28AX_FS_CONST = false;
const S28AY_SAMPLER_WHITE = false;
// §28bb FALSIFIED: textureSampleLevel(…,0.0) gave the IDENTICAL dark
// menu (hash 0x-680ec5c0, 0 valErr) ⇒ sample-mechanics (LOD/bias/
// mip) is NOT the root. By the §28ba decision rule this isolates the
// root to the UV addressing the WRONG atlas sub-region (the GC
// texgen/posttransform path, §28an/al). Flag reverted (false).
const S28BB_SAMPLE_LOD0 = false;
// §28bf RESULT: UV-as-colour showed a spatially-VARYING gradient
// (non-degenerate, not uniformly zero) ⇒ the texgen produces a real
// varying UV. Combined with §28be (posttransform verified correct at
// the right offset), every measurable value is correct yet the
// sample is ~0 — a systemic texgen/atlas/sample mismatch needing
// reference-texel comparison, not more value-probing. Flag reverted.
const S28BF_SHOW_UV = false;
// §28at: apply the compare flip uniformly (drop the per-pass `revZ`
// gate). The single reverse-Z convention is correct for every
// rzRelevant draw now that flag=false made all viewports uniform.
const REVZ_COMPARE_FLIP_ALL = true;
// DIAGNOSTIC (revertible): force cullMode "none" + skip scissor so no
// primitive is culled/scissored. With EFB→canvas: geometry appears ⇒
// it was rasterization state (cull/scissor); still black ⇒ VS math /
// vertex fetch / clip-space.
const DIAG_RASTER_OPEN = false;  // §28w: cull CONCLUSIVELY ruled out for the 3D region (clean A-only running repro)

// Set true once the WebGPU hardware renderer (cmd-ring executor) has
// presented a frame; suppresses the legacy CPU-framebuffer canvas blit
// in runPresentationLoop so the two don't fight over renderGpu.context.
let cmdRingOwnsCanvas = false;
const webGpuExecStats = {
  beginFb0: 0, beginFbN: 0, draw: 0, drawIdx: 0, setPipe: 0,
  setBg: 0, present: 0, missPipe: 0, missBg: 0, skipDraw: 0, lastLog: 0
};

function drainWebGpuCmdRing() {
  const ring = webGpuCmdRing;
  if (!ring || !renderGpu) return;
  const write = Atomics.load(ring.headerI32, 0) >>> 0;
  let read = Atomics.load(ring.headerI32, 1) >>> 0;
  // §27 post-load watchdog: log BEFORE the empty-ring early return so
  // we see whether `write` keeps advancing (producer alive) after
  // State::Load, or freezes (producer/video-pthread stalled).
  if (self._postLoadProbeUntil && Date.now() < self._postLoadProbeUntil) {
    const nowMs = Date.now();
    // NOTE: do NOT `| 0` a Date.now() timestamp — it truncates to a
    // garbage 32-bit value and the throttle never fires (spam). Plain
    // Number compare, ~1 s cadence.
    if (nowMs - (self._postLoadProbeLast || 0) >= 1000) {
      self._postLoadProbeLast = nowMs;
      const s = webGpuExecStats;
      console.log(`[postload-probe] dt=` +
        `${((nowMs - self._postLoadProbeT0) / 1000).toFixed(1)}s ` +
        `ring write=${write} read=${read} pend=${(write - read) >>> 0} ` +
        `present=${s.present} draw=${s.draw} drawIdx=${s.drawIdx} ` +
        `beginFb0=${s.beginFb0} beginFbN=${s.beginFbN} ` +
        `setPipe=${s.setPipe} missPipe=${s.missPipe} ` +
        `setBg=${s.setBg} missBg=${s.missBg} ` +
        `efbId=${self._wgEfbColorId} tex=${webGpuObjects.textures.size} ` +
        `pipes=${webGpuObjects.pipelines.size} ` +
        `bg=${webGpuObjects.bindGroups.size}`);
    }
  }
  if (write === read) return;

  // NOTE (Day-27 audit): the Atomics.load(write) above is seq-cst.
  // The slot reads below are plain (non-atomic) Uint32/Float32 reads.
  // Per the abstract ECMAScript SAB memory model that's technically
  // unordered, but on a wasm-backed SharedArrayBuffer wasm seq-cst
  // atomics emit full memory fences, so every slot byte written
  // before the producer's release-store on `write` is visible here.
  // This is a deliberate, documented reliance on wasm SAB semantics
  // (not a portable-JS guarantee) — kept for zero-copy speed.
  const heap = moduleInstance.HEAPU8;
  const f32 = new Float32Array(heap.buffer);
  const u32 = new Uint32Array(heap.buffer);
  const dev = renderGpu.device;
  const q = dev.queue;
  let enc = null;
  let pass = null;
  let passW = 0;
  let passH = 0;
  let passColorFmt = null;
  let passDepthFmt = null;
  let passHasPipe = false;
  // §28j: per-pass bind-group validity. The fixed pipeline layout
  // declares 3 groups (l0/l1/l2); WebGPU requires ALL declared groups
  // to hold a valid bind group at draw time. If replayCreateBindGroup
  // skipped one (a referenced texture wasn't ready) the SET_BIND_GROUP
  // misses and the slot is unbound/stale → the draw is invalid → the
  // whole frame's queue.submit() throws → the ENTIRE frame presents
  // BLACK (the user-visible "mostly black, occasional flash"). Track
  // which slots currently hold a valid bind group and SKIP draws that
  // aren't fully bound, so one bad draw no longer poisons the frame.
  const bgValid = [false, false, false];
  let errScope = false;
  // One-shot present-path diagnostic: per-pass tally of pipeline/bind/
  // draw activity for the backbuffer (fb=0) and XFB-format (fb=47)
  // passes — tells us whether the present/XFB-copy draw actually runs.
  let passFbId = -1;
  let pd = { pipeOk: 0, pipeMiss: 0, bgOk: 0, bgMiss: 0, draw: 0, drawIdx: 0 };
  self._wgPassDiag = self._wgPassDiag || {};
  const flushPassDiag = () => {
    if (passFbId < 0) return;
    const key = passFbId === 0 ? "fb0" : "fb" + passFbId;
    const n = (self._wgPassDiag[key] = (self._wgPassDiag[key] || 0) + 1);
    // [webgpu-DIAG-cpypass] EFB-copy target passes (the 640x480
    // rgba8unorm depth-less RTs found opaque-black, §15a): does the
    // copy draw actually run, and with a pipeline+bind group?
    const isCopyTgt = self._wgCopyTargets &&
      self._wgCopyTargets.has(passFbId);
    // §28y: also fire on a wall-clock cadence (every 5 s, capped 30×)
    // so the copy pass is observable DEEP in the A-only black-3D
    // dwell (n≫6 there) — does the EFB→640×480 copy draw actually
    // run, with what srcTex/pipe/bg, when the copies read all-white?
    let _cpWcOk = false;
    if (isCopyTgt) {
      const _cn = Date.now();
      self._wgCpPassT0 = self._wgCpPassT0 || _cn;
      const _ct = Math.floor((_cn - self._wgCpPassT0) / 5000);
      self._wgCpPassWc = (self._wgCpPassWc == null) ? -1 : self._wgCpPassWc;
      if (_ct !== self._wgCpPassWc && _ct < 30) {
        self._wgCpPassWc = _ct;
        _cpWcOk = true;
      }
    }
    if (isCopyTgt && (n <= 6 || _cpWcOk)) {
      const _ct = webGpuObjects.pipeTpl.get(self._wgCurPipe);
      console.log(`[webgpu-DIAG-cpypass] pass#${n} fb=${passFbId} ` +
        `pipeOk=${pd.pipeOk} pipeMiss=${pd.pipeMiss} bgOk=${pd.bgOk} ` +
        `bgMiss=${pd.bgMiss} draw=${pd.draw} drawIdx=${pd.drawIdx} ` +
        `srcTex=${self._wgCpySrc != null ? "tex#" + self._wgCpySrc : "?"} ` +
        `pipe=${self._wgCurPipe} ${_ct ? _ct.s28dbg : "?"} ` +
        `${passColorFmt}/${passDepthFmt} ${passW}x${passH}`);
      // §28z: one-shot dump the 640×480 EFB-copy's FS WGSL — the
      // shader that outputs white instead of mirroring tex#14. Keyed
      // off the copy pipeline (not the broken 4096 heuristic).
      if (passW === 640 && passH === 480 && _ct && !self._wgCpFsDone &&
          self._wgFsSrc && self._wgFsSrc[_ct.fsId] !== undefined) {
        self._wgCpFsDone = true;
        const w = self._wgFsSrc[_ct.fsId].replace(/\s+/g, " ");
        console.log(`[s28z-cpfs] fb=${passFbId} pipe=${self._wgCurPipe} ` +
          `fs#${_ct.fsId} vs#${_ct.vsId} len=${w.length} ` +
          `nSample=${(w.match(/textureSample/g) || []).length}`);
        for (let o = 0; o < w.length && o < 4200; o += 700)
          console.log(`[s28z-cpfs ${o}] ${w.slice(o, o + 700)}`);
      }
    }
    if ((passFbId === 0 || passFbId === 47) && n <= 3) {
      console.log(`[webgpu-exec] pass#${n} fb=${passFbId} ` +
        `pipeOk=${pd.pipeOk} pipeMiss=${pd.pipeMiss} bgOk=${pd.bgOk} ` +
        `bgMiss=${pd.bgMiss} draw=${pd.draw} drawIdx=${pd.drawIdx} ` +
        `${passColorFmt}/${passDepthFmt} ${passW}x${passH}`);
    }
    // [webgpu-DIAG-efbpass] The EFB colour pass (depth-attached
    // tex#14) sampled across the run. Decides menu-black: real draws
    // but black EFB ⇒ state/shader; ~0 draws ⇒ menu uses another path.
    if (self._wgEfbColorId && passFbId === self._wgEfbColorId &&
        (n % 240) === 1) {
      console.log(`[webgpu-DIAG-efbpass] p=${webGpuExecStats.present} ` +
        `n=${n} fb=${passFbId} pipeOk=${pd.pipeOk} pipeMiss=${pd.pipeMiss} ` +
        `bgOk=${pd.bgOk} bgMiss=${pd.bgMiss} draw=${pd.draw} ` +
        `drawIdx=${pd.drawIdx} ${passColorFmt}/${passDepthFmt} ` +
        `${passW}x${passH}`);
    }
    // §28k: where do intro-cutscene / title / main-menu draws go?
    // Those screens render BLACK with zero draws into tex#14 (the EFB
    // pass). Tally per-fbId draw totals over the run and dump the full
    // map periodically so we can see whether they target a different
    // FB / copy target instead of the depth-attached EFB.
    if (pd.draw + pd.drawIdx > 0) {
      self._wgFbDraws = self._wgFbDraws || {};
      const fk = passFbId === 0 ? "fb0" : "fb" + passFbId;
      const e = self._wgFbDraws[fk] || { d: 0, passes: 0, efb: 0 };
      e.d += pd.draw + pd.drawIdx; e.passes += 1;
      if (passFbId === self._wgEfbColorId) e.efb = 1;
      self._wgFbDraws[fk] = e;
    }
    self._wgFbDumpN = (self._wgFbDumpN || 0) + 1;
    if ((self._wgFbDumpN % 600) === 0) {
      const rows = Object.entries(self._wgFbDraws || {})
        .map(([k, v]) => `${k}${v.efb ? "*EFB" : ""}=${v.d}/${v.passes}p`)
        .join(" ");
      console.log(`[s28k-fbdraws] p=${webGpuExecStats.present} ` +
        `efbId=${self._wgEfbColorId} ${rows}`);
    }
    passFbId = -1;
    pd = { pipeOk: 0, pipeMiss: 0, bgOk: 0, bgMiss: 0, draw: 0, drawIdx: 0 };
  };
  const ensureEnc = () => {
    if (!enc) {
      dev.pushErrorScope("validation");
      errScope = true;
      enc = dev.createCommandEncoder({ label: "dolphin-frame" });
    }
    return enc;
  };
  const submitEnc = () => {
    if (!enc) return;
    try { q.submit([enc.finish()]); } catch (e) {}
    enc = null;
    if (errScope) {
      errScope = false;
      dev.popErrorScope().then((er) => {
        if (er && !self._wgValErr) {
          self._wgValErr = true;
          console.log(`[webgpu-exec] VALIDATION: ${String(er.message).slice(0, 320)}`);
        }
      }).catch(() => {});
    }
  };
  const endPass = () => {
    if (pass) { try { pass.end(); } catch (e) {} pass = null; flushPassDiag(); }
  };
  const heapCopy = (off, len) => heap.slice(off, off + len);
  // §28ao flicker fix: when BEGIN_PASS is reached but its back-to-back
  // SET_VIEWPORT isn't visible in the ring yet (consumer drained
  // between the producer's two separate atomic Push() stores), the
  // §28af peek misses → stale _wgPassRevZ → wrong baked depthClearValue
  // for the whole pass → intermittent flicker. Defer the BEGIN_PASS to
  // the next drain (don't advance `read`) so the SET_VIEWPORT is
  // present and revZ is correct. Bounded so a stalled producer can't
  // wedge the ring forever.
  let deferBeginPass = false;
  while (read !== write) {
    const recWord = (ring.slotsBase + (read % ring.capacity) * 32) >>> 2;
    const op = u32[recWord];
    if (op === WGPU_CMD_OP_BEGIN_PASS && ((read + 1) >>> 0) === write) {
      self._wgBpDefer = (self._wgBpDefer || 0) + 1;
      if (self._wgBpDefer <= 8) { deferBeginPass = true; break; }
      // budget exhausted: fall through and process with last revZ.
    } else if (op === WGPU_CMD_OP_BEGIN_PASS) {
      self._wgBpDefer = 0;
    }
    try {
      switch (op) {
        case WGPU_CMD_OP_CREATE_SHADER:
          replayCreateShader(u32[recWord + 1], u32[recWord + 2],
                             u32[recWord + 3], u32[recWord + 4]);
          break;
        case WGPU_CMD_OP_CREATE_PIPELINE_CFG:
          replayCreatePipelineCfg(u32[recWord + 1], u32[recWord + 2],
                                  u32[recWord + 3]);
          break;
        case WGPU_CMD_OP_CREATE_PIPELINE:
          replayCreatePipeline(u32[recWord + 1], u32[recWord + 2],
                               u32[recWord + 3], u32[recWord + 4]);
          break;
        case WGPU_CMD_OP_CREATE_BUFFER: {
          const id = u32[recWord + 1];
          if (!webGpuObjects.buffers.has(id)) {
            const size = Math.max(16, (u32[recWord + 2] + 3) & ~3);
            webGpuObjects.buffers.set(id,
              dev.createBuffer({ size, usage: u32[recWord + 3] }));
            // The utility UBO is the unique 4096-byte uniform buffer
            // (kUtilUboSize). Track its id so we can dump what
            // UploadUtilityUniforms actually writes (src_offset/size
            // for the EFB-copy VS).
            if (u32[recWord + 2] === 4096) self._wgUtilBuf = id;
            // §28-vtxdata: the main vertex buffer is the unique 16 MB
            // buffer (kVertexBufferSize). Track its id so we can read
            // the uploaded per-vertex texcoord bytes for the dark-menu
            // probe (zero ⇒ GX position-texgen; non-zero ⇒ posttransform).
            if (u32[recWord + 2] === 16777216) self._wgVtxBufId = id;
          }
          break;
        }
        case WGPU_CMD_OP_UPLOAD_BUFFER: {
          const buf = webGpuObjects.buffers.get(u32[recWord + 1]);
          if (buf) {
            // writeBuffer requires offset & size multiples of 4
            // (producer already aligns; round len defensively).
            const len = (u32[recWord + 4] + 3) & ~3;
            const srcP = u32[recWord + 3];
            // DIAG one-shot per buffer id: dump what we actually write.
            // The VS UBO is the big one; floats @byte32=posnormalmatrix,
            // @byte128=projection. Zeros here ⇒ upload path broken;
            // valid ⇒ the GPU UBO is fine and the bug is VS exec /
            // vertex fetch.
            const bid = u32[recWord + 1];
            self._wgUbN = (self._wgUbN || 0) + 1;
            // First few + periodic so steady-state UBO uploads are
            // visible (one-shot only caught the pre-SetConstants zero).
            if (self._wgUbN <= 6 || (self._wgUbN % 4000) === 0) {
              const ff = new Float32Array(moduleInstance.HEAPU8.buffer,
                                          srcP, Math.min(len, 160) >>> 2);
              console.log(`[webgpu-DIAG-ub] id=${bid} dst=${u32[recWord+2]} ` +
                `len=${len} f0=${ff[0]?.toFixed(3)},${ff[1]?.toFixed(3)} ` +
                `pnm@32=${ff[8]?.toFixed(3)},${ff[9]?.toFixed(3)},${ff[10]?.toFixed(3)} ` +
                `proj@128=${ff[32]?.toFixed(3)},${ff[33]?.toFixed(3)},` +
                `${ff[34]?.toFixed(3)},${ff[35]?.toFixed(3)}`);
            }
            // §28b: PixelShaderConstants has fogcolor (int4 @byte432),
            // fogi (int4 @448), fogf (float4 @464). The backdrop FS
            // lerps to fogcolor by a fogf-driven factor → if fogcolor
            // is ~0 the untextured backdrop goes black. Dump fog for
            // PS-sized uploads (len ≥ 480) so we can see if fogcolor
            // is zero / fogf forces full fog at difficulty-select.
            // PixelShaderConstants is ~1536 bytes (VS ~4112, GS small);
            // the per-draw uniform ring writes the PS slice at that len.
            if (len >= 1500 && len <= 1700) {
              self._wgFogN = (self._wgFogN || 0) + 1;
              if (self._wgFogN <= 6 || (self._wgFogN % 1500) === 0) {
                const ib = new Int32Array(moduleInstance.HEAPU8.buffer,
                                          srcP + 432, 8);   // fogcolor+fogi
                const fb = new Float32Array(moduleInstance.HEAPU8.buffer,
                                            srcP + 464, 4);  // fogf
                // §28e: TEV color registers — I_COLORS @0 (int4[4]),
                // I_KCOLORS @64 (int4[4]), I_ALPHA @128 (int4). If the
                // untextured backdrop TEV reads these and they're 0,
                // that's why it's black (vs a fog problem).
                const cb = new Int32Array(moduleInstance.HEAPU8.buffer,
                                          srcP, 36);  // colors+kcolors+alpha
                console.log(`[s28-fog] id=${bid} len=${len} ` +
                  `fogcolor=${ib[0]},${ib[1]},${ib[2]},${ib[3]} ` +
                  `fogi=${ib[4]},${ib[5]},${ib[6]},${ib[7]} ` +
                  `fogf=${fb[0]?.toFixed(4)},${fb[1]?.toFixed(4)},` +
                  `${fb[2]?.toFixed(4)},${fb[3]?.toFixed(4)}`);
                // §28f: I_TEXDIMS @144 (int4[8]); the textured-draw FS
                // normalises texcoords by f32(I_TEXDIMS[map].xy*128).
                // If these are 0 ⇒ div-by-0 ⇒ NaN uv ⇒ sample 0 ⇒
                // black despite a valid texture+konst.
                const td = new Int32Array(moduleInstance.HEAPU8.buffer,
                                          srcP + 144, 16);  // texdims[0..3]
                console.log(`[s28-creg] id=${bid} ` +
                  `c0=${cb[0]},${cb[1]},${cb[2]},${cb[3]} ` +
                  `c1=${cb[4]},${cb[5]},${cb[6]},${cb[7]} ` +
                  `c2=${cb[8]},${cb[9]},${cb[10]},${cb[11]} ` +
                  `c3=${cb[12]},${cb[13]},${cb[14]},${cb[15]} ` +
                  `k0=${cb[16]},${cb[17]},${cb[18]},${cb[19]} ` +
                  `alpha=${cb[32]},${cb[33]},${cb[34]},${cb[35]}`);
                console.log(`[s28-texdim] id=${bid} ` +
                  `td0=${td[0]},${td[1]},${td[2]},${td[3]} ` +
                  `td1=${td[4]},${td[5]},${td[6]},${td[7]} ` +
                  `td2=${td[8]},${td[9]},${td[10]},${td[11]} ` +
                  `td3=${td[12]},${td[13]},${td[14]},${td[15]}`);
              }
              // [s28av] snapshot the freshest PSBlock (every PS-sized
              // write, NOT throttled) so the DRAW_INDEXED probe can read
              // I_TEXDIMS (member_3 @byte144) for the effective-UV calc.
              if (!self._wgPsSnap || self._wgPsSnap.byteLength < len)
                self._wgPsSnap = new Uint8Array(len);
              self._wgPsSnap.set(
                new Uint8Array(moduleInstance.HEAPU8.buffer, srcP, len));
              self._wgPsSnapLen = len;
            }
            // [s28be] snapshot the VS UBO (VertexShaderConstants ~4112B;
            // PS is ~1536). The §28an baked probe read posttransform at
            // the WRONG offset (byte 1280 = transformmatrices) so it was
            // NEVER verified. Correct C++ offsets (ConstantManager.h):
            // texmatrices@896, posttransformmatrices@2816.
            if (len >= 4000 && len <= 4200) {
              if (!self._wgVsSnap || self._wgVsSnap.byteLength < len)
                self._wgVsSnap = new Uint8Array(len);
              self._wgVsSnap.set(
                new Uint8Array(moduleInstance.HEAPU8.buffer, srcP, len));
              self._wgVsSnapLen = len;
            }
            // [webgpu-DIAG-utilubo] EFB-copy VS reads src_offset(.xy)
            // + src_size(.xy) from this UBO. If src_size≈0 every vertex
            // gets the same uv ⇒ samples one EFB texel ⇒ uniform black.
            // §28y: also wall-clock-sample (every 5 s, capped 24×) so
            // the EFB-copy src_size is observable DEEP in the A-only
            // black-3D dwell (src_size≈0 ⇒ degenerate UV ⇒ uniform
            // white copy = the §28x root).
            let _utWcOk = false;
            if (bid === self._wgUtilBuf) {
              const _un = Date.now();
              self._wgUtUbT0 = self._wgUtUbT0 || _un;
              const _ut = Math.floor((_un - self._wgUtUbT0) / 5000);
              self._wgUtUbWc = (self._wgUtUbWc == null) ? -1 : self._wgUtUbWc;
              if (_ut !== self._wgUtUbWc && _ut < 24) {
                self._wgUtUbWc = _ut;
                _utWcOk = true;
              }
            }
            if (bid === self._wgUtilBuf &&
                ((self._wgUtilUbN = (self._wgUtilUbN || 0) + 1) <= 8
                 || _utWcOk)) {
              const uf = new Float32Array(moduleInstance.HEAPU8.buffer,
                                          srcP, Math.min(len, 64) >>> 2);
              const ui = new Uint32Array(moduleInstance.HEAPU8.buffer,
                                         srcP, Math.min(len, 64) >>> 2);
              console.log(`[webgpu-DIAG-utilubo] id=${bid} len=${len} ` +
                `src_offset=${uf[0]?.toFixed(4)},${uf[1]?.toFixed(4)} ` +
                `src_size=${uf[2]?.toFixed(4)},${uf[3]?.toFixed(4)} ` +
                `filt=${ui[4]},${ui[5]},${ui[6]} gamma_rcp=${uf[7]?.toFixed(3)} ` +
                `clamp=${uf[8]?.toFixed(4)},${uf[9]?.toFixed(4)} ` +
                `pxh=${uf[10]?.toFixed(5)}`);
            }
            // §28-vtxdata: snapshot the vertex batch bytes from the
            // HEAP before they go to the GPU (this is the only window
            // to read them). Keyed by dst_offset; bounded to 64 batches.
            if (bid === self._wgVtxBufId) {
              if (!self._wgVbSnap) self._wgVbSnap = new Map();
              const dstOff = u32[recWord + 2] & ~3;
              const snap = new Uint8Array(len);
              snap.set(new Uint8Array(moduleInstance.HEAPU8.buffer, srcP, len));
              self._wgVbSnap.set(dstOff, snap);
              if (self._wgVbSnap.size > 64)
                self._wgVbSnap.delete(self._wgVbSnap.keys().next().value);
            }
            q.writeBuffer(buf, u32[recWord + 2] & ~3,
                          heapCopy(srcP, len));
          }
          break;
        }
        case WGPU_CMD_OP_CREATE_TEXTURE: {
          const id = u32[recWord + 1];
          if (!webGpuObjects.textures.has(id)) {
            const fmt = WGPU_TEX_FORMAT[u32[recWord + 4]] || "rgba8unorm";
            const layers = Math.max(1, u32[recWord + 6] || 1);
            const tex = dev.createTexture({
              size: [Math.max(1, u32[recWord + 2]),
                     Math.max(1, u32[recWord + 3]), layers],
              format: fmt, usage: u32[recWord + 5]
            });
            webGpuObjects.textures.set(id,
              { tex, format: fmt, layers, view2dArray: null });
          }
          break;
        }
        case WGPU_CMD_OP_UPLOAD_TEXTURE: {
          const t = webGpuObjects.textures.get(u32[recWord + 1]);
          const uz = u32[recWord + 7];
          if (t && !t.format.startsWith("depth") && uz < t.layers) {
            const src = u32[recWord + 2], bpr = u32[recWord + 3];
            const w = u32[recWord + 4], h = u32[recWord + 5];
            // DIAG one-shot per tex id: confirm uploaded pixels aren't
            // all-zero (→ black sampling). Dumps first 4 RGBA texels.
            self._wgUtN = self._wgUtN || {};
            const tid = u32[recWord + 1];
            if (!self._wgUtN[tid] &&
                (self._wgUtTot = (self._wgUtTot || 0) + 1) <= 14) {
              self._wgUtN[tid] = true;
              const px = new Uint8Array(moduleInstance.HEAPU8.buffer, src,
                                        Math.min(bpr * h, 16));
              let nz = 0;
              const chk = new Uint8Array(moduleInstance.HEAPU8.buffer, src,
                                         Math.min(bpr * h, 4096));
              for (let q2 = 0; q2 < chk.length; q2++) if (chk[q2]) { nz++; }
              console.log(`[webgpu-DIAG-ut] tex#${tid} ${w}x${h} bpr=${bpr} ` +
                `mip=${u32[recWord+6]} px0=${px[0]},${px[1]},${px[2]},${px[3]} ` +
                `px1=${px[4]},${px[5]},${px[6]},${px[7]} nz=${nz}/${chk.length}`);
            }
            q.writeTexture(
              { texture: t.tex, mipLevel: u32[recWord + 6],
                origin: { x: 0, y: 0, z: uz } },
              heapCopy(src, bpr * h),
              { offset: 0, bytesPerRow: bpr, rowsPerImage: h },
              { width: w, height: h, depthOrArrayLayers: 1 });
          }
          break;
        }
        case WGPU_CMD_OP_CREATE_SAMPLER: {
          const id = u32[recWord + 1];
          if (!webGpuObjects.samplers.has(id)) {
            webGpuObjects.samplers.set(id, dev.createSampler({
              magFilter: "linear", minFilter: "linear",
              mipmapFilter: "linear", addressModeU: "repeat",
              addressModeV: "repeat"
            }));
          }
          break;
        }
        case WGPU_CMD_OP_CREATE_BIND_GROUP:
          replayCreateBindGroup(u32[recWord + 1], u32[recWord + 2],
                                u32[recWord + 3]);
          break;
        case WGPU_CMD_OP_BEGIN_PASS: {
          endPass();
          ensureEnc();
          const fbId = u32[recWord + 1];
          const loadOp = u32[recWord + 6] === 1 ? "clear" : "load";
          const depthId = u32[recWord + 7];
          // §28af: the producer emits SET_VIEWPORT immediately after
          // BEGIN_PASS (cached vp re-emit). Peek it to learn this
          // pass's reverse-Z BEFORE the depth attachment (whose
          // depthClearValue is fixed at beginRenderPass and cannot be
          // changed later) is built. reverse-Z ⇒ clear depth to far
          // 0.0; normal-Z ⇒ far 1.0 (the GX/Dolphin default). If the
          // peek isn't available yet, keep the last-seen pass state.
          if (((read + 1) >>> 0) !== write) {
            const nrw = (ring.slotsBase + ((read + 1) % ring.capacity) * 32) >>> 2;
            if (u32[nrw] === WGPU_CMD_OP_SET_VIEWPORT)
              self._wgPassRevZ = f32[nrw + 5] > f32[nrw + 6];
          }
          // §28at: SINGLE non-reverse convention (producer flag=false
          // + C++ inversion cluster decoupled). Bake a CONSTANT far
          // depth clear for EVERY pass — a per-pass dcv is exactly
          // the §28aq flicker mechanism (one baked value can't serve a
          // mixed pass). With uniform normal-Z [0,1] viewports and the
          // [s28at-vp] PROVED flag=false makes EVERY viewport arrive
          // T(near=0,far=1) → consumer setViewport(0,1) for all — the
          // SAME setViewport flag=true-3D produces after swapping its
          // raw (1,0). flag=true-3D RENDERS that with dcv=0.0 + GEQUAL
          // (reverse-Z carried in the projection/VS, which is NOT
          // flag-keyed). So the single convention = dcv=0.0 + flipped
          // compare for ALL rzRelevant draws (uniform — see
          // REVZ_COMPARE_FLIP). dcv=1.0/unflipped was backwards = black;
          // §28as's dcv=0.0-but-unflipped was the half-right mismatch.
          const dcv = 0.0;
          // §28aq DISCRIMINATING PROBE: record the revZ baked into
          // this pass's depthClearValue; the SET_VIEWPORT handler
          // logs when a later viewport in the SAME pass disagrees
          // (⇒ the bake-time value was wrong = the flicker source).
          self._wgPassRevZAtBegin = self._wgPassRevZ;
          self._wgBpSeq = (self._wgBpSeq || 0) + 1;
          self._wgVpInPass = 0;
          if (depthId && (self._wgAqN = (self._wgAqN || 0) + 1) <= 60) {
            console.log(`[s28aq-bp] bp#${self._wgBpSeq} fb=${fbId} ` +
              `depth=${depthId} dcv=${dcv} revZ=${self._wgPassRevZ ? 1 : 0} ` +
              `peeked=${(((read + 1) >>> 0) !== write &&
                u32[(ring.slotsBase + ((read + 1) % ring.capacity) * 32) >>> 2]
                  === WGPU_CMD_OP_SET_VIEWPORT) ? 1 : 0}`);
          }
          let colorView;
          if (fbId === 0) {
            webGpuExecStats.beginFb0++;
            const cur = renderGpu.context.getCurrentTexture();
            colorView = cur.createView();
            passW = cur.width;
            passH = cur.height;
            passColorFmt = renderGpu.format;
          } else {
            webGpuExecStats.beginFbN++;
            const ct = webGpuObjects.textures.get(fbId);
            if (!ct) break;
            colorView = ct.tex.createView();
            passW = ct.tex.width;
            passH = ct.tex.height;
            passColorFmt = ct.format;
            // DIAG: which texture ids are ever render targets (+size).
            // Cross-ref with tex#69 (640x480 green, sampled at b1
            // everywhere): if 640x480 ids never appear here, they're
            // pure XFB-from-RAM ⇒ EFB-copy-to-RAM (staging) is stubbed.
            self._wgRT = self._wgRT || {};
            if (!self._wgRT[fbId]) {
              self._wgRT[fbId] = true;
              console.log(`[webgpu-DIAG-rt] render-target tex#${fbId} ` +
                `${ct.tex.width}x${ct.tex.height} ${ct.format} depth=${depthId}`);
            }
            // [webgpu-DIAG-cpy] EFB-copy color targets: depth-less
            // rgba8unorm RTs that aren't the bgra8 XFB. These are the
            // textures textured draws later SAMPLE — if they are empty
            // post-copy-to-vram, every consumer is black (§15a).
            if (!depthId && ct.format === "rgba8unorm" &&
                ct.tex.width <= 1024) {
              self._wgCopyTargets = self._wgCopyTargets || new Set();
              self._wgCopyTargets.add(fbId);
              self._wgCpySrc = null;
            }
            // The XFB blit target: the large bgra8unorm depth-less RT.
            // If menu content lives HERE while the EFB is cleared, the
            // interim DIAG_EFB_TO_CANVAS present (EFB only) shows black.
            if (!depthId && ct.format === "bgra8unorm" &&
                ct.tex.width >= 1024) {
              self._wgXfbId = fbId;
            }
          }
          passDepthFmt = (depthId && webGpuObjects.textures.get(depthId))
            ? webGpuObjects.textures.get(depthId).format : null;
          const desc = {
            colorAttachments: [{
              view: colorView,
              clearValue: { r: f32[recWord + 2], g: f32[recWord + 3],
                            b: f32[recWord + 4], a: f32[recWord + 5] },
              loadOp, storeOp: "store"
            }]
          };
          const dt = depthId ? webGpuObjects.textures.get(depthId) : null;
          if (dt) {
            const ds = {
              view: dt.tex.createView(),
              // §28af: per-pass reverse-Z depth clear (dcv computed
              // from the peeked SET_VIEWPORT above). reverse-Z 3D
              // passes clear to far=0.0 (paired with the flipped
              // GEQUAL compare); normal-Z menu/UI passes clear to
              // far=1.0 with the unflipped GX compare — the §28ad
              // global 0.0 wrongly killed the normal-Z menu draws.
              depthClearValue: dcv, depthLoadOp: loadOp, depthStoreOp: "store"
            };
            if (dt.format.indexOf("stencil") >= 0) {
              ds.stencilClearValue = 0;
              ds.stencilLoadOp = loadOp;
              ds.stencilStoreOp = "store";
            }
            desc.depthStencilAttachment = ds;
          }
          pass = enc.beginRenderPass(desc);
          passHasPipe = false;
          bgValid[0] = bgValid[1] = bgValid[2] = false;  // §28j
          passFbId = fbId;
          // The EFB colour pass is the only one with a depth
          // attachment (the fb=47 XFB has none) — track its id so the
          // DIAG path can blit it straight to the canvas.
          if (fbId !== 0 && depthId) self._wgEfbColorId = fbId;
          if (fbId !== 0) {
            self._wgEfbN = (self._wgEfbN || 0) + 1;
            if (self._wgEfbN <= 6) {
              const ct2 = webGpuObjects.textures.get(fbId);
              console.log(`[webgpu-exec] EFB pass#${self._wgEfbN} fb=${fbId}` +
                `(${ct2 ? ct2.format : "?"}) depth=${depthId}` +
                `(${dt ? dt.format : "none"}) load=${loadOp} ` +
                `clear=${f32[recWord + 2].toFixed(2)},${f32[recWord + 3].toFixed(2)},` +
                `${f32[recWord + 4].toFixed(2)},${f32[recWord + 5].toFixed(2)}`);
            }
          } else if (!self._wgFb0Logged) {
            self._wgFb0Logged = true;
            console.log(`[webgpu-exec] first backbuffer pass load=${loadOp} ` +
              `clear=${f32[recWord + 2].toFixed(2)},${f32[recWord + 3].toFixed(2)},` +
              `${f32[recWord + 4].toFixed(2)}`);
          }
          break;
        }
        case WGPU_CMD_OP_SET_PIPELINE: {
          const pid = u32[recWord + 1];
          self._wgCurPipe = pid;
          const p = pass
            ? resolvePipeline(pid, passColorFmt, passDepthFmt, undefined,
                              !!self._wgPassRevZ)
            : null;
          if (pass && p) {
            pass.setPipeline(p); passHasPipe = true; webGpuExecStats.setPipe++; pd.pipeOk++;
          } else { webGpuExecStats.missPipe++; pd.pipeMiss++; }
          break;
        }
        case WGPU_CMD_OP_SET_BIND_GROUP: {
          const bgSlot = u32[recWord + 1];
          const bgId = u32[recWord + 2];
          const bg = webGpuObjects.bindGroups.get(bgId);
          if (bgSlot < 3) bgValid[bgSlot] = !!(pass && bg);  // §28j
          if (u32[recWord + 1] === 1) self._wgCurBg1 = bgId;
          if (u32[recWord + 1] === 1 && self._wgBgTex &&
              self._wgBgTex[bgId] != null &&
              self._wgCopyTargets && self._wgCopyTargets.has(passFbId)) {
            self._wgCpySrc = self._wgBgTex[bgId];
          }
          if (pass && bg) {
            // §16: arg.u[2]=nDynOff, u[3..6]=per-draw ring offsets
            // (group0 has 4 dynamic-offset UBO bindings; groups 1/2: 0).
            const nOff = u32[recWord + 3];
            if (nOff) {
              for (let k = 0; k < nOff; k++)
                WGPU_DYN_OFF_SCRATCH[k] = u32[recWord + 4 + k];
              // Zero-alloc overload: (slot, bg, data, dataStart, dataLen)
              pass.setBindGroup(u32[recWord + 1], bg,
                                WGPU_DYN_OFF_SCRATCH, 0, nOff);
            } else {
              pass.setBindGroup(u32[recWord + 1], bg);
            }
            webGpuExecStats.setBg++; pd.bgOk++;
          }
          else { webGpuExecStats.missBg++; pd.bgMiss++; }
          break;
        }
        case WGPU_CMD_OP_SET_VERTEX_BUFFER: {
          const b = webGpuObjects.buffers.get(u32[recWord + 2]);
          if (pass && b) pass.setVertexBuffer(u32[recWord + 1], b, u32[recWord + 3]);
          break;
        }
        case WGPU_CMD_OP_SET_INDEX_BUFFER: {
          const b = webGpuObjects.buffers.get(u32[recWord + 1]);
          if (pass && b) {
            pass.setIndexBuffer(b, u32[recWord + 2] === 1 ? "uint32" : "uint16",
                                u32[recWord + 3]);
          }
          break;
        }
        case WGPU_CMD_OP_SET_VIEWPORT:
          if (pass && passW > 0) {
            // WebGPU: x,y>=0; x+w<=W; y+h<=H; 0<=minD<=maxD<=1.
            let vx = f32[recWord + 1], vy = f32[recWord + 2];
            let vw = f32[recWord + 3], vh = f32[recWord + 4];
            if (vx < 0) { vw += vx; vx = 0; }
            if (vy < 0) { vh += vy; vy = 0; }
            vw = Math.max(1, Math.min(vw, passW - vx));
            vh = Math.max(1, Math.min(vh, passH - vy));
            // §28af: raw near>far ⇒ Dolphin reverse-Z viewport for
            // this pass. Drives the per-pass compare-flip + depth
            // clear (set self._wgPassRevZ BEFORE the Dawn-required
            // mn≤mx swap so the reversal signal isn't lost).
            self._wgPassRevZ = f32[recWord + 5] > f32[recWord + 6];
            // §28aq: a SET_VIEWPORT inside an open pass whose revZ
            // disagrees with what BEGIN_PASS baked into depthClearValue
            // = the flicker mechanism (bake-time guess was wrong).
            self._wgVpInPass = (self._wgVpInPass || 0) + 1;
            if (pass && self._wgPassRevZ !== self._wgPassRevZAtBegin &&
                (self._wgAqMisN = (self._wgAqMisN || 0) + 1) <= 60) {
              console.log(`[s28aq-MISMATCH] bp#${self._wgBpSeq} ` +
                `vpInPass=${self._wgVpInPass} bakedRevZ=` +
                `${self._wgPassRevZAtBegin ? 1 : 0} nowRevZ=` +
                `${self._wgPassRevZ ? 1 : 0} (dcv stuck at ` +
                `${self._wgPassRevZAtBegin ? 0.0 : 1.0}, wrong for this draw)`);
            }
            // §28at DISCRIMINATING PROBE (JS-only, flag=true run):
            // BPFunctions emits near_T=max_depth,far_T=min_depth at
            // flag=true; at flag=false it emits (1-max_depth,
            // 1-min_depth) = exactly (1-near_T,1-far_T) for this SAME
            // draw. So we can compute the precise flag=false viewport
            // here without a rebuild and test the tracer's "zero-width
            // collapse" hypothesis vs "stays healthy [0,1]" (⇒ the real
            // coupling-(2) is the dcv/compare pairing, not BPFunctions).
            {
              const nT = f32[recWord + 5], fT = f32[recWord + 6];
              const nF = 1.0 - nT, fF = 1.0 - fT;
              const span = Math.abs(nF - fF);
              const cls = span < 1e-4 ? "ZEROWIDTH"
                : (nF > fF ? "inverted(needswap)" : "normal[0,1]");
              if ((self._wgAtN = (self._wgAtN || 0) + 1) <= 120) {
                console.log(`[s28at-vp] bp#${self._wgBpSeq} ` +
                  `vp#${self._wgVpInPass} revZ=${self._wgPassRevZ ? 1 : 0} ` +
                  `T(near=${nT.toFixed(5)},far=${fT.toFixed(5)}) ` +
                  `=> F(near=${nF.toFixed(5)},far=${fF.toFixed(5)}) ` +
                  `span=${span.toFixed(5)} ${cls}`);
              }
            }
            let mn = f32[recWord + 5], mx = f32[recWord + 6];
            mn = Math.min(1, Math.max(0, mn));
            mx = Math.min(1, Math.max(0, mx));
            // §28ad: WebGPU/Dawn REJECTS minDepth>maxDepth (unlike
            // Vulkan's VkViewport) — confirmed validation error. So a
            // reversed viewport is impossible here; keep the swap to a
            // normal [mn,mx] viewport. Dolphin's reverse-Z
            // (bSupportsReversedDepthRange=true) must instead be
            // honoured via the depth CLEAR value (see depthClearValue
            // below) since the viewport sense cannot carry it.
            if (mn > mx) { const t = mn; mn = mx; mx = t; }
            pass.setViewport(vx, vy, vw, vh, mn, mx);
          }
          break;
        case WGPU_CMD_OP_SET_SCISSOR:
          if (pass && passW > 0 && !DIAG_RASTER_OPEN) {
            let sx = u32[recWord + 1], sy = u32[recWord + 2];
            let sw = u32[recWord + 3], sh = u32[recWord + 4];
            if (sx > passW) sx = passW;
            if (sy > passH) sy = passH;
            sw = Math.min(sw, passW - sx);
            sh = Math.min(sh, passH - sy);
            pass.setScissorRect(sx, sy, sw, sh);
          }
          break;
        case WGPU_CMD_OP_DRAW:
          // §28j: require pipeline + ALL 3 bind groups valid, else
          // skipping prevents an invalid draw poisoning the whole
          // frame submit (→ black frame).
          if (pass && passHasPipe && bgValid[0] && bgValid[1] && bgValid[2]) { pass.draw(u32[recWord + 1], u32[recWord + 2], u32[recWord + 3], 0); webGpuExecStats.draw++; pd.draw++; }
          else if (pass && passHasPipe) { webGpuExecStats.skipDraw = (webGpuExecStats.skipDraw || 0) + 1; }
          break;
        case WGPU_CMD_OP_DRAW_INDEXED:
          if (pass && passHasPipe &&
              !(bgValid[0] && bgValid[1] && bgValid[2])) {
            webGpuExecStats.skipDraw = (webGpuExecStats.skipDraw || 0) + 1;
          } else if (pass && passHasPipe) {
            pass.drawIndexed(u32[recWord + 1], u32[recWord + 2],
                             u32[recWord + 3], u32[recWord + 4], 0);
            webGpuExecStats.drawIdx++; pd.drawIdx++;
            if ((self._wgDi = (self._wgDi || 0) + 1) <= 5) {
              console.log(`[webgpu-exec] DRAW_INDEXED#${self._wgDi} ` +
                `idx=${u32[recWord + 1]} inst=${u32[recWord + 2]} ` +
                `firstIdx=${u32[recWord + 3]} baseVtx=${u32[recWord + 4]}`);
            }
            // §28-vtxdata: dark-menu probe — for the menu textured
            // pipeline (stride 20, TexCoord0 @location(8) float32x2
            // @offset 12) read the uploaded per-vertex texcoord bytes.
            // All-zero ⇒ GX position-texgen (VertexLoader writes 0
            // UVs; UV must come from VS texgen/posttransform) ⇒ the
            // dark is degenerate uv≈0 → atlas-corner. Non-zero ⇒ the
            // posttransform screen→UV mapping is the defect.
            if (self._wgVbSnap &&
                (self._wgVtxProbeN = (self._wgVtxProbeN || 0)) < 60) {
              const vtpl = webGpuObjects.pipeTpl.get(self._wgCurPipe);
              const vbs = vtpl && vtpl.desc && vtpl.desc.vertex &&
                vtpl.desc.vertex.buffers;
              // §28-vtxdata GENERALISED: match ANY vertex-buffer layout
              // carrying a TexCoord0 attr @location(8) float32x2 (the
              // menu VS texcoord input) — ANY stride/offset (the §28ap
              // menu pipes vary: stride 20 tc@12, or L5:unorm8x4 + tc@16
              // etc). Read using the layout's real arrayStride + the
              // attr's real offset, and pos from @location(0) if present.
              let vb = null, tcA = null, posA = null;
              if (vbs) {
                for (const b of vbs) {
                  const t = b.attributes.find((a) =>
                    a.shaderLocation === 8 && a.format === "float32x2");
                  if (t) { vb = b; tcA = t;
                    posA = b.attributes.find((a) => a.shaderLocation === 0);
                    break; }
                }
              }
              if (vb && tcA) {
                const stride = vb.arrayStride;
                const baseVtx = u32[recWord + 4];
                const batchOff = baseVtx * stride;
                let s = null, sOff = 0;
                for (const [doff, sn] of self._wgVbSnap) {
                  if (batchOff >= doff &&
                      batchOff < doff + sn.byteLength) { s = sn; sOff = doff; break; }
                }
                if (s) {
                  self._wgVtxProbeN++;
                  const lb = batchOff - sOff;
                  const nV = Math.min(4,
                    Math.floor((s.byteLength - lb) / stride));
                  const dv = new DataView(s.buffer, s.byteOffset + lb);
                  const tcv = [], pov = [];
                  for (let v = 0; v < nV; v++) {
                    const to = v * stride + tcA.offset;
                    tcv.push(`(${dv.getFloat32(to, true).toFixed(4)},` +
                      `${dv.getFloat32(to + 4, true).toFixed(4)})`);
                    if (posA && posA.format.indexOf("float32") === 0) {
                      const po = v * stride + posA.offset;
                      pov.push(`(${dv.getFloat32(po, true).toFixed(1)},` +
                        `${dv.getFloat32(po + 4, true).toFixed(1)},` +
                        `${dv.getFloat32(po + 8, true).toFixed(1)})`);
                    }
                  }
                  console.log(`[s28-vtxdata] pipe=${self._wgCurPipe} ` +
                    `fs#${vtpl.fsId} stride=${stride} tcOff=${tcA.offset} ` +
                    `baseVtx=${baseVtx} idx=${u32[recWord + 1]} ` +
                    `tc=[${tcv.join(",")}] pos=[${pov.join(",")}]`);
                }
              }
            }
            // [s28av-texuv] DECISIVE dark-menu probe: the menu FS
            // computes uv = vtxTC / (I_TEXDIMS*128) (Dolphin texel*128
            // fixed-point convention). [s28-vtxdata] PROVED the WebGPU
            // VertexLoader delivers [0,1]-normalised UVs, so this
            // division collapses uv→~0 → samples the atlas corner →
            // dark menu. Confirm: parse the FS for the member_3*128
            // pattern, read live I_TEXDIMS from the PSBlock snapshot,
            // compute the effective UV. Capped 8.
            if ((self._wgAvN = (self._wgAvN || 0)) < 8) {
              const aT = webGpuObjects.pipeTpl.get(self._wgCurPipe);
              const aB = aT && aT.desc && aT.desc.vertex &&
                aT.desc.vertex.buffers;
              let aTc = null, aStride = 0;
              if (aB) for (const b of aB) {
                const t = b.attributes.find((a) =>
                  a.shaderLocation === 8 && a.format === "float32x2");
                if (t) { aTc = t; aStride = b.arrayStride; break; }
              }
              if (aTc && aT && self._wgFsSrc &&
                  self._wgFsSrc[aT.fsId] !== undefined) {
                self._wgAvN++;
                const flat = self._wgFsSrc[aT.fsId].replace(/\s+/g, " ");
                const hasNorm = flat.indexOf("member_3") >= 0 &&
                  flat.indexOf("128") >= 0;
                const sm = flat.match(/textureSample\w*\s*\([^;]{0,180}/);
                // §28ba: which @binding does the menu FS actually
                // sample? dolphin_fn_1_ is called with (…, global_1,
                // global_2, …) ⇒ the sampled texture = `global_1`.
                // Parse its @group/@binding + list all texture_2d_array
                // bindings, so we can cross-check [s28-texfs]'s b0..b7
                // (b0=tex#76 atlas, b1=tex#65 640×480 EFB backdrop).
                const g1m = flat.match(
                  /@group\((\d+)\)\s*@binding\((\d+)\)\s*var\s+global_1\s*:/);
                const texBinds = (flat.match(
                  /@binding\(\d+\)\s*var\s+\w+\s*:\s*texture_2d_array/g)
                  || []).join(" | ");
                console.log(`[s28ba-bind] fs#${aT.fsId} ` +
                  `global_1@group${g1m ? g1m[1] : "?"}` +
                  `/binding${g1m ? g1m[2] : "?"} ` +
                  `texDecls=[${texBinds}]`);
                // [s28be] DECISIVE: read the VS UBO at the CORRECT C++
                // offsets — texmatrices@896, posttransformmatrices@2816
                // (the §28an baked probe read byte1280=transformmatrices,
                // so posttransform was NEVER verified). UV =
                // posttransform(texmtx·texcoordAttr). If postP0/P1≈0 ⇒
                // ROOT=A (posttransform delivered zero → UV→0 →
                // transparent atlas → dark).
                if (self._wgVsSnap && self._wgVsSnapLen >= 2864) {
                  const vv = new DataView(self._wgVsSnap.buffer,
                    self._wgVsSnap.byteOffset);
                  const r4 = (o) => [0, 4, 8, 12].map((d) =>
                    vv.getFloat32(o + d, true).toFixed(3));
                  const p0 = r4(2816), p1 = r4(2832), p2 = r4(2848);
                  const tm0 = r4(896), tm1 = r4(912);
                  const pmag = Math.abs(+p0[0]) + Math.abs(+p0[1]) +
                    Math.abs(+p1[0]) + Math.abs(+p1[1]);
                  const tmag = Math.abs(+tm0[0]) + Math.abs(+tm0[1]) +
                    Math.abs(+tm1[0]) + Math.abs(+tm1[1]);
                  console.log(`[s28be-vsubo] fs#${aT.fsId} ` +
                    `texm0=[${tm0}] texm1=[${tm1}] ` +
                    `postP0=[${p0}] postP1=[${p1}] postP2=[${p2}]`);
                  if (pmag < 0.01)
                    console.log(`[s28be-VERDICT] ROOT=A: ` +
                      `posttransformmatrices @byte2816 are ZERO ⇒ ` +
                      `UV→0 → transparent atlas → dark menu. (§28an's ` +
                      `"post real" read byte1280=transformmatrices.)`);
                  else if (tmag < 0.01)
                    console.log(`[s28be-VERDICT] texmatrices @896 ZERO ` +
                      `(unexpected — §28an said identity).`);
                  else
                    console.log(`[s28be-VERDICT] post+texm BOTH ` +
                      `populated (pmag=${pmag.toFixed(3)} ` +
                      `tmag=${tmag.toFixed(3)}) — root is elsewhere; ` +
                      `dump effective UV next.`);
                }
                // §28bd: dump the menu VS texgen — does texture_coord_0
                // derive from rawpos (SourceRow::Geom) or rawtex0
                // (SourceRow::Tex)? and is the posttransform (P0/P1/P2,
                // I_POSTTRANSFORMMATRICES) applied? This pins WHICH
                // input the wrong-atlas UV (§28bc) comes from.
                if (self._wgVsSrc && aT.vsId !== undefined &&
                    self._wgVsSrc[aT.vsId] !== undefined &&
                    !self._wgBdVs) {
                  self._wgBdVs = true;
                  const vf = self._wgVsSrc[aT.vsId].replace(/\s+/g, " ");
                  console.log(`[s28bd-vs] vs#${aT.vsId} len=${vf.length} ` +
                    `nTexSampleBiasFS=na — full VS WGSL follows:`);
                  for (let o = 0; o < vf.length; o += 700)
                    console.log(`[s28bd-vs ${o}] ${vf.slice(o, o + 700)}`);
                }
                let tdx = -1, tdy = -1, tdz = -1, tdw = -1;
                if (self._wgPsSnap && self._wgPsSnapLen >= 160) {
                  const pv = new DataView(self._wgPsSnap.buffer,
                    self._wgPsSnap.byteOffset);
                  tdx = pv.getInt32(144, true);   // texdims[0].x = width
                  tdy = pv.getInt32(148, true);   // texdims[0].y = height
                  tdz = pv.getInt32(152, true);   // [0].z = tc_scale_s
                  tdw = pv.getInt32(156, true);   // [0].w = tc_scale_t
                  // §28az: dump the TEV colour/konst PS-constants the
                  // menu FS combines the sample with (§28ay proved the
                  // TEV chain is the dominant collapse). [s28-creg]
                  // layout: I_COLORS@0 (4×int4), I_KCOLORS@64,
                  // I_ALPHA@128. If a register the TEV uses is ~0 ⇒
                  // the §28b-class PS-constant delivery is the root.
                  const r4 = (o) => `${pv.getInt32(o, true)},` +
                    `${pv.getInt32(o + 4, true)},${pv.getInt32(o + 8, true)},` +
                    `${pv.getInt32(o + 12, true)}`;
                  console.log(`[s28az-creg] fs#${aT.fsId} ` +
                    `C0=[${r4(0)}] C1=[${r4(16)}] C2=[${r4(32)}] ` +
                    `C3=[${r4(48)}] K0=[${r4(64)}] K1=[${r4(80)}] ` +
                    `K2=[${r4(96)}] K3=[${r4(112)}] A=[${r4(128)}]`);
                }
                let vU = NaN, vV = NaN;
                if (self._wgVbSnap) {
                  const off = u32[recWord + 4] * aStride;
                  for (const [doff, sn] of self._wgVbSnap) {
                    if (off >= doff && off + aStride <= doff + sn.byteLength) {
                      const dv = new DataView(sn.buffer,
                        sn.byteOffset + (off - doff));
                      vU = dv.getFloat32(aTc.offset, true);
                      vV = dv.getFloat32(aTc.offset + 4, true);
                      break;
                    }
                  }
                }
                // FULL effective sampled UV: texgen multiplies vtxTC by
                // (tc_scale .zw · 128), FS divides by (texdims .xy · 128)
                // ⇒ effUV = vtxTC · (.zw / .xy). The 128s cancel.
                const effU = (tdx > 0) ? vU * (tdz / tdx) : NaN;
                const effV = (tdy > 0) ? vV * (tdw / tdy) : NaN;
                console.log(`[s28av-texuv] pipe=${self._wgCurPipe} ` +
                  `fs#${aT.fsId} vs#${aT.vsId} hasNorm=${hasNorm ? 1 : 0} ` +
                  `td.xy=(${tdx},${tdy}) td.zw_scale=(${tdz},${tdw}) ` +
                  `vtxTC=(${vU.toFixed(5)},${vV.toFixed(5)}) ` +
                  `effUV=(${effU.toFixed(6)},${effV.toFixed(6)}) ` +
                  `sample=${sm ? sm[0].slice(0, 120) : "NONE"}`);
                if (!isNaN(effU)) {
                  if (Math.abs(effU) < 0.01 && Math.abs(effV) < 0.01 &&
                      !isNaN(vU) && Math.abs(vU) > 0.01) {
                    console.log(`[s28av-VERDICT] UV-COLLAPSE: vtxTC ` +
                      `(${vU.toFixed(3)},${vV.toFixed(3)}) × (tc_scale ` +
                      `${tdz},${tdw} / texdim ${tdx},${tdy}) → effUV≈0. ` +
                      (tdz <= 1 || tdw <= 1
                        ? `tc_scale .zw≈${tdz},${tdw} is NOT the texsize ` +
                          `(SetTexCoordChanged not delivering scale=texsize) ` +
                          `⇒ the .zw/tc-scale path is the defect.`
                        : `tc_scale present but mismatched vs texdim ` +
                          `(${tdz},${tdw} vs ${tdx},${tdy}).`));
                  } else if (Math.abs(effU - vU) < 0.05 &&
                             Math.abs(effV - vV) < 0.05) {
                    console.log(`[s28av-VERDICT] effUV≈vtxTC ` +
                      `(${effU.toFixed(3)},${effV.toFixed(3)}) — round-trip ` +
                      `OK. Dark root is NOT UV units; check texture ` +
                      `content / FS TEV / blend.`);
                  } else {
                    console.log(`[s28av-VERDICT] effUV=` +
                      `(${effU.toFixed(3)},${effV.toFixed(3)}) vs vtxTC=` +
                      `(${vU.toFixed(3)},${vV.toFixed(3)}) — partial ` +
                      `mismatch; tc_scale=${tdz},${tdw} texdim=${tdx},${tdy}.`);
                  }
                }
              }
            }
            // §28: at difficulty-select the backdrop is black. For the
            // EFB colour pass, tally the DISTINCT (pipeline, sampled
            // group-1 texture, size, idxCount) set so we can tell what
            // the backdrop draw samples vs the glyph/text draws.
            if (self._wgEfbColorId && passFbId === self._wgEfbColorId) {
              const idx = u32[recWord + 1];
              const bg1 = self._wgCurBg1;
              const allb = (self._wgBgAll && bg1 != null)
                ? (self._wgBgAll[bg1] || "?") : "?";
              const tpl = webGpuObjects.pipeTpl.get(self._wgCurPipe);
              const pdbg = tpl ? (tpl.s28dbg || "?") : "?";
              // §28: the backdrop draw = b0 is the 1x1 dummy + large
              // index count. Capture its FS id and dump that FS once.
              if (tpl && idx >= 40 && allb.indexOf(" b0=tex#57(1x1)") === 0
                  && !self._wgBdFsDone && self._wgFsSrc &&
                  self._wgFsSrc[tpl.fsId] !== undefined) {
                self._wgBdFsDone = true;
                const w = self._wgFsSrc[tpl.fsId];
                console.log(`[s28-bdfs] pipe=${self._wgCurPipe} ` +
                  `fs#${tpl.fsId} len=${w.length} ${pdbg}`);
                // Parse the WGSL: log only the decisive lines —
                // textureSample* calls (which binding the backdrop
                // samples), discards/alpha-test, and the final
                // @location(0) output assignment.
                const flat = w.replace(/\s+/g, " ");
                // §28e: dump the WHOLE TEV chain (every dolphin_fn_*),
                // not just fn_4_, to see which TEV input (vertex color
                // vs I_COLORS / konst / I_KCOLORS UBO reg) collapses
                // the untextured backdrop to black. Start at the first
                // "fn dolphin_fn_" so fn_0..fn_4 are all captured.
                const fi = flat.indexOf("fn dolphin_fn_");
                console.log(`[s28-bdfsX] fnAt=${fi} len=${flat.length} ` +
                  `nSample=${(flat.match(/textureSample/g) || []).length}`);
                // Capture the global UBO struct decl too (member_N ↔
                // I_COLORS/I_KCOLORS/konst byte mapping).
                const sd = flat.indexOf("struct type_");
                if (sd >= 0)
                  console.log(`[s28-bdfsS] ${flat.slice(sd, sd + 900)}`);
                if (fi >= 0)
                  for (let o = fi; o < flat.length; o += 700)
                    console.log(`[s28-fn4 ${o - fi}] ${flat.slice(o, o + 700)}`);
                // §28e: dump the paired VS — trace how color0 (the
                // location(0) varying the FS returns) is produced: a
                // per-vertex @location(5) attr, or a lighting/material
                // UBO constant (which would be 0 ⇒ black backdrop).
                if (self._wgVsSrc &&
                    self._wgVsSrc[tpl.vsId] !== undefined) {
                  const v = self._wgVsSrc[tpl.vsId].replace(/\s+/g, " ");
                  const vm = v.indexOf("fn main(");
                  console.log(`[s28-vs] vs#${tpl.vsId} len=${v.length} ` +
                    `sig=${v.slice(vm, v.indexOf("{", vm))}`);
                  // The VS color-channel synthesis: log lines that
                  // write the colour varying / read material lights.
                  const ci = v.indexOf("fn dolphin_fn_");
                  if (ci >= 0)
                    for (let o = ci; o < v.length; o += 700)
                      console.log(`[s28-vsfn ${o - ci}] ${v.slice(o, o + 700)}`);
                }
              }
              // §28f: also dump the dominant TEXTURED difficulty-select
              // draw — b0 a REAL texture (not the 1x1 dummy), big idx
              // (the backdrop/roster composite), binding a 640x480
              // EFB-copy at b1. This is the draw that outputs ~0 into
              // tex#14 while sampling the black copy; dump its FS
              // textureSample* calls + final return to see if it
              // multiplies the (black) b1 copy (feedback) or collapses
              // via alpha/texcoord.
              // §28ag: dump each DISTINCT textured EFB FS once (capped),
              // not one-shot — so the MENU pipeline (fs#16081, dark 1P
              // menu) is captured too, not just difficulty-select's.
              self._wgTexFsSet = self._wgTexFsSet || new Set();
              if (tpl && idx >= 40 &&
                  allb.indexOf(" b0=tex#57(1x1)") !== 0 &&
                  allb.indexOf("(640x480)") >= 0 &&
                  self._wgFsSrc && self._wgFsSrc[tpl.fsId] !== undefined &&
                  !self._wgTexFsSet.has(tpl.fsId) &&
                  self._wgTexFsSet.size < 8) {
                self._wgTexFsSet.add(tpl.fsId);
                const w = self._wgFsSrc[tpl.fsId];
                const flat = w.replace(/\s+/g, " ");
                console.log(`[s28-texfs] pipe=${self._wgCurPipe} ` +
                  `fs#${tpl.fsId} vs#${tpl.vsId} len=${w.length} ${pdbg} ` +
                  `bg1=${allb} nSample=` +
                  `${(flat.match(/textureSample/g) || []).length}`);
                const fi = flat.indexOf("fn dolphin_fn_");
                if (fi >= 0)
                  for (let o = fi; o < flat.length; o += 700)
                    console.log(`[s28-tfn ${o - fi}] ${flat.slice(o, o + 700)}`);
                // §28aj: dump the PSBlock UBO struct decls so we can map
                // Naga member_N → byte offset and compare to the C++
                // PixelShaderConstants layout (colors@0, kcolors@64,
                // alpha@128, texdims@144…). The §28ah probe proved the
                // VALUES are correct at source; a std140 member-offset
                // mismatch here (the §28b/c class) would make the FS
                // read colors[1]/kcolors[0]/texdims from the wrong
                // bytes → black menu. JS-only (FS already captured).
                // §28ak: queue this menu textured draw's b0 (the
                // sampled UI/glyph texture) for the [webgpu-DIAG-cpy]
                // readback — decides texture CONTENT empty (upload
                // bug) vs populated (⇒ texcoord/texdim sampling bug).
                {
                  const m = /b0=tex#(\d+)/.exec(allb);
                  if (m) {
                    self._wgCpyExtra = self._wgCpyExtra || new Set();
                    if (self._wgCpyExtra.size < 24)
                      self._wgCpyExtra.add(parseInt(m[1], 10));
                    console.log(`[s28ak-b0] fs#${tpl.fsId} b0=tex#${m[1]} queued`);
                  }
                }
                let sd = flat.indexOf("struct type_");
                for (let k = 0; k < 6 && sd >= 0; k++) {
                  const end = flat.indexOf("}", sd);
                  console.log(`[s28aj-struct ${k}] ` +
                    flat.slice(sd, end >= 0 ? end + 1 : sd + 700));
                  sd = flat.indexOf("struct type_", sd + 1);
                }
                // The @group/@binding decls (which binding is the
                // PSBlock vs textures) + the global var lines.
                const gb = flat.match(/@group\([0-9]\)\s*@binding\([0-9]+\)\s*var<?[^;]*;/g);
                if (gb) console.log(`[s28aj-bind] ${gb.join(" || ")}`);
                // §28al: dump the paired menu VS texgen — the FS UV
                // (param_8/param_9) is a VS output varying. A zero/
                // wrong texgen here makes a populated texture sample
                // ≈0 → black menu (§28ak). JS-only (VS WGSL captured).
                if (self._wgVsSrc && self._wgVsSrc[tpl.vsId] !== undefined) {
                  const v = self._wgVsSrc[tpl.vsId].replace(/\s+/g, " ");
                  const vm = v.indexOf("fn main(");
                  console.log(`[s28al-vs] vs#${tpl.vsId} len=${v.length} ` +
                    `nLoc=${(v.match(/@location\(/g) || []).length} ` +
                    `sig=${v.slice(vm, v.indexOf("{", vm) + 1)}`);
                  // texgen lives in the dolphin_fn chain — dump it +
                  // the @location output assignments (the varyings the
                  // FS reads as param_8/param_9 texcoord/layer).
                  const ci = v.indexOf("fn dolphin_fn_");
                  if (ci >= 0)
                    for (let o = ci; o < v.length; o += 700)
                      console.log(`[s28al-vsfn ${o - ci}] ${v.slice(o, o + 700)}`);
                  // §28am: dump the VS UBO struct decls so member_9/
                  // member_12 (the texgen matrices the UV depends on)
                  // map to VertexShaderConstants fields (texmatrices@
                  // /posttransformmatrices). JS-only, no rebuild.
                  let vd = v.indexOf("struct type_");
                  for (let k = 0; k < 4 && vd >= 0; k++) {
                    const ve = v.indexOf("}", vd);
                    console.log(`[s28am-vstruct ${k}] ` +
                      v.slice(vd, ve >= 0 ? ve + 1 : vd + 700));
                    vd = v.indexOf("struct type_", vd + 1);
                  }
                  const vgb = v.match(/@group\([0-9]\)\s*@binding\([0-9]+\)\s*var<?[^;]*;/g);
                  if (vgb) console.log(`[s28am-vbind] ${vgb.join(" || ")}`);
                }
              }
              const key = `pipe${self._wgCurPipe}|idx${idx}|${pdbg}|${allb}`;
              self._wgEfbDraws = self._wgEfbDraws || new Map();
              self._wgEfbDraws.set(key, (self._wgEfbDraws.get(key) || 0) + 1);
              self._wgEfbDrawsN = (self._wgEfbDrawsN || 0) + 1;
              if ((self._wgEfbDrawsN % 20000) === 0) {
                const rows = [...self._wgEfbDraws.entries()]
                  .sort((a, b) => b[1] - a[1]).slice(0, 14)
                  .map(([k, v]) => `${k}=${v}`);
                console.log(`[s28-efbdraws] n=${self._wgEfbDrawsN} ` +
                  rows.join("  "));
                self._wgEfbDraws.clear();
              }
            }
          }
          break;
        case WGPU_CMD_OP_END_PASS:
          endPass();
          break;
        case WGPU_CMD_OP_SUBMIT_PRESENT:
          endPass();
          if (DIAG_EFB_TO_CANVAS && self._wgEfbColorId) {
            const efb = webGpuObjects.textures.get(self._wgEfbColorId);
            const bs = efb ? ensureBlitState() : null;
            const dpipe = bs ? ensureBlitPipeline(renderGpu.format) : null;
            if (efb && dpipe) {
              try {
                ensureEnc();
                const ubo = dev.createBuffer({ size: 16, usage: 0x40 | 0x8,
                                               mappedAtCreation: true });
                new Float32Array(ubo.getMappedRange()).set([1, 1, 0, 0]);
                ubo.unmap();
                const ev = efb.tex.createView({ dimension: "2d-array",
                  baseArrayLayer: 0, arrayLayerCount: 1 });
                const dbg = dev.createBindGroup({ layout: bs.bgl, entries: [
                  { binding: 0, resource: ev },
                  { binding: 1, resource: bs.sampler },
                  { binding: 2, resource: { buffer: ubo } } ] });
                const ctex = renderGpu.context.getCurrentTexture();
                const rp = enc.beginRenderPass({ label: "DIAG-efb-to-canvas",
                  colorAttachments: [{ view: ctex.createView(),
                    clearValue: { r: 0, g: 0, b: 0, a: 1 },
                    loadOp: "clear", storeOp: "store" }] });
                rp.setPipeline(dpipe);
                rp.setViewport(0, 0, ctex.width, ctex.height, 0, 1);
                rp.setBindGroup(0, dbg);
                rp.draw(3);
                rp.end();
                if (!self._wgDiagOnce) {
                  self._wgDiagOnce = true;
                  console.log(`[webgpu-DIAG] EFB ${self._wgEfbColorId} ` +
                    `${efb.format} ${efb.tex.width}x${efb.tex.height} -> ` +
                    `canvas ${ctex.width}x${ctex.height}`);
                }
              } catch (e) {
                if (!self._wgDiagErr) {
                  self._wgDiagErr = true;
                  console.log(`[webgpu-DIAG] threw: ${e?.message || e}`);
                }
              }
            }
          }
          // [webgpu-DIAG-cpy] PERIODIC readback of the EFB colour tex
          // (self._wgEfbColorId — what DIAG_EFB_TO_CANVAS shows) AND the
          // EFB-copy targets, sampled across boot→title→menu→demo so we
          // can correlate "EFB black during menus" vs "EFB-copy content"
          // with the screenshot timeline (tag p=<present>). Encoded into
          // `enc` before submit; mapAsync after. COPY_SRC on all (kTexUsage).
          {
            const P = webGpuExecStats.present;
            const tick = (P >= 300) ? Math.floor((P - 300) / 350) : -1;
            self._wgCpyTick = (self._wgCpyTick == null) ? -1 : self._wgCpyTick;
            // §28x: the present-gated tick caps at <9 so it never
            // fires deep in the A-only black-3D dwell (P ≫). Add a
            // WALL-CLOCK periodic trigger (every 6 s, capped 20 fires)
            // so the EFB/copy readback runs throughout ANY run —
            // bisects whether the 3D scene's draws sample black
            // EFB-copies (feedback chain) vs produce black directly.
            const _wcNow = Date.now();
            self._wgCpyWcT0 = self._wgCpyWcT0 || _wcNow;
            const _wcTick = Math.floor((_wcNow - self._wgCpyWcT0) / 6000);
            self._wgCpyWcTick = (self._wgCpyWcTick == null)
              ? -1 : self._wgCpyWcTick;
            const _preOk = tick >= 0 && tick !== self._wgCpyTick
              && tick < 9;
            const _wcOk = _wcTick !== self._wgCpyWcTick && _wcTick < 20;
            if (self._wgCopyTargets && (_preOk || _wcOk)) {
            if (_preOk) self._wgCpyTick = tick;
            if (_wcOk) self._wgCpyWcTick = _wcTick;
            const pending = [];
            const ids = new Set(self._wgCopyTargets);
            if (self._wgEfbColorId) ids.add(self._wgEfbColorId);
            if (self._wgXfbId) ids.add(self._wgXfbId);
            // §28: also read back the backdrop's sampled b1/b2 textures.
            if (self._wgCpyExtra) for (const e of self._wgCpyExtra) ids.add(e);
            for (const cid of ids) {
              const ct = webGpuObjects.textures.get(cid);
              if (!ct || ct.format.startsWith("depth")) continue;
              try {
                ensureEnc();
                const w = ct.tex.width, h = ct.tex.height;
                const bpr = Math.ceil(w * 4 / 256) * 256;
                const rb = dev.createBuffer({ size: bpr * h,
                  usage: 0x1 | 0x8 });           // MAP_READ | COPY_DST
                enc.copyTextureToBuffer(
                  { texture: ct.tex },
                  { buffer: rb, bytesPerRow: bpr, rowsPerImage: h },
                  { width: w, height: h, depthOrArrayLayers: 1 });
                pending.push({ rb, bpr, w, h,
                  tag: `p=${P} tex#${cid}` +
                    (cid === self._wgEfbColorId ? "(EFB)"
                     : cid === self._wgXfbId ? "(XFB)" : "(copy)") +
                    ` ${w}x${h}` });
              } catch (e) {
                console.log(`[webgpu-DIAG-cpy] ${cid} enc threw ` +
                  `${e?.message || e}`);
              }
            }
            if (pending.length) {
              submitEnc();
              for (const p of pending) {
                p.rb.mapAsync(0x1).then(() => {
                  const a = new Uint8Array(p.rb.getMappedRange());
                  const N = a.length;
                  let nz = 0, mx = 0;
                  for (let i = 0; i < N; i++) {
                    if (a[i]) { nz++; if (a[i] > mx) mx = a[i]; }
                  }
                  const cy = p.h >> 1, cx = p.w >> 1;
                  const o = cy * p.bpr + cx * 4;
                  const o2 = (p.h >> 2) * p.bpr + (p.w >> 2) * 4;
                  // Fixed (200,150) lands inside any plausible 640x480
                  // menu sub-rect even for the big 2560x1024 XFB.
                  const sy = Math.min(150, p.h - 1);
                  const sx = Math.min(200, p.w - 1);
                  const o3 = sy * p.bpr + sx * 4;
                  console.log(`[webgpu-DIAG-cpy] ${p.tag} ` +
                    `nz=${nz}/${N} max=${mx} ` +
                    `px0=${a[0]},${a[1]},${a[2]},${a[3]} ` +
                    `ctr=${a[o]},${a[o+1]},${a[o+2]},${a[o+3]} ` +
                    `q=${a[o2]},${a[o2+1]},${a[o2+2]},${a[o2+3]} ` +
                    `s200x150=${a[o3]},${a[o3+1]},${a[o3+2]},${a[o3+3]}`);
                  p.rb.unmap(); p.rb.destroy();
                }).catch((e) => console.log(
                  `[webgpu-DIAG-cpy] map ${p.tag} err ${e?.message || e}`));
              }
            }
            }
          }
          submitEnc();
          webGpuExecStats.present++;
          if (webGpuExecStats.present - webGpuExecStats.lastLog >= 120) {
            webGpuExecStats.lastLog = webGpuExecStats.present;
            const s = webGpuExecStats;
            console.log(
              `[webgpu-exec] stats present=${s.present} beginFb0=${s.beginFb0} ` +
              `beginFbN=${s.beginFbN} drawIdx=${s.drawIdx} draw=${s.draw} ` +
              `setPipe=${s.setPipe} missPipe=${s.missPipe} setBg=${s.setBg} ` +
              `missBg=${s.missBg} skipDraw=${s.skipDraw} ` +
              `pipes=${webGpuObjects.pipelines.size} ` +
              `tex=${webGpuObjects.textures.size} buf=${webGpuObjects.buffers.size} ` +
              `bg=${webGpuObjects.bindGroups.size}`);
          }
          break;
        case WGPU_CMD_OP_DESTROY: {
          const tag = u32[recWord + 1], id = u32[recWord + 2];
          const m = tag === 1 ? webGpuObjects.buffers
                  : tag === 2 ? webGpuObjects.textures
                  : tag === 3 ? webGpuObjects.bindGroups : null;
          if (m) m.delete(id);
          break;
        }
        case WGPU_CMD_OP_BLIT_TEXTURE: {
          const s = webGpuObjects.textures.get(u32[recWord + 1]);
          const d = webGpuObjects.textures.get(u32[recWord + 2]);
          if (s && d) {
            endPass();
            ensureEnc();
            const a2 = u32[recWord + 3], a3 = u32[recWord + 4];
            const a4 = u32[recWord + 5], a5 = u32[recWord + 6];
            const a6 = u32[recWord + 7];
            blitTexture(enc, s, d,
              a2 & 0xFFFF, a2 >>> 16, a3 & 0xFFFF, a3 >>> 16,
              a4 & 0xFFFF, a4 >>> 16, a5 & 0xFFFF, a5 >>> 16,
              a6 & 0xFF, (a6 >>> 8) & 0xFF, (a6 >>> 16) & 0xFF, (a6 >>> 24) & 0xFF);
          }
          break;
        }
        default:
          break;
      }
    } catch (e) {
      if (!self._webGpuExecErr) {
        self._webGpuExecErr = true;
        console.log(`[webgpu-exec] op=${op} threw: ${e?.message || e}`);
      }
    }
    read = (read + 1) >>> 0;
  }
  endPass();
  submitEnc();
  Atomics.store(ring.headerI32, 1, read | 0);
  // Once the cmd-ring executor has presented a real frame, IT owns the
  // canvas (renderGpu.context). The legacy runPresentationLoop blit of
  // the CPU framebuffer (presentFrame → drawFrameBytesToWebGpu) must
  // then be suppressed — post-cutover the Software rasteriser is gone
  // so that CPU buffer is stale/empty (the green that was clobbering
  // our GPU render every loop iteration).
  if (webGpuExecStats.present > 0) cmdRingOwnsCanvas = true;
}

// Day-29: build a real GPURenderPipeline from a bridge-translated
// vertex-shader module + the constant-colour test FS. Wrapped in an
// error scope so WGSL/pipeline-validation failures are reported
// rather than silently swallowed. One-shot per pipeline id.
function replayCreatePipeline(pipelineId, vsShaderId, fsShaderId, topology) {
  if (!renderGpu || webGpuObjects.pipelines.has(pipelineId)) return;
  const vs = webGpuObjects.shaders.get(vsShaderId);
  const fs = webGpuObjects.shaders.get(fsShaderId);
  if (!vs || !fs) {
    if (!self._webGpuPipeNoShader) {
      self._webGpuPipeNoShader = true;
      console.log(
        `[webgpu-cmd-pipeline] CREATE_PIPELINE id=${pipelineId}: ` +
        `vs ${vsShaderId}=${vs ? "ok" : "MISSING"} ` +
        `fs ${fsShaderId}=${fs ? "ok" : "MISSING"} (drain-order bug?)`
      );
    }
    return;
  }
  try {
    renderGpu.device.pushErrorScope("validation");
    // Day-32: real Dolphin VS + real Dolphin FS pair (both
    // bridge-translated). layout:"auto" lets WGPU derive bind groups
    // from the shaders for now; Day-33 supplies Dolphin's real
    // pipeline/vertex/bind state.
    const pipe = renderGpu.device.createRenderPipeline({
      label: `dolphin-pipeline-${pipelineId}`,
      layout: "auto",
      vertex: { module: vs },
      fragment: {
        module: fs,
        targets: [{ format: renderGpu.format }]
      },
      primitive: { topology: topology === 0 ? "triangle-list" : "triangle-list" }
    });
    renderGpu.device.popErrorScope().then((err) => {
      if (err) {
        if (!self._webGpuPipeFirstErr) {
          self._webGpuPipeFirstErr = true;
          console.log(
            `[webgpu-cmd-pipeline] pipeline ${pipelineId} (vs=${vsShaderId} ` +
            `fs=${fsShaderId}) validation error: ${String(err.message).slice(0, 280)}`
          );
        }
      } else {
        webGpuObjects.pipelines.set(pipelineId, pipe);
        console.log(
          `[webgpu-cmd-pipeline] GPURenderPipeline ${pipelineId} built OK ` +
          `from real Dolphin VS=${vsShaderId}+FS=${fsShaderId} — ` +
          `shader-pair pipeline proven`
        );
      }
    }).catch(() => {});
  } catch (e) {
    if (!self._webGpuPipeErr) {
      self._webGpuPipeErr = true;
      console.log(`[webgpu-cmd-pipeline] createRenderPipeline threw: ${e?.message || e}`);
    }
  }
}

// Day-33 A2: consumer-side WebGPU enum tables. The producer pre-maps
// every Dolphin pipeline-state enum to these numeric codes (see
// SerializePipelineConfig), so this side never reasons about GameCube
// semantics — it just indexes.
const WGPU_VERTEX_FORMAT = [
  "float32", "float32x2", "float32x3", "float32x4",
  "uint8x2", "uint8x4", "sint8x2", "sint8x4",
  "unorm8x2", "unorm8x4", "snorm8x2", "snorm8x4",
  "uint16x2", "uint16x4", "sint16x2", "sint16x4",
  "unorm16x2", "unorm16x4", "snorm16x2", "snorm16x4"
];
const WGPU_COMPARE = [
  "never", "less", "equal", "less-equal",
  "greater", "not-equal", "greater-equal", "always"
];
const WGPU_BLEND_FACTOR = [
  "zero", "one", "src", "one-minus-src",
  "src-alpha", "one-minus-src-alpha", "dst", "one-minus-dst",
  "dst-alpha", "one-minus-dst-alpha"
];
const WGPU_BLEND_OP = ["add", "subtract", "reverse-subtract"];

const webGpuPcfg = { ok: 0, fail: 0, defer: 0 };

// Day-33 A2: build a real GPURenderPipeline from the serialized
// AbstractPipelineConfig blob (replaces the Day-32 layout:"auto" +
// test-FS proof with Dolphin's real blend/depth/raster/vertex state).
// Bind-group layout is still derived (layout:"auto") — explicit
// layouts + vertex/uniform buffers land in A3/A4; this increment
// measures real-pipeline build coverage. One-shot per pipeline id.
function replayCreatePipelineCfg(pipelineId, blobPtr, blobLen) {
  if (!renderGpu || !blobPtr || !blobLen ||
      webGpuObjects.pipelines.has(pipelineId)) {
    return;
  }
  const u = new Uint32Array(moduleInstance.HEAPU8.buffer, blobPtr,
                            blobLen >>> 2);
  if (u[0] !== 0x57504c33) {  // 'WPL3'
    if (!self._webGpuPcfgMagic) {
      self._webGpuPcfgMagic = true;
      console.log(`[webgpu-pcfg] bad magic 0x${u[0].toString(16)} id=${pipelineId}`);
    }
    return;
  }
  const vsId = u[1], fsId = u[2];
  const vs = webGpuObjects.shaders.get(vsId);
  const fs = webGpuObjects.shaders.get(fsId);
  if (!vs || !fs) {
    // FIFO guarantees CreateShader drained first; modules build
    // synchronously at drain, so a miss is rare. Defer this frame.
    webGpuPcfg.defer += 1;
    if (!self._webGpuPcfgDefer) {
      self._webGpuPcfgDefer = true;
      console.log(
        `[webgpu-pcfg] defer id=${pipelineId} vs ${vsId}=${vs ? 1 : 0} ` +
        `fs ${fsId}=${fs ? 1 : 0}`
      );
    }
    return;
  }

  const topology = u[3];
  const stripIdxFmt = u[4];
  const cullCode = u[5];
  const depthTest = u[7];
  const depthWrite = u[8];
  const depthCompare = u[9];
  const hasDepth = u[10];
  const depthFmt = u[11];
  const colorFmt = u[12];
  const blendEnable = u[13];
  const writeMask = u[14];
  const colorOp = u[15];
  const srcF = u[16];
  const dstF = u[17];
  const alphaOp = u[18];
  const srcFA = u[19];
  const dstFA = u[20];
  const stride = u[24];
  const attrCount = u[25];

  const attributes = [];
  for (let i = 0; i < attrCount; i++) {
    const base = 26 + i * 3;
    attributes.push({
      shaderLocation: u[base],
      format: WGPU_VERTEX_FORMAT[u[base + 1]] || "float32x4",
      offset: u[base + 2]
    });
  }

  // §28ap: cap 24→1200 so the late-created MENU pipelines (id≈16000+,
  // fs#16081) are captured — compare their serialized vertex
  // attributes (esp. the TexCoord0 = @location(8) entry the menu VS
  // reads) vs the VS @location inputs to settle data-vs-layout for
  // the dark-content defect (§28an). Tag the texcoord attrs.
  if (attrCount > 0 && (self._wgPcfgAttrN = (self._wgPcfgAttrN || 0) + 1) <= 1200) {
    const tc = attributes.filter((a) => a.shaderLocation >= 8 &&
      a.shaderLocation <= 15);
    console.log(`[webgpu-DIAG-attr] pcfg id=${pipelineId} vs=${vsId} fs=${fsId} ` +
      `stride=${stride} attrCount=${attrCount} ` +
      attributes.map((a) => `L${a.shaderLocation}:${a.format}@${a.offset}`).join(" ") +
      ` | texcoordAttrs=${tc.length ? tc.map((a) => `L${a.shaderLocation}:${a.format}@${a.offset}`).join(",") : "NONE"}`);
  }

  const TOPO = ["point-list", "line-list", "triangle-list",
                "triangle-strip"];
  const CULL = ["none", "back", "front"];

  const target = {
    format: colorFmt === 1 ? "bgra8unorm" : "rgba8unorm",
    writeMask: writeMask
  };
  if (blendEnable) {
    target.blend = {
      color: {
        srcFactor: WGPU_BLEND_FACTOR[srcF] || "one",
        dstFactor: WGPU_BLEND_FACTOR[dstF] || "zero",
        operation: WGPU_BLEND_OP[colorOp] || "add"
      },
      alpha: {
        srcFactor: WGPU_BLEND_FACTOR[srcFA] || "one",
        dstFactor: WGPU_BLEND_FACTOR[dstFA] || "zero",
        operation: WGPU_BLEND_OP[alphaOp] || "add"
      }
    };
  }

  const desc = {
    label: `dolphin-pcfg-${pipelineId}`,
    layout: getFixedLayouts().pipelineLayout,
    vertex: {
      module: vs,
      buffers: attrCount > 0
        ? [{ arrayStride: stride, stepMode: "vertex", attributes }]
        : []
    },
    fragment: { module: fs, targets: [target] },
    primitive: {
      topology: TOPO[topology] || "triangle-list",
      // §28g ROOT-CAUSE FIX: the GX vertex shader negates clip-space Y
      // (VertexShaderGen Y-flip → `pos.y = -pos.y`), which REVERSES
      // triangle winding. With the default frontFace "ccw" the
      // Dolphin-driven back/front cull then removes exactly the
      // geometry that should be visible — the confirmed cause of the
      // black difficulty-select roster/scene (bisected via
      // DIAG_RASTER_OPEN → DIAG_CULL_NONE_ONLY: cull-none renders it
      // fully, scissor innocent). Declaring frontFace "cw" compensates
      // for the VS Y-flip so Dolphin's cull semantics are correct;
      // cull-none draws (boot/text/2D UI) are unaffected.
      frontFace: "cw",
      cullMode: DIAG_RASTER_OPEN ? "none" : (CULL[cullCode] || "none")
    },
    multisample: { count: 1 }
  };
  if (topology === 3 && stripIdxFmt === 1) {
    desc.primitive.stripIndexFormat = "uint16";
  }
  if (hasDepth) {
    desc.depthStencil = {
      format: depthFmt === 1 ? "depth32float" : "depth24plus",
      depthWriteEnabled: !!depthWrite,
      depthCompare: depthTest ? (WGPU_COMPARE[depthCompare] || "always")
                              : "always"
    };
  }

  // Store a template; the actual GPURenderPipeline is built lazily per
  // (colorFmt, depthFmt) the pass actually uses — Dolphin's pipeline
  // framebuffer-state and the real WebGPU target formats can diverge
  // (RGBA8 vs the bgra8unorm canvas/XFB), and WebGPU requires an exact
  // attachment match. Pipeline *variants* keyed on the live pass
  // formats eliminate the whole attachment-mismatch class.
  const depthBase = hasDepth
    ? { depthWriteEnabled: !!depthWrite,
        depthCompare: depthTest ? (WGPU_COMPARE[depthCompare] || "always")
                                : "always" }
    : null;
  // §28: persist a compact pipeline-state summary so the EFB-draw
  // tally can report why the backdrop draw produces black (writeMask
  // 0? blend dst-only? depth always-fail? which FS to dump?).
  const s28dbg = `fs#${fsId} vs#${vsId} wm${writeMask}` +
    ` blend${blendEnable ? `1:${srcF}/${dstF}` : "0"}` +
    ` depth${hasDepth ? `${depthTest ? 1 : 0}/${depthWrite ? 1 : 0}/${depthCompare}` : "off"}`;
  webGpuObjects.pipeTpl.set(pipelineId, { desc, target, depthBase, s28dbg, fsId, vsId });
  // Build the default (pcfg-format) variant now so the map is warm.
  resolvePipeline(pipelineId, target.format, depthBase ? desc.depthStencil.format : null,
                  { vsId, fsId, attrCount, stride, blendEnable, hasDepth });
}

// Return (building+caching on first use) the pipeline variant whose
// colour/depth attachment formats match the render pass it'll run in.
function resolvePipeline(pipelineId, colorFmt, depthFmt, dbg, revZ) {
  // §28af: revZ is per-PASS (from the SET_VIEWPORT near>far that
  // precedes this draw). Default to the last-seen pass state so the
  // warm template build (revZ undefined) doesn't pin a wrong variant.
  if (revZ === undefined) revZ = !!self._wgPassRevZ;
  const tpl = webGpuObjects.pipeTpl.get(pipelineId);
  // §28ai SMOOTHNESS: the rz0/rz1 split only changes the descriptor
  // when there's a depth attachment AND a FLIPPABLE compare
  // (less/greater/less-equal/greater-equal). For depthless pipelines
  // (copies/composites/most UI) and depth pipelines with
  // always/equal/never/not-equal, rz1 builds a byte-identical
  // pipeline → a wasted second WebGPU compile (stutter). Collapse
  // those to a single rz0 variant — zero correctness change (the
  // §28af flip is already a no-op there), fewer pipeline compiles.
  const _fc = tpl && tpl.depthBase ? tpl.depthBase.depthCompare : null;
  const rzRelevant = !!depthFmt && (_fc === "less" || _fc === "greater" ||
    _fc === "less-equal" || _fc === "greater-equal");
  // §28at: single convention — flip for every rzRelevant draw
  // (REVZ_COMPARE_FLIP_ALL), so the variant key no longer depends on
  // per-pass revZ (which is uniformly false at flag=false anyway).
  const keyRz = ((typeof REVZ_COMPARE_FLIP_ALL !== "undefined" &&
                  REVZ_COMPARE_FLIP_ALL)
                   ? rzRelevant
                   : (rzRelevant && revZ)) ? 1 : 0;
  const key = `${pipelineId}|${colorFmt}|${depthFmt}|rz${keyRz}`;
  const cached = webGpuObjects.pipeVar.get(key);
  if (cached !== undefined) return cached;
  if (!tpl) { webGpuObjects.pipeVar.set(key, null); return null; }
  const d = Object.assign({}, tpl.desc);
  d.fragment = { module: tpl.desc.fragment.module,
                 targets: [Object.assign({}, tpl.target, { format: colorFmt })] };
  if (depthFmt) {
    d.depthStencil = Object.assign({ format: depthFmt },
      tpl.depthBase || { depthWriteEnabled: false, depthCompare: "always" });
    // §28ad/§28af ROOT FIX (3D-black layer (a)): reverse-Z compare
    // flip — but ONLY for reverse-Z passes. Dolphin runs
    // bSupportsReversedDepthRange=true so it emits the GX compare
    // UNflipped and relies on a reversed VkViewport to carry
    // reverse-Z. WebGPU/Dawn forbids minDepth>maxDepth, so we keep a
    // normal viewport; for the perspective (reversed-viewport) draws
    // the window depth is reverse-Z (near→1,far→0) and the GX
    // LEQUAL/LESS compare must be flipped to GEQUAL/GREATER (+ depth
    // cleared to far=0.0 at depthClearValue). §28ad flipped this
    // GLOBALLY, which INVERTED occlusion on the normal-Z (vp
    // near<far) menu/UI/overlay depth draws → menu rendered dark and
    // the title flickered (user-reported). §28af makes it per-pass:
    // flip + clear-0 only when revZ; normal-Z passes keep the GX
    // compare and clear to 1.0 unchanged (no §28g/menu regression).
    if (REVZ_COMPARE_FLIP && rzRelevant &&
        ((typeof REVZ_COMPARE_FLIP_ALL !== "undefined" &&
          REVZ_COMPARE_FLIP_ALL) || revZ)) {
      const F = { "less": "greater", "greater": "less",
                  "less-equal": "greater-equal",
                  "greater-equal": "less-equal" };
      const c = d.depthStencil.depthCompare;
      if (F[c]) d.depthStencil.depthCompare = F[c];
    }
    // DIAGNOSTIC (revertible): force depth-test off so nothing is
    // depth-rejected. With the EFB→canvas DIAG, this bisects "black
    // EFB": geometry appears ⇒ uniform depth-rejection (EFB depth
    // clear / GX-vs-Vulkan z convention); still black ⇒ transform/
    // vertex bug. Flip false to restore real depth state.
    if (DIAG_DEPTH_ALWAYS) {
      d.depthStencil.depthCompare = "always";
      d.depthStencil.depthWriteEnabled = false;
    }
  } else {
    delete d.depthStencil;
  }
  let pipe = null;
  try {
    renderGpu.device.pushErrorScope("validation");
    pipe = renderGpu.device.createRenderPipeline(d);
    renderGpu.device.popErrorScope().then((err) => {
      if (err) {
        webGpuObjects.pipeVar.set(key, null);
        webGpuPcfg.fail += 1;
        // DIAG: log the first ~24 distinct variant failures (not just
        // the first ever) — silent per-pipeline VS↔FS interstage
        // mismatches are the leading textured-black suspect (§14).
        if ((self._wgPcfgFailN = (self._wgPcfgFailN || 0) + 1) <= 24) {
          console.log(`[webgpu-pcfg] variant FAIL ${key}` +
            (dbg ? ` (vs=${dbg.vsId} fs=${dbg.fsId} attrs=${dbg.attrCount})` : "") +
            `: ${String(err.message).slice(0, 220)}`);
        }
      } else {
        webGpuPcfg.ok += 1;
        if (webGpuPcfg.ok <= 3 || webGpuPcfg.ok % 128 === 0) {
          console.log(`[webgpu-pcfg] variant OK ${key} ` +
            `[ok=${webGpuPcfg.ok} fail=${webGpuPcfg.fail}]`);
        }
      }
    }).catch(() => {});
  } catch (e) {
    webGpuPcfg.fail += 1;
    if (!self._webGpuPcfgThrew) {
      self._webGpuPcfgThrew = true;
      console.log(`[webgpu-pcfg] createRenderPipeline threw ${key}: ${e?.message || e}`);
    }
  }
  webGpuObjects.pipeVar.set(key, pipe);
  return pipe;
}

// Day-28: build a real GPUShaderModule from a WGSL blob in the shared
// wasm heap, keyed by the producer-assigned id. createShaderModule is
// synchronous; compilation diagnostics come back via the async
// getCompilationInfo() — we count ok/fail off that and surface the
// first few + the first error so we can see how much of Dolphin's
// real shader set survives GLSL→Naga→WGSL→browser end-to-end.
function replayCreateShader(id, blobPtr, blobLen, stage) {
  if (!self._webGpuShaderSeen) {
    self._webGpuShaderSeen = true;
    console.log(
      `[webgpu-cmd-shader] first CREATE_SHADER reached consumer: id=${id} ` +
      `ptr=${blobPtr} len=${blobLen} stage=${stage} ` +
      `renderGpu=${renderGpu ? 1 : 0} dec=${webGpuTextDecoder ? 1 : 0}`
    );
  }
  if (!renderGpu || !webGpuTextDecoder || !blobPtr || !blobLen) {
    webGpuObjects.shaderFail += 1;
    return;
  }
  let wgsl;
  try {
    // TextDecoder.decode() rejects SharedArrayBuffer-backed views in
    // several engines ("cannot decode from a shared ArrayBuffer"), so
    // copy the blob into a plain (non-shared) Uint8Array first. The
    // copy is small (a shader's WGSL, ~1-4 KB) and one-time per shader.
    const shared = new Uint8Array(moduleInstance.HEAPU8.buffer, blobPtr, blobLen);
    const local = new Uint8Array(blobLen);
    local.set(shared);
    wgsl = webGpuTextDecoder.decode(local);
  } catch (e) {
    webGpuObjects.shaderFail += 1;
    if (!self._webGpuShaderDecodeErr) {
      self._webGpuShaderDecodeErr = true;
      console.log(`[webgpu-cmd-shader] WGSL decode failed: ${e?.message || e}`);
    }
    return;
  }

  // DIAG one-shot per stage: dump the translated WGSL head so the
  // @group/@binding for the UBO blocks and the @location vertex inputs
  // can be checked against the producer's group0 layout + pcfg vertex
  // attributes (the suspected black-EFB cause: shader-interface
  // mismatch).
  // Compact interface map: for every distinct vertex shader, log just
  // its `fn main(...)` signature (the @location inputs). Correlate
  // shader id ↔ [webgpu-DIAG-attr]'s pcfg vs=<id> attrs to find the
  // vertex-attribute interface mismatch.
  if (stage === 0 && (self._wgWgslN = (self._wgWgslN || 0) + 1) <= 24) {
    const mi = wgsl.indexOf("fn main(");
    let sig = "(no main)";
    if (mi >= 0) {
      const end = wgsl.indexOf("{", mi);
      sig = wgsl.slice(mi, end >= 0 ? end : mi + 240).replace(/\s+/g, " ");
    }
    console.log(`[webgpu-DIAG-wgsl] vs id=${id} len=${wgsl.length} ${sig}`);
  }
  // Full body of the first GX vertex shader (has @location inputs, big)
  // to trace how @builtin(position) is computed from the position attr
  // + VSBlock (clip-space / projection / Y-Z-W convention).
  if (stage === 0 && wgsl.length > 5000 && wgsl.indexOf("@location(0)") >= 0 &&
      !self._wgVsFull) {
    self._wgVsFull = true;
    for (let o = 0; o < wgsl.length; o += 1600) {
      console.log(`[webgpu-DIAG-vsfull id=${id} ${o}] ` +
                  wgsl.slice(o, o + 1600));
    }
  }
  // Full body of the first big GX fragment shader (TEV) — trace
  // texture sampling, TEV combiner, alpha test, ocol0 output to find
  // why textured draws output black.
  if (stage === 2 && wgsl.length > 4000 && !self._wgFsFull) {
    self._wgFsFull = true;
    for (let o = 0; o < wgsl.length; o += 1600) {
      console.log(`[webgpu-DIAG-fsfull id=${id} ${o}] ` +
                  wgsl.slice(o, o + 1600));
    }
  }
  // §28: stash pixel-shader WGSL by id (capped) so the EFB-draw tally
  // can dump the specific black-backdrop FS on demand.
  if (stage === 2) {
    self._wgFsSrc = self._wgFsSrc || {};
    if (self._wgFsSrc[id] === undefined &&
        Object.keys(self._wgFsSrc).length < 80) {
      self._wgFsSrc[id] = wgsl;
    }
  }
  // §28e: also stash vertex-shader WGSL by id — the backdrop FS = pure
  // vertex-colour pass-through, so the black comes from the VS colour
  // output. Dump the backdrop VS alongside its FS to see how color0 is
  // synthesised (per-vertex attr vs lighting/material UBO constants).
  if (stage === 0) {
    self._wgVsSrc = self._wgVsSrc || {};
    if (self._wgVsSrc[id] === undefined &&
        Object.keys(self._wgVsSrc).length < 80) {
      self._wgVsSrc[id] = wgsl;
    }
  }

  // [webgpu-DIAG-util] Full body of the small utility shaders (EFB-copy
  // VS/FS, screen-quad, color/copy FS — all < 4 KB; GX TEV shaders are
  // far bigger so the length cap excludes them). The EFB-copy targets
  // are still opaque-black after the utility-uniform fix, so trace the
  // copy VS (vertex_index fullscreen-tri + src_offset/src_size from the
  // PSBlock UBO) and the copy FS (SampleEFB → ocol0) for the real cause.
  if (wgsl.length < 4000 &&
      (self._wgUtilN = (self._wgUtilN || 0) + 1) <= 8) {
    for (let o = 0; o < wgsl.length; o += 1600) {
      console.log(`[webgpu-DIAG-util id=${id} s${stage} ${o}] ` +
                  wgsl.slice(o, o + 1600));
    }
  }

  // [s28aw] DECISIVE dark-menu experiment (JS-only, gated, revertible):
  // §28av proved the menu sampled UV is valid [0,1]; the remaining
  // strong candidate is the textureSampleBias array-LAYER index. The
  // menu textures are single-layer but bound as 2d-array views; if the
  // texgen 3rd coord makes i32(_eN.z) ≥ 1 the sample is out-of-range ⇒
  // 0 ⇒ black. Force the layer to 0 in FS textureSampleBias calls and
  // see if the menu renders. Verified against BOTH the menu (must
  // render) and title/3D (must NOT regress) before keeping.
  if (S28AW_FORCE_TEXLAYER0 && stage === 2 &&
      wgsl.indexOf("textureSampleBias(") >= 0) {
    const before = wgsl;
    wgsl = wgsl.replace(/(textureSampleBias\([^;]*?,\s*)i32\(_e\d+\.z\)/g,
                        "$1" + "0i");
    if (wgsl !== before &&
        (self._wgS28awN = (self._wgS28awN || 0) + 1) <= 4) {
      console.log(`[s28aw] forced textureSampleBias layer→0 in fs id=${id}`);
    }
  }
  // [s28ax] decisive bisection: replace the textured-FS entry body
  // (the only `-> @location(0) vec4<f32> { … }`, no nested braces in
  // Naga's main) with a constant magenta return.
  if (S28AX_FS_CONST && stage === 2 &&
      wgsl.indexOf("textureSampleBias(") >= 0) {
    const before = wgsl;
    wgsl = wgsl.replace(
      /(->\s*@location\(0\)\s*vec4<f32>\s*\{)[^{}]*\}/,
      "$1 return vec4<f32>(1.0, 0.0, 1.0, 1.0); }");
    if (wgsl !== before &&
        (self._wgS28axN = (self._wgS28axN || 0) + 1) <= 4) {
      console.log(`[s28ax] forced const-magenta FS id=${id}`);
    }
  }
  // [s28bf] visualise the sampled UV: replace textureSampleBias(t,s,
  // vec2<f32>(UV), layer, bias) with vec4(UV.x, UV.y, 0, 1) so the
  // TEV carries the texgen UV as colour. Naga form:
  // textureSampleBias(p6, p7, vec2<f32>(_eN.x, _eN.y), i32(_eN.z), _eM)
  if (S28BF_SHOW_UV && stage === 2 &&
      wgsl.indexOf("textureSampleBias(") >= 0) {
    const before = wgsl;
    wgsl = wgsl.replace(
      /textureSampleBias\(\s*\w+\s*,\s*\w+\s*,\s*(vec2<f32>\([^()]*\))\s*,\s*[^,]*,\s*\w+\s*\)/g,
      "vec4<f32>(($1).x, ($1).y, 0.0, 1.0)");
    if (wgsl !== before &&
        (self._wgS28bfN = (self._wgS28bfN || 0) + 1) <= 4) {
      console.log(`[s28bf] showing UV-as-colour fs id=${id}`);
    }
  }
  // [s28bb] isolate sample mechanics: textureSampleBias(t,s,c,l,bias)
  // → textureSampleLevel(t,s,c,l,0.0). Naga emits the bias as the
  // final `_e<N>` arg right after `i32(_e<N>.z)`; swap the call name
  // and replace that last arg with explicit LOD 0.0.
  if (S28BB_SAMPLE_LOD0 && stage === 2 &&
      wgsl.indexOf("textureSampleBias(") >= 0) {
    const before = wgsl;
    wgsl = wgsl
      .replace(/textureSampleBias\(/g, "textureSampleLevel(")
      .replace(/(textureSampleLevel\([^;]*?,\s*i32\(_e\d+\.z\)\s*),\s*_e\d+\)/g,
               "$1, 0.0)");
    if (wgsl !== before &&
        (self._wgS28bbN = (self._wgS28bbN || 0) + 1) <= 4) {
      console.log(`[s28bb] textureSampleBias→Level(…,0.0) fs id=${id}`);
    }
  }
  // [s28ay] sample-vs-TEV bisect: dolphin_fn_1_ is the texture-sampler
  // helper (`-> vec4<i32> { …no nested braces… return _eN; }`). Force
  // it to return white so the TEV runs with a known-good "sample".
  if (S28AY_SAMPLER_WHITE && stage === 2 &&
      wgsl.indexOf("fn dolphin_fn_1_(") >= 0 &&
      wgsl.indexOf("textureSampleBias(") >= 0) {
    const before = wgsl;
    wgsl = wgsl.replace(
      /(fn dolphin_fn_1_\([^{]*\{)[^{}]*\}/,
      "$1 return vec4<i32>(255i, 255i, 255i, 255i); }");
    if (wgsl !== before &&
        (self._wgS28ayN = (self._wgS28ayN || 0) + 1) <= 4) {
      console.log(`[s28ay] forced dolphin_fn_1_→white FS id=${id}`);
    }
  }
  let module;
  try {
    module = renderGpu.device.createShaderModule({
      label: `dolphin-shader-${id}-s${stage}`,
      code: wgsl
    });
  } catch (e) {
    webGpuObjects.shaderFail += 1;
    if (!self._webGpuShaderFirstErr) {
      self._webGpuShaderFirstErr = true;
      // console.log (not postStatus) so the validator's console.log
      // capture preserves it — postStatus only keeps the latest pill.
      console.log(`[webgpu-cmd-shader] createShaderModule threw: ${e?.message || e}`);
    }
    return;
  }
  webGpuObjects.shaders.set(id, module);
  if (webGpuObjects.shaders.size <= 4) {
    console.log(
      `[webgpu-cmd-shader] GPUShaderModule created id=${id} stage=${stage} ` +
      `wgslLen=${wgsl.length} hasCompileInfo=` +
      `${typeof module.getCompilationInfo === "function" ? 1 : 0} ` +
      `(map size=${webGpuObjects.shaders.size})`
    );
  }

  // Validate asynchronously (discio worker is event-loop driven, so
  // this resolves — unlike the pthread). Count + report via
  // console.log so it lands in the captured console stream.
  if (typeof module.getCompilationInfo === "function") {
    module.getCompilationInfo().then((info) => {
      const errs = (info?.messages || []).filter((m) => m.type === "error");
      if (errs.length === 0) {
        webGpuObjects.shaderOk += 1;
        if (webGpuObjects.shaderOk <= 4) {
          console.log(
            `[webgpu-cmd-shader] module id=${id} stage=${stage} compiled OK ` +
            `[ok=${webGpuObjects.shaderOk} fail=${webGpuObjects.shaderFail}]`
          );
        }
      } else {
        webGpuObjects.shaderFail += 1;
        if (!self._webGpuShaderFirstCompileErr) {
          self._webGpuShaderFirstCompileErr = true;
          const e0 = errs[0];
          console.log(
            `[webgpu-cmd-shader] first WGSL compile error (id=${id} stage=${stage}) ` +
            `L${e0.lineNum}:${e0.linePos} ${String(e0.message).slice(0, 220)}`
          );
          // Day-31: dump the offending WGSL so we can see the
          // cyclic-function pattern Naga emitted. Cap to keep the log
          // sane; include line numbers for cross-ref with the error.
          try {
            const lines = String(wgsl).split("\n");
            const dump = lines
              .map((ln, i) => `${i + 1}: ${ln}`)
              .join("\n")
              .slice(0, 6000);
            console.log(`[webgpu-cmd-wgsl] id=${id} (${lines.length} lines):\n${dump}`);
          } catch (e) { /* best-effort */ }
        }
      }
    }).catch(() => { webGpuObjects.shaderFail += 1; });
  } else {
    webGpuObjects.shaderOk += 1;
  }
}

// Day-17 phase 4: receive XFB pixel data from `WebGPUGfx::ShowImage`
// (`?video=wgpu` path). The C++ side posts {type:'webgpu-show-image',
// width, height, bytes: Uint8Array} from the GPU pthread; we feed
// those bytes through the existing WebGPU presenter pipeline so the
// canvas displays the real frame via a `wgpuRenderPass` blit.
let webGpuShowImageCount = 0;
function handleWebGpuShowImage(event) {
  const data = event.data;
  if (!data || data.type !== "webgpu-show-image" || !data.ptr || !data.len) return;
  webGpuShowImageCount += 1;
  if (webGpuShowImageCount === 1) {
    postStatus(
      `WebGPU video backend: first XFB frame ${data.width}x${data.height} ` +
        `(zero-copy via shared heap @0x${data.ptr.toString(16)})`
    );
  }
  try {
    // Zero-copy: read the pixels straight out of the shared wasm heap
    // at the pointer C++ handed us. drawFrameBytesToWebGpu only reads
    // the view (queue.writeTexture copies into the GPU texture), so no
    // intermediate JS allocation is needed.
    const heap = moduleInstance?.HEAPU8;
    if (!heap) return;
    const frameView = new Uint8Array(heap.buffer, data.ptr, data.len);
    drawFrameBytesToWebGpu(data.width, data.height, frameView);
  } catch (e) {
    if (!self._webGpuShowImageErrLogged) {
      self._webGpuShowImageErrLogged = true;
      postStatus(`webgpu-show-image draw error: ${e?.message || e}`);
    }
  }
}

let detachedOglForwardedCount = 0;
function handleDetachedOglFrame(event) {
  const data = event.data;
  if (!data || data.type !== "detachedOglFrame" || !data.bitmap) return;
  detachedOglForwardedCount += 1;
  if (detachedOglForwardedCount === 1) {
    postStatus(
      `ogl-detached: first bitmap received from GPU pthread (${data.width}x${data.height}); forwarding to main`
    );
  }
  try {
    self.postMessage(
      { type: "detachedOglFrame", bitmap: data.bitmap, width: data.width, height: data.height },
      [data.bitmap]
    );
  } catch (err) {
    if (!self._detachedOglForwardErrLogged) {
      self._detachedOglForwardErrLogged = true;
      postStatus(`ogl-detached: forward to main failed: ${err?.message || err}`);
    }
    try { data.bitmap.close(); } catch {}
  }
}

// Day-1 instrumentation: drain the C++ per-frame ring buffer ~1Hz and print
// new entries to console. The C side pushes one entry per OGL swap; entries
// are 32 bytes / 8 × u32 (see DolphinWebFrameRingEntry in
// core/upstream/dolphin_web_discio.cpp). Layout:
//   u32 frame, prim, draw, verts, xfb_hash, glerr; i32 commit_result; u32 debug_bits
//
// `head` is monotonic so we can detect overflow (newEntries > capacity).
let frameRingDrainTimer = null;
let frameRingLastDrainHead = 0;
function startFrameRingDrainLoop() {
  if (frameRingDrainTimer || !api?.getFrameRingHead || !api?.getFrameRingEntryPtr) {
    return;
  }
  const capacity = api.getFrameRingCapacity?.() | 0;
  const entrySize = api.getFrameRingEntrySize?.() | 0;
  if (capacity <= 0 || entrySize !== 32) {
    postStatus(`frame-ring drain disabled: capacity=${capacity} entrySize=${entrySize}`);
    return;
  }
  const ptr = api.getFrameRingEntryPtr();
  if (!ptr || !moduleInstance?.HEAPU32) {
    postStatus("frame-ring drain disabled: no HEAPU32 or null ptr");
    return;
  }
  frameRingLastDrainHead = api.getFrameRingHead?.() >>> 0;
  postStatus(
    `frame-ring drain online: capacity=${capacity} ptr=0x${ptr.toString(16)} startHead=${frameRingLastDrainHead}`
  );
  frameRingDrainTimer = setInterval(() => {
    const heap = moduleInstance.HEAPU32;
    if (!heap || !api?.getFrameRingHead) return;
    const head = api.getFrameRingHead() >>> 0;
    if (head === frameRingLastDrainHead) return;
    const total = (head - frameRingLastDrainHead) >>> 0;
    const overflowed = total > capacity;
    const startIndex = overflowed ? head - capacity : frameRingLastDrainHead;
    const baseIndex = (ptr >>> 2);
    const u32sPerEntry = 8;
    if (overflowed) {
      postStatus(`frame-ring overflow: ${total} entries dropped (capacity=${capacity})`);
    }
    for (let n = startIndex; (n >>> 0) !== head; n = (n + 1) >>> 0) {
      const slot = (n >>> 0) % capacity;
      const off = baseIndex + slot * u32sPerEntry;
      const frame = heap[off + 0] >>> 0;
      const prim = heap[off + 1] >>> 0;
      const draw = heap[off + 2] >>> 0;
      const verts = heap[off + 3] >>> 0;
      const xfbHash = heap[off + 4] >>> 0;
      const glerr = heap[off + 5] >>> 0;
      const commit = heap[off + 6] | 0; // signed
      const debugBits = heap[off + 7] >>> 0;
      console.log(
        `[frame-ring] f=${frame} prim=${prim} draw=${draw} verts=${verts} ` +
          `xfb=0x${xfbHash.toString(16)} glerr=${glerr} commit=${commit} ` +
          `dbg=0x${debugBits.toString(16)}`
      );
    }
    frameRingLastDrainHead = head;
  }, 1000);
}

function formatHex(value) {
  return `0x${Math.trunc(value).toString(16).toUpperCase()}`;
}
