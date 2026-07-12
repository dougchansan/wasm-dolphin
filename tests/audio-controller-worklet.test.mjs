import test from "node:test";
import assert from "node:assert/strict";

function installBrowser({ search = "?audiotransport=worklet", isolated = true, sampleRate = 48000 } = {}) {
  const modules = [];
  class Context {
    constructor() {
      this.sampleRate = sampleRate;
      this.currentTime = 0;
      this.state = "running";
      this.destination = {};
      this.audioWorklet = { addModule: async (url) => modules.push(url) };
    }
    createGain() {
      return { gain: { value: 0, setTargetAtTime() {} }, connect() {} };
    }
    createBuffer() { throw new Error("legacy scheduler should not run"); }
  }
  class Node {
    constructor(_context, _name, options) { this.options = options; }
    connect() {}
    disconnect() {}
  }
  globalThis.window = {
    location: { search }, AudioContext: Context,
    setInterval, clearInterval,
  };
  globalThis.crossOriginIsolated = isolated;
  globalThis.AudioWorkletNode = Node;
  return { modules };
}

test("worklet transport activates only after feature, module, rate, and producer gates", async () => {
  const { modules } = installBrowser();
  const { AudioController } = await import(`../src/audio.js?active=${Date.now()}`);
  const audio = new AudioController();
  const calls = [];
  audio.setTransportBridge(async (config) => { calls.push(config); return true; });
  audio.muted = false;
  await audio.ensureContext();
  assert.equal(audio.activeTransport, "worklet");
  assert.equal(modules.length, 1);
  assert.ok(calls[0].sab instanceof SharedArrayBuffer);
});

test("worklet request falls back observably on missing isolation", async () => {
  installBrowser({ isolated: false });
  const { AudioController } = await import(`../src/audio.js?fallback=${Date.now()}`);
  const audio = new AudioController();
  audio.setTransportBridge(async () => true);
  await audio.ensureContext();
  assert.equal(audio.activeTransport, "legacy");
  assert.equal(audio.transportFallbackReason, "cross-origin-isolation-required");
});

test("legacy remains the default and never loads a worklet module", async () => {
  const { modules } = installBrowser({ search: "" });
  const { AudioController } = await import(`../src/audio.js?legacy=${Date.now()}`);
  const audio = new AudioController();
  await audio.ensureContext();
  assert.equal(audio.requestedTransport, "legacy");
  assert.equal(audio.activeTransport, "legacy");
  assert.equal(modules.length, 0);
});
