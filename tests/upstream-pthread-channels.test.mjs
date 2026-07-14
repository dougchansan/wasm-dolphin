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
      this.listeners.push({ type, name: listener.name, listener });
    },
    postMessage(message) {
      if (throwOnPost) throw new Error("intentional cache post failure");
      this.messages.push(message);
      if (message.type === "dolphin-jit-cache-barrier") {
        const entry = this.listeners.find(
          ({ name }) => name === "handleDolphinJitPthreadBarrierAckEvent"
        );
        entry?.listener?.({
          currentTarget: this,
          data: {
            type: "dolphin-jit-cache-barrier-ack",
            generation: message.generation,
            installed: true,
            cacheSize: 0,
          },
        });
      }
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
  await installDolphinPthreadChannels(
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

  const overlappingWorker = fakePthreadWorker();
  await installDolphinPthreadChannels(
    {
      PThread: {
        runningWorkers: [overlappingWorker],
        unusedWorkers: [overlappingWorker]
      }
    },
    { jitCacheEnabled: false }
  );
  assert.deepEqual(listenerNames(overlappingWorker), rendererListenerNames);

  const cacheEnabled = fakePthreadWorker();
  await installDolphinPthreadChannels(
    { PThread: { runningWorkers: [cacheEnabled], unusedWorkers: [] } },
    { jitCacheEnabled: true }
  );
  assert.deepEqual(listenerNames(cacheEnabled), [
    ...rendererListenerNames,
    "handleDolphinJitPthreadBarrierAckEvent",
    "handleDolphinJitNewCompile"
  ]);
  assert.equal(cacheEnabled.messages.length, 2);
  assert.equal(cacheEnabled.messages[0].type, "dolphin-jit-cache");
  assert.equal(cacheEnabled.messages[1].type, "dolphin-jit-cache-barrier");

  const cachePostFailure = fakePthreadWorker({ throwOnPost: true });
  await installDolphinPthreadChannels(
    { PThread: { runningWorkers: [cachePostFailure], unusedWorkers: [] } },
    { jitCacheEnabled: true }
  );
  assert.deepEqual(listenerNames(cachePostFailure), [
    ...rendererListenerNames,
    "handleDolphinJitPthreadBarrierAckEvent",
    "handleDolphinJitNewCompile"
  ]);
});

test("loadCore awaits pthread cache installation before returning", async () => {
  const source = await readFile(workerUrl, "utf8");

  assert.match(
    source,
    /await installDolphinPthreadChannels\(moduleInstance, \{\s*jitCacheEnabled: !noJitCache\s*\}\);/
  );
  assert.doesNotMatch(
    source,
    /if\s*\(!noJitCache\)\s*installDolphinPthreadChannels/
  );
});
