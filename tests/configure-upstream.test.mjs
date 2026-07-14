import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Emscripten feature probes avoid production LTO while Release keeps it", async () => {
  const source = await readFile(
    new URL("../tools/configure-upstream-wasm.mjs", import.meta.url),
    "utf8"
  );
  assert.match(
    source,
    /const wasmCompileFlags =[\s\S]*?-O3 -pthread -msimd128 -flto -DXXH_VECTOR=0[\s\S]*?-DDOLPHIN_WEB_INLINE_FAST_BRANCH=\$\{fastBranchInline\}/
  );
  assert.match(source, /const wasmDebugProbeFlags = "-O0 -fno-lto"/);
  assert.match(source, /"-DCMAKE_TRY_COMPILE_CONFIGURATION=Debug"/);
  assert.match(source, /`-DCMAKE_C_FLAGS:STRING=\$\{wasmCompileFlags\}`/);
  assert.match(source, /`-DCMAKE_CXX_FLAGS:STRING=\$\{wasmCompileFlags\}`/);
  assert.match(source, /`-DCMAKE_C_FLAGS_DEBUG:STRING=\$\{wasmDebugProbeFlags\}`/);
  assert.match(source, /`-DCMAKE_CXX_FLAGS_DEBUG:STRING=\$\{wasmDebugProbeFlags\}`/);
});
