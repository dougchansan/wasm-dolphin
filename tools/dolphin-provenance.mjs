import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  statSync
} from "node:fs";
import { spawnSync } from "node:child_process";
import { relative, resolve, sep } from "node:path";

export const SOURCE_LOCK_PATH = "provenance/dolphin-source.lock.json";
export const CORE_ABI_PATH = "provenance/dolphin-core-abi-v1.json";
export const VENDOR_SNAPSHOT_PATH = "provenance/dolphin-vendor-snapshot-v1.json";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function normalizedPath(path) {
  return path.split(sep).join("/");
}

export function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256File(path) {
  return sha256Bytes(readFileSync(path));
}

function normalizedFileBytes(path, hashMode = "raw") {
  const bytes = readFileSync(path);
  if (hashMode === "raw") {
    return bytes;
  }
  invariant(hashMode === "lf-normalized", `Unsupported file hash mode: ${hashMode}`);
  return Buffer.from(bytes.toString("utf8").replaceAll("\r\n", "\n"));
}

export function fileRecord(path, root = process.cwd(), hashMode = "raw") {
  const absolute = resolve(root, path);
  const stats = statSync(absolute);
  invariant(stats.isFile(), `Expected a regular file: ${path}`);
  const bytes = normalizedFileBytes(absolute, hashMode);
  return {
    path: normalizedPath(relative(root, absolute)),
    ...(hashMode === "raw" ? {} : { hashMode }),
    size: bytes.length,
    sha256: sha256Bytes(bytes)
  };
}

export function verifyFileRecord(root, record, label = record?.path ?? "file") {
  invariant(record && typeof record === "object", `Invalid ${label} record`);
  invariant(typeof record.path === "string" && record.path.length > 0, `Invalid ${label} path`);
  invariant(record.hashMode === undefined || record.hashMode === "raw" || record.hashMode === "lf-normalized",
    `Invalid ${label} hash mode`);
  invariant(Number.isSafeInteger(record.size) && record.size >= 0, `Invalid ${label} size`);
  invariant(SHA256_PATTERN.test(record.sha256), `Invalid ${label} SHA-256`);

  const absolute = resolve(root, record.path);
  invariant(existsSync(absolute), `Missing ${label}: ${record.path}`);
  const actual = fileRecord(record.path, root, record.hashMode ?? "raw");
  invariant(
    actual.size === record.size,
    `${label} size mismatch for ${record.path}: expected ${record.size}, got ${actual.size}`
  );
  invariant(
    actual.sha256 === record.sha256,
    `${label} SHA-256 mismatch for ${record.path}: expected ${record.sha256}, got ${actual.sha256}`
  );
  return actual;
}

export function patchSeriesDigest(patches) {
  const payload = patches
    .map((patch) =>
      `${patch.order}\0${patch.cwd ?? "."}\0${patch.path}\0${patch.hashMode ?? "raw"}\0` +
      `${patch.sha256}\0${patch.size}\n`)
    .join("");
  return sha256Bytes(payload);
}

export function validateSourceLock(lock) {
  invariant(lock?.schemaVersion === 1, "Unsupported Dolphin source lock schema");
  invariant(typeof lock.upstream?.repository === "string", "Missing upstream repository");
  invariant(GIT_SHA_PATTERN.test(lock.upstream?.commit ?? ""), "Invalid pinned upstream commit");
  invariant(lock.repositories && typeof lock.repositories === "object", "Missing patch repository map");
  for (const [cwd, repository] of Object.entries(lock.repositories)) {
    invariant(cwd === "." || (!cwd.startsWith("/") && !cwd.includes("..") && !cwd.includes("\\")),
      `Invalid patch repository cwd: ${cwd}`);
    invariant(GIT_SHA_PATTERN.test(repository?.commit ?? ""), `Invalid base commit for ${cwd}`);
  }
  invariant(lock.repositories["."]?.commit === lock.upstream.commit,
    "Root patch repository must use the pinned upstream commit");
  invariant(Array.isArray(lock.patches) && lock.patches.length > 0, "Patch lock is empty");

  const paths = new Set();
  for (const [index, patch] of lock.patches.entries()) {
    invariant(patch.order === index + 1, `Patch order must be contiguous at index ${index}`);
    invariant(typeof patch.path === "string" && /^patches\/dolphin-wasm\/.*\.patch$/.test(patch.path) &&
      !patch.path.includes("..") && !patch.path.includes("\\"),
      `Invalid patch path at order ${patch.order}`);
    invariant(typeof patch.cwd === "string" && lock.repositories[patch.cwd],
      `Unknown patch repository cwd at order ${patch.order}: ${patch.cwd}`);
    invariant(patch.hashMode === "raw" || patch.hashMode === "lf-normalized",
      `Invalid patch hash mode: ${patch.path}`);
    invariant(!paths.has(patch.path), `Duplicate patch path: ${patch.path}`);
    invariant(Number.isSafeInteger(patch.size) && patch.size > 0, `Invalid patch size: ${patch.path}`);
    invariant(SHA256_PATTERN.test(patch.sha256), `Invalid patch SHA-256: ${patch.path}`);
    paths.add(patch.path);
  }

  invariant(SHA256_PATTERN.test(lock.patchSeriesSha256 ?? ""), "Invalid patch-series SHA-256");
  invariant(
    patchSeriesDigest(lock.patches) === lock.patchSeriesSha256,
    "Patch-series SHA-256 does not match the ordered lock entries"
  );
  return lock;
}

export function loadSourceLock(root = process.cwd(), lockPath = SOURCE_LOCK_PATH) {
  const absolute = resolve(root, lockPath);
  invariant(existsSync(absolute), `Missing Dolphin source lock: ${lockPath}`);
  return validateSourceLock(JSON.parse(readFileSync(absolute, "utf8")));
}

export function verifyPatchSeries(root = process.cwd(), lock = loadSourceLock(root)) {
  validateSourceLock(lock);
  for (const patch of lock.patches) {
    verifyFileRecord(root, patch, `patch ${patch.order}`);
  }

  return {
    count: lock.patches.length,
    sha256: lock.patchSeriesSha256
  };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? process.cwd(),
    encoding: "utf8",
    stdio: options.stdio ?? "pipe"
  });
  if (result.error || result.status !== 0) {
    const detail = [result.stderr, result.stdout, result.error?.message].filter(Boolean).join("\n").trim();
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `:\n${detail}` : ""}`);
  }
  return result;
}

function git(cwd, args, options = {}) {
  return run("git", args, { ...options, cwd });
}

function gitText(cwd, args) {
  return git(cwd, args).stdout.trim();
}

export function assertExactCommit(expected, actual, label = "Dolphin checkout") {
  invariant(GIT_SHA_PATTERN.test(expected ?? ""), `Invalid expected commit for ${label}`);
  invariant(
    actual === expected,
    `${label} commit mismatch: expected ${expected}, got ${actual || "<missing>"}`
  );
}

export function verifyDolphinCheckout(dolphinDir, lock) {
  validateSourceLock(lock);
  invariant(existsSync(resolve(dolphinDir, ".git")), `Not a Git checkout: ${dolphinDir}`);
  const head = gitText(dolphinDir, ["rev-parse", "HEAD"]);
  assertExactCommit(lock.upstream.commit, head);
  const objectType = gitText(dolphinDir, ["cat-file", "-t", lock.upstream.commit]);
  invariant(objectType === "commit", `Pinned upstream object is ${objectType}, not a commit`);
  return head;
}

export function verifyPatchRepositories(dolphinDir, lock) {
  validateSourceLock(lock);
  for (const [cwd, repository] of Object.entries(lock.repositories)) {
    const directory = cwd === "." ? dolphinDir : resolve(dolphinDir, cwd);
    invariant(existsSync(resolve(directory, ".git")), `Missing patch repository checkout: ${cwd}`);
    const head = gitText(directory, ["rev-parse", "HEAD"]);
    assertExactCommit(repository.commit, head, `Patch repository ${cwd}`);
  }
}

function checkoutIsDirty(dolphinDir) {
  return gitText(dolphinDir, ["status", "--porcelain=v1", "-uno"]).length > 0;
}

export function fetchPinnedDolphin({
  root = process.cwd(),
  destination = resolve(root, "vendor/dolphin"),
  repository,
  updateSubmodules = true
} = {}) {
  const lock = loadSourceLock(root);
  const source = repository ?? lock.upstream.repository;
  const created = !existsSync(destination);

  if (created) {
    run("git", ["clone", "--filter=blob:none", "--no-checkout", source, destination], { stdio: "inherit" });
  } else {
    invariant(existsSync(resolve(destination, ".git")), `${destination} exists but is not a Git checkout`);
    if (!repository) {
      const origin = gitText(destination, ["remote", "get-url", "origin"]);
      invariant(origin === lock.upstream.repository,
        `Dolphin origin mismatch: expected ${lock.upstream.repository}, got ${origin}`);
    }
  }

  const currentHead = gitText(destination, ["rev-parse", "--verify", "HEAD"]);
  if (created || currentHead !== lock.upstream.commit) {
    invariant(created || !checkoutIsDirty(destination),
      `Refusing to replace dirty Dolphin checkout at ${destination}`);
    git(destination, ["fetch", "--depth", "1", "origin", lock.upstream.commit], { stdio: "inherit" });
    const fetched = gitText(destination, ["rev-parse", "FETCH_HEAD^{commit}"]);
    assertExactCommit(lock.upstream.commit, fetched, "Fetched Dolphin object");
  }

  // This is safe for an already-patched tree because it does not change the
  // selected commit; it only prevents a local branch name from becoming an
  // accidental moving input on a later invocation.
  git(destination, ["checkout", "--detach", lock.upstream.commit], { stdio: "inherit" });
  verifyDolphinCheckout(destination, lock);
  if (updateSubmodules) {
    git(destination, ["submodule", "update", "--init", "--recursive", "--depth", "1"], { stdio: "inherit" });
    verifyPatchRepositories(destination, lock);
  }
  return { destination, commit: lock.upstream.commit };
}

export function applyPinnedPatches({
  root = process.cwd(),
  dolphinDir = resolve(root, "vendor/dolphin")
} = {}) {
  const lock = loadSourceLock(root);
  verifyPatchSeries(root, lock);
  verifyDolphinCheckout(dolphinDir, lock);
  verifyPatchRepositories(dolphinDir, lock);

  const groups = [];
  for (const patch of lock.patches) {
    const previous = groups.at(-1);
    if (previous?.cwd === patch.cwd) {
      previous.paths.push(resolve(root, patch.path));
    } else {
      invariant(!groups.some((group) => group.cwd === patch.cwd),
        `Patch repository ${patch.cwd} appears in non-contiguous groups`);
      groups.push({ cwd: patch.cwd, paths: [resolve(root, patch.path)] });
    }
  }

  const decisions = [];
  for (const group of groups) {
    const directory = group.cwd === "." ? dolphinDir : resolve(dolphinDir, group.cwd);
    const check = spawnSync("git", ["-C", directory, "apply", "--unidiff-zero", "--check", ...group.paths], {
      encoding: "utf8",
      stdio: "pipe"
    });
    if (check.status === 0) {
      decisions.push({ ...group, directory, status: "apply" });
      continue;
    }
    const reverse = spawnSync(
      "git",
      ["-C", directory, "apply", "--unidiff-zero", "--reverse", "--check", ...group.paths],
      { encoding: "utf8", stdio: "pipe" }
    );
    if (reverse.status === 0) {
      decisions.push({ ...group, directory, status: "already-applied" });
      continue;
    }
    const detail = [check.stderr, reverse.stderr].filter(Boolean).join("\n").trim();
    throw new Error(
      `Locked patch group for ${group.cwd} is neither wholly applicable nor wholly applied` +
      `${detail ? `:\n${detail}` : ""}`
    );
  }

  for (const decision of decisions) {
    if (decision.status === "apply") {
      git(decision.directory, ["apply", "--unidiff-zero", ...decision.paths], { stdio: "inherit" });
    }
  }
  const status = decisions.every((decision) => decision.status === "already-applied")
    ? "already-applied"
    : "applied";
  verifyVendorSnapshotCheckout(dolphinDir, root);
  return { status, count: lock.patches.length, sha256: lock.patchSeriesSha256 };
}

function validateSnapshotRecord(record, label) {
  invariant(record && typeof record === "object", `Invalid ${label}`);
  invariant(typeof record.path === "string" && record.path.length > 0 &&
    !record.path.startsWith("/") && !record.path.includes("..") && !record.path.includes("\\"),
  `Invalid ${label} path`);
  invariant(record.status === "A" || record.status === "M", `Invalid ${label} status`);
  invariant(/^\d{6}$/.test(record.mode), `Invalid ${label} mode`);
  invariant(record.baseBlob === null || GIT_SHA_PATTERN.test(record.baseBlob), `Invalid ${label} base blob`);
  invariant(GIT_SHA_PATTERN.test(record.resultBlob ?? ""), `Invalid ${label} result blob`);
  invariant(Number.isSafeInteger(record.size) && record.size >= 0, `Invalid ${label} size`);
  invariant(SHA256_PATTERN.test(record.sha256 ?? ""), `Invalid ${label} SHA-256`);
}

export function validateVendorSnapshotManifest(manifest, lock) {
  invariant(manifest?.schemaVersion === 1, "Unsupported vendor snapshot schema");
  invariant(manifest.normalization === "git-blob-lf", "Unsupported vendor snapshot normalization");
  invariant(manifest.root?.baseCommit === lock.upstream.commit,
    "Vendor snapshot root base does not match the source lock");
  invariant(GIT_SHA_PATTERN.test(manifest.root?.snapshotCommit ?? ""), "Invalid snapshot commit");
  invariant(GIT_SHA_PATTERN.test(manifest.root?.resultTree ?? ""), "Invalid snapshot root tree");
  invariant(Array.isArray(manifest.root?.records), "Missing vendor snapshot root records");
  invariant(manifest.root.records.length === manifest.root.changedPathCount,
    "Vendor snapshot changed-path count mismatch");

  const rootPaths = new Set();
  for (const [index, record] of manifest.root.records.entries()) {
    validateSnapshotRecord(record, `root snapshot record ${index}`);
    invariant(!rootPaths.has(record.path), `Duplicate root snapshot path: ${record.path}`);
    rootPaths.add(record.path);
  }

  invariant(Array.isArray(manifest.submodules), "Missing vendor snapshot submodules");
  const submoduleCwds = new Set();
  for (const submodule of manifest.submodules) {
    invariant(lock.repositories[submodule.cwd], `Unknown snapshot submodule: ${submodule.cwd}`);
    invariant(submodule.baseCommit === lock.repositories[submodule.cwd].commit,
      `Snapshot submodule base mismatch: ${submodule.cwd}`);
    invariant(GIT_SHA_PATTERN.test(submodule.resultTree ?? ""),
      `Invalid snapshot submodule tree: ${submodule.cwd}`);
    invariant(!submoduleCwds.has(submodule.cwd), `Duplicate snapshot submodule: ${submodule.cwd}`);
    submoduleCwds.add(submodule.cwd);
    invariant(Array.isArray(submodule.records) && submodule.records.length > 0,
      `Missing snapshot records for ${submodule.cwd}`);
    const paths = new Set();
    for (const [index, record] of submodule.records.entries()) {
      validateSnapshotRecord(record, `${submodule.cwd} snapshot record ${index}`);
      invariant(!paths.has(record.path), `Duplicate ${submodule.cwd} snapshot path: ${record.path}`);
      paths.add(record.path);
    }
  }
  const expectedSubmodules = Object.keys(lock.repositories).filter((cwd) => cwd !== ".").sort();
  invariant(JSON.stringify([...submoduleCwds].sort()) === JSON.stringify(expectedSubmodules),
    "Vendor snapshot submodule inventory does not match the source lock");

  invariant(SHA256_PATTERN.test(manifest.contentSha256 ?? ""), "Invalid vendor snapshot content digest");
  const content = JSON.stringify({ root: manifest.root, submodules: manifest.submodules });
  invariant(sha256Bytes(content) === manifest.contentSha256, "Vendor snapshot content digest mismatch");
  return manifest;
}

export function loadVendorSnapshotManifest(
  root = process.cwd(),
  lock = loadSourceLock(root),
  manifestPath = VENDOR_SNAPSHOT_PATH
) {
  const absolute = resolve(root, manifestPath);
  invariant(existsSync(absolute), `Missing vendor snapshot manifest: ${manifestPath}`);
  return validateVendorSnapshotManifest(JSON.parse(readFileSync(absolute, "utf8")), lock);
}

export function verifyVendorSnapshotCheckout(dolphinDir, root = process.cwd()) {
  const lock = loadSourceLock(root);
  const manifest = loadVendorSnapshotManifest(root, lock);
  const verifyRecords = (directory, records, label) => {
    for (const record of records) {
      const actual = fileRecord(record.path, directory, "lf-normalized");
      invariant(actual.size === record.size,
        `${label} snapshot size mismatch for ${record.path}: expected ${record.size}, got ${actual.size}`);
      invariant(actual.sha256 === record.sha256,
        `${label} snapshot SHA-256 mismatch for ${record.path}`);
    }
  };
  verifyRecords(dolphinDir, manifest.root.records, "root");
  for (const submodule of manifest.submodules) {
    verifyRecords(resolve(dolphinDir, submodule.cwd), submodule.records, submodule.cwd);
  }
  return {
    rootPaths: manifest.root.records.length,
    submodulePaths: manifest.submodules.reduce((sum, item) => sum + item.records.length, 0),
    resultTree: manifest.root.resultTree
  };
}

function readUleb(bytes, cursor) {
  let value = 0;
  let shift = 0;
  for (;;) {
    invariant(cursor.offset < bytes.length, "Unexpected end of WASM while reading ULEB128");
    const byte = bytes[cursor.offset++];
    value += (byte & 0x7f) * (2 ** shift);
    if ((byte & 0x80) === 0) {
      return value;
    }
    shift += 7;
    invariant(shift <= 49, "WASM ULEB128 exceeds safe integer range");
  }
}

function readName(bytes, cursor) {
  const length = readUleb(bytes, cursor);
  const end = cursor.offset + length;
  invariant(end <= bytes.length, "Unexpected end of WASM name");
  const value = new TextDecoder().decode(bytes.subarray(cursor.offset, end));
  cursor.offset = end;
  return value;
}

function readLimits(bytes, cursor) {
  const flags = readUleb(bytes, cursor);
  const minimum = readUleb(bytes, cursor);
  const maximum = (flags & 1) !== 0 ? readUleb(bytes, cursor) : null;
  return {
    flags,
    minimum,
    maximum,
    shared: (flags & 2) !== 0,
    memory64: (flags & 4) !== 0
  };
}

export function parseWasmMemoryImports(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  invariant(data.length >= 8 && data[0] === 0x00 && data[1] === 0x61 && data[2] === 0x73 && data[3] === 0x6d,
    "Not a WebAssembly binary");
  const cursor = { offset: 8 };
  const memories = [];

  while (cursor.offset < data.length) {
    const sectionId = data[cursor.offset++];
    const sectionSize = readUleb(data, cursor);
    const sectionEnd = cursor.offset + sectionSize;
    invariant(sectionEnd <= data.length, "WASM section exceeds file size");
    if (sectionId !== 2) {
      cursor.offset = sectionEnd;
      continue;
    }

    const count = readUleb(data, cursor);
    for (let index = 0; index < count; index += 1) {
      const module = readName(data, cursor);
      const name = readName(data, cursor);
      const kind = data[cursor.offset++];
      if (kind === 0) {
        readUleb(data, cursor);
      } else if (kind === 1) {
        cursor.offset += 1;
        readLimits(data, cursor);
      } else if (kind === 2) {
        memories.push({ module, name, ...readLimits(data, cursor) });
      } else if (kind === 3) {
        cursor.offset += 2;
      } else if (kind === 4) {
        readUleb(data, cursor);
        readUleb(data, cursor);
      } else {
        throw new Error(`Unknown WASM import kind: ${kind}`);
      }
    }
    invariant(cursor.offset === sectionEnd, "WASM import parser did not consume the section exactly");
    return memories;
  }
  return memories;
}

export function publicModuleExports(glueSource) {
  const names = new Set();
  for (const match of glueSource.matchAll(/Module\["(_[A-Za-z0-9_]+)"\]/g)) {
    names.add(match[1]);
  }
  return [...names].sort();
}

export function inspectMemoryContract(root = process.cwd()) {
  const glue = readFileSync(resolve(root, "cores/dolphin/dolphin-core-upstream.js"), "utf8");
  const wrapper = readFileSync(resolve(root, "core/upstream/dolphin_web_core.cpp"), "utf8");
  const lock = loadSourceLock(root);
  const activePatchText = lock.patches
    .filter((entry) => entry.cwd === ".")
    .map((entry) => readFileSync(resolve(root, entry.path), "utf8"))
    .join("\n");
  const wasm = readFileSync(resolve(root, "cores/dolphin/dolphin-core-upstream.wasm"));
  const jsMatch = glue.match(/var INITIAL_MEMORY=Module\["INITIAL_MEMORY"\]\|\|(\d+)/);
  invariant(jsMatch, "Could not discover INITIAL_MEMORY in the generated JS glue");
  const wrapperPages = [...wrapper.matchAll(/EmitU32Leb\(imports,\s*(\d+)\);/g)]
    .map((match) => Number(match[1]))
    .filter((value) => value >= 16384);
  invariant(wrapperPages.length > 0, "Could not discover dynamic-JIT memory pages in the wrapper");
  const patchMatches = [...activePatchText.matchAll(/-sINITIAL_MEMORY=(\d+)/g)]
    .map((match) => Number(match[1]));
  const patchMemoryBytes = [...new Set(patchMatches)];
  invariant(patchMemoryBytes.length === 1, "Active patch series must declare exactly one INITIAL_MEMORY value");
  return {
    wasmPageBytes: 65536,
    jsGlue: {
      initialMemoryBytes: Number(jsMatch[1]),
      initialPages: Number(jsMatch[1]) / 65536
    },
    wasmImports: parseWasmMemoryImports(wasm),
    wrapperDynamicJitPages: [...new Set(wrapperPages)].sort((a, b) => a - b),
    activePatchSeries: {
      initialMemoryBytes: patchMemoryBytes[0],
      initialPages: patchMemoryBytes[0] / 65536
    }
  };
}

export function verifyCoreAbiManifest(root = process.cwd(), manifestPath = CORE_ABI_PATH) {
  const absolute = resolve(root, manifestPath);
  invariant(existsSync(absolute), `Missing core ABI manifest: ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(absolute, "utf8"));
  invariant(manifest.schemaVersion === 1, "Unsupported core manifest schema");
  invariant(manifest.abiVersion === 1, "Unsupported host/core ABI version");
  invariant(Array.isArray(manifest.artifacts) && manifest.artifacts.length === 2,
    "Core ABI manifest must contain the JS and WASM artifacts");
  for (const artifact of manifest.artifacts) {
    verifyFileRecord(root, artifact, `core artifact ${artifact.path}`);
  }
  for (const source of manifest.contractSources ?? []) {
    verifyFileRecord(root, source, `ABI source ${source.path}`);
  }

  const glue = readFileSync(resolve(root, "cores/dolphin/dolphin-core-upstream.js"), "utf8");
  const actualExports = publicModuleExports(glue);
  invariant(
    JSON.stringify(actualExports) === JSON.stringify(manifest.moduleExports),
    "Generated core Module exports do not match ABI v1"
  );
  const actualMemory = inspectMemoryContract(root);
  invariant(
    JSON.stringify(actualMemory) === JSON.stringify(manifest.memoryContract),
    "Core memory contract does not match ABI v1"
  );
  const wasmArtifact = manifest.artifacts.find((artifact) => artifact.path.endsWith(".wasm"));
  invariant(manifest.coreId === `sha256:${wasmArtifact.sha256}`, "Core ID must address the WASM content");
  return {
    abiVersion: manifest.abiVersion,
    coreId: manifest.coreId,
    exports: actualExports.length,
    memoryContract: actualMemory
  };
}

export function verifyDolphinProvenance(root = process.cwd()) {
  const lock = loadSourceLock(root);
  const patches = verifyPatchSeries(root, lock);
  const vendor = loadVendorSnapshotManifest(root, lock);
  const core = verifyCoreAbiManifest(root);
  return {
    upstreamCommit: lock.upstream.commit,
    patches,
    vendorSnapshot: {
      rootPaths: vendor.root.records.length,
      submodulePaths: vendor.submodules.reduce((sum, item) => sum + item.records.length, 0),
      resultTree: vendor.root.resultTree,
      sha256: vendor.contentSha256
    },
    core
  };
}
