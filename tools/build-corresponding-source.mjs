// Build the GPL "complete corresponding source" archive for the committed core.
//
// cores/dolphin/dolphin-core-upstream.wasm is a derivative work of Dolphin
// (GPLv2-or-later), so distributing it obliges us to distribute the source it
// was built from. This produces that archive: the patched Dolphin tree the
// core is compiled from, our shim and build tooling, and the provenance record
// that ties the two together.
//
// The archive is verified before it is written -- provenance has to agree that
// the working tree is the locked upstream commit plus the locked patch series,
// so a drifted checkout produces an error rather than a mislabelled tarball.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadSourceLock, verifyDolphinProvenance } from "./dolphin-provenance.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Everything the recipient needs to rebuild the core, and nothing else. The
// vendored tree arrives under dolphin/ so the archive is self-describing.
const REPO_PAYLOAD = [
  "LICENSE",
  "package.json",
  "core/upstream",
  "patches/dolphin-wasm",
  "provenance",
  "tools"
];

// vendor/dolphin/.git is a partial clone: large, and not part of the source.
const VENDOR_EXCLUDES = [".git"];

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: root, encoding: "utf8", ...options });
}

function readableSize(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function manifest(lock, provenance) {
  return `# Corresponding source for wasm-dolphin

This archive is the complete corresponding source, in the sense of the GNU
General Public License, for the compiled core distributed as
\`cores/dolphin/dolphin-core-upstream.wasm\`.

That core is a derivative work of Dolphin (https://github.com/dolphin-emu/dolphin),
which is licensed GPLv2-or-later. The combined work is therefore GPL, and the
license text is included as LICENSE.

## What is here

| Path | What it is |
|------|------------|
| \`dolphin/\` | The Dolphin source tree the core is compiled from, already patched |
| \`patches/dolphin-wasm/\` | The patch series applied to upstream, as individual patches |
| \`core/upstream/\` | The C-ABI shim compiled together with Dolphin |
| \`tools/\` | The build driver, the Emscripten configuration, and the provenance tooling |
| \`provenance/\` | The pinned upstream commit, patch hashes, and tree snapshot |

## Exactly which source this is

- Upstream repository: ${lock.upstream.repository}
- Upstream commit: ${lock.upstream.commit}
- Patches applied: ${provenance.patches.count}
- Changed paths against upstream: ${provenance.vendorSnapshot.rootPaths}

\`dolphin/\` is that commit with those patches already applied, so it can be
built directly. To reconstruct it yourself instead, clone the upstream
repository at the commit above and apply \`patches/dolphin-wasm/snapshot/\` in
filename order.

## Rebuilding

The build needs the Emscripten SDK; see \`tools/wasm-toolchain.mjs\` for the
pinned version. With the tree in place as \`vendor/dolphin\`:

    npm run configure:upstream
    npm run build:upstream:full-core

That writes \`cores/dolphin/dolphin-core-upstream.{js,wasm}\`.
`;
}

export function buildCorrespondingSource({ outputDir = join(root, "dist") } = {}) {
  const vendor = join(root, "vendor/dolphin");
  if (!existsSync(vendor)) {
    throw new Error(
      "vendor/dolphin is missing. Run `npm run fetch:dolphin` and `npm run patch:upstream` first."
    );
  }

  // Fail before writing anything if the tree is not what the lock describes.
  const provenance = verifyDolphinProvenance(root);
  const lock = loadSourceLock(root);

  const version = JSON.parse(run("node", ["-p", "JSON.stringify(require('./package.json'))"])).version;
  const stem = `wasm-dolphin-corresponding-source-v${version}`;
  mkdirSync(outputDir, { recursive: true });

  // The manifest rides in the archive as README.md. Staging it under its final
  // name avoids a --transform, which GNU tar applies globally and in order.
  const staging = mkdtempSync(join(tmpdir(), "wasm-dolphin-cs-"));
  const manifestPath = join(staging, "README.md");
  writeFileSync(manifestPath, manifest(lock, provenance));

  const archive = join(outputDir, `${stem}.tar.gz`);
  rmSync(archive, { force: true });

  const posix = (value) => value.split("\\").join("/");
  const args = [
    "--create",
    "--gzip",
    // Without this, GNU tar reads a Windows "G:/..." path as host:path.
    "--force-local",
    "--file", posix(archive),
    ...VENDOR_EXCLUDES.map((entry) => `--exclude=${entry}`),
    "--transform", "s,^vendor/dolphin,dolphin,",
    "-C", posix(root),
    ...REPO_PAYLOAD,
    "vendor/dolphin",
    "-C", posix(staging),
    "README.md"
  ];

  try {
    run("tar", args, { stdio: ["ignore", "inherit", "pipe"] });
  } catch (error) {
    const detail = error.stderr ? `: ${String(error.stderr).trim()}` : "";
    throw new Error(`tar failed while writing ${archive}${detail}`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  return {
    archive,
    bytes: statSync(archive).size,
    commit: lock.upstream.commit,
    patches: provenance.patches.count
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = buildCorrespondingSource();
  console.log(`Corresponding source: ${result.archive}`);
  console.log(`  upstream ${result.commit} + ${result.patches} patches`);
  console.log(`  ${readableSize(result.bytes)}`);
  console.log("Attach it to the release alongside the core.");
}
