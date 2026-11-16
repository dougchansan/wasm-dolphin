import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { compareCoreBuildInfo } from "../tools/compare-core-builds.mjs";
import { buildCandidateAbiManifest, buildToolchainRecord, verifyConfiguredNagaLibrary,
  wasmSectionInfo, writeCoreBuildInfo } from "../tools/core-build-info.mjs";
import { REQUIRED_CORE_RUNTIME_METHODS, REQUIRED_WGPU_OWNERSHIP_TRACE_EXPORTS } from "../tools/dolphin-provenance.mjs";
import { loadWasmToolchainLock, observeWasmToolchain, sha256File } from "../tools/wasm-toolchain.mjs";

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
    const normalizedGlue = 'Module["_ExistingExport"]=_ExistingExport;\nModule["_NewExport"]=_NewExport;\n' +
      [...REQUIRED_CORE_RUNTIME_METHODS, "WORKERFS"].map((name) => `Module["${name}"]=${name};\n`).join("");
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

function buildFixture() {
  const observed = {
    schemaVersion: 1,
    tools: { emcc: { path: "/sdk/emcc", sha256: "observed-emcc-hash", version: "actual-version-output" } },
  };
  const build = {
    source: { upstreamCommit: "a" },
    toolchain: { emscriptenVersion: "1", observed },
    configure: {
      nagaLibrarySha256: "naga", wasmCompileFlags: "-O3", cmakeCacheSha256: "cache",
      toolchainObserved: structuredClone(observed),
    },
    artifacts: {
      js: { sha256: "js" },
      wasm: { sha256: "wasm" },
      wasmSections: [
        { id: 10, size: 1, sha256: "code" },
        { id: 11, size: 1, sha256: "data" }
      ]
    }
  };
  return build;
}

test("core comparison requires exact source, observed tools, configure inputs, and artifacts", () => {
  const build = buildFixture();
  assert.equal(compareCoreBuildInfo(build, structuredClone(build)).reproducible, true);
  const changed = structuredClone(build);
  changed.artifacts.wasmSections[0].sha256 = "different";
  const report = compareCoreBuildInfo(build, changed);
  assert.equal(report.reproducible, false);
  assert.equal(report.codeSection.equal, false);
});

test("configuration divergence is reported even with identical toolchain declarations and outputs", () => {
  for (const field of ["nagaLibrarySha256", "wasmCompileFlags", "cmakeCacheSha256"]) {
    const build = buildFixture();
    const changed = structuredClone(build);
    changed.configure[field] = "different";
    const report = compareCoreBuildInfo(build, changed);
    assert.equal(report.declaredToolchainEqual, true);
    assert.equal(report.artifactParity, true);
    assert.equal(report.configure[field].equal, false);
    assert.equal(report.configurationEqual, false);
    assert.equal(report.reproducible, false);
  }
});

test("legacy lock-only records retain artifact parity without claiming observed toolchain parity", () => {
  const legacy = buildFixture();
  delete legacy.toolchain.observed;
  delete legacy.configure.toolchainObserved;
  const report = compareCoreBuildInfo(legacy, structuredClone(legacy));
  assert.equal(report.declaredToolchainEqual, true);
  assert.equal(report.observedToolchainEqual, null);
  assert.equal(report.artifactParity, true);
  assert.equal(report.reproducible, false);
});

test("equal locks cannot hide a changed observed executable", () => {
  const build = buildFixture();
  const changed = structuredClone(build);
  changed.toolchain.observed.tools.emcc.sha256 = "different-on-disk";
  const report = compareCoreBuildInfo(build, changed);
  assert.equal(report.declaredToolchainEqual, true);
  assert.equal(report.observedToolchainEqual, false);
  assert.equal(report.reproducible, false);
});

test("build records require and preserve observations of the selected tool files", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "wasm-tool-observation-"));
  try {
    const emcc = path.join(directory, "emcc.bat");
    writeFileSync(emcc, "first tool bytes");
    const options = { paths: { emcc }, versions: { emcc: "observed version" },
      emsdkRoot: directory, emsdkHead: "observed-sdk-commit" };
    const first = observeWasmToolchain(options);
    writeFileSync(emcc, "second tool bytes");
    const second = observeWasmToolchain(options);
    assert.notEqual(first.tools.emcc.sha256, second.tools.emcc.sha256);
    assert.equal(second.tools.emcc.path, emcc);
    assert.equal(second.tools.emcc.version, "observed version");
    const verification = { lock: loadWasmToolchainLock(), observed: second,
      hashes: { lock: "lock-hash", cargoLock: "cargo-lock-hash" } };
    assert.deepEqual(buildToolchainRecord(verification).observed, second);
    delete verification.observed;
    assert.throws(() => buildToolchainRecord(verification), /requires the observed result/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("build recording rejects a replaced, deleted, or unidentified configured Naga archive", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "wasm-naga-record-"));
  try {
    const archive = path.join(directory, "libnaga_spirv_wgsl.a");
    writeFileSync(archive, "archive selected during configure");
    const configure = { nagaLibrary: archive, nagaLibrarySha256: sha256File(archive) };
    assert.deepEqual(verifyConfiguredNagaLibrary(configure), {
      path: archive, sha256: configure.nagaLibrarySha256,
    });
    writeFileSync(path.join(directory, "wasm-dolphin-configure.json"), JSON.stringify(configure));
    const outputPath = path.join(directory, "core.build.json");
    const previousRecord = "preserved existing build record";
    writeFileSync(outputPath, previousRecord);
    const toolchain = { lock: loadWasmToolchainLock(),
      observed: { schemaVersion: 1, tools: { emcc: {} } },
      hashes: { lock: "lock-hash", cargoLock: "cargo-lock-hash" } };
    writeFileSync(archive, "different archive rebuilt after configure");
    assert.throws(() => writeCoreBuildInfo({ buildDir: directory, toolchain, outputPath }),
      /Naga archive changed.*Rerun npm run configure:upstream/);
    assert.equal(readFileSync(outputPath, "utf8"), previousRecord);
    rmSync(archive);
    assert.throws(() => writeCoreBuildInfo({ buildDir: directory, toolchain, outputPath }),
      /Cannot read configured Naga archive.*Rerun npm run configure:upstream/);
    assert.equal(readFileSync(outputPath, "utf8"), previousRecord);
    delete configure.nagaLibrary;
    writeFileSync(path.join(directory, "wasm-dolphin-configure.json"), JSON.stringify(configure));
    assert.throws(() => writeCoreBuildInfo({ buildDir: directory, toolchain, outputPath }),
      /lacks the selected Naga archive path\/hash.*Rerun npm run configure:upstream/);
    assert.equal(readFileSync(outputPath, "utf8"), previousRecord);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
