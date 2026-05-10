import { DolphinCoreAdapter, dolphinBundleAvailable } from "./dolphin-adapter.js";
import { buttonMaskFromPressed } from "./input.js";
import { UpstreamMainThreadAdapter } from "./upstream-main-thread-adapter.js";
import { UpstreamWorkerAdapter, upstreamBundleAvailable } from "./upstream-worker-adapter.js";
import { instantiateDemoCore } from "./wasm/demo-core.js";

const DEMO_WIDTH = 320;
const DEMO_HEIGHT = 240;
const SAVE_KEY = "wasm-dolphin.demo-state.0";
const VISIBLE_SAMPLE_WIDTH = 96;
const VISIBLE_SAMPLE_HEIGHT = 72;
const VISIBLE_SAMPLE_INTERVAL_MS = 250;
const SAFE_JIT_WARMUP_FRAMES = 5000;

export class EmulatorHost {
  constructor({ canvas, onFrame = () => {}, onStatus = () => {}, onMode = () => {} }) {
    this.canvas = canvas;
    this.onFrame = onFrame;
    this.onStatus = onStatus;
    this.onMode = onMode;

    this.demo = null;
    this.coreKind = requestedCoreKind();
    this.videoBackend = requestedVideoBackend();
    this.cpuThread = requestedCpuThread(this.videoBackend);
    this.cpuCore = requestedCpuCore();
    this.ppcWasmJit = requestedPpcWasmJit(this.videoBackend);
    this.ppcWasmJitTier = requestedPpcWasmJitTier();
    this.ppcWasmJitForce = requestedPpcWasmJitForce();
    this.ppcWasmJitWarmupFrames = requestedPpcWasmJitWarmupFrames(this.videoBackend);
    this.ppcProfile = requestedPpcProfile();
    this.cpuOverclock = requestedCpuOverclock();
    this.emulationSpeed = requestedEmulationSpeed();
    this.presentationScale = requestedPresentationScale();
    this.presentationQueueSize = requestedPresentationQueueSize();
    this.presenterBackend = requestedPresenterBackend();
    this.presentationPacing = requestedPresentationPacing(this.videoBackend);
    this.oglProxyMode = requestedOglProxyMode();
    this.oglTestClear = requestedOglTestClear();
    this.fastSoftwareRaster = requestedFastSoftwareRaster();
    this.collectMetrics = requestedCollectMetrics();
    this.visibleSamplerEnabled = requestedVisibleSampler();
    this.usesMainThreadOgl =
      this.coreKind === "upstream" && this.videoBackend === "OGL" && this.oglProxyMode === "main";
    this.usesAdapterCanvas =
      this.coreKind === "upstream" && !this.usesMainThreadOgl && Boolean(canvas.transferControlToOffscreen);
    this.canvasOwnedByAdapter = this.usesAdapterCanvas || this.usesMainThreadOgl;
    this.context = this.canvasOwnedByAdapter ? null : canvas.getContext("2d", { alpha: false });
    if (this.context) {
      this.context.imageSmoothingEnabled = false;
    }

    this.frameCanvas = this.canvasOwnedByAdapter ? null : document.createElement("canvas");
    if (this.frameCanvas) {
      this.frameCanvas.width = DEMO_WIDTH;
      this.frameCanvas.height = DEMO_HEIGHT;
    }
    this.frameContext = this.frameCanvas?.getContext("2d", { alpha: false }) ?? null;
    this.imageData = this.frameContext?.createImageData(DEMO_WIDTH, DEMO_HEIGHT) ?? null;
    this.pixels = this.imageData ? new Uint32Array(this.imageData.data.buffer) : null;
    this.nativeImageData = null;

    this.adapterLabel = this.coreKind === "upstream" ? "Dolphin upstream core" : "Dolphin native scaffold";
    if (this.coreKind === "upstream" && this.videoBackend === "OGL") {
      const oglScale = Math.min(1, Math.max(0.25, Number(this.presentationScale) || 0.5));
      canvas.width = Math.max(160, Math.round(640 * oglScale));
      canvas.height = Math.max(120, Math.round(480 * oglScale));
    }
    const offscreenCanvas =
      this.usesAdapterCanvas && canvas.transferControlToOffscreen ? canvas.transferControlToOffscreen() : null;
    if (offscreenCanvas) {
      offscreenCanvas.id = "canvas";
    }
    this.adapter =
      this.coreKind === "upstream" && this.usesMainThreadOgl
        ? new UpstreamMainThreadAdapter({
            onStatus,
            canvas,
            videoBackend: this.videoBackend,
            cpuThread: this.cpuThread,
            cpuCore: this.cpuCore,
            ppcWasmJit: this.ppcWasmJit,
            ppcWasmJitTier: this.ppcWasmJitTier,
            ppcWasmJitForce: this.ppcWasmJitForce,
            ppcWasmJitWarmupFrames: this.ppcWasmJitWarmupFrames,
            ppcProfile: this.ppcProfile,
            cpuOverclock: this.cpuOverclock,
            emulationSpeed: this.emulationSpeed,
            presentationScale: this.presentationScale,
            oglTestClear: this.oglTestClear,
            fastSoftwareRaster: this.fastSoftwareRaster
          })
        : this.coreKind === "upstream"
        ? new UpstreamWorkerAdapter({
            onStatus,
            canvas: offscreenCanvas,
            videoBackend: this.videoBackend,
            cpuThread: this.cpuThread,
            cpuCore: this.cpuCore,
            ppcWasmJit: this.ppcWasmJit,
            ppcWasmJitTier: this.ppcWasmJitTier,
            ppcWasmJitForce: this.ppcWasmJitForce,
            ppcWasmJitWarmupFrames: this.ppcWasmJitWarmupFrames,
            ppcProfile: this.ppcProfile,
            cpuOverclock: this.cpuOverclock,
            emulationSpeed: this.emulationSpeed,
            presentationScale: this.presentationScale,
            presentationQueueSize: this.presentationQueueSize,
            presenterBackend: this.presenterBackend,
            presentationPacing: this.presentationPacing,
            oglProxyMode: this.oglProxyMode,
            oglTestClear: this.oglTestClear,
            fastSoftwareRaster: this.fastSoftwareRaster,
            collectMetrics: this.collectMetrics
          })
        : new DolphinCoreAdapter({ canvas, onStatus });
    this.mode = "demo";
    this.running = true;
    this.frame = 0;
    this.lastFpsTime = performance.now();
    this.framesSinceFps = 0;
    this.fps = 0;
    this.coreFps = 0;
    this.gameSpeed = 0;
    this.presentationFps = 0;
    this.visibleChangeFps = 0;
    this.visibleFrameHash = 0;
    this.visibleSampleError = "";
    this.visibleChangesSinceFps = 0;
    this.lastVisibleFrameHash = 0;
    this.lastVisibleSampleAt = 0;
    this.visibleSampleCanvas = document.createElement("canvas");
    this.visibleSampleCanvas.width = VISIBLE_SAMPLE_WIDTH;
    this.visibleSampleCanvas.height = VISIBLE_SAMPLE_HEIGHT;
    this.visibleSampleContext = this.visibleSampleCanvas.getContext("2d", {
      alpha: false,
      willReadFrequently: true
    });
    this.lastCoreFrameForFps = 0;
    this.lastCoreTicksForSpeed = 0;
    this.lastPresentedFrameForFps = 0;
    this.buttonMask = 0;
    this.adapterStatsPollMs = this.canvasOwnedByAdapter ? 250 : 0;
    this.lastAdapterStatsPollAt = 0;
    this.animationId = 0;
    this.game = {
      name: "Demo scene",
      size: 0,
      mounted: false
    };
  }

  async init() {
    const result = await instantiateDemoCore();
    this.demo = result.instance.exports;
    this.onStatus("Demo WASM ready");

    if (await this.adapterAvailable()) {
      this.onMode(`${this.adapterLabel} detected`);
    } else {
      this.onMode("Demo fallback");
    }

    this.start();
  }

  async mountFile(file) {
    this.game = {
      name: file.name,
      size: file.size,
      mounted: true
    };

    if (await this.adapterAvailable()) {
      try {
        const mounted = await this.adapter.mountGame(file);
        this.mode = "dolphin";
        this.game.name = mounted.title || file.name;
        this.game.gameId = mounted.gameId;
        this.game.platform = mounted.platform;
        this.game.region = mounted.region;
        this.game.core = this.adapterLabel;
        this.game.bootDolOffset = mounted.bootDolOffset;
        this.game.bootDolSize = mounted.bootDolSize;
        this.game.fstOffset = mounted.fstOffset;
        this.game.fstSize = mounted.fstSize;
        this.game.apploaderDate = mounted.apploaderDate;
        this.game.apploaderSize = mounted.apploaderSize;
        this.game.rawSize = mounted.rawSize;
        this.game.dataSize = mounted.dataSize;
        this.game.rootEntryCount = mounted.rootEntryCount;
        this.game.rootEntries = mounted.rootEntries ?? [];
        this.game.bootProbe = mounted.bootProbe ?? null;
        this.game.fullCore = mounted.fullCore;
        this.game.coreBoot = mounted.coreBoot;
        this.game.coreState = mounted.coreState;
        this.game.coreStateName = mounted.coreStateName;
        this.game.coreStatus = mounted.coreStatus;
        this.game.coreTitle = mounted.coreTitle;
        this.lastCoreFrameForFps = this.adapter.coreFrame || 0;
        this.lastPresentedFrameForFps = this.adapter.presentedFrame || 0;
        this.coreFps = 0;
        this.presentationFps = 0;
        this.resetVisibleSampler();
        this.onStatus(`${this.adapterLabel} mounted`);
        this.onMode(this.adapterLabel);
        return this.game;
      } catch (error) {
        this.mode = "demo";
        this.onStatus(`Dolphin adapter fallback: ${error.message}`);
      }
    } else {
      this.mode = "demo";
      this.onStatus("Disc mounted for adapter; demo core running");
    }

    return this.game;
  }

  adapterAvailable() {
    return this.coreKind === "upstream" ? upstreamBundleAvailable() : dolphinBundleAvailable();
  }

  start() {
    if (this.running && this.animationId) {
      return;
    }

    this.running = true;
    this.lastAdapterStatsPollAt = 0;
    this.adapter.start();
    this.lastFpsTime = performance.now();
    this.loop();
  }

  pause() {
    this.running = false;
    this.adapter.pause();
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = 0;
    }
  }

  reset() {
    this.frame = 0;
    this.lastCoreFrameForFps = 0;
    this.lastPresentedFrameForFps = 0;
    this.coreFps = 0;
    this.gameSpeed = 0;
    this.presentationFps = 0;
    this.lastCoreTicksForSpeed = 0;
    this.resetVisibleSampler();
    this.adapter.reset();
    this.renderDemo();
    this.publishFrame();
  }

  setPressedButtons(pressedButtons) {
    this.buttonMask = buttonMaskFromPressed(pressedButtons);
    this.adapter.setInputMask(this.buttonMask);
  }

  setInputState(inputState) {
    this.buttonMask = inputState?.mask >>> 0;
    this.adapter.setInputState?.(inputState);
  }

  saveState() {
    if (this.mode === "dolphin") {
      this.adapter.saveState(0);
      this.onStatus("Save slot 0 requested");
      return;
    }

    localStorage.setItem(
      SAVE_KEY,
      JSON.stringify({
        frame: this.frame,
        game: this.game,
        savedAt: new Date().toISOString()
      })
    );
    this.onStatus("Demo save slot written");
  }

  loadState() {
    if (this.mode === "dolphin") {
      this.adapter.loadState(0);
      this.onStatus("Load slot 0 requested");
      return;
    }

    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) {
      this.onStatus("No demo save slot");
      return;
    }

    const state = JSON.parse(raw);
    this.frame = Number(state.frame) || 0;
    this.game = state.game ?? this.game;
    this.renderDemo();
    this.publishFrame();
    this.onStatus("Demo save slot loaded");
  }

  mixAudio(frames = 1024) {
    if (this.mode !== "dolphin") {
      return Promise.resolve({
        available: false,
        frames: 0,
        channels: 2,
        sampleRate: 48000,
        samples: null,
        stats: "audio:demo"
      });
    }

    return this.adapter.mixAudio?.(frames) ?? Promise.resolve({
      available: false,
      frames: 0,
      channels: 2,
      sampleRate: 48000,
      samples: null,
      stats: "audio:unavailable"
    });
  }

  setAudioMuted(muted) {
    if (this.mode === "dolphin") {
      this.adapter.setAudioMuted?.(muted);
    }
  }

  loop = () => {
    if (!this.running) {
      return;
    }

    this.frame += 1;
    if (this.mode === "demo") {
      this.renderDemo();
    } else {
      this.renderDolphin();
    }
    this.publishFrame();
    this.animationId = requestAnimationFrame(this.loop);
  };

  renderDemo() {
    if (!this.demo?.pixel) {
      return;
    }
    if (!this.frameContext || !this.imageData || !this.pixels || !this.context || !this.frameCanvas) {
      return;
    }

    let offset = 0;
    const frame = this.frame >>> 0;
    const mask = this.buttonMask >>> 0;

    for (let y = 0; y < DEMO_HEIGHT; y += 1) {
      for (let x = 0; x < DEMO_WIDTH; x += 1) {
        this.pixels[offset] = this.demo.pixel(x, y, frame, mask);
        offset += 1;
      }
    }

    this.drawFocusMarker(mask, frame);
    this.frameContext.putImageData(this.imageData, 0, 0);
    this.context.drawImage(this.frameCanvas, 0, 0, this.canvas.width, this.canvas.height);
  }

  renderDolphin() {
    if (this.canvasOwnedByAdapter) {
      if (this.adapterStatsPollMs > 0) {
        const now = performance.now();
        if (now - this.lastAdapterStatsPollAt >= this.adapterStatsPollMs) {
          this.lastAdapterStatsPollAt = now;
          this.adapter.pollFrame?.();
        }
      }
      return;
    }
    this.adapter.runFrame();

    const rgba = this.adapter.readFrameRgba();
    if (!rgba || !this.frameContext || !this.context || !this.frameCanvas) {
      return;
    }

    if (
      !this.nativeImageData ||
      this.nativeImageData.width !== this.adapter.width ||
      this.nativeImageData.height !== this.adapter.height
    ) {
      this.frameCanvas.width = this.adapter.width;
      this.frameCanvas.height = this.adapter.height;
      this.nativeImageData = this.frameContext.createImageData(this.adapter.width, this.adapter.height);
    }

    this.nativeImageData.data.set(rgba);
    this.frameContext.putImageData(this.nativeImageData, 0, 0);
    this.context.drawImage(this.frameCanvas, 0, 0, this.canvas.width, this.canvas.height);
  }

  drawFocusMarker(mask, frame) {
    const size = 16 + (mask & 0x0f);
    const x = (frame * 2 + ((mask & 0xf0) << 1)) % (DEMO_WIDTH - size);
    const y = (DEMO_HEIGHT / 2 + Math.sin(frame / 16) * 52) | 0;

    this.frameContext.save();
    this.frameContext.strokeStyle = "#f2efe6";
    this.frameContext.lineWidth = 2;
    this.frameContext.strokeRect(x, y, size, size);
    this.frameContext.restore();
  }

  publishFrame() {
    this.framesSinceFps += 1;
    const now = performance.now();
    const frame = this.mode === "dolphin" ? this.adapter.coreFrame : this.frame;
    const presentedFrame = this.mode === "dolphin" ? this.adapter.presentedFrame : this.frame;
    this.sampleVisibleFrame(now);

    if (now - this.lastFpsTime >= 500) {
      const elapsed = now - this.lastFpsTime;
      this.fps = Math.round((this.framesSinceFps * 1000) / elapsed);
      const measuredCoreFps =
        this.mode === "dolphin" ? Math.max(0, Math.round(((frame - this.lastCoreFrameForFps) * 1000) / elapsed)) : this.fps;
      const coreTicks = this.mode === "dolphin" ? this.adapter.coreTicks : 0;
      const ticksPerSecond = this.mode === "dolphin" ? this.adapter.coreTicksPerSecond || 486000000 : 0;
      const measuredGameSpeed = this.measureGameSpeed(coreTicks, ticksPerSecond, elapsed);
      this.presentationFps = this.mode === "dolphin" ? this.adapter.presentationFps : this.fps;
      this.visibleChangeFps = this.measureVisibleChangeFps(elapsed);
      this.coreFps = measuredCoreFps;
      this.gameSpeed = measuredGameSpeed;
      this.lastCoreFrameForFps = frame;
      this.lastCoreTicksForSpeed = this.mode === "dolphin" ? this.adapter.coreTicks : 0;
      this.lastPresentedFrameForFps = presentedFrame;
      this.framesSinceFps = 0;
      this.lastFpsTime = now;
    }

    this.onFrame({
      frame,
      fps: this.mode === "dolphin" ? this.presentationFps : this.fps,
      uiFps: this.fps,
      coreFps: this.mode === "dolphin" ? this.coreFps : this.fps,
      gameSpeed: this.mode === "dolphin" ? this.gameSpeed : 100,
      presentationFps: this.mode === "dolphin" ? this.presentationFps : this.fps,
      presentationAverageIntervalMs:
        this.mode === "dolphin" ? this.adapter.presentationAverageIntervalMs : 0,
      presentationRawFps: this.mode === "dolphin" ? this.adapter.presentationRawFps : this.fps,
      presentationP95IntervalMs: this.mode === "dolphin" ? this.adapter.presentationP95IntervalMs : 0,
      presentationMaxIntervalMs: this.mode === "dolphin" ? this.adapter.presentationMaxIntervalMs : 0,
      presentationLongFrameCount:
        this.mode === "dolphin" ? this.adapter.presentationLongFrameCount : 0,
      presentationFrameLag: this.mode === "dolphin" ? this.adapter.presentationFrameLag : 0,
      presentationQueueAgeMs: this.mode === "dolphin" ? this.adapter.presentationQueueAgeMs : 0,
      visualChangeFps:
        this.mode === "dolphin"
          ? this.visibleSamplerEnabled &&
            this.visibleSampleContext &&
            !this.visibleSampleError &&
            !this.canvasOwnedByAdapter
            ? this.visibleChangeFps
            : this.adapter.visualChangeFps
          : this.fps,
      visualFrameHash: this.mode === "dolphin" ? this.visibleFrameHash || this.adapter.visualFrameHash : 0,
      visualSampleSource:
        this.mode === "dolphin" ? this.adapter.visualSampleSource ?? "none" : "demo",
      oglGlError: this.mode === "dolphin" ? this.adapter.oglGlError ?? 0 : 0,
      visibleSampleError: this.mode === "dolphin" ? this.visibleSampleError : "",
      presentedFrame,
      coreTicks: this.mode === "dolphin" ? this.adapter.coreTicks : 0,
      ppcPc: this.mode === "dolphin" ? this.adapter.ppcPc : 0,
      cpuCoreName: this.mode === "dolphin" ? this.adapter.cpuCoreName : "",
      ppcWasmBlockCompileCount:
        this.mode === "dolphin" ? this.adapter.ppcWasmBlockCompileCount : 0,
      ppcWasmBlockRunCount: this.mode === "dolphin" ? this.adapter.ppcWasmBlockRunCount : 0,
      ppcWasmHelperStats: this.mode === "dolphin" ? this.adapter.ppcWasmHelperStats : "",
      frameProfileStats: this.mode === "dolphin" ? this.adapter.frameProfileStats : "-",
      running: this.running,
      mode: this.mode,
      game: this.game,
      buttonMask: this.buttonMask
    });
  }

  measureGameSpeed(coreTicks, ticksPerSecond, elapsedMs) {
    if (this.mode !== "dolphin") {
      return this.fps > 0 ? 100 : 0;
    }

    if (ticksPerSecond <= 0 || this.lastCoreTicksForSpeed <= 0 || coreTicks < this.lastCoreTicksForSpeed) {
      return 0;
    }

    return Math.max(
      0,
      Math.round(((coreTicks - this.lastCoreTicksForSpeed) / ticksPerSecond / (elapsedMs / 1000)) * 100)
    );
  }

  measureVisibleChangeFps(elapsedMs) {
    if (this.mode !== "dolphin") {
      return this.fps;
    }

    if (!this.visibleSampleContext || this.visibleSampleError) {
      return this.adapter.visualChangeFps;
    }

    const fps = Math.round((this.visibleChangesSinceFps * 1000) / elapsedMs);
    this.visibleChangesSinceFps = 0;
    return fps;
  }

  sampleVisibleFrame(now) {
    if (
      this.mode !== "dolphin" ||
      !this.visibleSamplerEnabled ||
      !this.visibleSampleContext ||
      now - this.lastVisibleSampleAt < VISIBLE_SAMPLE_INTERVAL_MS
    ) {
      return;
    }

    this.lastVisibleSampleAt = now;
    try {
      this.visibleSampleContext.drawImage(
        this.canvas,
        0,
        0,
        VISIBLE_SAMPLE_WIDTH,
        VISIBLE_SAMPLE_HEIGHT
      );
      const bytes = this.visibleSampleContext.getImageData(
        0,
        0,
        VISIBLE_SAMPLE_WIDTH,
        VISIBLE_SAMPLE_HEIGHT
      ).data;
      const hash = hashVisibleSample(bytes);
      this.visibleSampleError = "";
      if (!hash) {
        return;
      }
      this.visibleFrameHash = hash;
      if (this.lastVisibleFrameHash && hash !== this.lastVisibleFrameHash) {
        this.visibleChangesSinceFps += 1;
      }
      this.lastVisibleFrameHash = hash;
    } catch (error) {
      this.visibleSampleError = error instanceof Error ? error.message : String(error);
    }
  }

  resetVisibleSampler() {
    this.visibleChangeFps = 0;
    this.visibleFrameHash = 0;
    this.visibleSampleError = "";
    this.visibleChangesSinceFps = 0;
    this.lastVisibleFrameHash = 0;
    this.lastVisibleSampleAt = 0;
  }
}

function hashVisibleSample(bytes) {
  if (!bytes?.length) {
    return 0;
  }

  let hash = 2166136261;
  for (let index = 0; index < bytes.length; index += 16) {
    hash ^= bytes[index];
    hash = Math.imul(hash, 16777619);
    hash ^= bytes[index + 1] ?? 0;
    hash = Math.imul(hash, 16777619);
    hash ^= bytes[index + 2] ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function requestedCoreKind() {
  return new URLSearchParams(window.location.search).get("core") === "native" ? "native" : "upstream";
}

function requestedVideoBackend() {
  const requested = new URLSearchParams(window.location.search).get("video");
  if (requested === "ogl") {
    return "OGL";
  }
  if (requested === "null") {
    return "Null";
  }
  return "Software Renderer";
}

function requestedCpuThread(videoBackend) {
  const requested = new URLSearchParams(window.location.search).get("cpu");
  if (requested === "single") {
    return false;
  }
  if (requested === "dual") {
    return true;
  }
  if (requested === "auto") {
    return videoBackend === "OGL";
  }
  return true;
}

function requestedCpuCore() {
  const requested = new URLSearchParams(window.location.search).get("ppc");
  return requested === "interpreter" ? "interpreter" : "cached";
}

function requestedPpcWasmJit(videoBackend) {
  const params = new URLSearchParams(window.location.search);
  const wasmjit = params.get("wasmjit");
  if (wasmjit === "0") {
    return false;
  }
  if (videoBackend === "OGL" && wasmjit === null && params.get("forcejit") !== "1") {
    // OGL default is JIT-off. Lane E showed the experimental WASM JIT compiles
    // ~0 useful blocks for this workload, but every engage burst creates a
    // 110-1900ms stall (Lane S H1). Disabling by default trades zero perf for
    // dramatically better stability on the OGL path: 0%-speed samples drop
    // 5% -> 2%, gameSpeed normalises from 150% (overspeed) to 104%, and 89%
    // of seconds reach 30fps+. Power users can opt in with wasmjit=1 or
    // wasmjit=2 explicitly, or with forcejit=1.
    return false;
  }
  return true;
}

function requestedPpcWasmJitTier() {
  const params = new URLSearchParams(window.location.search);
  return params.get("jittier") === "mixed" || params.get("wasmjit") === "2" ? "mixed" : "guarded";
}

function requestedPpcWasmJitForce() {
  return new URLSearchParams(window.location.search).get("forcejit") === "1";
}

function requestedPpcWasmJitWarmupFrames(videoBackend) {
  const params = new URLSearchParams(window.location.search);
  const forceJit = params.get("forcejit") === "1";
  const unsafeWarmup = params.get("unsafejitwarmup") === "1";
  // OGL safety minimum: on OpenGL backends, we enforce a minimum warmup of 5000 stable video
  // frames before JIT activation to prevent GPU driver instability from blocking the compile
  // burst. This floor applies regardless of jitwarmup URL param to protect OGL presentation
  // stability. Use forcejit=1 to override; use unsafejitwarmup=1 to disable both the floor and
  // the normal staged-warmup threshold (not recommended for stability-sensitive workloads).
  const oglSafetyActive = videoBackend === "OGL" && !forceJit && !unsafeWarmup;
  const minimumWarmup = oglSafetyActive ? SAFE_JIT_WARMUP_FRAMES : 0;
  const requested = Number.parseInt(params.get("jitwarmup") || "", 10);
  let effective;
  if (Number.isFinite(requested) && requested >= 0 && requested <= 60000) {
    effective = Math.max(minimumWarmup, requested);
    if (oglSafetyActive && requested < minimumWarmup) {
      console.log(
        `[wasm-dolphin] OGL safety floor raised jitwarmup from ${requested} to ${minimumWarmup}. ` +
          `Use forcejit=1 or unsafejitwarmup=1 to bypass.`
      );
    }
  } else {
    effective = forceJit ? Math.max(minimumWarmup, 700) : Math.max(minimumWarmup, 3600);
  }
  return effective;
}

function requestedPpcProfile() {
  return new URLSearchParams(window.location.search).get("ppcprof") === "1";
}

function requestedCpuOverclock() {
  const requested = Number.parseFloat(new URLSearchParams(window.location.search).get("oc") || "");
  if (Number.isFinite(requested) && requested >= 0.01 && requested <= 5) {
    return requested;
  }
  return 1;
}

function requestedEmulationSpeed() {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("speed");
  if (raw === "unlimited") {
    return 0;
  }

  const requested = Number.parseFloat(raw || "");
  if (Number.isFinite(requested) && requested >= 0 && requested <= 5) {
    return requested;
  }
  return 1;
}

function requestedPresentationScale() {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("present");
  if (raw === "full") {
    return 1;
  }
  if (raw === "half") {
    return 0.5;
  }

  const requested = Number.parseFloat(raw || "");
  if (Number.isFinite(requested) && requested >= 0.25 && requested <= 1) {
    return requested;
  }
  return 1;
}

function requestedPresentationQueueSize() {
  const requested = Number.parseInt(new URLSearchParams(window.location.search).get("queue") || "", 10);
  if (Number.isFinite(requested) && requested >= 2 && requested <= 12) {
    return requested;
  }
  return 2;
}

function requestedPresenterBackend() {
  const requested = new URLSearchParams(window.location.search).get("presenter");
  if (requested === "webgpu" || requested === "wgpu") {
    return "webgpu";
  }
  if (requested === "2d" || requested === "canvas") {
    return "2d";
  }
  if (requested === "webgl") {
    return "webgl";
  }
  return "webgpu";
}

function requestedPresentationPacing(videoBackend = "Software Renderer") {
  const requested = new URLSearchParams(window.location.search).get("pacing");
  if (videoBackend === "OGL") {
    return requested === "smooth" ? "smooth" : "direct";
  }
  return requested === "direct" ? "direct" : "smooth";
}

function requestedOglProxyMode() {
  const requested = new URLSearchParams(window.location.search).get("oglproxy");
  if (requested === "main" || requested === "direct") {
    return "main";
  }
  if (requested === "readback" || requested === "bridge") {
    return "readback";
  }
  if (requested === "proxy" || requested === "compat") {
    return "proxy";
  }
  return "worker";
}

function requestedOglTestClear() {
  return new URLSearchParams(window.location.search).get("ogltestclear") === "1";
}

function requestedFastSoftwareRaster() {
  const requested = Number.parseInt(new URLSearchParams(window.location.search).get("fastsw") || "1", 10);
  return Number.isFinite(requested) ? Math.min(2, Math.max(0, requested)) : 1;
}

function requestedVisibleSampler() {
  return new URLSearchParams(window.location.search).get("mainsample") === "1";
}

function requestedCollectMetrics() {
  return new URLSearchParams(window.location.search).get("metrics") === "1";
}
