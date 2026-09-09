// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// The canonical core build refuses to run from a dirty tree, because a build
// evidence record that lists 21 modified and 7 untracked paths -- which is what
// the shipped artifact actually carried -- describes no committed source state
// and cannot be reproduced by anyone else.
//
// The gate is only as good as its parse of `git status --porcelain=v1`, and the
// first version of that parse was wrong in a way that failed a clean build: it
// sliced a fixed three characters, which is right for " M path" but off by one
// for "M path", and git() trims its stdout so the first line always arrives in
// the second form.

import assert from "node:assert/strict";
import test from "node:test";

import { dirtyPathsFromStatus, unexpectedDirtyPaths } from "../tools/core-build-info.mjs";

test("status lines parse to paths regardless of the leading status column", () => {
  for (const [line, expected] of [
    // Unstaged: git writes a leading space...
    [" M cores/dolphin/dolphin-core-upstream.js", "cores/dolphin/dolphin-core-upstream.js"],
    // ...which a trim() upstream removes. Both must give the same path.
    ["M cores/dolphin/dolphin-core-upstream.js", "cores/dolphin/dolphin-core-upstream.js"],
    ["?? page_view.png", "page_view.png"],
    ["A  patches/dolphin-wasm/snapshot/0061-webgpu-renderer-feature-mask.patch",
     "patches/dolphin-wasm/snapshot/0061-webgpu-renderer-feature-mask.patch"],
    ["D  removed.patch", "removed.patch"],
    ["MM src/upstream-discio-worker.js", "src/upstream-discio-worker.js"],
    // Renames report both sides; the destination is the path that now exists.
    ["R  tools/old-name.mjs -> tools/new-name.mjs", "tools/new-name.mjs"],
    // Paths with spaces come back quoted.
    ['?? "docs/a file.md"', "docs/a file.md"]
  ]) {
    assert.deepEqual(dirtyPathsFromStatus(line), [expected], line);
  }
});

test("empty and blank status means a clean tree", () => {
  for (const status of [null, undefined, "", "\n", "  \n\n"]) {
    assert.deepEqual(dirtyPathsFromStatus(status), []);
  }
});

test("multi-line status keeps every path, first line included", () => {
  // As git() delivers it: trimmed, so the first line has lost its leading space.
  const status = [
    "M cores/dolphin/dolphin-core-upstream.js",
    " M cores/dolphin/dolphin-core-upstream.wasm",
    "?? page_view.png"
  ].join("\n");
  assert.deepEqual(dirtyPathsFromStatus(status), [
    "cores/dolphin/dolphin-core-upstream.js",
    "cores/dolphin/dolphin-core-upstream.wasm",
    "page_view.png"
  ]);
});

test("the build's own outputs are allowed dirty and nothing else is", () => {
  // A build necessarily rewrites these, so they cannot be a reason to refuse.
  const outputsOnly = [
    "M cores/dolphin/dolphin-core-upstream.js",
    " M cores/dolphin/dolphin-core-upstream.wasm",
    " M cores/dolphin/dolphin-core-upstream.build.json",
    " M provenance/dolphin-core-abi-v1.json"
  ].join("\n");
  assert.deepEqual(unexpectedDirtyPaths(outputsOnly), [],
    "a tree dirty only in build outputs is a clean canonical build");

  // The residue that was actually recorded in the shipped build evidence.
  const residue = [
    "M cores/dolphin/dolphin-core-upstream.js",
    "?? page_view.png",
    "?? patches/dolphin-wasm/snapshot/0059-preserve-existing-renderer-and-diagnostic-source.patch",
    " M src/upstream-discio-worker.js"
  ].join("\n");
  assert.deepEqual(unexpectedDirtyPaths(residue), [
    "page_view.png",
    "patches/dolphin-wasm/snapshot/0059-preserve-existing-renderer-and-diagnostic-source.patch",
    "src/upstream-discio-worker.js"
  ], "source and stray files must still be reported");
});
