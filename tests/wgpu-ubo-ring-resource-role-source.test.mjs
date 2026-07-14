// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("producer tags only the WebGPU UBO ring with a stable resource role", async () => {
  const [header, stream, gfx, patch] = await Promise.all([
    source("vendor/dolphin/Source/Core/VideoBackends/WebGPU/WebGPUCommandStream.h"),
    source("vendor/dolphin/Source/Core/VideoBackends/WebGPU/WebGPUCommandStream.cpp"),
    source("vendor/dolphin/Source/Core/VideoBackends/WebGPU/WebGPUGfx.cpp"),
    source("patches/dolphin-wasm/snapshot/0051-tag-webgpu-ubo-ring-resource.patch"),
  ]);
  assert.match(header, /enum class BufferResourceRole : u32[\s\S]*Unknown = 0,[\s\S]*UboRing = 1/);
  assert.match(
    header,
    /PushCreateBuffer\(u32 size, u32 usage_flags,[\s\S]*BufferResourceRole role = BufferResourceRole::Unknown\)/
  );
  assert.match(stream, /rec\.arg\.u\[3\] = static_cast<u32>\(role\)/);
  assert.match(
    gfx,
    /PushCreateBuffer\(kUboRingSize, kUsageUniform,[\s\S]*BufferResourceRole::UboRing\)/
  );
  assert.equal((gfx.match(/BufferResourceRole::UboRing/g) ?? []).length, 1);
  assert.match(patch, /u3=BufferResourceRole/);
  assert.match(patch, /BufferResourceRole::UboRing/);
});
