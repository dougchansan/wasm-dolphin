import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = process.cwd();
const dolphinDir = resolve(root, "vendor/dolphin");
const patches = [resolve(root, "patches/dolphin-wasm/0001-browser-platform-build-gates.patch")];

function runGit(args, stdio = "pipe") {
  return spawnSync("git", ["-C", dolphinDir, ...args], {
    encoding: "utf8",
    stdio
  });
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

  const check = runGit(["apply", "--check", patch]);
  if (check.status === 0) {
    const apply = runGit(["apply", patch], "inherit");
    if (apply.status !== 0) {
      process.exit(apply.status || 1);
    }
    console.log(`applied ${patch}`);
    continue;
  }

  const reverseCheck = runGit(["apply", "--reverse", "--check", patch]);
  if (reverseCheck.status === 0) {
    console.log(`already applied ${patch}`);
    continue;
  }

  process.stderr.write(check.stderr || "");
  process.stderr.write(reverseCheck.stderr || "");
  console.error(`unable to apply ${patch}`);
  process.exit(1);
}
