// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import { verifyLocalPrebuiltJitCache } from "./prebuilt-jit-cache-provenance.mjs";

try {
  await verifyLocalPrebuiltJitCache(process.cwd());
} catch (error) {
  console.error(`[prebuilt-cache] invalid: ${error.message}`);
  console.error("Regenerate with npm run build:prebuilt-cache, or delete cores/dolphin/prebuilt-jit-cache.bin.");
  process.exitCode = 1;
}
