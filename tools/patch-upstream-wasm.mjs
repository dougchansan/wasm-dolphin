import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { applyPinnedPatches } from "./dolphin-provenance.mjs";

const root = process.cwd();
const dolphinDir = resolve(root, "vendor/dolphin");
const experimentalOverlays = [
  resolve(root, "patches/dolphin-wasm/experimental/0055-webgpu-partial-clear-region.patch")
];

function applyOverlay(patch) {
  if (!existsSync(patch))
    throw new Error(`Missing experimental patch: ${patch}`);

  const git = (args) =>
    spawnSync("git", ["-C", dolphinDir, "apply", "--unidiff-zero", ...args], {
      encoding: "utf8"
    });

  if (git(["--check", patch]).status === 0) {
    const applied = git([patch]);
    if (applied.status !== 0)
      throw new Error(applied.stderr || `Unable to apply ${patch}`);
    console.log(`applied experimental overlay ${patch}`);
    return;
  }

  if (git(["--reverse", "--check", patch]).status === 0) {
    console.log(`experimental overlay already applied ${patch}`);
    return;
  }

  const checked = git(["--check", patch]);
  throw new Error(checked.stderr || `Unable to apply experimental overlay ${patch}`);
}

try {
  const result = applyPinnedPatches();
  console.log(
    `${result.status} ${result.count} locked patches (${result.sha256}); ` +
    `verified result tree ${result.resultTree}`
  );

  // Keep this outside the locked reproducible series until the MKWii race-path
  // regression is validated on hardware. Once proven, fold it into the next
  // numbered snapshot patch and regenerate provenance instead of leaving an
  // untracked source delta here.
  for (const patch of experimentalOverlays)
    applyOverlay(patch);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
