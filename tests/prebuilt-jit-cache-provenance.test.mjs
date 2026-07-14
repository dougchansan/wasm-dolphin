// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { encodePrebuiltCache } from "../src/prebuilt-jit-cache-format.js";
import {
  JIT_CACHE_ENTRY_KEY_SCHEMA,
  canonicalCoreFingerprint,
  canonicalWasmBlockKey,
} from "../src/jit-cache-identity.js";
import { writeCandidatePrebuiltCache } from "../tools/prebuilt-jit-cache-provenance.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fixture(root, { manifestCore, blobCore }) {
  const directoryCore = "a".repeat(64);
  const candidateDir = path.join(root, "build", "core-candidates", directoryCore);
  await mkdir(candidateDir, { recursive: true });
  const wasm = Buffer.from("candidate wasm");
  const actualCore = sha256(wasm);
  const resolvedDir = path.join(root, "build", "core-candidates", actualCore);
  await mkdir(path.dirname(resolvedDir), { recursive: true });
  await rm(candidateDir, { recursive: true, force: true });
  await mkdir(resolvedDir, { recursive: true });
  await writeFile(path.join(resolvedDir, "dolphin-core-upstream.wasm"), wasm);
  await writeFile(path.join(resolvedDir, "manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    coreId: `sha256:${manifestCore || actualCore}`,
    files: [{ name: "dolphin-core-upstream.wasm", sha256: actualCore }],
  }, null, 2)}\n`);
  const block = new Uint8Array([0, 97, 115, 109]);
  const key = await canonicalWasmBlockKey(block);
  const blob = encodePrebuiltCache({
    fingerprint: canonicalCoreFingerprint(blobCore || actualCore),
    entryKeySchema: JIT_CACHE_ENTRY_KEY_SCHEMA,
    entries: new Map([[key, block]]),
  });
  return {
    actualCore,
    blob,
    outPath: path.join(resolvedDir, "prebuilt-jit-cache.bin"),
    manifestPath: path.join(resolvedDir, "manifest.json"),
  };
}

test("candidate prebuilt export atomically refreshes a fingerprinted manifest entry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dolphin-prebuilt-provenance-"));
  try {
    const value = await fixture(root, {});
    const evidence = await writeCandidatePrebuiltCache({ root, outPath: value.outPath, blob: value.blob });
    const manifest = JSON.parse(await readFile(value.manifestPath, "utf8"));
    const entry = manifest.files.find((item) => item.name === "prebuilt-jit-cache.bin");
    assert.deepEqual(entry, {
      name: "prebuilt-jit-cache.bin",
      sha256: sha256(value.blob),
      bytes: value.blob.byteLength,
      fingerprint: canonicalCoreFingerprint(value.actualCore),
      entryKeySchema: JIT_CACHE_ENTRY_KEY_SCHEMA,
      entryCount: 1,
      entriesVerified: true,
    });
    assert.equal(evidence.sha256, entry.sha256);
    assert.deepEqual(new Uint8Array(await readFile(value.outPath)), value.blob);

    const replacementBlock = new Uint8Array([0, 97, 115, 109, 1]);
    const replacementKey = await canonicalWasmBlockKey(replacementBlock);
    const replacementBlob = encodePrebuiltCache({
      fingerprint: canonicalCoreFingerprint(value.actualCore),
      entryKeySchema: JIT_CACHE_ENTRY_KEY_SCHEMA,
      entries: new Map([[replacementKey, replacementBlock]]),
    });
    await writeCandidatePrebuiltCache({
      root,
      outPath: value.outPath,
      blob: replacementBlob,
    });
    const replacementManifest = JSON.parse(await readFile(value.manifestPath, "utf8"));
    const replacementEntries = replacementManifest.files.filter(
      (item) => item.name === "prebuilt-jit-cache.bin"
    );
    assert.equal(replacementEntries.length, 1);
    assert.equal(replacementEntries[0].sha256, sha256(replacementBlob));
    assert.deepEqual(new Uint8Array(await readFile(value.outPath)), replacementBlob);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("candidate prebuilt export fails closed before writing on manifest or fingerprint mismatch", async () => {
  for (const mismatch of ["manifest", "fingerprint"]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "dolphin-prebuilt-provenance-"));
    try {
      const value = await fixture(root, {
        manifestCore: mismatch === "manifest" ? "b".repeat(64) : undefined,
        blobCore: mismatch === "fingerprint" ? "c".repeat(64) : undefined,
      });
      await assert.rejects(
        writeCandidatePrebuiltCache({ root, outPath: value.outPath, blob: value.blob }),
        /manifest core|fingerprint/i
      );
      await assert.rejects(readFile(value.outPath), /ENOENT/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("candidate prebuilt evidence rejects a canonical-looking key for the wrong payload", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dolphin-prebuilt-provenance-"));
  try {
    const value = await fixture(root, {});
    const decoded = new Uint8Array(value.blob);
    decoded[decoded.length - 1] ^= 0xff;
    await assert.rejects(
      writeCandidatePrebuiltCache({ root, outPath: value.outPath, blob: decoded }),
      /entry key mismatch/
    );
    await assert.rejects(readFile(value.outPath), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
