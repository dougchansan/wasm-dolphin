import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workerUrl = new URL("../src/upstream-discio-worker.js", import.meta.url);
const rendererListenerNames = [
  "handleDetachedOglFrame",
  "handleWebGpuShowImage",
  "handleWebGpuCmdRing"
];

function fakePthreadWorker({ throwOnPost = false } = {}) {
  return {
    listeners: [],
    messages: [],
    addEventListener(type, listener) {
      this.listeners.push({ type, name: listener.name });
    },
    postMessage(message) {
      if (throwOnPost) throw new Error("intentional cache post failure");
      this.messages.push(message);
    }
  };
}

function listenerNames(worker) {
  return worker.listeners.map(({ name }) => name);
}

test("pthread renderer transport is independent of the optional JIT cache channel", async (t) => {
  const originalSelf = globalThis.self;
  const statusMessages = [];
  globalThis.self = {
    location: { href: "http://127.0.0.1:8080/" },
    addEventListener() {},
    postMessage(message) {
      statusMessages.push(message);
    }
  };
  t.after(() => {
    if (originalSelf === undefined) {
      delete globalThis.self;
    } else {
      globalThis.self = originalSelf;
    }
  });

  const { installDolphinPthreadChannels } = await import(
    `${workerUrl.href}?pthread-channels-test=${Date.now()}`
  );

  const cacheDisabledRunning = fakePthreadWorker();
  const cacheDisabledUnused = fakePthreadWorker();
  installDolphinPthreadChannels(
    {
      PThread: {
        runningWorkers: [cacheDisabledRunning],
        unusedWorkers: [cacheDisabledUnused]
      }
    },
    { jitCacheEnabled: false }
  );

  for (const worker of [cacheDisabledRunning, cacheDisabledUnused]) {
    assert.deepEqual(listenerNames(worker), rendererListenerNames);
    assert.deepEqual(worker.messages, []);
  }
  assert.deepEqual(statusMessages, []);

  const cacheEnabled = fakePthreadWorker();
  installDolphinPthreadChannels(
    { PThread: { runningWorkers: [cacheEnabled], unusedWorkers: [] } },
    { jitCacheEnabled: true }
  );
  assert.deepEqual(listenerNames(cacheEnabled), [
    ...rendererListenerNames,
    "handleDolphinJitNewCompile"
  ]);
  assert.equal(cacheEnabled.messages.length, 1);
  assert.equal(cacheEnabled.messages[0].type, "dolphin-jit-cache");

  const cachePostFailure = fakePthreadWorker({ throwOnPost: true });
  installDolphinPthreadChannels(
    { PThread: { runningWorkers: [cachePostFailure], unusedWorkers: [] } },
    { jitCacheEnabled: true }
  );
  assert.deepEqual(listenerNames(cachePostFailure), [
    ...rendererListenerNames,
    "handleDolphinJitNewCompile"
  ]);
});

test("loadCore always installs pthread channels and only passes cache enablement as data", async () => {
  const source = await readFile(workerUrl, "utf8");

  assert.match(
    source,
    /installDolphinPthreadChannels\(moduleInstance, \{\s*jitCacheEnabled: !noJitCache\s*\}\);/
  );
  assert.doesNotMatch(
    source,
    /if\s*\(!noJitCache\)\s*installDolphinPthreadChannels/
  );
});
