import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = process.cwd();
const buildDir = resolve(process.env.DOLPHIN_WASM_BUILD_DIR ?? resolve(root, "build/dolphin-wasm"));
const appData = process.env.APPDATA ?? "";
const target = process.argv[2] ?? "discio";

function findCmake() {
  if (process.env.CMAKE && existsSync(process.env.CMAKE)) {
    return process.env.CMAKE;
  }

  const fallback = resolve(appData, "Python/Python312/Scripts/cmake.exe");
  return existsSync(fallback) ? fallback : "cmake";
}

if (!existsSync(resolve(buildDir, "CMakeCache.txt"))) {
  console.error("build/dolphin-wasm is not configured. Run npm run configure:upstream first.");
  process.exit(1);
}

const result = spawnSync(
  findCmake(),
  ["--build", buildDir, "--target", target, "--parallel", process.env.BUILD_PARALLELISM ?? "8"],
  { encoding: "utf8", stdio: "inherit" }
);

if (result.error || result.status !== 0) {
  process.exit(result.status || 1);
}
