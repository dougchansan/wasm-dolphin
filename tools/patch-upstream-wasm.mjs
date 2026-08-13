// Apply the wasm-dolphin patch set to the pinned upstream Dolphin tree.
//
// patches/dolphin-wasm/wasm-dolphin-full.patch is the authoritative build
// input: the complete delta from the pinned upstream revision to the source
// tree that produced the committed core .wasm. It is verified to apply
// cleanly to a pristine checkout of that revision.
//
// Two of Dolphin's own submodules also carry changes. A patch against the
// superproject cannot express those (a superproject diff only records the
// gitlink), so they are applied inside each submodule.
//
// patches/dolphin-wasm/historical/ holds the earlier hand-curated 0001-0009
// series. Those are kept for readability — each one documents a single
// browser-porting decision — but they are a subset of the full patch and are
// NOT applied. Do not re-add them to this pipeline; they would conflict.

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = process.cwd();
const dolphinDir = resolve(root, "vendor/dolphin");

const FULL_PATCH = resolve(root, "patches/dolphin-wasm/wasm-dolphin-full.patch");

const NESTED = [
  {
    submodule: "Externals/SFML/SFML",
    patch: resolve(root, "patches/dolphin-wasm/nested/sfml-emscripten-platform.patch")
  },
  {
    submodule: "Externals/xxhash/xxHash",
    patch: resolve(root, "patches/dolphin-wasm/nested/xxhash.patch")
  }
];

function apply(patch, cwd, label) {
  if (!existsSync(patch)) {
    console.error(`Missing patch: ${patch}`);
    process.exit(1);
  }
  if (!existsSync(cwd)) {
    console.error(`Missing tree: ${cwd}\nRun npm run fetch:dolphin first.`);
    process.exit(1);
  }

  const git = (args, stdio = "pipe") =>
    spawnSync("git", ["-C", cwd, "apply", "--unidiff-zero", ...args], {
      encoding: "utf8",
      stdio
    });

  if (git(["--check", patch]).status === 0) {
    const result = git([patch], "inherit");
    if (result.status !== 0) {
      process.exit(result.status || 1);
    }
    console.log(`applied       ${label}`);
    return;
  }

  if (git(["--reverse", "--check", patch]).status === 0) {
    console.log(`already applied ${label}`);
    return;
  }

  process.stderr.write(git(["--check", patch]).stderr || "");
  console.error(`unable to apply ${label}`);
  process.exit(1);
}

if (!existsSync(resolve(dolphinDir, ".git"))) {
  console.error("vendor/dolphin is missing. Run npm run fetch:dolphin first.");
  process.exit(1);
}

apply(FULL_PATCH, dolphinDir, "wasm-dolphin-full.patch");

for (const { submodule, patch } of NESTED) {
  apply(patch, resolve(dolphinDir, submodule), `${submodule}`);
}

console.log("\npatch set applied. Next: npm run configure:upstream");
