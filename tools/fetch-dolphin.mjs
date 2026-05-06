import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const destination = resolve(process.cwd(), "vendor/dolphin");
const repo = "https://github.com/dolphin-emu/dolphin.git";

function run(command, args, cwd = process.cwd()) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: "inherit"
  });

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

if (!existsSync(destination)) {
  run("git", ["clone", "--filter=blob:none", "--depth", "1", repo, destination]);
} else {
  run("git", ["fetch", "--depth", "1", "origin", "master"], destination);
  run("git", ["checkout", "FETCH_HEAD"], destination);
}

run("git", ["submodule", "update", "--init", "--recursive", "--depth", "1"], destination);
