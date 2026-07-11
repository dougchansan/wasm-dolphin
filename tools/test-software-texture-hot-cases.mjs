import { existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { verifyWasmToolchain } from "./wasm-toolchain.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = resolve(root, "build/texture-hot-case-parity");
const outputModule = resolve(outputDir, "parity.mjs");

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

console.log("Building software texture hot-case parity harness");
run(toolchain.paths.emcc.replace(/emcc(\.bat)?$/i, "em++$1"), [
  "-std=c++20",
  "-O2",
  "-DTEXTURE_HOT_CASE_PARITY_STANDALONE",
  `-I${resolve(root, "vendor/dolphin/Source/Core")}`,
  `-I${resolve(root, "vendor/dolphin/Externals/fmt/fmt/include")}`,
  resolve(root, "tools/software-texture-hot-case-parity.cpp"),
  resolve(root, "vendor/dolphin/Source/Core/VideoCommon/TextureDecoder_Common.cpp"),
  "-sENVIRONMENT=node",
  "-sEXIT_RUNTIME=1",
  "-o",
  outputModule,
]);

if (!existsSync(outputModule)) {
  throw new Error(`Parity build did not produce ${outputModule}`);
}

console.log("Running software texture hot-case parity harness");
run(toolchain.paths.node, [
  "--input-type=module",
  "--eval",
  "const module = await import(process.argv[1]); await module.default();",
  pathToFileURL(outputModule).href,
]);
