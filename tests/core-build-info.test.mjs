import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { compareCoreBuildInfo } from "../tools/compare-core-builds.mjs";
import { wasmSectionInfo } from "../tools/core-build-info.mjs";

test("WASM build evidence hashes individual sections", () => {
  const directory = mkdtempSync(join(tmpdir(), "wasm-build-info-"));
  try {
    const path = join(directory, "tiny.wasm");
    writeFileSync(path, Buffer.from([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      0x0a, 0x01, 0x00,
      0x0b, 0x01, 0x00
    ]));
    const sections = wasmSectionInfo(path);
    assert.deepEqual(sections.map(({ id, size }) => ({ id, size })), [
      { id: 10, size: 1 },
      { id: 11, size: 1 }
    ]);
    assert.equal(sections[0].sha256.length, 64);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("core comparison requires exact source, toolchain, glue, WASM, code, and data", () => {
  const build = {
    source: { upstreamCommit: "a" },
    toolchain: { emscriptenVersion: "1" },
    artifacts: {
      js: { sha256: "js" },
      wasm: { sha256: "wasm" },
      wasmSections: [
        { id: 10, size: 1, sha256: "code" },
        { id: 11, size: 1, sha256: "data" }
      ]
    }
  };
  assert.equal(compareCoreBuildInfo(build, structuredClone(build)).reproducible, true);
  const changed = structuredClone(build);
  changed.artifacts.wasmSections[0].sha256 = "different";
  const report = compareCoreBuildInfo(build, changed);
  assert.equal(report.reproducible, false);
  assert.equal(report.codeSection.equal, false);
});
