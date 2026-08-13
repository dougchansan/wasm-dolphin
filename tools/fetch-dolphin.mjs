// Fetch the upstream Dolphin tree at the pinned revision.
//
// vendor/dolphin is a git submodule pinned to DOLPHIN_PIN. Pinning is a
// licensing requirement, not a convenience: the distributed core .wasm is a
// derived work of GPLv2+ Dolphin, so the exact upstream revision plus the
// patch set in patches/dolphin-wasm/ must together reconstruct the source
// that produced it. Tracking a moving `master` cannot satisfy that.
//
// Two upstream dependencies are NOT reachable through submodules and are
// vendored here explicitly:
//
//   * glslang gitignores External/spirv-tools (see glslang/.gitignore), yet
//     the build needs it: Externals/glslang/CMakeLists.txt sets ENABLE_OPT=ON
//     so glslang compiles its SPIRV-Tools optimizer bridge, which canonicalises
//     raw glslang SPIR-V into the subset Naga's spv frontend accepts.
//   * SPIRV-Headers is spirv-tools' own external dependency.

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = process.cwd();
const destination = resolve(root, "vendor/dolphin");

const DOLPHIN_REPO = "https://github.com/dolphin-emu/dolphin.git";
const DOLPHIN_PIN = "e22551eae1c84a7e4d0b6a5c519ef4ed4ef69df1";

// Vendored into Externals/glslang/glslang/External/ at glslang's known-good
// revisions. Matches what built the committed core .wasm.
const GLSLANG_EXTERNAL = resolve(
  destination,
  "Externals/glslang/glslang/External"
);
const VENDORED = [
  {
    name: "spirv-tools",
    repo: "https://github.com/KhronosGroup/SPIRV-Tools.git",
    pin: "7f2d9ee926f98fc77a3ed1e1e0f113b8c9c49458",
    path: resolve(GLSLANG_EXTERNAL, "spirv-tools")
  },
  {
    name: "spirv-headers",
    repo: "https://github.com/KhronosGroup/SPIRV-Headers.git",
    pin: "01e0577914a75a2569c846778c2f93aa8e6feddd",
    path: resolve(GLSLANG_EXTERNAL, "spirv-tools/external/spirv-headers")
  }
];

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function capture(args, cwd) {
  return spawnSync("git", args, { cwd, encoding: "utf8" }).stdout?.trim() ?? "";
}

function fetchPinned(repo, pin, path, label) {
  if (!existsSync(resolve(path, ".git"))) {
    run("git", ["init", "-q", path]);
    run("git", ["remote", "add", "origin", repo], path);
  }

  if (capture(["rev-parse", "HEAD"], path) === pin) {
    console.log(`${label} already at ${pin.slice(0, 10)}`);
    return;
  }

  // Line endings must stay LF. The patch set is generated against an LF tree;
  // a CRLF checkout produces a source tree that differs from the one that
  // built the committed .wasm.
  run("git", ["config", "core.autocrlf", "false"], path);
  run("git", ["fetch", "--depth", "1", "origin", pin], path);
  run("git", ["checkout", "-q", "--force", pin], path);
  console.log(`${label} pinned at ${pin.slice(0, 10)}`);
}

// 1. Dolphin itself, via the submodule gitlink pinned in this repo's index.
if (!existsSync(resolve(destination, ".git"))) {
  run("git", ["submodule", "update", "--init", "--depth", "1", "vendor/dolphin"]);
}
fetchPinned(DOLPHIN_REPO, DOLPHIN_PIN, destination, "vendor/dolphin");

// 2. Dolphin's own submodules.
run("git", ["submodule", "update", "--init", "--recursive", "--depth", "1"], destination);

// 3. Dependencies upstream does not track.
for (const dep of VENDORED) {
  fetchPinned(dep.repo, dep.pin, dep.path, `  ${dep.name}`);
}

console.log("\nupstream tree ready. Next: npm run patch:upstream");
