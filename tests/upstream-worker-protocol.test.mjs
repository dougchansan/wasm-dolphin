import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeDiscFileName, workerFsDiscPath } from "../src/upstream-worker-protocol.js";

test("upstream worker sanitizes disc names for WORKERFS paths", () => {
  assert.equal(sanitizeDiscFileName("Super Smash Bros. Melee.iso"), "Super Smash Bros. Melee.iso");
  assert.equal(sanitizeDiscFileName("../GALE01.gcm"), ".._GALE01.gcm");
  assert.equal(sanitizeDiscFileName(""), "disc.iso");
  assert.equal(workerFsDiscPath("GALE01.gcm"), "/workerfs/GALE01.gcm");
});
