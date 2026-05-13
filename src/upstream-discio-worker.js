import { DEFAULT_UPSTREAM_CORE_URL, WORKERFS_MOUNT_DIR, sanitizeDiscFileName } from "./upstream-worker-protocol.js";
import { parseDolHeader } from "./dol.js";

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
const DEFAULT_PRESENTATION_QUEUE = 2;
const MIN_PRESENTATION_QUEUE = 2;
const MAX_PRESENTATION_QUEUE = 12;
const VISUAL_HASH_SAMPLE_STRIDE_BYTES = 256;
const DEFAULT_WASM_JIT_WARMUP_XFB_FRAMES = 3600;
const WASM_JIT_MIN_STABLE_PRESENTATION_FPS = 25;
const WASM_JIT_MAX_STABLE_PRESENTATION_GAP_MS = 80;
const WASM_JIT_MIN_ACTIVE_FRAMES_BEFORE_FUSE = 240;
const WASM_JIT_MIN_ACTIVE_PRESENTATION_FPS = 25;
const WASM_JIT_MAX_ACTIVE_PRESENTATION_GAP_MS = 40;
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
    renderCanvas = moduleCanvas;
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

  moduleInstance = await factory({
    noInitialRun: true,
    canvas: videoBackend === "OGL" ? moduleCanvas || undefined : undefined,
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
    locateFile: (path) => new URL(path, coreUrl).href,
    print: (message) => postStatus(message),
    printErr: (message) => postStatus(message),
    onAbort: (reason) => postStatus(`Emscripten abort: ${reason}`)
  });

  api = bindApi(moduleInstance);
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
  wait.value
    .catch(() => "error")
    .then(() => {
      frameSignalWaitPending = false;
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
  try {
    loopsSincePresentationFps += 1;
    if (moduleInstance && api) {
      pollInputStateFromSab();
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
      addProfileTime("pump", performance.now() - pumpStartedAt);
      lastHostPumpTime = now;
      if (!coreBoot.accepted) {
        const runStartedAt = performance.now();
        api.runFrame?.();
        addProfileTime("run", performance.now() - runStartedAt);
      }

      const apiStartedAt = performance.now();
      const width = api.frameWidth();
      const height = api.frameHeight();
      const pointer = api.frameBuffer();
      const coreFrame = api.getFrame?.() ?? 0;
      addProfileTime("api", performance.now() - apiStartedAt);
      maybeEnablePpcWasmJit(coreFrame);
      if (coreBoot.accepted && frameSignalHeap && renderBackend === "ogl") {
        // OGL bypasses XFB, so api.getFrame() doesn't increment per visible frame.
        // Use the OGL swap count (incremented in DolphinWeb_OnOglSwap) as the
        // present-deduplication key so each new GL swap registers as a new frame.
        const oglSwap = parseOglSwapStats(api.getVideoStats?.()).swap >>> 0;
        const oglFrameKey = oglSwap > 0 ? oglSwap : coreFrame;
        // Detached OGL: worker owns a standalone OffscreenCanvas. After each
        // new GL swap, transferToImageBitmap to capture the rendered frame
        // and post it to main thread for drawImage onto the visible canvas.
        // Bypasses commit/captureStream/transferControlToOffscreen entirely.
        if (detachedOglCanvas && oglFrameKey !== lastPresentedCoreFrame) {
          // Skip if we've already learned the canvas is detached (Emscripten
          // pthread transferred it to the GPU thread). Avoid spamming the
          // status pill with every frame's failure. Set detachedOglCanvas
          // to null after the first failure so we stop trying.
          try {
            const bitmap = detachedOglCanvas.transferToImageBitmap();
            if (bitmap) {
              detachedOglFrameCount += 1;
              self.postMessage(
                { type: "detachedOglFrame", bitmap, width: bitmap.width, height: bitmap.height },
                [bitmap]
              );
              if (detachedOglFrameCount === 1) {
                postStatus(`Detached OGL: first bitmap posted (${bitmap.width}x${bitmap.height})`);
              }
            } else if (detachedOglFrameCount === 0) {
              postStatus("Detached OGL: transferToImageBitmap returned null; disabling");
              detachedOglCanvas = null;
            }
          } catch (err) {
            if (detachedOglFrameCount === 0) {
              postStatus(
                `Detached OGL disabled (${err.message || err}). Canvas was transferred to GPU pthread; ` +
                  `try cpu=single to keep canvas on worker thread.`
              );
            }
            // Disable so we don't spam errors every frame.
            detachedOglCanvas = null;
          }
        }
        presentFrame(width, height, pointer, width * height * 4, oglFrameKey);
      } else if (coreBoot.accepted && frameSignalHeap && presentationPacingMode === "direct") {
        presentFrame(width, height, pointer, width * height * 4, coreFrame);
      } else if (coreBoot.accepted && frameSignalHeap) {
        captureFrameForPacedPresentation(width, height, pointer, width * height * 4, coreFrame);
      } else if (coreFrame !== lastPresentedCoreFrame) {
        presentFrame(width, height, pointer, width * height * 4, coreFrame);
      }
      updatePresentationFps();
      maybeDisablePpcWasmJit(coreFrame);
      addProfileTime("loop", performance.now() - loopStartedAt);
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

  if ((coreFrame >>> 0) < ppcWasmJitWarmupFrames) {
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

  api.setPpcWasmJitEnabled(ppcWasmJitTier === "mixed" ? 2 : 1);
  ppcWasmJitActive = true;
  ppcWasmJitEnabledAtFrame = coreFrame >>> 0;
  postStatus(`Experimental WASM JIT enabled after ${coreFrame} stable video frames`);
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

  if (
    presentationFps >= WASM_JIT_MIN_ACTIVE_PRESENTATION_FPS &&
    presentationP95IntervalMs <= WASM_JIT_MAX_ACTIVE_PRESENTATION_GAP_MS
  ) {
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
      `(fps:${presentationFps} gap:${presentationP95IntervalMs}ms; cooldown ` +
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
const OGL_SAB_MIN_INTERVAL_MS = 14;  // ~70 Hz cap; vsync is 60 Hz on most monitors

function publishOglSabFrame(width, height, frameView) {
  // Throttle to ~60 Hz: without this cap, the worker drives glReadPixels
  // at 150-200 Hz (no presenter pacing in SAB mode), eating GPU pthread
  // time that the CPU emulation pthread could otherwise use. Empirically
  // dropped gameSpeed from 98 % to 67 %. Capping the publish rate keeps the
  // readback at human-visible cadence without saturating the pipeline.
  const now = performance.now();
  if (now - oglSabLastPublishMs < OGL_SAB_MIN_INTERVAL_MS) return;
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
  const sampler = device.createSampler({
    label: "dolphin-xfb-nearest",
    magFilter: "nearest",
    minFilter: "nearest"
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
