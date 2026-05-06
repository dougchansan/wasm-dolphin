import { existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = process.cwd();
const source = resolve(root, "core/native/dolphin_web_core.cpp");
const outDir = resolve(root, "cores/dolphin");
const output = resolve(outDir, "dolphin.js");

mkdirSync(outDir, { recursive: true });

function findEmcc() {
  if (process.env.EMCC && existsSync(process.env.EMCC)) {
    return process.env.EMCC;
  }

  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  const candidates = [
    resolve(home, "emsdk/upstream/emscripten/emcc.bat"),
    resolve(root, ".tools/emsdk/upstream/emscripten/emcc.bat")
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? "emcc";
}

function quoteShellArg(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}

function runTool(command, args) {
  const isWindowsBatch = process.platform === "win32" && /\.(bat|cmd)$/i.test(command);
  return spawnSync(isWindowsBatch ? [command, ...args].map(quoteShellArg).join(" ") : command, isWindowsBatch ? [] : args, {
    encoding: "utf8",
    stdio: "inherit",
    shell: isWindowsBatch
  });
}

const command = findEmcc();
const args = [
  source,
  "-O3",
  "-std=c++20",
  "-sWASM=1",
  "-sMODULARIZE=1",
  "-sEXPORT_NAME=createDolphinCore",
  "-sEXPORT_ES6=1",
  "-sENVIRONMENT=web",
  "-sALLOW_MEMORY_GROWTH=1",
  "-sFILESYSTEM=1",
  "-sEXPORTED_FUNCTIONS=['_MountDisc','_Reset','_SetInputMask','_RunFrame','_FrameWidth','_FrameHeight','_FrameBuffer','_SaveState','_LoadState','_GetFrame','_GetGameId','_GetGameTitle','_malloc','_free']",
  "-sEXPORTED_RUNTIME_METHODS=['FS','ccall','cwrap','UTF8ToString','HEAPU8']",
  "-o",
  output
];

const result = runTool(command, args);

if (result.error || result.status !== 0) {
  console.error("Unable to build native core. Install and activate Emscripten SDK, then rerun npm run build:core.");
  process.exit(result.status || 1);
}

console.log(`Wrote ${output}`);
