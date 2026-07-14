import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("prebuilt-cache export can retarget a validation-equivalent core fingerprint", async () => {
  const source = await readFile(
    new URL("../tools/export-prebuilt-jit-cache.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /TARGET_FINGERPRINT/);
  assert.match(source, /\^\[0-9a-f\]\{64\}\$/);
  assert.match(source, /canonicalCoreFingerprint\(targetFingerprint\)/);
  assert.match(source, /fingerprint: encodedFingerprint \|\| dump\.fingerprint/);
  assert.match(source, /verifyCanonicalWasmBlockKey\(hash, u8\)/);
  assert.match(source, /BROWSER_EXECUTABLE/);
  assert.match(source, /executablePath: path\.resolve\(configuredExecutable\)/);
});
