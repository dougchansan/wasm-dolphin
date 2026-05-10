import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = process.cwd();
const dolphinDir = resolve(root, "vendor/dolphin");
const patches = [
  resolve(root, "patches/dolphin-wasm/0001-browser-platform-build-gates.patch"),
  resolve(root, "patches/dolphin-wasm/0002-skip-large-dcbx-warmup-invalidations.patch"),
  resolve(root, "patches/dolphin-wasm/0003-disable-webgl-base-vertex.patch"),
  resolve(root, "patches/dolphin-wasm/0004-fix-ogltexture-mapbufferrange-invalidate.patch"),
  resolve(root, "patches/dolphin-wasm/0005-webgl-depth-range-and-xfb-duplicate.patch"),
  resolve(root, "patches/dolphin-wasm/0006-skip-sleepuntil-and-immediate-xfb.patch"),
  resolve(root, "patches/dolphin-wasm/0007-skip-dcbx-when-jit-inactive.patch"),
  resolve(root, "patches/dolphin-wasm/0008-fix-character-rendering-on-webgl2.patch")
];

function runGit(args, stdio = "pipe") {
  return spawnSync("git", ["-C", dolphinDir, ...args], {
    encoding: "utf8",
    stdio
  });
}

function runGitApply(args, stdio = "pipe") {
  return runGit(["apply", "--unidiff-zero", ...args], stdio);
}

if (!existsSync(resolve(dolphinDir, ".git"))) {
  console.error("vendor/dolphin is missing. Run npm run fetch:dolphin first.");
  process.exit(1);
}

for (const patch of patches) {
  if (!existsSync(patch)) {
    console.error(`Missing patch: ${patch}`);
    process.exit(1);
  }

  const check = runGitApply(["--check", patch]);
  if (check.status === 0) {
    const apply = runGitApply([patch], "inherit");
    if (apply.status !== 0) {
      process.exit(apply.status || 1);
    }
    console.log(`applied ${patch}`);
    continue;
  }

  const reverseCheck = runGitApply(["--reverse", "--check", patch]);
  if (reverseCheck.status === 0) {
    console.log(`already applied ${patch}`);
    continue;
  }

  process.stderr.write(check.stderr || "");
  process.stderr.write(reverseCheck.stderr || "");
  console.error(`unable to apply ${patch}`);
  process.exit(1);
}
