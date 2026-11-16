import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import { resolveEmscriptenPython } from "../tools/wasm-toolchain.mjs";

test("Emscripten Python accepts an explicit file or configured PATH command and keeps the launcher default", () => {
  const directory = mkdtempSync(join(tmpdir(), "wasm-python-launcher-"));
  try {
    const executable = join(directory, "python.exe");
    writeFileSync(executable, "Python executable fixture");
    assert.equal(resolveEmscriptenPython(executable, () => assert.fail("explicit file must not search PATH")),
      executable);
    for (const configured of ["python", "python3", ""]) {
      const requested = [];
      const selected = resolveEmscriptenPython(configured, (command) => {
        requested.push(command);
        return executable;
      });
      assert.deepEqual(requested, [configured || "python"]);
      assert.equal(selected, executable);
      assert.ok(isAbsolute(selected));
    }
    const requested = [];
    assert.throws(() => resolveEmscriptenPython("missing-python", (command) => {
      requested.push(command);
      return null;
    }), /Could not observe.*missing-python/);
    assert.deepEqual(requested, ["missing-python"], "do not silently substitute the default interpreter");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
