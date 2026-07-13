import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { compareCoreBuildInfo } from "../tools/compare-core-builds.mjs";
import { buildCandidateAbiManifest, wasmSectionInfo } from "../tools/core-build-info.mjs";
import { REQUIRED_WGPU_OWNERSHIP_TRACE_EXPORTS } from "../tools/dolphin-provenance.mjs";

test("WASM build evidence hashes individual sections", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "wasm-build-info-"));
  try {
    const wasmPath = path.join(directory, "tiny.wasm");
    writeFileSync(wasmPath, Buffer.from([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      0x0a, 0x01, 0x00,
      0x0b, 0x01, 0x00
    ]));
    const sections = wasmSectionInfo(wasmPath);
    assert.deepEqual(sections.map(({ id, size }) => ({ id, size })), [
      { id: 10, size: 1 },
      { id: 11, size: 1 }
    ]);
    assert.equal(sections[0].sha256.length, 64);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("candidate ABI manifest is bound to candidate artifacts and exports", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "wasm-dolphin-candidate-abi-"));
  try {
    const jsPath = path.join(directory, "dolphin-core-upstream.js");
    const wasmPath = path.join(directory, "dolphin-core-upstream.wasm");
    const normalizedGlue = 'Module["_ExistingExport"]=_ExistingExport;\nModule["_NewExport"]=_NewExport;\n';
    await writeFile(jsPath, normalizedGlue.replaceAll("\n", "\r\n"));
    await writeFile(wasmPath, Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
    const template = JSON.parse(await readFile(
      new URL("../provenance/dolphin-core-abi-v1.json", import.meta.url),
      "utf8"
    ));
    template.sourceOnlyExportsPendingRebuild = ["_NewExport", "_StillMissing"];

    const manifest = buildCandidateAbiManifest({ template, jsPath, wasmPath });

    assert.match(manifest.coreId, /^sha256:[0-9a-f]{64}$/);
    assert.notEqual(manifest.coreId, template.coreId);
    assert.deepEqual(manifest.moduleExports, ["_ExistingExport", "_NewExport"]);
    assert.deepEqual(manifest.sourceOnlyExportsPendingRebuild, [
      "_StillMissing",
      ...REQUIRED_WGPU_OWNERSHIP_TRACE_EXPORTS,
    ]);
    assert.equal(manifest.artifacts[0].path, "cores/dolphin/dolphin-core-upstream.js");
    assert.equal(manifest.artifacts[0].size, Buffer.byteLength(normalizedGlue));
    assert.equal(manifest.artifacts[1].path, "cores/dolphin/dolphin-core-upstream.wasm");
    assert.equal(manifest.artifacts[1].sha256, manifest.coreId.slice("sha256:".length));
    assert.ok(manifest.contractSources.length > 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
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
