import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { sha256File, verifyWasmToolchain } from "./wasm-toolchain.mjs";

const root = process.cwd();
const sourceDir = resolve(root, "vendor/dolphin");
const buildDir = resolve(process.env.DOLPHIN_WASM_BUILD_DIR ?? resolve(root, "build/dolphin-wasm"));
const bridgeSource = resolve(root, "core/upstream/dolphin_web_discio.cpp");
const sharedSourceDir = dirname(bridgeSource);
const coreSource = resolve(root, "core/upstream/dolphin_web_core.cpp");
const outputDir = resolve(process.env.DOLPHIN_WASM_OUTPUT_DIR ?? resolve(root, "cores/dolphin"));
const nagaDir = resolve(root, "tools/naga-spirv-wgsl");
const nagaLibrary = resolve(nagaDir, "target/wasm32-unknown-emscripten/release/naga_spirv_wgsl.a");
const nagaLibraryAlternate = resolve(nagaDir, "target/wasm32-unknown-emscripten/release/libnaga_spirv_wgsl.a");
const jitCachePreJs = resolve(root, "tools/jit-cache-prejs.js");
const wasmMemoryPages = 24576;
const fastBranchInline = String(
  process.env.DOLPHIN_WEB_INLINE_FAST_BRANCH ?? "1"
).trim();
if (!["0", "1"].includes(fastBranchInline)) {
  throw new Error(
    `DOLPHIN_WEB_INLINE_FAST_BRANCH must be 0 or 1, got ${JSON.stringify(fastBranchInline)}`
  );
}
const fallbackMapDiagnostics = String(
  process.env.DOLPHIN_WEB_FALLBACK_MAP_DIAGNOSTICS ?? "0"
).trim();
if (!["0", "1"].includes(fallbackMapDiagnostics)) {
  throw new Error(
    `DOLPHIN_WEB_FALLBACK_MAP_DIAGNOSTICS must be 0 or 1, got ${JSON.stringify(fallbackMapDiagnostics)}`
  );
}
const fallbackMapBits = String(
  process.env.DOLPHIN_WEB_FALLBACK_MAP_BITS ?? "16"
).trim();
if (!["16", "18", "20"].includes(fallbackMapBits)) {
  throw new Error(
    `DOLPHIN_WEB_FALLBACK_MAP_BITS must be 16, 18, or 20, got ${JSON.stringify(fallbackMapBits)}`
  );
}
const directWasmBlockDispatch = String(
  process.env.DOLPHIN_WEB_DIRECT_WASM_BLOCK_DISPATCH ?? "0"
).trim();
if (!["0", "1"].includes(directWasmBlockDispatch)) {
  throw new Error(
    `DOLPHIN_WEB_DIRECT_WASM_BLOCK_DISPATCH must be 0 or 1, got ${JSON.stringify(directWasmBlockDispatch)}`
  );
}

function quoteShellArg(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}

function run(command, args, options = {}) {
  const isWindowsBatch = process.platform === "win32" && /\.(bat|cmd)$/i.test(command);
  const result = spawnSync(isWindowsBatch ? [command, ...args].map(quoteShellArg).join(" ") : command, isWindowsBatch ? [] : args, {
    encoding: "utf8",
    stdio: "inherit",
    shell: isWindowsBatch,
    ...options
  });

  if (result.error || result.status !== 0) {
    process.exit(result.status || 1);
  }
}

if (!existsSync(resolve(sourceDir, "CMakeLists.txt"))) {
  console.error("vendor/dolphin is missing. Run npm run fetch:dolphin first.");
  process.exit(1);
}

mkdirSync(buildDir, { recursive: true });
mkdirSync(outputDir, { recursive: true });

const toolchain = verifyWasmToolchain();
const { emcc, emcmake, cmake, ninja, cargo, rustc } = toolchain.paths;
const nagaEnvironment = {
  ...process.env,
  PATH: `${dirname(rustc)};${dirname(emcc)};${process.env.PATH ?? ""}`,
  RUSTC: rustc,
  CARGO: cargo
};

console.log("Building the pinned Naga SPIR-V to WGSL bridge");
run(cargo, ["build", "--locked", "--release", "--target", toolchain.lock.rust.target], {
  cwd: nagaDir,
  env: nagaEnvironment
});
const resolvedNagaLibrary = existsSync(nagaLibrary) ? nagaLibrary : nagaLibraryAlternate;
if (!existsSync(resolvedNagaLibrary)) {
  console.error(`Pinned Naga build did not produce ${nagaLibrary} or ${nagaLibraryAlternate}`);
  process.exit(1);
}

// CMake runs hundreds of feature probes. Keep the original global production
// flags so subprojects that replace their Release flags still retain LTO, but
// make try_compile use Debug and append overrides that disable optimization
// and LTO for probes only. Clang/Emscripten honors the last -O*/-f*lto option.
const wasmCompileFlags =
  "-O3 -pthread -msimd128 -flto -DXXH_VECTOR=0 -DDOLPHIN_WEB_HOT_COUNTERS=0 " +
  `-DDOLPHIN_WEB_INLINE_FAST_BRANCH=${fastBranchInline} ` +
  `-DDOLPHIN_WEB_FALLBACK_MAP_DIAGNOSTICS=${fallbackMapDiagnostics} ` +
  `-DDOLPHIN_WEB_FALLBACK_MAP_BITS=${fallbackMapBits} ` +
  `-DDOLPHIN_WEB_DIRECT_WASM_BLOCK_DISPATCH=${directWasmBlockDispatch}`;
const wasmDebugProbeFlags = "-O0 -fno-lto";
const cmakeArgs = [
  cmake,
  "-S",
  sourceDir,
  "-B",
  buildDir,
  "-GNinja",
  `-DCMAKE_MAKE_PROGRAM=${ninja}`,
  "-DCMAKE_BUILD_TYPE=Release",
  "-DCMAKE_TRY_COMPILE_CONFIGURATION=Debug",
  "-DCMAKE_EXPORT_COMPILE_COMMANDS=ON",
  "-DUSE_SYSTEM_LIBS=OFF",
  "-DENABLE_GENERIC=ON",
  "-DENABLE_QT=OFF",
  "-DENABLE_NOGUI=OFF",
  "-DENABLE_CLI_TOOL=OFF",
  "-DENABLE_HEADLESS=OFF",
  "-DENABLE_ALSA=OFF",
  "-DENABLE_PULSEAUDIO=OFF",
  "-DENABLE_CUBEB=OFF",
  "-DENABLE_X11=OFF",
  "-DENABLE_EGL=OFF",
  "-DENABLE_SDL=OFF",
  "-DENABLE_VULKAN=OFF",
  "-DENABLE_LLVM=OFF",
  "-DENABLE_TESTS=OFF",
  "-DUSE_UPNP=OFF",
  "-DUSE_DISCORD_PRESENCE=OFF",
  "-DUSE_MGBA=OFF",
  "-DUSE_RETRO_ACHIEVEMENTS=OFF",
  "-DENABLE_AUTOUPDATE=OFF",
  "-DENABLE_ANALYTICS=OFF",
  "-DENCODE_FRAMEDUMPS=OFF",
  "-DWITH_OPTIM=OFF",
  "-DWITH_SSE2=OFF",
  "-DWITH_SSSE3=OFF",
  "-DWITH_SSE41=OFF",
  "-DWITH_SSE42=OFF",
  "-DWITH_PCLMULQDQ=OFF",
  "-DWITH_AVX2=OFF",
  "-DWITH_AVX512=OFF",
  "-DWITH_AVX512VNNI=OFF",
  "-DWITH_VPCLMULQDQ=OFF",
  `-DCMAKE_C_FLAGS:STRING=${wasmCompileFlags}`,
  `-DCMAKE_CXX_FLAGS:STRING=${wasmCompileFlags}`,
  `-DCMAKE_C_FLAGS_DEBUG:STRING=${wasmDebugProbeFlags}`,
  `-DCMAKE_CXX_FLAGS_DEBUG:STRING=${wasmDebugProbeFlags}`,
  `-DDOLPHIN_WASM_NAGA_WGSL_LIB=${resolvedNagaLibrary}`,
  `-DDOLPHIN_WASM_JIT_CACHE_PRE_JS=${jitCachePreJs}`,
  `-DDOLPHIN_WASM_MEMORY_PAGES=${wasmMemoryPages}`
];

if (existsSync(bridgeSource)) {
  cmakeArgs.push(`-DDOLPHIN_WASM_BRIDGE_SOURCE=${bridgeSource}`);
  cmakeArgs.push(`-DDOLPHIN_WASM_SHARED_SOURCE_DIR=${sharedSourceDir}`);
  cmakeArgs.push(`-DDOLPHIN_WASM_OUTPUT_DIR=${outputDir}`);
}

if (existsSync(coreSource)) {
  cmakeArgs.push(`-DDOLPHIN_WASM_CORE_SOURCE=${coreSource}`);
  cmakeArgs.push(`-DDOLPHIN_WASM_OUTPUT_DIR=${outputDir}`);
}

console.log(`Configuring upstream Dolphin for Emscripten in ${buildDir}`);
run(emcmake, cmakeArgs);
writeFileSync(resolve(buildDir, "wasm-dolphin-configure.json"), `${JSON.stringify({
  schemaVersion: 1,
  sourceDir,
  buildDir,
  outputDir,
  bridgeSource,
  sharedSourceDir,
  coreSource,
  nagaLibrary: resolvedNagaLibrary,
  nagaLibrarySha256: sha256File(resolvedNagaLibrary),
  jitCachePreJs,
  wasmMemoryPages,
  fastBranchInline,
  fallbackMapDiagnostics,
  fallbackMapBits,
  directWasmBlockDispatch,
  wasmCompileFlags,
  cmakeArgs,
  toolchainLockSha256: toolchain.hashes.lock,
  cargoLockSha256: toolchain.hashes.cargoLock
}, null, 2)}\n`);
console.log("Configured. Probe targets with: cmake --build build/dolphin-wasm --target discio --parallel 8");
