import { DEFAULT_UPSTREAM_CORE_URL } from "./upstream-worker-protocol.js";

const DEFAULT_WORKER_URL = new URL("./upstream-discio-worker.js", import.meta.url).href;

export async function upstreamBundleAvailable(coreUrl = DEFAULT_UPSTREAM_CORE_URL) {
  try {
    const response = await fetch(coreUrl, {
      method: "HEAD",
      cache: "no-store"
    });
    return response.ok;
  } catch {
    return false;
  }
}

export class UpstreamWorkerAdapter {
  constructor({
    coreUrl = DEFAULT_UPSTREAM_CORE_URL,
    workerUrl = DEFAULT_WORKER_URL,
    onStatus = () => {},
    canvas = null,
    videoBackend = "Software Renderer",
    cpuThread = false,
    cpuCore = "cached",
    ppcWasmJit = false,
    ppcWasmJitForce = false,
    ppcWasmJitWarmupFrames = 3600,
    ppcProfile = false,
    cpuOverclock = 1,
    emulationSpeed = 1,
    presentationScale = 0.5,
    presentationQueueSize = 8,
    presenterBackend = "webgl",
    oglProxyMode = "proxy",
    oglTestClear = false,
    fastSoftwareRaster = 0
  } = {}) {
    this.coreUrl = coreUrl;
    this.workerUrl = workerUrl;
    this.onStatus = onStatus;
    this.canvas = canvas;
    this.workerCanvas = Boolean(canvas);
    this.videoBackend = videoBackend;
    this.cpuThread = cpuThread;
    this.cpuCore = cpuCore;
    this.ppcWasmJit = ppcWasmJit;
    this.ppcWasmJitForce = Boolean(ppcWasmJitForce);
    this.ppcWasmJitWarmupFrames = ppcWasmJitWarmupFrames;
    this.ppcProfile = Boolean(ppcProfile);
    this.cpuOverclock = cpuOverclock;
    this.emulationSpeed = emulationSpeed;
    this.presentationScale = presentationScale;
    this.presentationQueueSize = presentationQueueSize;
    this.presenterBackend = presenterBackend;
    this.oglProxyMode = oglProxyMode;
    this.oglTestClear = Boolean(oglTestClear);
    this.fastSoftwareRaster = Math.min(2, Math.max(0, Number(fastSoftwareRaster) || 0));
    this.worker = null;
    this.nextId = 1;
    this.pending = new Map();
    this.loaded = false;
    this.framePending = false;
    this.lastTelemetryRequestTime = 0;
    this.telemetryIntervalMs = this.workerCanvas ? 250 : 0;
    this.width = 320;
    this.height = 240;
    this.coreFrame = 0;
    this.presentedFrame = 0;
    this.lastPresentedCoreFrame = -1;
    this.presentationFps = 0;
    this.presentationRawFps = 0;
    this.presentationAverageIntervalMs = 0;
    this.presentationP95IntervalMs = 0;
    this.presentationMaxIntervalMs = 0;
    this.presentationLongFrameCount = 0;
    this.visualChangeFps = 0;
    this.visualFrameHash = 0;
    this.coreTicks = 0;
    this.coreTicksPerSecond = 486000000;
    this.ppcPc = 0;
    this.cpuCoreName = "";
    this.ppcWasmBlockCompileCount = 0;
    this.ppcWasmBlockRunCount = 0;
    this.ppcWasmHelperStats = "";
    this.frameProfileStats = "-";
    this.frameData = null;
  }

  async load() {
    if (this.loaded) {
      return;
    }

    if (!this.worker) {
      this.worker = new Worker(this.workerUrl, {
        type: "module",
        name: "dolphin-upstream-discio"
      });
      this.worker.addEventListener("message", (event) => this.handleMessage(event.data));
      this.worker.addEventListener("error", (event) => this.rejectAll(event.message || "Upstream worker failed"));
    }

    const loadPayload = {
      coreUrl: new URL(this.coreUrl, window.location.href).href,
      videoBackend: this.videoBackend,
      cpuThread: this.cpuThread,
      cpuCore: this.cpuCore,
      ppcWasmJit: this.ppcWasmJit,
      ppcWasmJitForce: this.ppcWasmJitForce,
      ppcWasmJitWarmupFrames: this.ppcWasmJitWarmupFrames,
      ppcProfile: this.ppcProfile,
      cpuOverclock: this.cpuOverclock,
      emulationSpeed: this.emulationSpeed,
      presentationScale: this.presentationScale,
      presentationQueueSize: this.presentationQueueSize,
      presenterBackend: this.presenterBackend,
      oglProxyMode: this.oglProxyMode,
      oglTestClear: this.oglTestClear,
      fastSoftwareRaster: this.fastSoftwareRaster
    };
    const transfer = [];
    if (this.canvas) {
      loadPayload.canvas = this.canvas;
      transfer.push(this.canvas);
      this.canvas = null;
    }

    const response = await this.request("load", loadPayload, transfer);
    this.applyMetadata(response);
    this.loaded = true;
  }

  async mountGame(file) {
    await this.load();
    const response = await this.request("mountFile", { file });
    this.applyMetadata(response);
    this.applyFrame(response);

    return {
      path: response.path,
      gameId: response.gameId,
      title: response.title,
      makerId: response.makerId,
      platform: response.platform,
      region: response.region,
      discNumber: response.discNumber,
      apploaderDate: response.apploaderDate,
      apploaderSize: response.apploaderSize,
      bootDolOffset: response.bootDolOffset,
      bootDolSize: response.bootDolSize,
      fstOffset: response.fstOffset,
      fstSize: response.fstSize,
      rawSize: response.rawSize,
      dataSize: response.dataSize,
      rootEntryCount: response.rootEntryCount,
      rootEntries: response.rootEntries ?? [],
      bootProbe: response.bootProbe ?? null,
      fullCore: Boolean(response.fullCore),
      coreBoot: response.coreBoot ?? null,
      coreState: response.coreState,
      coreStateName: response.coreStateName,
      coreStatus: response.coreStatus,
      coreTitle: response.coreTitle,
      coreTicks: response.coreTicks,
      ppcPc: response.ppcPc,
      cpuCoreName: response.cpuCoreName,
      ppcWasmBlockCompileCount: response.ppcWasmBlockCompileCount,
      ppcWasmBlockRunCount: response.ppcWasmBlockRunCount
    };
  }

  async probeBoot() {
    await this.load();
    const response = await this.request("bootProbe");
    return response.bootProbe;
  }

  setInputMask(mask) {
    if (!this.loaded) {
      return;
    }
    this.request("setInputMask", { mask: mask >>> 0 }).catch((error) => this.onStatus(error.message));
  }

  setInputState(state) {
    if (!this.loaded || !state) {
      return;
    }
    this.request("setInputState", {
      mask: state.mask >>> 0,
      stickX: state.stickX | 0,
      stickY: state.stickY | 0,
      cStickX: state.cStickX | 0,
      cStickY: state.cStickY | 0,
      triggerLeft: state.triggerLeft | 0,
      triggerRight: state.triggerRight | 0,
      analogA: state.analogA | 0,
      analogB: state.analogB | 0
    }).catch((error) => this.onStatus(error.message));
  }

  runFrame() {
    if (!this.loaded || this.framePending) {
      return;
    }
    const now = performance.now();
    if (this.telemetryIntervalMs > 0 && now - this.lastTelemetryRequestTime < this.telemetryIntervalMs) {
      return;
    }

    this.lastTelemetryRequestTime = now;
    this.framePending = true;
    this.request("runFrame")
      .then((response) => this.applyFrame(response))
      .catch((error) => this.onStatus(error.message))
      .finally(() => {
        this.framePending = false;
      });
  }

  readFrameRgba() {
    return this.frameData;
  }

  start() {}

  pause() {}

  reset() {
    if (!this.loaded) {
      return;
    }
    this.request("reset")
      .then((response) => this.applyFrame(response))
      .catch((error) => this.onStatus(error.message));
  }

  saveState(slot) {
    if (!this.loaded) {
      return;
    }
    this.request("saveState", { slot }).catch((error) => this.onStatus(error.message));
  }

  loadState(slot) {
    if (!this.loaded) {
      return;
    }
    this.request("loadState", { slot })
      .then((response) => this.applyFrame(response))
      .catch((error) => this.onStatus(error.message));
  }

  request(type, payload = {}, transfer = []) {
    if (!this.worker) {
      throw new Error("Upstream worker has not been created");
    }

    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, payload }, transfer);
    });
  }

  handleMessage(message) {
    if (message?.type === "status") {
      this.onStatus(message.message);
      return;
    }

    const pending = this.pending.get(message?.id);
    if (!pending) {
      return;
    }

    this.pending.delete(message.id);

    if (message.ok) {
      pending.resolve(message);
    } else {
      pending.reject(new Error(message.error || "Upstream worker request failed"));
    }
  }

  rejectAll(message) {
    for (const { reject } of this.pending.values()) {
      reject(new Error(message));
    }
    this.pending.clear();
  }

  applyMetadata(response) {
    this.width = response.width || this.width;
    this.height = response.height || this.height;
    if (Number.isFinite(response.coreTicks)) {
      this.coreTicks = response.coreTicks;
    }
    if (Number.isFinite(response.coreTicksPerSecond) && response.coreTicksPerSecond > 0) {
      this.coreTicksPerSecond = response.coreTicksPerSecond;
    }
    if (Number.isFinite(response.ppcPc)) {
      this.ppcPc = response.ppcPc >>> 0;
    }
    if (response.cpuCoreName) {
      this.cpuCoreName = response.cpuCoreName;
    }
    if (Number.isFinite(response.ppcWasmBlockCompileCount)) {
      this.ppcWasmBlockCompileCount = response.ppcWasmBlockCompileCount;
    }
    if (Number.isFinite(response.ppcWasmBlockRunCount)) {
      this.ppcWasmBlockRunCount = response.ppcWasmBlockRunCount;
    }
    if (typeof response.ppcWasmHelperStats === "string") {
      this.ppcWasmHelperStats = response.ppcWasmHelperStats;
    }
    if (typeof response.frameProfileStats === "string") {
      this.frameProfileStats = response.frameProfileStats;
    }
  }

  applyFrame(response) {
    this.applyMetadata(response);

    if (Number.isFinite(response.frame)) {
      this.coreFrame = response.frame;
      if (Number.isFinite(response.presentedFrame)) {
        this.presentedFrame = response.presentedFrame;
        this.lastPresentedCoreFrame = response.frame;
      } else if (response.frame !== this.lastPresentedCoreFrame) {
        this.presentedFrame += 1;
        this.lastPresentedCoreFrame = response.frame;
      }
    }
    if (Number.isFinite(response.presentationFps)) {
      this.presentationFps = response.presentationFps;
    }
    if (Number.isFinite(response.presentationRawFps)) {
      this.presentationRawFps = response.presentationRawFps;
    }
    if (Number.isFinite(response.presentationAverageIntervalMs)) {
      this.presentationAverageIntervalMs = response.presentationAverageIntervalMs;
    }
    if (Number.isFinite(response.presentationP95IntervalMs)) {
      this.presentationP95IntervalMs = response.presentationP95IntervalMs;
    }
    if (Number.isFinite(response.presentationMaxIntervalMs)) {
      this.presentationMaxIntervalMs = response.presentationMaxIntervalMs;
    }
    if (Number.isFinite(response.presentationLongFrameCount)) {
      this.presentationLongFrameCount = response.presentationLongFrameCount;
    }
    if (Number.isFinite(response.visualChangeFps)) {
      this.visualChangeFps = response.visualChangeFps;
    }
    if (Number.isFinite(response.visualFrameHash)) {
      this.visualFrameHash = response.visualFrameHash;
    }

    if (response.frameBuffer) {
      this.frameData = new Uint8ClampedArray(response.frameBuffer);
    }
  }
}
