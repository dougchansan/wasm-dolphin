import { AudioController } from "./audio.js";
import { EmulatorHost } from "./core-host.js";
import {
  CONTROL_LABELS,
  formatControlLabel,
  inputStateFromPressed,
  mergePressedSets,
  readGamepadInput,
  resolveKeyboardButton,
  updatePressedSet
} from "./input.js";
import {
  buildPlayablePresetHref,
  buildSettingsHref,
  describeSettings,
  readSettingsFromSearch
} from "./settings.js";

const elements = {
  adapterStatus: document.querySelector("#adapterStatus"),
  audioStatus: document.querySelector("#audioStatus"),
  bootApploader: document.querySelector("#bootApploader"),
  bootBlocker: document.querySelector("#bootBlocker"),
  bootDol: document.querySelector("#bootDol"),
  bootEntry: document.querySelector("#bootEntry"),
  bootFst: document.querySelector("#bootFst"),
  bootImage: document.querySelector("#bootImage"),
  bootStatus: document.querySelector("#bootStatus"),
  controlGrid: document.querySelector("#controlGrid"),
  coreLabel: document.querySelector("#coreLabel"),
  coreMode: document.querySelector("#coreMode"),
  debugPanel: document.querySelector("#debugPanel"),
  debugToggle: document.querySelector("#debugToggle"),
  dropBadge: document.querySelector("#dropBadge"),
  dropZone: document.querySelector("#dropZone"),
  frameCounter: document.querySelector("#frameCounter"),
  fullscreenButton: document.querySelector("#fullscreenButton"),
  fpsCounter: document.querySelector("#fpsCounter"),
  visualFpsCounter: document.querySelector("#visualFpsCounter"),
  gameSpeedCounter: document.querySelector("#gameSpeedCounter"),
  coreTicks: document.querySelector("#coreTicks"),
  coreFpsCounter: document.querySelector("#coreFpsCounter"),
  presentationGapCounter: document.querySelector("#presentationGapCounter"),
  presentationLagCounter: document.querySelector("#presentationLagCounter"),
  ppcPc: document.querySelector("#ppcPc"),
  cpuCoreName: document.querySelector("#cpuCoreName"),
  ppcWasmJit: document.querySelector("#ppcWasmJit"),
  ppcWasmHelperStats: document.querySelector("#ppcWasmHelperStats"),
  frameProfileStats: document.querySelector("#frameProfileStats"),
  uiFpsCounter: document.querySelector("#uiFpsCounter"),
  gameSize: document.querySelector("#gameSize"),
  gameTitle: document.querySelector("#gameTitle"),
  hudFps: document.querySelector("#hudFps"),
  hudJit: document.querySelector("#hudJit"),
  hudLatency: document.querySelector("#hudLatency"),
  hudResolution: document.querySelector("#hudResolution"),
  hudSpeed: document.querySelector("#hudSpeed"),
  hudVisualFps: document.querySelector("#hudVisualFps"),
  inputSource: document.querySelector("#inputSource"),
  loadButton: document.querySelector("#loadButton"),
  mountNote: document.querySelector("#mountNote"),
  muteButton: document.querySelector("#muteButton"),
  overlayToggle: document.querySelector("#overlayToggle"),
  resetButton: document.querySelector("#resetButton"),
  romInput: document.querySelector("#romInput"),
  rootEntryList: document.querySelector("#rootEntryList"),
  runButton: document.querySelector("#runButton"),
  saveButton: document.querySelector("#saveButton"),
  screen: document.querySelector("#screen"),
  screenHud: document.querySelector("#screenHud"),
  settingCore: document.querySelector("#settingCore"),
  settingCpu: document.querySelector("#settingCpu"),
  settingFastSw: document.querySelector("#settingFastSw"),
  settingForceJit: document.querySelector("#settingForceJit"),
  settingJitTier: document.querySelector("#settingJitTier"),
  settingOglProxy: document.querySelector("#settingOglProxy"),
  settingPacing: document.querySelector("#settingPacing"),
  settingMetrics: document.querySelector("#settingMetrics"),
  settingPresenter: document.querySelector("#settingPresenter"),
  settingQueue: document.querySelector("#settingQueue"),
  settingResolution: document.querySelector("#settingResolution"),
  settingSpeed: document.querySelector("#settingSpeed"),
  settingVideo: document.querySelector("#settingVideo"),
  settingWasmJit: document.querySelector("#settingWasmJit"),
  settingsApplyButton: document.querySelector("#settingsApplyButton"),
  settingsForm: document.querySelector("#settingsForm"),
  settingsPresetButton: document.querySelector("#settingsPresetButton"),
  settingsSummary: document.querySelector("#settingsSummary"),
  statusPill: document.querySelector("#statusPill")
};

const DEBUG_PREF_KEY = "wasm-dolphin.debug-open";
const OSD_PREF_KEY = "wasm-dolphin.osd-visible";

const keyboardPressed = new Set();
let touchPressed = new Set();
let gamepadPressed = new Set();
let gamepadInputState = null;
let combinedPressed = new Set();
let lastFrameInfo = null;
let currentSettings = readSettingsFromSearch(window.location.search);

const audio = new AudioController();
const host = new EmulatorHost({
  canvas: elements.screen,
  onFrame: handleFrame,
  onStatus: setStatus,
  onMode: setMode
});
audio.setSource((frames) => host.mixAudio(frames));

renderControlGrid();
wireSettings();
wireDiagnostics();
wireFileMounting();
wireTransport();
wireKeyboard();
wireTouchControls();
wireGamepadPolling();

host
  .init()
  .then(runSmokeScenario)
  .catch((error) => {
    setStatus(error.message, "error");
  });

function handleFrame(info) {
  lastFrameInfo = info;
  updateScreenHud(info);
  updateRuntimeControls(info);

  if (!elements.debugPanel.hidden) {
    updateDebugMetrics(info);
  }
}

function updateRuntimeControls(info) {
  elements.coreMode.textContent = info.mode === "dolphin" ? "Dolphin" : "Demo";
  elements.runButton.textContent = info.running ? "Pause" : "Run";
  elements.statusPill.classList.toggle("paused", !info.running);
  audio.update(info.buttonMask, info.running);
  elements.muteButton.textContent = audio.label();
}

function updateDebugMetrics(info) {
  elements.frameCounter.textContent = String(info.frame);
  elements.fpsCounter.textContent = String(info.fps);
  if (elements.visualFpsCounter) {
    elements.visualFpsCounter.textContent =
      info.visualChangeFps == null ? "n/a" : String(info.visualChangeFps);
  }
  if (elements.gameSpeedCounter) {
    elements.gameSpeedCounter.textContent = `${Math.max(0, Number(info.gameSpeed) || 0)}%`;
  }
  elements.uiFpsCounter.textContent = String(info.uiFps ?? info.fps);
  if (elements.coreFpsCounter) {
    elements.coreFpsCounter.textContent = String(info.coreFps ?? info.fps);
  }
  if (elements.presentationGapCounter) {
    const p95Gap = Number(info.presentationP95IntervalMs) || 0;
    const maxGap = Number(info.presentationMaxIntervalMs) || 0;
    const longFrames = Number(info.presentationLongFrameCount) || 0;
    const formattedP95 = p95Gap.toFixed(p95Gap >= 10 ? 0 : 1);
    const formattedMax = maxGap.toFixed(maxGap >= 10 ? 0 : 1);
    elements.presentationGapCounter.textContent = `${formattedP95} p95 / ${formattedMax} max / ${longFrames}`;
  }
  if (elements.presentationLagCounter) {
    const frameLag = Math.max(0, Number(info.presentationFrameLag) || 0);
    const queueAge = Math.max(0, Number(info.presentationQueueAgeMs) || 0);
    elements.presentationLagCounter.textContent =
      `${frameLag.toFixed(0)}f / ${queueAge.toFixed(queueAge >= 10 ? 0 : 1)} ms`;
  }
  if (elements.audioStatus) {
    elements.audioStatus.textContent = audio.stats || audio.label();
  }
  elements.coreTicks.textContent = formatLargeInteger(info.coreTicks || 0);
  elements.ppcPc.textContent = formatHex(info.ppcPc || 0) || "-";
  elements.cpuCoreName.textContent = info.cpuCoreName || "-";
  elements.ppcWasmJit.textContent = `${formatLargeInteger(info.ppcWasmBlockRunCount || 0)} / ${formatLargeInteger(info.ppcWasmBlockCompileCount || 0)}`;
  elements.ppcWasmHelperStats.textContent = info.ppcWasmHelperStats || "-";
  if (elements.frameProfileStats) {
    elements.frameProfileStats.textContent = info.frameProfileStats || "-";
  }
}

function setStatus(message, tone = "") {
  elements.statusPill.textContent = message;
  elements.statusPill.classList.toggle("error", tone === "error");
}

function setMode(message) {
  elements.coreLabel.textContent = message;
  elements.adapterStatus.textContent = message.includes("Dolphin") ? "Detected" : "Fallback";
}

function wireTransport() {
  elements.runButton.addEventListener("click", () => {
    if (lastFrameInfo?.running) {
      host.pause();
      setStatus("Paused");
      host.publishFrame();
    } else {
      setStatus("Running");
      host.start();
    }
  });

  elements.resetButton.addEventListener("click", () => {
    host.reset();
    setStatus("Reset");
  });

  elements.saveButton.addEventListener("click", () => host.saveState());
  elements.loadButton.addEventListener("click", () => {
    host.loadState();
    syncGameInfo(host.game);
  });

  elements.muteButton.addEventListener("click", async () => {
    const muted = !audio.muted;
    host.setAudioMuted(muted);
    await audio.setMuted(muted);
    elements.muteButton.textContent = audio.label();
  });

  elements.fullscreenButton.addEventListener("click", async () => {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await elements.dropZone.requestFullscreen();
    }
  });
}

function wireSettings() {
  populateSettingsForm(currentSettings);
  updateSettingsSummary();

  elements.settingsForm.addEventListener("change", () => {
    currentSettings = collectSettingsForm();
    updateSettingsSummary();
  });

  elements.settingsForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const nextHref = buildSettingsHref(window.location.href, collectSettingsForm());
    window.location.assign(nextHref);
  });

  elements.settingsPresetButton.addEventListener("click", () => {
    window.location.assign(buildPlayablePresetHref(window.location.href));
  });
}

function wireDiagnostics() {
  const debugOpen = localStorage.getItem(DEBUG_PREF_KEY) === "1";
  const osdVisible = localStorage.getItem(OSD_PREF_KEY) !== "0";

  setDebugOpen(debugOpen);
  setOverlayVisible(osdVisible);

  elements.debugToggle.addEventListener("click", () => {
    setDebugOpen(elements.debugPanel.hidden);
  });

  elements.overlayToggle.addEventListener("click", () => {
    setOverlayVisible(elements.screenHud.hidden);
  });
}

function populateSettingsForm(settings) {
  elements.settingCore.value = settings.core;
  elements.settingVideo.value = settings.video;
  elements.settingResolution.value = settings.present;
  elements.settingSpeed.value = settings.speed;
  elements.settingCpu.value = settings.cpu;
  elements.settingPresenter.value = settings.presenter;
  elements.settingPacing.value = settings.pacing;
  elements.settingOglProxy.value = settings.oglproxy;
  elements.settingQueue.value = settings.queue;
  elements.settingFastSw.value = settings.fastsw;
  elements.settingJitTier.value = settings.jittier;
  elements.settingWasmJit.checked = settings.wasmjit === "1";
  elements.settingForceJit.checked = settings.forcejit === "1";
  elements.settingMetrics.checked = settings.metrics === "1";
}

function collectSettingsForm() {
  return {
    core: elements.settingCore.value,
    video: elements.settingVideo.value,
    present: elements.settingResolution.value,
    speed: elements.settingSpeed.value,
    cpu: elements.settingCpu.value,
    presenter: elements.settingPresenter.value,
    pacing: elements.settingPacing.value,
    oglproxy: elements.settingOglProxy.value,
    queue: elements.settingQueue.value,
    fastsw: elements.settingFastSw.value,
    wasmjit: elements.settingWasmJit.checked ? "1" : "0",
    jittier: elements.settingJitTier.value,
    forcejit: elements.settingForceJit.checked ? "1" : "0",
    metrics: elements.settingMetrics.checked ? "1" : "0"
  };
}

function updateSettingsSummary() {
  elements.settingsSummary.textContent = describeSettings(currentSettings);
}

function setDebugOpen(open) {
  elements.debugPanel.hidden = !open;
  elements.debugToggle.setAttribute("aria-expanded", String(open));
  elements.debugToggle.classList.toggle("active", open);
  elements.debugToggle.textContent = open ? "DBG on" : "DBG";
  localStorage.setItem(DEBUG_PREF_KEY, open ? "1" : "0");
  if (open && lastFrameInfo) {
    updateDebugMetrics(lastFrameInfo);
  }
}

function setOverlayVisible(visible) {
  elements.screenHud.hidden = !visible;
  elements.overlayToggle.setAttribute("aria-pressed", String(visible));
  elements.overlayToggle.classList.toggle("active", visible);
  elements.overlayToggle.textContent = visible ? "FPS on" : "FPS";
  localStorage.setItem(OSD_PREF_KEY, visible ? "1" : "0");
}

function wireFileMounting() {
  elements.romInput.addEventListener("change", async (event) => {
    const [file] = event.target.files;
    if (file) {
      await mountFile(file);
    }
  });

  for (const eventName of ["dragenter", "dragover"]) {
    elements.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      elements.dropZone.classList.add("dragging");
      elements.dropBadge.textContent = "Release";
    });
  }

  for (const eventName of ["dragleave", "drop"]) {
    elements.dropZone.addEventListener(eventName, () => {
      elements.dropZone.classList.remove("dragging");
      elements.dropBadge.textContent = "Drop disc";
    });
  }

  elements.dropZone.addEventListener("drop", async (event) => {
    event.preventDefault();
    const [file] = event.dataTransfer.files;
    if (file) {
      await mountFile(file);
    }
  });
}

function updateScreenHud(info) {
  elements.hudFps.textContent = formatMetricNumber(info.presentationFps ?? info.fps);
  elements.hudVisualFps.textContent =
    info.visualChangeFps == null ? "n/a" : formatMetricNumber(info.visualChangeFps);
  elements.hudSpeed.textContent = `${Math.max(0, Number(info.gameSpeed) || 0)}%`;
  elements.hudLatency.textContent = formatPresentationLag(info);
  elements.hudJit.textContent = parseJitState(info);
  elements.hudResolution.textContent = parsePresentationResolution(info);
}

async function mountFile(file) {
  try {
    const game = await host.mountFile(file);
    host.setAudioMuted(audio.muted);
    syncGameInfo(game);
    host.start();
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function syncGameInfo(game) {
  elements.gameTitle.textContent = game.name;
  elements.gameSize.textContent = game.size ? formatBytes(game.size) : "No file";
  const coreDetail = [game.gameId, game.platform, game.region].filter(Boolean).join(" / ");
  elements.mountNote.textContent =
    host.mode === "dolphin"
      ? `${game.core || "Dolphin core"} active${coreDetail ? `: ${coreDetail}` : ""}`
      : "Demo WASM core active";
  syncBootInfo(game);
}

function syncBootInfo(game) {
  const mounted = host.mode === "dolphin" && game?.gameId;
  elements.bootStatus.textContent = mounted ? `${game.rootEntryCount ?? 0} root` : "No disc";
  elements.bootApploader.textContent = mounted
    ? [formatBytesMaybe(game.apploaderSize), game.apploaderDate].filter(Boolean).join(" / ")
    : "-";
  elements.bootDol.textContent = mounted ? formatOffsetSize(game.bootDolOffset, game.bootDolSize) : "-";
  elements.bootFst.textContent = mounted ? formatOffsetSize(game.fstOffset, game.fstSize) : "-";
  elements.bootImage.textContent = mounted ? formatImageSizes(game.rawSize, game.dataSize) : "-";
  elements.bootEntry.textContent = mounted ? formatHex(game.bootProbe?.dol?.entryPoint) || "-" : "-";
  elements.bootBlocker.textContent = mounted
    ? [game.bootProbe?.blocker, game.coreStatus].filter(Boolean).join(" / ") || "Boot probe unavailable"
    : "No boot attempt";
  renderRootEntries(mounted ? game.rootEntries ?? [] : []);
}

function renderRootEntries(entries) {
  elements.rootEntryList.replaceChildren();

  if (entries.length === 0) {
    const empty = document.createElement("span");
    empty.className = "root-entry-empty";
    empty.textContent = "No root entries";
    elements.rootEntryList.append(empty);
    return;
  }

  for (const entry of entries.slice(0, 8)) {
    const row = document.createElement("div");
    row.className = "root-entry";

    const name = document.createElement("span");
    name.textContent = entry.path || entry.name || "/";

    const size = document.createElement("strong");
    size.textContent = entry.directory ? "dir" : formatBytesMaybe(entry.size);

    row.append(name, size);
    elements.rootEntryList.append(row);
  }
}

function wireKeyboard() {
  document.addEventListener("keydown", (event) => {
    if (event.repeat) {
      return;
    }

    const button = resolveKeyboardButton(event.code);
    if (!button) {
      return;
    }

    event.preventDefault();
    const nextKeyboard = updatePressedSet(keyboardPressed, button, true);
    keyboardPressed.clear();
    for (const pressed of nextKeyboard) keyboardPressed.add(pressed);
    syncInput("Keyboard");
  });

  document.addEventListener("keyup", (event) => {
    const button = resolveKeyboardButton(event.code);
    if (!button) {
      return;
    }

    event.preventDefault();
    keyboardPressed.delete(button);
    syncInput("Keyboard");
  });
}

function wireTouchControls() {
  const touchButtons = document.querySelectorAll("[data-touch-button]");
  for (const button of touchButtons) {
    const control = button.dataset.touchButton;
    const press = (event) => {
      event.preventDefault();
      touchPressed = updatePressedSet(touchPressed, control, true);
      syncInput("Touch");
    };
    const release = (event) => {
      event.preventDefault();
      touchPressed = updatePressedSet(touchPressed, control, false);
      syncInput("Touch");
    };

    button.addEventListener("pointerdown", press);
    button.addEventListener("pointerup", release);
    button.addEventListener("pointercancel", release);
    button.addEventListener("pointerleave", release);
  }
}

function wireGamepadPolling() {
  // Poll on a 4ms interval rather than rAF. The Gamepad API has no event
  // model so we must poll, but rAF caps the cadence at the display refresh
  // rate (~16.7ms), which adds a worst-case full-frame of latency to every
  // gamepad input. setInterval at 4ms cuts that floor to ~4ms.
  const poll = () => {
    const pads = navigator.getGamepads?.() ?? [];
    const firstPad = Array.from(pads).find(Boolean);
    const gamepadInput = readGamepadInput(firstPad);
    gamepadPressed = gamepadInput.pressed;
    gamepadInputState = firstPad ? gamepadInput.state : null;

    if (gamepadPressed.size > 0) {
      syncInput("Gamepad");
    } else {
      syncInput(elements.inputSource.textContent === "Gamepad" ? "Keyboard" : elements.inputSource.textContent);
    }
  };

  setInterval(poll, 4);
}

function syncInput(source) {
  combinedPressed = mergePressedSets(keyboardPressed, touchPressed, gamepadPressed);
  host.setInputState(inputStateFromPressed(combinedPressed, gamepadInputState));
  elements.inputSource.textContent = source;

  for (const chip of elements.controlGrid.children) {
    chip.classList.toggle("active", combinedPressed.has(chip.dataset.control));
  }
}

function renderControlGrid() {
  const fragment = document.createDocumentFragment();

  for (const label of CONTROL_LABELS) {
    const chip = document.createElement("span");
    chip.className = "control-chip";
    chip.dataset.control = label;
    chip.textContent = formatControlLabel(label);
    fragment.append(chip);
  }

  elements.controlGrid.append(fragment);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatBytesMaybe(bytes) {
  return Number.isFinite(bytes) && bytes >= 0 ? formatBytes(bytes) : "";
}

function formatHex(value) {
  return Number.isFinite(value) && value >= 0 ? `0x${Math.trunc(value).toString(16).toUpperCase()}` : "";
}

function formatLargeInteger(value) {
  return Number.isFinite(value) ? Math.trunc(value).toLocaleString("en-US") : "0";
}

function formatMetricNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "0";
  }

  return numeric >= 10 ? String(Math.round(numeric)) : numeric.toFixed(1);
}

function formatPresentationLag(info) {
  const frameLag = Math.max(0, Number(info.presentationFrameLag) || 0);
  return `${frameLag.toFixed(0)}f`;
}

function parseJitState(info) {
  const helperStats = info.ppcWasmHelperStats || "";
  const match = /(?:^|\s)jit:([a-z0-9_-]+)/i.exec(helperStats);
  if (match) {
    return match[1] === "on" ? "JIT on" : `JIT ${match[1]}`;
  }

  if ((info.ppcWasmBlockCompileCount || 0) > 0 || (info.ppcWasmBlockRunCount || 0) > 0) {
    return "JIT active";
  }

  return currentSettings.wasmjit === "1" ? "JIT armed" : "JIT off";
}

function parsePresentationResolution(info) {
  const helperStats = info.ppcWasmHelperStats || "";
  const match = /present:(\d+x\d+)/i.exec(helperStats);
  if (match) {
    return match[1];
  }

  return `${elements.screen.width}x${elements.screen.height}`;
}

function formatOffsetSize(offset, size) {
  const parts = [formatHex(offset), formatBytesMaybe(size)].filter(Boolean);
  return parts.length > 0 ? parts.join(" / ") : "-";
}

function formatImageSizes(rawSize, dataSize) {
  const raw = formatBytesMaybe(rawSize);
  const data = formatBytesMaybe(dataSize);
  return raw && data ? `${raw} / ${data}` : raw || data || "-";
}

async function runSmokeScenario() {
  const scenario = new URLSearchParams(window.location.search).get("smoke");
  if (scenario !== "melee") {
    return;
  }

  const header = new Uint8Array(0x3000);
  header.set(new TextEncoder().encode("GALE01"), 0);
  header.set([0xc2, 0x33, 0x9f, 0x3d], 0x1c);
  header.set(new TextEncoder().encode("Super Smash Bros. Melee"), 0x20);
  header.set([0x00, 0x00, 0x00, 0x01], 0x458);
  header.set(new TextEncoder().encode("2026/05/05"), 0x2440);
  writeU32BE(header, 0x420, 0x1000);
  writeU32BE(header, 0x424, 0x2800);
  writeU32BE(header, 0x428, 0x24);
  writeU32BE(header, 0x1000, 0x100);
  writeU32BE(header, 0x1048, 0x80003100);
  writeU32BE(header, 0x1090, 0x40);
  writeU32BE(header, 0x10d8, 0x80400000);
  writeU32BE(header, 0x10dc, 0x1000);
  writeU32BE(header, 0x10e0, 0x80003100);
  writeU32BE(header, 0x2454, 0x20);
  writeU32BE(header, 0x2458, 0x10);
  writeU32BE(header, 0x2800, 0x01000000);
  writeU32BE(header, 0x2804, 0);
  writeU32BE(header, 0x2808, 2);
  writeU32BE(header, 0x280c, 0);
  writeU32BE(header, 0x2810, 0x2900);
  writeU32BE(header, 0x2814, 4);
  header.set(new TextEncoder().encode("opening.bnr"), 0x2818);
  header.set(new TextEncoder().encode("BNR1"), 0x2900);

  const file = new File([header], "Super Smash Bros Melee.iso", {
    type: "application/octet-stream"
  });
  await mountFile(file);
  window.__wasmDolphinSmoke = {
    mode: host.mode,
    game: host.game
  };
}

function writeU32BE(bytes, offset, value) {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}
