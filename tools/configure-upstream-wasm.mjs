import { existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = process.cwd();
const sourceDir = resolve(root, "vendor/dolphin");
const buildDir = resolve(process.env.DOLPHIN_WASM_BUILD_DIR ?? resolve(root, "build/dolphin-wasm"));
const bridgeSource = resolve(root, "core/upstream/dolphin_web_discio.cpp");
const coreSource = resolve(root, "core/upstream/dolphin_web_core.cpp");
const outputDir = resolve(root, "cores/dolphin");
const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
const appData = process.env.APPDATA ?? "";

function findTool(command, fallbackPath) {
  if (process.env[command.toUpperCase()] && existsSync(process.env[command.toUpperCase()])) {
    return process.env[command.toUpperCase()];
  }

  return existsSync(fallbackPath) ? fallbackPath : command;
}

function quoteShellArg(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}

function run(command, args) {
  const isWindowsBatch = process.platform === "win32" && /\.(bat|cmd)$/i.test(command);
  const result = spawnSync(isWindowsBatch ? [command, ...args].map(quoteShellArg).join(" ") : command, isWindowsBatch ? [] : args, {
    encoding: "utf8",
    stdio: "inherit",
    shell: isWindowsBatch
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

const emcmake = findTool("emcmake", resolve(home, "emsdk/upstream/emscripten/emcmake.bat"));
const cmake = findTool("cmake", resolve(appData, "Python/Python312/Scripts/cmake.exe"));
const wasmCompileFlags = "-O3 -pthread -msimd128 -flto -DXXH_VECTOR=0";
const cmakeArgs = [
  cmake,
  "-S",
  sourceDir,
  "-B",
  buildDir,
  "-GNinja",
  "-DCMAKE_BUILD_TYPE=Release",
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
  `-DCMAKE_CXX_FLAGS:STRING=${wasmCompileFlags}`
];

if (existsSync(bridgeSource)) {
  cmakeArgs.push(`-DDOLPHIN_WASM_BRIDGE_SOURCE=${bridgeSource}`);
  cmakeArgs.push(`-DDOLPHIN_WASM_OUTPUT_DIR=${outputDir}`);
}

if (existsSync(coreSource)) {
  cmakeArgs.push(`-DDOLPHIN_WASM_CORE_SOURCE=${coreSource}`);
  cmakeArgs.push(`-DDOLPHIN_WASM_OUTPUT_DIR=${outputDir}`);
}

console.log(`Configuring upstream Dolphin for Emscripten in ${buildDir}`);
run(emcmake, cmakeArgs);
console.log("Configured. Probe targets with: cmake --build build/dolphin-wasm --target discio --parallel 8");
