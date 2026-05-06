import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
const appData = process.env.APPDATA ?? "";

const checks = [
  { command: "node", args: ["--version"], required: true },
  { command: "git", args: ["--version"], required: true },
  {
    command: "emcc",
    args: ["--version"],
    required: false,
    fallbacks: [resolve(home, "emsdk/upstream/emscripten/emcc.bat")]
  },
  {
    command: "emcmake",
    args: ["cmake", "--version"],
    required: false,
    fallbacks: [resolve(home, "emsdk/upstream/emscripten/emcmake.bat")],
    fileOnly: true
  },
  {
    command: "cmake",
    args: ["--version"],
    required: false,
    fallbacks: [resolve(appData, "Python/Python312/Scripts/cmake.exe")]
  }
];

let missingOptional = false;

function quoteShellArg(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}

function runTool(command, args) {
  const isWindowsBatch = process.platform === "win32" && /\.(bat|cmd)$/i.test(command);
  return spawnSync(isWindowsBatch ? [command, ...args].map(quoteShellArg).join(" ") : command, isWindowsBatch ? [] : args, {
    encoding: "utf8",
    shell: isWindowsBatch
  });
}

for (const check of checks) {
  const candidates = [check.command, ...(check.fallbacks ?? []).filter((candidate) => existsSync(candidate))];
  let result = null;
  let usedCommand = check.command;

  if (check.fileOnly && candidates.some((candidate) => candidate !== check.command && existsSync(candidate))) {
    usedCommand = candidates.find((candidate) => candidate !== check.command && existsSync(candidate));
    console.log(`ok   ${check.command}: available (${usedCommand})`);
    continue;
  }

  for (const candidate of candidates) {
    const candidateResult = runTool(candidate, check.args);

    if (candidateResult.status === 0) {
      result = candidateResult;
      usedCommand = candidate;
      break;
    }

    result = candidateResult;
  }

  if (result?.status === 0) {
    const firstLine = `${result.stdout}${result.stderr}`.trim().split(/\r?\n/)[0];
    console.log(`ok   ${check.command}: ${firstLine} (${usedCommand})`);
    continue;
  }

  const label = check.required ? "fail" : "warn";
  console.log(`${label} ${check.command}: not found`);

  if (check.required) {
    process.exitCode = 1;
  } else {
    missingOptional = true;
  }
}

if (missingOptional) {
  console.log("Install Emscripten SDK to build core/native into cores/dolphin/dolphin.js.");
}
