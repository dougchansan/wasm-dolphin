import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { selectCargoStaticLibrary } from "../tools/cargo-staticlib.mjs";

test("Cargo output selects the reported archive even when the old filename remains", () => {
  const root = mkdtempSync(join(tmpdir(), "dolphin-cargo-artifact-"));
  try {
    const options = { manifestPath: join(root, "Cargo.toml"), targetName: "naga_spirv_wgsl" };
    const stale = join(root, "naga_spirv_wgsl.a");
    const built = join(root, "libnaga_spirv_wgsl.a");
    writeFileSync(stale, "old archive");
    writeFileSync(built, "current archive");
    const artifact = {
      reason: "compiler-artifact", manifest_path: options.manifestPath,
      package_id: "path+file:///naga#0.1.0",
      target: { name: options.targetName, crate_types: ["staticlib"] },
      filenames: [built], fresh: false,
    };
    const output = (messages) => [...messages, { reason: "build-finished", success: true }]
      .map((value) => JSON.stringify(value)).join("\n");
    for (const fresh of [false, true]) {
      const selected = selectCargoStaticLibrary(output([
        { ...artifact, manifest_path: join(root, "dependency/Cargo.toml"), filenames: [stale] },
        { ...artifact, fresh },
      ]), options);
      assert.equal(selected.path, built);
      assert.equal(selected.fresh, fresh);
    }
    assert.throws(() => selectCargoStaticLibrary(output([]), options), /exactly one.*found 0/);
    assert.throws(() => selectCargoStaticLibrary(output([
      { ...artifact, filenames: [stale, built] },
    ]), options), /exactly one.*found 2/);
    assert.throws(() => selectCargoStaticLibrary(output([
      { ...artifact, filenames: [join(root, "missing.a")] },
    ]), options), /static library is missing/);
    assert.throws(() => selectCargoStaticLibrary(JSON.stringify(artifact), options), /successful completed build/);
    assert.throws(() => selectCargoStaticLibrary([
      artifact, { reason: "build-finished", success: false },
    ].map(JSON.stringify).join("\n"), options), /successful completed build/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
