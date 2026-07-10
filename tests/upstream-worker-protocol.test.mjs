import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_UPSTREAM_CORE_SHA256,
  DEFAULT_UPSTREAM_CORE_URL,
  requestedUpstreamCoreBuild,
  sanitizeDiscFileName,
  sha256Hex,
  workerFsDiscPath
} from "../src/upstream-worker-protocol.js";

test("upstream worker sanitizes disc names for WORKERFS paths", () => {
  assert.equal(sanitizeDiscFileName("Super Smash Bros. Melee.iso"), "Super Smash Bros. Melee.iso");
  assert.equal(sanitizeDiscFileName("../GALE01.gcm"), ".._GALE01.gcm");
  assert.equal(sanitizeDiscFileName(""), "disc.iso");
  assert.equal(workerFsDiscPath("GALE01.gcm"), "/workerfs/GALE01.gcm");
});

test("upstream core selection is content-addressed and defaults to the pinned baseline", () => {
  assert.deepEqual(requestedUpstreamCoreBuild(""), {
    coreId: `sha256:${DEFAULT_UPSTREAM_CORE_SHA256}`,
    sha256: DEFAULT_UPSTREAM_CORE_SHA256,
    coreUrl: DEFAULT_UPSTREAM_CORE_URL,
    candidate: false
  });

  const hash = "a".repeat(64);
  assert.deepEqual(requestedUpstreamCoreBuild(`?coreid=sha256:${hash}`), {
    coreId: `sha256:${hash}`,
    sha256: hash,
    coreUrl: `./build/core-candidates/${hash}/dolphin-core-upstream.js`,
    candidate: true
  });
  assert.throws(() => requestedUpstreamCoreBuild("?coreid=not-a-hash"), /SHA-256/);
});

test("core selector hashing uses full SHA-256", async () => {
  assert.equal(
    await sha256Hex(new TextEncoder().encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  );
});
