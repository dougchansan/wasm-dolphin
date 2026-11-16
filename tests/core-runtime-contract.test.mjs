import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  inspectCoreRuntimeContract,
  inspectRuntimeMethods,
  REQUIRED_CORE_RUNTIME_METHODS,
} from "../tools/dolphin-provenance.mjs";

const runtimeGlue = () => REQUIRED_CORE_RUNTIME_METHODS.map((name) => `Module["${name}"]=${name};`).join("\n");

test("WORKERFS is reachable through either historical registry or current Module export", () => {
  const oldCore = inspectCoreRuntimeContract(`${runtimeGlue()} FS.filesystems={MEMFS,WORKERFS};`);
  assert.deepEqual(oldCore.filesystemRegistry, ["MEMFS", "WORKERFS"]);
  assert.deepEqual(oldCore.filesystems, [{ name: "WORKERFS", via: ["FS.filesystems"] }]);
  const currentCore = inspectCoreRuntimeContract(
    `${runtimeGlue()} FS.filesystems = { MEMFS }; Module['WORKERFS'] = WORKERFS;`
  );
  assert.deepEqual(currentCore.filesystems, [{ name: "WORKERFS", via: ["Module"] }]);
  assert.throws(() => inspectCoreRuntimeContract(`${runtimeGlue()} FS.filesystems={MEMFS};`),
    /required filesystem WORKERFS/);
});

test("frozen host requirements cannot be removed together with patch export expectations", () => {
  const root = mkdtempSync(join(tmpdir(), "dolphin-runtime-contract-"));
  try {
    mkdirSync(join(root, "provenance"));
    writeFileSync(join(root, "exports.patch"), "-sEXPORTED_RUNTIME_METHODS=['FS']");
    writeFileSync(join(root, "provenance/dolphin-source.lock.json"), JSON.stringify({
      patches: [{ cwd: ".", path: "exports.patch" }],
    }));
    assert.throws(() => inspectRuntimeMethods(root, `${runtimeGlue()} FS.filesystems={MEMFS};`),
      /required filesystem WORKERFS/);
    for (const method of REQUIRED_CORE_RUNTIME_METHODS) {
      const glue = runtimeGlue().replace(`Module["${method}"]=${method};`, "");
      assert.throws(() => inspectRuntimeMethods(root, `${glue} Module.WORKERFS=WORKERFS;`),
        new RegExp(`required runtime method ${method}`));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ABI updater refuses a WORKERFS regression before rewriting its manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "dolphin-runtime-update-"));
  try {
    mkdirSync(join(root, "provenance"));
    mkdirSync(join(root, "cores/dolphin"), { recursive: true });
    const manifest = JSON.stringify({ artifacts: [
      { path: "cores/dolphin/dolphin-core-upstream.js" },
      { path: "cores/dolphin/dolphin-core-upstream.wasm" },
    ] });
    const manifestPath = join(root, "provenance/dolphin-core-abi-v1.json");
    writeFileSync(manifestPath, manifest);
    writeFileSync(join(root, "provenance/dolphin-source.lock.json"),
      readFileSync(new URL("../provenance/dolphin-source.lock.json", import.meta.url)));
    writeFileSync(join(root, "cores/dolphin/dolphin-core-upstream.js"), `${runtimeGlue()} FS.filesystems={MEMFS};`);
    writeFileSync(join(root, "cores/dolphin/dolphin-core-upstream.wasm"), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
    const result = spawnSync(process.execPath,
      [fileURLToPath(new URL("../tools/update-core-abi.mjs", import.meta.url)), "--write"],
      { cwd: root, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /required filesystem WORKERFS/);
    assert.equal(readFileSync(manifestPath, "utf8"), manifest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the committed glue satisfies the independent host runtime contract", () => {
  const glue = readFileSync(new URL("../cores/dolphin/dolphin-core-upstream.js", import.meta.url), "utf8");
  const contract = inspectCoreRuntimeContract(glue);
  assert.ok(contract.filesystems.some(({ name }) => name === "WORKERFS"));
});
