import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("FastBranch attribution uses an explicit validated and recorded build toggle", async () => {
  const [configure, buildInfo] = await Promise.all([
    readFile(new URL("../tools/configure-upstream-wasm.mjs", import.meta.url), "utf8"),
    readFile(new URL("../tools/core-build-info.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(configure, /process\.env\.DOLPHIN_WEB_INLINE_FAST_BRANCH/);
  assert.match(configure, /\["0", "1"\]\.includes\(fastBranchInline\)/);
  assert.match(configure, /-DDOLPHIN_WEB_INLINE_FAST_BRANCH=\$\{fastBranchInline\}/);
  assert.match(configure, /fastBranchInline,/);
  assert.match(buildInfo, /fastBranchInline: configure\.fastBranchInline/);
});
