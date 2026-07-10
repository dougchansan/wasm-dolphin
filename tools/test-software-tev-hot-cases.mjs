import { existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { verifyWasmToolchain } from "./wasm-toolchain.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = resolve(root, "build/tev-hot-case-parity");

function quoteShellArg(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}

function run(command, args) {
  const isWindowsBatch = process.platform === "win32" && /\.(bat|cmd)$/i.test(command);
  const result = spawnSync(
    isWindowsBatch ? [command, ...args].map(quoteShellArg).join(" ") : command,
    isWindowsBatch ? [] : args,
    {
      cwd: root,
      encoding: "utf8",
      stdio: "inherit",
      shell: isWindowsBatch,
      windowsHide: true,
    }
  );
  if (result.error || result.status !== 0) {
    if (result.error) console.error(result.error.message);
    process.exit(result.status || 1);
  }
}

const toolchain = verifyWasmToolchain();
mkdirSync(outputDir, { recursive: true });
const source = resolve(root, "tools/software-tev-hot-case-parity.cpp");
const include = `-I${resolve(root, "vendor/dolphin/Source/Core")}`;

const nativeOutput = resolve(outputDir, process.platform === "win32" ? "parity.exe" : "parity");
console.log("Building native software TEV hot-case parity harness");
run(toolchain.paths.clangxx, ["-std=c++20", "-O2", include, source, "-o", nativeOutput]);
if (!existsSync(nativeOutput)) throw new Error(`Native parity build did not produce ${nativeOutput}`);
console.log("Running native software TEV hot-case parity harness");
run(nativeOutput, []);

const wasmOutput = resolve(outputDir, "parity.mjs");
const emxx = toolchain.paths.emcc.replace(/emcc(\.bat)?$/i, "em++$1");
console.log("Building Emscripten software TEV hot-case parity harness");
run(emxx, [
  "-std=c++20",
  "-O2",
  include,
  source,
  "-sENVIRONMENT=node",
  "-sEXIT_RUNTIME=1",
  "-o",
  wasmOutput,
]);
if (!existsSync(wasmOutput)) throw new Error(`Emscripten parity build did not produce ${wasmOutput}`);
console.log("Running Emscripten software TEV hot-case parity harness");
run(toolchain.paths.node, [
  "--input-type=module",
  "--eval",
  "const module = await import(process.argv[1]); await module.default();",
  pathToFileURL(wasmOutput).href,
]);
