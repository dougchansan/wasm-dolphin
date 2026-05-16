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
const DEFAULT_WASM_JIT_WARMUP_XFB_FRAMES = 3600;
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
        ? (enabled) => ccall("SetPpcWasmJitEnabled", null, ["number"], [enabled ? 1 : 0])
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
      `jit:${jitState} warm:${ppcWasmJitWarmupFrames} present ${renderBackend} signal:${frameSignalHeap ? "wait" : "poll"} mode:${presentationPacingMode} fps:${presentationFps} raw:${presentationRawFps} loop:${presentationLoopFps} gap:${presentationP95IntervalMs}/${presentationMaxIntervalMs}ms long:${presentationLongFrameCount} queue:${frameQueue.length}/${presentationQueueLimit} underrun:${presentationWindowUnderrunCount} drop:${presentationWindowDropCount} frames:${presentedFrame} visualfps:${visualChangeFps} visualsrc:${visualSampleSource} wd:${watchdogRecoveryCount}/${watchdogFireCount}`
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
      if (coreBoot.accepted && frameSignalHeap && renderBackend === "ogl") {
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

  api.setPpcWasmJitEnabled(ppcWasmJitTier === "mixed" ? 2 : 1);
  ppcWasmJitActive = true;
  ppcWasmJitEnabledAtFrame = coreFrame >>> 0;
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
  const catastrophic = presentationFps < WASM_JIT_ABSOLUTE_FLOOR_FPS;

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
const DOLPHIN_JIT_CACHE_MAX = 8192; // hard cap on in-memory entries
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
  // Cached entries are stored as bytes (WebAssembly.Module storage in IDB
  // proved unreliable across Chromium versions). Compile each on discio
  // before sending to pthreads — Module is structured-cloneable across
  // postMessage, so each pthread receives a ready-to-instantiate Module.
  for (const { key, value } of entries) {
    if (!(value instanceof Uint8Array) && !(value instanceof ArrayBuffer)) continue;
    if (dolphinJitCacheMap.has(key)) continue;
    if (dolphinJitCacheMap.size >= DOLPHIN_JIT_CACHE_MAX) break;
    try {
      const buf = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
      const mod = await WebAssembly.compile(buf);
      dolphinJitCacheMap.set(key, mod);
      loaded += 1;
    } catch {
      // Skip corrupt entries; they'll be re-cached on next miss.
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
let webGpuCmdRing = null;  // { headerI32, slotsBase, capacity }
// Day-28/29 resource object table: producer-assigned id → real GPU
// object built here on renderGpu.device.
const webGpuObjects = {
  shaders: new Map(),
  pipelines: new Map(),
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
    capacity: data.capacity >>> 0
  };
  postStatus(
    `webgpu-cmd-ring: registered (cap=${data.capacity}) — GPU command bridge live`
  );
}

// Drain + replay pending commands on renderGpu.device. Called every
// presentation tick. Single-consumer; the producer (video pthread)
// publishes with a release store on `write`, we acquire-load it.
function drainWebGpuCmdRing() {
  const ring = webGpuCmdRing;
  if (!ring || !renderGpu) return;
  const hdr = ring.headerU32;
  // Atomics.load on the Int32Array view = acquire of the producer's
  // release store.
  const write = Atomics.load(ring.headerI32, 0) >>> 0;
  let read = Atomics.load(ring.headerI32, 1) >>> 0;
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
  let lastClear = null;
  let lastDrawTest = null;
  while (read !== write) {
    const slot = read % ring.capacity;
    const recByte = ring.slotsBase + slot * 32;
    const recWord = recByte >>> 2;
    const op = u32[recWord];
    if (op === WGPU_CMD_OP_CLEAR) {
      // Coalesce: only the final CLEAR of the batch matters for a
      // single-clear-per-frame proof.
      lastClear = {
        r: f32[recWord + 1],
        g: f32[recWord + 2],
        b: f32[recWord + 3],
        a: f32[recWord + 4]
      };
    } else if (op === WGPU_CMD_OP_CREATE_SHADER) {
      // Day-28: build a real GPUShaderModule from the WGSL blob the
      // pthread translated (Dolphin GLSL → glslang → Naga → WGSL).
      // arg: [1]=id [2]=blobPtr [3]=blobLen [4]=stage
      const id = u32[recWord + 1];
      const blobPtr = u32[recWord + 2];
      const blobLen = u32[recWord + 3];
      const stage = u32[recWord + 4];
      replayCreateShader(id, blobPtr, blobLen, stage);
    } else if (op === WGPU_CMD_OP_CREATE_PIPELINE) {
      // Day-29: build a real GPURenderPipeline (one-shot).
      // arg: [1]=pipelineId [2]=vsShaderId [3]=topology
      replayCreatePipeline(u32[recWord + 1], u32[recWord + 2], u32[recWord + 3]);
    } else if (op === WGPU_CMD_OP_DRAW_TEST) {
      // arg: [1]=pipelineId [2]=vertexCount. Coalesce: one draw per
      // tick (producer emits one per frame).
      lastClear = null;
      lastDrawTest = { pipelineId: u32[recWord + 1], vertexCount: u32[recWord + 2] };
    }
    read = (read + 1) >>> 0;
  }
  // Publish consumed count (release) so the producer sees free slots.
  Atomics.store(ring.headerI32, 1, read | 0);

  if (lastClear) {
    try {
      const gpu = renderGpu;
      const view = gpu.context.getCurrentTexture().createView();
      const enc = gpu.device.createCommandEncoder({ label: "webgpu-cmd-clear" });
      const pass = enc.beginRenderPass({
        colorAttachments: [{
          view,
          clearValue: lastClear,
          loadOp: "clear",
          storeOp: "store"
        }]
      });
      pass.end();
      gpu.device.queue.submit([enc.finish()]);
      if (!self._webGpuCmdFirst) {
        self._webGpuCmdFirst = true;
        postStatus(
          `webgpu-cmd-ring: first CLEAR replayed (rgba=${lastClear.r.toFixed(2)},` +
          `${lastClear.g.toFixed(2)},${lastClear.b.toFixed(2)}) — bridge proven`
        );
      }
    } catch (e) {
      if (!self._webGpuCmdErr) {
        self._webGpuCmdErr = true;
        postStatus(`webgpu-cmd-ring replay error: ${e?.message || e}`);
      }
    }
  }

  if (lastDrawTest) {
    const pipe = webGpuObjects.pipelines.get(lastDrawTest.pipelineId);
    if (pipe) {
      try {
        const gpu = renderGpu;
        const view = gpu.context.getCurrentTexture().createView();
        const enc = gpu.device.createCommandEncoder({ label: "webgpu-cmd-draw" });
        const pass = enc.beginRenderPass({
          colorAttachments: [{
            view,
            clearValue: { r: 0.02, g: 0.02, b: 0.05, a: 1 },
            loadOp: "clear",
            storeOp: "store"
          }]
        });
        pass.setPipeline(pipe);
        pass.draw(lastDrawTest.vertexCount, 1, 0, 0);
        pass.end();
        gpu.device.queue.submit([enc.finish()]);
        if (!self._webGpuDrawFirst) {
          self._webGpuDrawFirst = true;
          console.log(
            `[webgpu-cmd-pipeline] first DRAW replayed (pipeline=` +
            `${lastDrawTest.pipelineId} verts=${lastDrawTest.vertexCount}) ` +
            `— GPU pipeline path proven`
          );
        }
      } catch (e) {
        if (!self._webGpuDrawErr) {
          self._webGpuDrawErr = true;
          console.log(`[webgpu-cmd-pipeline] DRAW replay error: ${e?.message || e}`);
        }
      }
    }
  }
}

// Day-29: build a real GPURenderPipeline from a bridge-translated
// vertex-shader module + the constant-colour test FS. Wrapped in an
// error scope so WGSL/pipeline-validation failures are reported
// rather than silently swallowed. One-shot per pipeline id.
function replayCreatePipeline(pipelineId, vsShaderId, topology) {
  if (!renderGpu || webGpuObjects.pipelines.has(pipelineId)) return;
  const vs = webGpuObjects.shaders.get(vsShaderId);
  if (!vs) {
    if (!self._webGpuPipeNoVs) {
      self._webGpuPipeNoVs = true;
      console.log(
        `[webgpu-cmd-pipeline] CREATE_PIPELINE id=${pipelineId} but VS id=` +
        `${vsShaderId} not in shader map (drain-order bug?)`
      );
    }
    return;
  }
  try {
    if (!webGpuTestFsModule) {
      webGpuTestFsModule = renderGpu.device.createShaderModule({
        label: "dolphin-test-fs",
        code: WGPU_TEST_FS_WGSL
      });
    }
    renderGpu.device.pushErrorScope("validation");
    const pipe = renderGpu.device.createRenderPipeline({
      label: `dolphin-pipeline-${pipelineId}`,
      layout: "auto",
      vertex: { module: vs },
      fragment: {
        module: webGpuTestFsModule,
        targets: [{ format: renderGpu.format }]
      },
      primitive: { topology: topology === 0 ? "triangle-list" : "triangle-list" }
    });
    renderGpu.device.popErrorScope().then((err) => {
      if (err) {
        console.log(
          `[webgpu-cmd-pipeline] pipeline ${pipelineId} validation error: ` +
          `${String(err.message).slice(0, 200)}`
        );
      } else {
        webGpuObjects.pipelines.set(pipelineId, pipe);
        console.log(
          `[webgpu-cmd-pipeline] GPURenderPipeline ${pipelineId} built OK ` +
          `from bridge VS id=${vsShaderId} — pipeline replay proven`
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
            `L${e0.lineNum}:${e0.linePos} ${String(e0.message).slice(0, 160)}`
          );
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
