// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { decodePrebuiltCache } from "../src/prebuilt-jit-cache-format.js";
import {
  JIT_CACHE_ENTRY_KEY_SCHEMA,
  canonicalCoreFingerprint,
} from "../src/jit-cache-identity.js";

const CANDIDATE_PREBUILT_RE =
  /^build\/core-candidates\/([0-9a-f]{64})\/prebuilt-jit-cache\.bin$/i;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeFileAtomic(filePath, contents) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, contents, { flag: "wx" });
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export function candidatePrebuiltLocation(root, outPath) {
  const absoluteRoot = path.resolve(root);
  const absoluteOutPath = path.resolve(outPath);
  const relativePath = path.relative(absoluteRoot, absoluteOutPath).replaceAll("\\", "/");
  const match = CANDIDATE_PREBUILT_RE.exec(relativePath);
  if (!match) return null;
  const coreSha256 = match[1].toLowerCase();
  const directory = path.dirname(absoluteOutPath);
  return {
    coreSha256,
    directory,
    outPath: absoluteOutPath,
    manifestPath: path.join(directory, "manifest.json"),
    wasmPath: path.join(directory, "dolphin-core-upstream.wasm"),
  };
}

export function describePrebuiltJitCache(blob) {
  const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  const decoded = decodePrebuiltCache(bytes);
  for (const entry of decoded.entries) {
    const expectedKey = `${JIT_CACHE_ENTRY_KEY_SCHEMA}:${sha256(entry.bytes)}`;
    if (entry.hash !== expectedKey) {
      throw new Error(`Candidate prebuilt entry key mismatch: ${entry.hash || "missing"}`);
    }
  }
  return {
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
    fingerprint: decoded.fingerprint,
    entryKeySchema: decoded.entryKeySchema,
    entryCount: decoded.entries.length,
    entriesVerified: true,
  };
}

export async function writeCandidatePrebuiltCache({ root, outPath, blob }) {
  const location = candidatePrebuiltLocation(root, outPath);
  if (!location) {
    throw new Error("Candidate prebuilt output must be build/core-candidates/<sha>/prebuilt-jit-cache.bin");
  }

  const [manifestText, wasm] = await Promise.all([
    readFile(location.manifestPath, "utf8"),
    readFile(location.wasmPath),
  ]);
  const manifest = JSON.parse(manifestText);
  const actualWasmSha256 = sha256(wasm);
  const expectedFingerprint = canonicalCoreFingerprint(location.coreSha256);
  const evidence = describePrebuiltJitCache(blob);

  if (manifest?.schemaVersion !== 1) {
    throw new Error("Candidate manifest schemaVersion must be 1");
  }
  if (manifest?.coreId !== `sha256:${location.coreSha256}`) {
    throw new Error(
      `Candidate manifest core mismatch: directory=${location.coreSha256} manifest=${manifest?.coreId || "missing"}`
    );
  }
  if (actualWasmSha256 !== location.coreSha256) {
    throw new Error(
      `Candidate WASM hash mismatch: directory=${location.coreSha256} actual=${actualWasmSha256}`
    );
  }
  if (evidence.fingerprint !== expectedFingerprint) {
    throw new Error(
      `Candidate prebuilt fingerprint mismatch: expected=${expectedFingerprint} actual=${evidence.fingerprint || "missing"}`
    );
  }
  if (evidence.entryKeySchema !== JIT_CACHE_ENTRY_KEY_SCHEMA || evidence.entryCount <= 0) {
    throw new Error("Candidate prebuilt cache must contain canonical non-empty JIT entries");
  }

  const entry = {
    name: "prebuilt-jit-cache.bin",
    ...evidence,
  };
  const files = Array.isArray(manifest.files) ? [...manifest.files] : [];
  const existingIndex = files.findIndex((item) => item?.name === entry.name);
  if (existingIndex >= 0) files.splice(existingIndex, 1, entry);
  else files.push(entry);
  const updatedManifest = { ...manifest, files };

  // Each rename is atomic. A crash between the artifact and manifest renames
  // leaves a detectable hash mismatch rather than silently trusted evidence.
  await writeFileAtomic(location.outPath, blob);
  await writeFileAtomic(location.manifestPath, `${JSON.stringify(updatedManifest, null, 2)}\n`);
  return { path: location.outPath, ...evidence };
}
