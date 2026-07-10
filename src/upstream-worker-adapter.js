import {
  DEFAULT_UPSTREAM_CORE_SHA256,
  DEFAULT_UPSTREAM_CORE_URL,
  verifyUpstreamCoreWasm
} from "./upstream-worker-protocol.js";

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
    expectedCoreSha256 = DEFAULT_UPSTREAM_CORE_SHA256,
    workerUrl = DEFAULT_WORKER_URL,
    onStatus = () => {},
    canvas = null,
    transferCanvas = null,
    visibleCanvas = null,
    videoBackend = "Software Renderer",
    cpuThread = false,
    cpuCore = "cached",
    ppcWasmJit = false,
    ppcWasmJitTier = "guarded",
    ppcWasmJitForce = false,
    ppcWasmJitWarmupFrames = 3600,
    ppcProfile = false,
    cpuOverclock = 1,
    emulationSpeed = 1,
    presentationScale = 1,
    presentationQueueSize = 2,
    presenterBackend = "webgl",
    presentationPacing = "smooth",
    oglProxyMode = "worker",
    oglTestClear = false,
    fastSoftwareRaster = 0,
    cachedInterpreterDisableMask = 0,
    noJitCache = false,
    collectMetrics = false,
    oglPixelSab = null,
    oglMetaSab = null,
    oglSabWidth = 0,
    oglSabHeight = 0
  } = {}) {
    this.coreUrl = coreUrl;
    this.expectedCoreSha256 = expectedCoreSha256;
    this.coreCandidatePreflighted = false;
    this.workerUrl = workerUrl;
    this.onStatus = onStatus;
    this.canvas = canvas;
    this.transferCanvasFn = typeof transferCanvas === "function" ? transferCanvas : null;
    this.workerCanvas = Boolean(canvas) || Boolean(this.transferCanvasFn);
    this.visibleCanvas = visibleCanvas;
    this.detachedOglContext = null;
    this.detachedOglFramesDrawn = 0;
    this.videoBackend = videoBackend;
    this.cpuThread = cpuThread;
    this.cpuCore = cpuCore;
    this.ppcWasmJit = ppcWasmJit;
    this.ppcWasmJitTier = ppcWasmJitTier === "mixed" ? "mixed" : "guarded";
    this.ppcWasmJitForce = Boolean(ppcWasmJitForce);
    this.ppcWasmJitWarmupFrames = ppcWasmJitWarmupFrames;
    this.ppcProfile = Boolean(ppcProfile);
    this.cpuOverclock = cpuOverclock;
    this.emulationSpeed = emulationSpeed;
    this.presentationScale = presentationScale;
    this.presentationQueueSize = presentationQueueSize;
    this.presenterBackend = presenterBackend;
    this.presentationPacing = presentationPacing;
    this.oglProxyMode = oglProxyMode;
    this.oglTestClear = Boolean(oglTestClear);
    this.fastSoftwareRaster = Math.min(3, Math.max(0, Number(fastSoftwareRaster) || 0));
    this.cachedInterpreterDisableMask = (Number(cachedInterpreterDisableMask) || 0) >>> 0;
    this.noJitCache = Boolean(noJitCache);
    this.collectMetrics = Boolean(collectMetrics);
    this.oglPixelSab = oglPixelSab;
    this.oglMetaSab = oglMetaSab;
    this.oglSabWidth = oglSabWidth | 0;
    this.oglSabHeight = oglSabHeight | 0;
    this.worker = null;
    this.nextId = 1;
    this.pending = new Map();
    this.loaded = false;
    this.framePending = false;
    this.lastTelemetryRequestTime = 0;
    this.telemetryIntervalMs = 250;
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
    this.presentationLifetimeMaxIntervalMs = 0;
    this.presentationLifetimeMaxIntervalAtMs = 0;
    this.presentationLifetimeDropCount = 0;
    this.presentationLifetimeFrameCount = 0;
    this.presentationIntervalStddevMs = 0;
    this.presentationIntervalHistogram = null;
    this.presentationIntervalHistogramBuckets = null;
    this.presentationFrameLag = 0;
    this.presentationQueueAgeMs = 0;
    this.visualChangeFps = 0;
    this.visualFrameHash = 0;
    this.visualSampleSource = "none";
    this.oglGlError = 0;
    this.coreTicks = 0;
    this.coreTicksPerSecond = 486000000;
    this.ppcPc = 0;
    this.cpuCoreName = "";
    this.ppcWasmBlockCompileCount = 0;
    this.ppcWasmBlockRunCount = 0;
    this.ppcWasmHelperStats = "";
    this.frameProfileStats = "-";
    this.frameData = null;
    this.lastInputStateSignature = "";
    // SharedArrayBuffer-backed input state. Bypasses postMessage queue.
    // Slots: 0=mask, 1=stickX, 2=stickY, 3=cStickX, 4=cStickY,
    //        5=triggerLeft, 6=triggerRight, 7=analogA, 8=analogB,
    //        9=generation (incremented on every write so the worker can
    //                       detect a new value without re-reading every slot).
    if (typeof SharedArrayBuffer === "function") {
      this.inputStateSab = new SharedArrayBuffer(40); // 10 * Int32
      this.inputStateView = new Int32Array(this.inputStateSab);
    } else {
      this.inputStateSab = null;
      this.inputStateView = null;
    }
  }

  async load() {
    if (this.loaded) {
      return;
    }

    if (!this.coreCandidatePreflighted && this.coreUrl !== DEFAULT_UPSTREAM_CORE_URL) {
      try {
        await verifyUpstreamCoreWasm(this.coreUrl, this.expectedCoreSha256, window.location.href);
        this.coreCandidatePreflighted = true;
      } catch (error) {
        this.onStatus(`Candidate core rejected; rolling back to pinned baseline: ${error.message}`);
        this.coreUrl = DEFAULT_UPSTREAM_CORE_URL;
        this.expectedCoreSha256 = DEFAULT_UPSTREAM_CORE_SHA256;
        this.coreCandidatePreflighted = true;
      }
    }

    if (!this.worker) {
      const _t_worker = performance.now();
      console.log(`[boot-phase] new Worker(discio) at perf.now=${_t_worker.toFixed(1)}ms`);
      this.worker = new Worker(this.workerUrl, {
        type: "module",
        name: "dolphin-upstream-discio"
      });
      this.worker.addEventListener("message", (event) => this.handleMessage(event.data));
      this.worker.addEventListener("error", (event) => this.rejectAll(event.message || "Upstream worker failed"));
    }
    const _t_load = performance.now();
    console.log(`[boot-phase] main-thread postMessage(load) at perf.now=${_t_load.toFixed(1)}ms`);

    const loadPayload = {
      coreUrl: new URL(this.coreUrl, window.location.href).href,
      expectedCoreSha256: this.expectedCoreSha256,
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
      cachedInterpreterDisableMask: this.cachedInterpreterDisableMask,
      noJitCache: this.noJitCache,
      collectMetrics: this.collectMetrics,
      inputStateSab: this.inputStateSab,
      oglPixelSab: this.oglPixelSab,
      oglMetaSab: this.oglMetaSab,
      oglSabWidth: this.oglSabWidth,
      oglSabHeight: this.oglSabHeight
    };
    const transfer = [];
    // Lazy transferControlToOffscreen: do it right at the moment we
    // postMessage to the worker, so the OffscreenCanvas hasn't had time to
    // be "used" by the main-thread compositor. Chrome rejects transferring
    // an OffscreenCanvas that has been bound to its element for too long.
    let canvasForLoad = this.canvas;
    if (!canvasForLoad && this.transferCanvasFn) {
      canvasForLoad = this.transferCanvasFn();
    }
    if (canvasForLoad) {
      loadPayload.canvas = canvasForLoad;
      transfer.push(canvasForLoad);
      this.canvas = null;
      this.transferCanvasFn = null;
    }

    let response;
    try {
      response = await this.request("load", loadPayload, transfer);
    } catch (err) {
      const msg = String(err?.message || err);
      // Some Chrome environments reject the OffscreenCanvas postMessage
      // transfer with "Cannot transfer OffscreenCanvas bound to element
      // using captureStream" because an extension or the compositor has
      // bound captureStream to the canvas. Retry once WITHOUT the canvas;
      // the worker boots, the OGL backend will fail to attach a canvas
      // but the worker stays alive so the user gets a clear status message
      // instead of a permanent black screen.
      if (/captureStream|OffscreenCanvas/i.test(msg)) {
        this.onStatus(
          `OffscreenCanvas transfer blocked by browser (captureStream binding); ` +
            `falling back to canvas-less worker. Use oglproxy=proxy for hardware OGL.`
        );
        delete loadPayload.canvas;
        response = await this.request("load", loadPayload, []);
      } else {
        throw err;
      }
    }
    this.applyMetadata(response);
    this.loaded = true;
  }

  async mountGame(file) {
    const _t_mountStart = performance.now();
    console.log(`[boot-phase] mountGame() entry at perf.now=${_t_mountStart.toFixed(1)}ms (file=${file?.size ?? "?"}B name=${file?.name ?? "?"})`);
    await this.load();
    const _t_afterLoad = performance.now();
    console.log(`[boot-phase] mountGame() after this.load() at perf.now=${_t_afterLoad.toFixed(1)}ms (load took ${(_t_afterLoad - _t_mountStart).toFixed(1)}ms)`);
    const response = await this.request("mountFile", { file });
    const _t_afterMount = performance.now();
    console.log(`[boot-phase] mountGame() mountFile responded at perf.now=${_t_afterMount.toFixed(1)}ms (mountFile took ${(_t_afterMount - _t_afterLoad).toFixed(1)}ms)`);
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
    this.post("setInputMask", { mask: mask >>> 0 });
  }

  setInputState(state) {
    if (!this.loaded || !state) {
      return;
    }
    const mask = state.mask >>> 0;
    const stickX = state.stickX | 0;
    const stickY = state.stickY | 0;
    const cStickX = state.cStickX | 0;
    const cStickY = state.cStickY | 0;
    const triggerLeft = state.triggerLeft | 0;
    const triggerRight = state.triggerRight | 0;
    const analogA = state.analogA | 0;
    const analogB = state.analogB | 0;
    const signature = `${mask}:${stickX}:${stickY}:${cStickX}:${cStickY}:${triggerLeft}:${triggerRight}:${analogA}:${analogB}`;
    if (signature === this.lastInputStateSignature) {
      return;
    }
    this.lastInputStateSignature = signature;

    if (this.inputStateView) {
      // Write each slot, then bump the generation counter last so the worker
      // sees a coherent snapshot.
      Atomics.store(this.inputStateView, 0, mask | 0);
      Atomics.store(this.inputStateView, 1, stickX);
      Atomics.store(this.inputStateView, 2, stickY);
      Atomics.store(this.inputStateView, 3, cStickX);
      Atomics.store(this.inputStateView, 4, cStickY);
      Atomics.store(this.inputStateView, 5, triggerLeft);
      Atomics.store(this.inputStateView, 6, triggerRight);
      Atomics.store(this.inputStateView, 7, analogA);
      Atomics.store(this.inputStateView, 8, analogB);
      Atomics.add(this.inputStateView, 9, 1);
    }
    // Always also send via postMessage. Belt-and-suspenders: if the worker
    // is between SAB-poll iterations when an input arrives (e.g. it's
    // blocked in a long pumpHostJobs() or compile burst), the message-based
    // path will deliver the update on the next event-loop tick. SAB is
    // strictly faster when the loop is healthy; postMessage is the floor.
    this.post("setInputState", {
      mask,
      stickX,
      stickY,
      cStickX,
      cStickY,
      triggerLeft,
      triggerRight,
      analogA,
      analogB
    });
  }

  runFrame() {
    this.requestFrame();
  }

  pollFrame() {
    this.requestFrame(this.telemetryIntervalMs);
  }

  requestFrame(minIntervalMs = 0) {
    if (!this.loaded || this.framePending) {
      return;
    }
    const now = performance.now();
    if (minIntervalMs > 0 && now - this.lastTelemetryRequestTime < minIntervalMs) {
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

  async mixAudio(frames = 1024) {
    if (!this.loaded) {
      return { available: false, frames: 0, channels: 2, sampleRate: 48000, samples: null };
    }

    return this.request("mixAudio", { frames });
  }

  setAudioMuted(muted) {
    if (!this.loaded) {
      return;
    }

    this.post("setAudioMuted", { muted: Boolean(muted) });
  }

  start() {
    if (!this.loaded) {
      return;
    }
    this.request("start")
      .then((response) => this.applyFrame(response))
      .catch((error) => this.onStatus(error.message));
  }

  pause() {
    if (!this.loaded) {
      return;
    }
    this.request("pause")
      .then((response) => this.applyFrame(response))
      .catch((error) => this.onStatus(error.message));
  }

  reset() {
    if (!this.loaded) {
      return;
    }
    this.request("reset")
      .then((response) => {
        this.applyFrame(response);
        this.onStatus("Reset requested");
      })
      .catch((error) => this.onStatus(error.message));
  }

  saveState(slot) {
    if (!this.loaded) {
      return;
    }
    this.request("saveState", { slot })
      .then((response) => this.onStatus(response.saved ? `Save slot ${slot} requested` : `Save slot ${slot} unavailable`))
      .catch((error) => this.onStatus(error.message));
  }

  loadState(slot) {
    if (!this.loaded) {
      return;
    }
    this.request("loadState", { slot })
      .then((response) => {
        this.applyFrame(response);
        this.onStatus(response.loaded ? `Load slot ${slot} requested` : `Load slot ${slot} unavailable`);
      })
      .catch((error) => this.onStatus(error.message));
  }

  // Load a Dolphin save state from raw .sav bytes (transferred to the
  // worker, which FS.writeFile's it then State::LoadAs's it). Returns
  // the worker response so callers (the validator) can await + inspect
  // rc/before/after core state. Bytes are build/version sensitive.
  loadStateFile(bytes) {
    if (!this.loaded) {
      return Promise.resolve({ loaded: false, error: "not loaded" });
    }
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return this.request("loadStateFile", { bytes: u8 }, [u8.buffer])
      .then((response) => {
        this.applyFrame(response);
        this.onStatus(
          response.loaded
            ? `Save state loaded (${response.afterState || "?"})`
            : `Save state load failed (rc=${response.rc ?? "?"}${
                response.error ? " " + response.error : ""})`);
        return response;
      })
      .catch((error) => {
        this.onStatus(error.message);
        return { loaded: false, error: error.message };
      });
  }

  // Capture a version-matched Dolphin save state from THIS build.
  // Returns { saved, size, bytes (ArrayBuffer) } so the caller can
  // persist it for deterministic reuse across rebuilds.
  saveStateFile() {
    if (!this.loaded) {
      return Promise.resolve({ saved: false, error: "not loaded" });
    }
    return this.request("saveStateFile", {}, [])
      .then((r) => {
        this.onStatus(
          r.saved
            ? `Save state captured (${r.size} B)`
            : `Save state capture failed (${r.error || "?"})`);
        return r;
      })
      .catch((e) => ({ saved: false, error: e.message }));
  }

  // Reload a state already present in the worker FS (e.g. the one
  // saveStateFile just wrote) — a zero-serving version-matched
  // round-trip.
  loadStateFileFromFs(fsPath) {
    if (!this.loaded) {
      return Promise.resolve({ loaded: false, error: "not loaded" });
    }
    return this.request("loadStateFile", { fsPath })
      .then((response) => {
        this.applyFrame(response);
        this.onStatus(
          response.loaded
            ? `Save state reloaded (${response.afterState || "?"})`
            : `Save state reload failed (rc=${response.rc ?? "?"})`);
        return response;
      })
      .catch((e) => ({ loaded: false, error: e.message }));
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

  post(type, payload = {}, transfer = []) {
    if (!this.worker) {
      return;
    }

    this.worker.postMessage({ type, payload }, transfer);
  }

  drawDetachedOglBitmap(bitmap, width, height) {
    if (!bitmap) return;
    if (!this.visibleCanvas) {
      try { bitmap.close(); } catch {}
      return;
    }
    if (!this.detachedOglContext) {
      try {
        this.detachedOglContext = this.visibleCanvas.getContext("2d", { alpha: false });
      } catch (err) {
        this.onStatus(`Detached OGL: cannot get 2D context on visible canvas: ${err.message}`);
        try { bitmap.close(); } catch {}
        return;
      }
      if (!this.detachedOglContext) {
        this.onStatus("Detached OGL: visible canvas has no 2D context (may already be transferred)");
        try { bitmap.close(); } catch {}
        return;
      }
      this.onStatus(`Detached OGL: 2D presenter live (${this.visibleCanvas.width}x${this.visibleCanvas.height})`);
    }
    this.detachedOglContext.drawImage(
      bitmap,
      0,
      0,
      this.visibleCanvas.width,
      this.visibleCanvas.height
    );
    this.detachedOglFramesDrawn += 1;
    try { bitmap.close(); } catch {}
  }

  handleMessage(message) {
    // Stall logger: surface worker→main message handlers that take >20 ms.
    // This catches applyFrame backlog, detachedOgl bitmap draws, and
    // status floods. Correlates with PerformanceLongAnimationFrame entries.
    const handlerStartedAt = performance.now();
    const result = this._handleMessageInner(message);
    const handlerMs = performance.now() - handlerStartedAt;
    if (handlerMs > 20) {
      this._msgStallCount = (this._msgStallCount || 0) + 1;
      const isNewWorst = handlerMs > (this._msgStallWorstMs || 0);
      if (isNewWorst) this._msgStallWorstMs = handlerMs;
      if (isNewWorst || this._msgStallCount % 10 === 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[msg-stall#${this._msgStallCount}${isNewWorst ? "*" : ""}] ` +
          `handler=${handlerMs.toFixed(0)}ms ` +
          `type=${message?.type || "rpc"} ` +
          `hasFrameBuffer=${Boolean(message?.payload?.frameBuffer ?? message?.frameBuffer)}`
        );
      }
    }
    return result;
  }

  _handleMessageInner(message) {
    if (message?.type === "status") {
      this.onStatus(message.message);
      return;
    }

    if (message?.type === "detachedOglFrame" && message.bitmap) {
      // Worker has rendered a frame to its standalone OffscreenCanvas and
      // handed us the result as an ImageBitmap. Draw onto the visible
      // canvas via 2D context. Lazily create the context on first frame.
      this.drawDetachedOglBitmap(message.bitmap, message.width, message.height);
      return;
    }

    if (message?.type === "frameUpdate" && message.payload) {
      this.applyFrame(message.payload);
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
    if (Number.isFinite(response.presentationLifetimeMaxIntervalMs)) {
      this.presentationLifetimeMaxIntervalMs = response.presentationLifetimeMaxIntervalMs;
    }
    if (Number.isFinite(response.presentationLifetimeMaxIntervalAtMs)) {
      this.presentationLifetimeMaxIntervalAtMs = response.presentationLifetimeMaxIntervalAtMs;
    }
    if (Number.isFinite(response.presentationLifetimeDropCount)) {
      this.presentationLifetimeDropCount = response.presentationLifetimeDropCount;
    }
    if (Number.isFinite(response.presentationLifetimeFrameCount)) {
      this.presentationLifetimeFrameCount = response.presentationLifetimeFrameCount;
    }
    if (Number.isFinite(response.presentationIntervalStddevMs)) {
      this.presentationIntervalStddevMs = response.presentationIntervalStddevMs;
    }
    if (Array.isArray(response.presentationIntervalHistogram)) {
      this.presentationIntervalHistogram = response.presentationIntervalHistogram;
    }
    if (Array.isArray(response.presentationIntervalHistogramBuckets)) {
      this.presentationIntervalHistogramBuckets = response.presentationIntervalHistogramBuckets;
    }
    if (Number.isFinite(response.presentationFrameLag)) {
      this.presentationFrameLag = response.presentationFrameLag;
    }
    if (Number.isFinite(response.presentationQueueAgeMs)) {
      this.presentationQueueAgeMs = response.presentationQueueAgeMs;
    }
    if (Number.isFinite(response.visualChangeFps)) {
      this.visualChangeFps = response.visualChangeFps;
    }
    if (Number.isFinite(response.visualFrameHash)) {
      this.visualFrameHash = response.visualFrameHash;
    }
    if (typeof response.visualSampleSource === "string") {
      this.visualSampleSource = response.visualSampleSource;
    }
    if (Number.isFinite(response.oglGlError)) {
      this.oglGlError = response.oglGlError;
    }

    if (response.frameBuffer) {
      this.frameData = new Uint8ClampedArray(response.frameBuffer);
    }
  }
}
