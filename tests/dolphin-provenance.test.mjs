import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertExactCommit,
  fetchPinnedDolphin,
  fileRecord,
  loadSourceLock,
  patchSeriesDigest,
  validateVendorSnapshotManifest,
  verifyCoreAbiManifest,
  verifyDolphinProvenance,
  verifyPatchSeries
} from "../tools/dolphin-provenance.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initializeRepository(directory) {
  mkdirSync(directory, { recursive: true });
  git(directory, "init", "--quiet");
  git(directory, "config", "user.email", "provenance-test@example.invalid");
  git(directory, "config", "user.name", "Provenance Test");
}

function commitFile(directory, name, contents, message) {
  writeFileSync(join(directory, name), contents);
  git(directory, "add", name);
  git(directory, "commit", "--quiet", "-m", message);
  return git(directory, "rev-parse", "HEAD");
}

function writeMinimalLock(root, { repository, commit }) {
  const patchPath = "patches/dolphin-wasm/test.patch";
  const absolutePatch = join(root, patchPath);
  mkdirSync(dirname(absolutePatch), { recursive: true });
  writeFileSync(absolutePatch, "diff --git a/a b/a\n");
  const patch = {
    order: 1,
    cwd: ".",
    path: patchPath,
    hashMode: "lf-normalized",
    ...fileRecord(patchPath, root, "lf-normalized")
  };
  const lock = {
    schemaVersion: 1,
    upstream: { repository, commit },
    repositories: { ".": { commit } },
    patches: [patch]
  };
  lock.patchSeriesSha256 = patchSeriesDigest(lock.patches);
  mkdirSync(join(root, "provenance"), { recursive: true });
  writeFileSync(join(root, "provenance/dolphin-source.lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
}

test("committed Dolphin provenance and ABI manifests verify", () => {
  const result = verifyDolphinProvenance(projectRoot);
  assert.equal(result.upstreamCommit, "e22551eae1c84a7e4d0b6a5c519ef4ed4ef69df1");
  assert.equal(result.patches.count, 8);
  assert.equal(result.vendorSnapshot.rootPaths, 87);
  assert.equal(result.vendorSnapshot.submodulePaths, 2);
  assert.equal(result.core.abiVersion, 1);
  assert.equal(result.core.memoryContract.jsGlue.initialPages, 24576);
  assert.equal(result.core.memoryContract.activePatchSeries.initialPages, 24576);
});

test("vendor snapshot manifest rejects changed per-path evidence", () => {
  const lock = loadSourceLock(projectRoot);
  const manifest = JSON.parse(
    readFileSync(join(projectRoot, "provenance/dolphin-vendor-snapshot-v1.json"), "utf8")
  );
  manifest.root.records[0].sha256 = "0".repeat(64);
  assert.throws(() => validateVendorSnapshotManifest(manifest, lock), /content digest mismatch/);
});

test("patch verification rejects changed content and ordering", () => {
  const lock = structuredClone(loadSourceLock(projectRoot));
  lock.patches[0].sha256 = "0".repeat(64);
  lock.patchSeriesSha256 = patchSeriesDigest(lock.patches);
  assert.throws(() => verifyPatchSeries(projectRoot, lock), /SHA-256 mismatch/);

  const reordered = structuredClone(loadSourceLock(projectRoot));
  reordered.patches[0].order = 2;
  assert.throws(() => verifyPatchSeries(projectRoot, reordered), /order must be contiguous/);
});

test("LF-normalized hashes are stable across Windows and Unix checkouts", () => {
  const root = mkdtempSync(join(tmpdir(), "dolphin-eol-"));
  writeFileSync(join(root, "unix.js"), "first\nsecond\n");
  writeFileSync(join(root, "windows.js"), "first\r\nsecond\r\n");
  const unix = fileRecord("unix.js", root, "lf-normalized");
  const windows = fileRecord("windows.js", root, "lf-normalized");
  assert.equal(windows.size, unix.size);
  assert.equal(windows.sha256, unix.sha256);
  assert.notEqual(fileRecord("windows.js", root).sha256, fileRecord("unix.js", root).sha256);
});

test("ABI verification rejects an artifact hash mismatch", () => {
  const root = mkdtempSync(join(tmpdir(), "dolphin-abi-"));
  const manifest = JSON.parse(readFileSync(join(projectRoot, "provenance/dolphin-core-abi-v1.json"), "utf8"));
  manifest.artifacts[1].sha256 = "0".repeat(64);
  const manifestPath = join(root, "tampered-abi.json");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => verifyCoreAbiManifest(projectRoot, manifestPath), /SHA-256 mismatch/);
});

test("pinned fetch ignores a moved default branch and checks out the locked commit", () => {
  const root = mkdtempSync(join(tmpdir(), "dolphin-fetch-"));
  const origin = join(root, "origin");
  initializeRepository(origin);
  const pinned = commitFile(origin, "source.txt", "pinned\n", "pinned");
  const moved = commitFile(origin, "source.txt", "moved\n", "moved");
  assert.notEqual(pinned, moved);

  const harness = join(root, "harness");
  mkdirSync(harness);
  writeMinimalLock(harness, { repository: origin, commit: pinned });
  const destination = join(harness, "vendor/dolphin");
  const result = fetchPinnedDolphin({
    root: harness,
    destination,
    repository: origin,
    updateSubmodules: false
  });
  assert.equal(result.commit, pinned);
  assert.equal(git(destination, "rev-parse", "HEAD"), pinned);
  assert.equal(readFileSync(join(destination, "source.txt"), "utf8").trim(), "pinned");
  assert.throws(() => assertExactCommit(pinned, moved), /commit mismatch/);
});
