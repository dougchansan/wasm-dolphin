import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  fileRecord,
  patchSeriesDigest,
  sha256Bytes,
  validateSourceLock,
  validateVendorSnapshotManifest,
} from "./dolphin-provenance.mjs";

const root = process.cwd();
const vendorRoot = resolve(root, "vendor/dolphin");
const sourceLockPath = resolve(root, "provenance/dolphin-source.lock.json");
const snapshotPath = resolve(root, "provenance/dolphin-vendor-snapshot-v1.json");
const write = process.argv.includes("--write");

const previousLock = JSON.parse(readFileSync(sourceLockPath, "utf8"));
const rootPatchPaths = readdirSync(resolve(root, "patches/dolphin-wasm/snapshot"))
  .filter((name) => /^\d{4}-.*\.patch$/.test(name))
  .sort()
  .map((name) => `patches/dolphin-wasm/snapshot/${name}`);
const submodulePatches = previousLock.patches
  .filter((patch) => patch.cwd !== ".")
  .sort((left, right) => left.order - right.order)
  .map(({ cwd, path }) => ({ cwd, path }));

const patchInputs = [
  ...rootPatchPaths.map((path) => ({ cwd: ".", path })),
  ...submodulePatches,
];
const patches = patchInputs.map(({ cwd, path }, index) => ({
  order: index + 1,
  cwd,
  hashMode: "lf-normalized",
  ...fileRecord(path, root, "lf-normalized"),
}));
const lock = {
  ...previousLock,
  patches,
  patchSeriesSha256: patchSeriesDigest(patches),
};
validateSourceLock(lock);

const temporaryDirectory = mkdtempSync(join(tmpdir(), "wasm-dolphin-provenance-"));
try {
  const rootSnapshot = replayRepository({
    repository: vendorRoot,
    baseCommit: lock.repositories["."].commit,
    patches: lock.patches.filter((patch) => patch.cwd === "."),
    indexName: "root.index",
  });
  const submodules = Object.keys(lock.repositories)
    .filter((cwd) => cwd !== ".")
    .sort()
    .map((cwd, index) => ({
      cwd,
      ...replayRepository({
        repository: resolve(vendorRoot, cwd),
        baseCommit: lock.repositories[cwd].commit,
        patches: lock.patches.filter((patch) => patch.cwd === cwd),
        indexName: `submodule-${index}.index`,
      }),
    }));
  const snapshot = {
    schemaVersion: 1,
    normalization: "git-blob-lf",
    root: {
      baseCommit: lock.repositories["."].commit,
      resultTree: rootSnapshot.resultTree,
      changedPathCount: rootSnapshot.records.length,
      records: rootSnapshot.records,
    },
    submodules: submodules.map(({ cwd, resultTree, records }) => ({
      cwd,
      baseCommit: lock.repositories[cwd].commit,
      resultTree,
      records,
    })),
  };
  snapshot.contentSha256 = sha256Bytes(JSON.stringify({
    root: snapshot.root,
    submodules: snapshot.submodules,
  }));
  validateVendorSnapshotManifest(snapshot, lock);

  if (write) {
    writeFileSync(sourceLockPath, `${JSON.stringify(lock, null, 2)}\n`);
    writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  }

  console.log(JSON.stringify({
    wroteFiles: write,
    patchCount: lock.patches.length,
    patchSeriesSha256: lock.patchSeriesSha256,
    rootResultTree: snapshot.root.resultTree,
    rootChangedPathCount: snapshot.root.changedPathCount,
    submodules: snapshot.submodules.map((entry) => ({
      cwd: entry.cwd,
      resultTree: entry.resultTree,
      changedPathCount: entry.records.length,
    })),
  }, null, 2));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

function replayRepository({ repository, baseCommit, patches: repositoryPatches, indexName }) {
  const indexPath = resolve(temporaryDirectory, indexName);
  const objectDirectory = resolve(temporaryDirectory, `${indexName}.objects`);
  mkdirSync(objectDirectory, { recursive: true });
  const sourceObjectDirectory = gitText(repository, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "objects",
  ]);
  const environment = {
    GIT_INDEX_FILE: indexPath,
    // The real checkout is a read-only alternate. Patch blobs and the virtual
    // result tree are written under the temporary directory, so replay changes
    // neither the vendor worktree/index nor its object database.
    GIT_OBJECT_DIRECTORY: objectDirectory,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: sourceObjectDirectory,
  };
  gitText(repository, ["read-tree", baseCommit], environment);
  for (const patch of repositoryPatches) {
    gitText(repository, [
      "apply",
      "--cached",
      "--whitespace=nowarn",
      resolve(root, patch.path),
    ], environment);
  }
  const resultTree = gitText(repository, ["write-tree"], environment);
  const changed = gitText(repository, [
    "diff-tree",
    "--no-commit-id",
    "--name-status",
    "-r",
    baseCommit,
    resultTree,
  ], environment);
  const records = changed
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf("\t");
      if (separator < 0) throw new Error(`Malformed diff-tree row: ${line}`);
      const status = line.slice(0, separator);
      const path = line.slice(separator + 1);
      if (status !== "A" && status !== "M") {
        throw new Error(`Unsupported provenance status ${status} for ${path}`);
      }
      return snapshotRecord(repository, baseCommit, resultTree, path, status, environment);
    })
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return { resultTree, records };
}

function snapshotRecord(repository, baseCommit, resultTree, path, status, environment) {
  const result = treeEntry(repository, resultTree, path, environment);
  if (!result || result.type !== "blob") {
    throw new Error(`Expected result blob for ${path}`);
  }
  const base = treeEntry(repository, baseCommit, path, environment);
  const bytes = gitBuffer(repository, ["cat-file", "blob", result.object], environment);
  return {
    path,
    status,
    mode: result.mode,
    baseBlob: base?.object ?? null,
    resultBlob: result.object,
    size: bytes.length,
    sha256: sha256Bytes(bytes),
  };
}

function treeEntry(repository, tree, path, environment) {
  const output = gitText(repository, ["ls-tree", tree, "--", path], environment);
  if (!output) return null;
  const match = /^(\d{6})\s+(\S+)\s+([0-9a-f]{40})\t/.exec(output);
  if (!match) throw new Error(`Malformed ls-tree row for ${path}: ${output}`);
  return { mode: match[1], type: match[2], object: match[3] };
}

function gitText(repository, args, environment = {}) {
  return git(repository, args, environment, "utf8").trim();
}

function gitBuffer(repository, args, environment = {}) {
  return git(repository, args, environment, null);
}

function git(repository, args, environment, encoding) {
  const result = spawnSync("git", ["-C", repository, ...args], {
    encoding,
    env: { ...process.env, ...environment },
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString("utf8")
      : String(result.stderr || "");
    throw new Error(
      `git ${args.join(" ")} failed in ${basename(repository)}: ${stderr.trim() || result.error?.message}`
    );
  }
  return result.stdout;
}
