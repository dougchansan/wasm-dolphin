// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import {
  captureInitialWgpuConsumerResetAttestation,
  isAuthenticInitialWgpuConsumerResetAttestation,
} from "../src/wgpu-consumer-reset-attestation.js";

test("only the pre-trace empty hardware consumer boundary is attested", () => {
  const attestation = captureInitialWgpuConsumerResetAttestation(validInput());
  assert.equal(attestation.valid, true);
  assert.equal(attestation.totalResourceCount, 0);
  assert.equal(isAuthenticInitialWgpuConsumerResetAttestation(attestation), true);
  assert.equal(Object.isFrozen(attestation.resourceCounts), true);
});

test("live resources, replay activity, and late capture all fail closed", () => {
  for (const override of [
    { resourceMaps: maps({ textures: 1 }) },
    { commandsProcessed: 1 },
    { commandRingRegistered: true },
    { canvasOwnedByCommandRing: true },
    { capturedBeforeTraceAttach: false },
    { replayFatal: { scope: "device-lost" } },
    { videoBackend: "WebGPU" },
    { renderDeviceReady: false },
  ]) {
    const attestation = captureInitialWgpuConsumerResetAttestation({
      ...validInput(),
      ...override,
    });
    assert.equal(attestation.valid, false, JSON.stringify(override));
    assert.equal(isAuthenticInitialWgpuConsumerResetAttestation(attestation), false);
  }
});

test("plain objects cannot forge a trusted reset attestation", () => {
  const real = captureInitialWgpuConsumerResetAttestation(validInput());
  assert.equal(isAuthenticInitialWgpuConsumerResetAttestation({ ...real }), false);
});

function validInput() {
  return {
    resourceMaps: maps(),
    videoBackend: "WebGPU-Real",
    renderDeviceReady: true,
    capturedBeforeTraceAttach: true,
    commandRingRegistered: false,
    commandsProcessed: 0,
    canvasOwnedByCommandRing: false,
    replayFatal: null,
  };
}

function maps(sizes = {}) {
  return Object.fromEntries([
    "shaders",
    "pipelines",
    "buffers",
    "textures",
    "samplers",
    "bindGroups",
    "pipeTpl",
    "pipeVar",
  ].map((name) => {
    const map = new Map();
    for (let index = 0; index < (sizes[name] || 0); index += 1) map.set(index, {});
    return [name, map];
  }));
}
