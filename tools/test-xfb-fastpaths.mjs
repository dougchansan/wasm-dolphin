// Copyright 2026
// SPDX-License-Identifier: GPL-2.0-or-later

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = resolve(root, "tools/xfb-fastpaths-parity.cpp");
const emxx = process.env.EMXX || join(homedir(), "emsdk/upstream/emscripten/em++.bat");

if (!existsSync(emxx)) {
  throw new Error(`Pinned Emscripten C++ compiler was not found at ${emxx}; set EMXX to override`);
}

const temporary = mkdtempSync(join(tmpdir(), "wasm-dolphin-xfb-fastpaths-"));
const output = join(temporary, "xfb-fastpaths-parity.js");

try {
  const compilerArgs = [
    source,
    "-std=c++20",
    "-O2",
    "-sENVIRONMENT=node",
    "-sEXIT_RUNTIME=1",
    "-o",
    output
  ];
  const pythonCompiler = emxx.replace(/\.bat$/i, ".py");
  if (pythonCompiler !== emxx && existsSync(pythonCompiler)) {
    run(process.env.PYTHON || "python", [pythonCompiler, ...compilerArgs]);
  } else {
    run(emxx, compilerArgs);
  }
  run(process.execPath, [output]);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32" && /\.(?:bat|cmd)$/i.test(command)
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}
