import assert from "node:assert/strict";
import test from "node:test";

import { IncrementalSha256, sha256Hex } from "../src/incremental-sha256.js";

const encoder = new TextEncoder();

test("incremental SHA-256 matches NIST vectors", () => {
  assert.equal(
    sha256Hex(new Uint8Array()),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  );
  assert.equal(
    sha256Hex(encoder.encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  );
  assert.equal(
    sha256Hex(encoder.encode("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
  );
});

test("incremental SHA-256 is chunk and clone stable", () => {
  const bytes = Uint8Array.from({ length: 4097 }, (_, index) => (index * 37) & 0xff);
  const expected = sha256Hex(bytes);
  const hash = new IncrementalSha256();
  for (let offset = 0; offset < bytes.length; offset += 13) {
    hash.update(bytes.subarray(offset, Math.min(bytes.length, offset + 13)));
  }
  assert.equal(hash.digestHex(), expected);
  const prefix = new IncrementalSha256().update(bytes.subarray(0, 2048));
  const left = prefix.clone().update(bytes.subarray(2048));
  const right = new IncrementalSha256(prefix.snapshot()).update(bytes.subarray(2048));
  assert.equal(left.digestHex(), expected);
  assert.equal(right.digestHex(), expected);
  assert.equal(prefix.digestHex(), sha256Hex(bytes.subarray(0, 2048)));
});

test("incremental SHA-256 snapshots reject inconsistent buffered lengths", () => {
  const snapshot = new IncrementalSha256().update(encoder.encode("abc")).snapshot();
  snapshot.bytesLow += 1;
  assert.throws(
    () => new IncrementalSha256(snapshot),
    /length does not match buffered bytes/
  );
});
