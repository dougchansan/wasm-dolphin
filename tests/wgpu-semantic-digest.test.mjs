import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  WGPU_SEMANTIC_MAGIC,
  WGPU_SEMANTIC_SCHEMA_VERSION,
  createWgpuSemanticDigest,
  encodeWgpuSemanticEvent,
} from "../src/wgpu-semantic-digest.js";

function draft(overrides = {}) {
  return {
    kind: 1,
    opcode: 6,
    resourceClass: 3,
    resourceId: 9,
    generation: 2,
    args: [9, 64, 4, 1],
    payloadBytes: Uint8Array.of(1, 2, 3, 4),
    ...overrides,
  };
}

test("WDS1 framing follows the exact little-endian canonical order", () => {
  const encoded = encodeWgpuSemanticEvent({
    ...draft(),
    epoch: 5,
    transaction: 7,
    sequenceLo: 11,
    sequenceHi: 13,
  });
  const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
  assert.equal(view.getUint32(0, true), encoded.byteLength - 4);
  assert.deepEqual(
    Array.from({ length: 13 }, (_, index) => view.getUint32(index * 4, true)),
    [
      encoded.byteLength - 4,
      WGPU_SEMANTIC_MAGIC,
      WGPU_SEMANTIC_SCHEMA_VERSION,
      1, 5, 7, 11, 13, 6, 3, 9, 2, 4,
    ]
  );
  assert.deepEqual(
    Array.from({ length: 4 }, (_, index) => view.getUint32(52 + index * 4, true)),
    [9, 64, 4, 1]
  );
  assert.equal(view.getUint32(68, true), 4);
  assert.equal(encoded.byteLength, 104);
});

test("WDS1 event and first chain digest match an independent Node crypto oracle", () => {
  const encoded = encodeWgpuSemanticEvent({
    ...draft(),
    epoch: 5,
    transaction: 7,
    sequenceLo: 11,
    sequenceHi: 13,
  });
  const domain = createHash("sha256")
    .update("wasm-dolphin-wgpu-semantic-v1")
    .digest();
  const expectedPayload = createHash("sha256")
    .update(Buffer.from([1, 2, 3, 4]))
    .digest("hex");
  assert.equal(Buffer.from(encoded.subarray(encoded.length - 32)).toString("hex"), expectedPayload);
  assert.equal(
    createHash("sha256").update(domain).update(encoded).digest("hex"),
    "b7692274bacb659b840a6bd5ecefc1424429d9260f29b7a70a2dcc14cdb6ca4f"
  );
});

test("semantic chains are deterministic and payload sensitive", () => {
  const run = (payload) => {
    const sink = createWgpuSemanticDigest({ now: () => 0 });
    sink.beginEpoch(1);
    sink.beginTransaction(2);
    sink.appendEvent(draft({ transaction: 2, payloadBytes: payload }));
    sink.commitTransaction(2);
    return sink.snapshot();
  };
  const first = run(Uint8Array.of(1, 2, 3, 4));
  const same = run(Uint8Array.of(1, 2, 3, 4));
  const changed = run(Uint8Array.of(1, 2, 3, 5));
  assert.equal(first.globalDigest, same.globalDigest);
  assert.notEqual(first.globalDigest, changed.globalDigest);
  assert.equal(first.committedTransactionCount, 1);
  assert.equal(first.payloadBytesHashed, 4);
});

test("aborted transaction content never advances the committed chain", () => {
  const baseline = createWgpuSemanticDigest({ now: () => 0 });
  baseline.beginEpoch(3);
  const candidate = createWgpuSemanticDigest({ now: () => 0 });
  candidate.beginEpoch(3);
  candidate.beginTransaction(8);
  candidate.appendEvent(draft({ transaction: 8 }));
  candidate.abortTransaction(8);
  assert.equal(candidate.snapshot().globalDigest, baseline.snapshot().globalDigest);
  assert.equal(candidate.snapshot().epochDigest, baseline.snapshot().epochDigest);
  assert.equal(candidate.snapshot().abortedTransactionCount, 1);
  assert.equal(candidate.snapshot().committedEventCount, 0);
  assert.equal(candidate.snapshot().sequenceLo, baseline.snapshot().sequenceLo);
});

test("epoch boundaries fail closed on open branches and bound commit history", () => {
  const sink = createWgpuSemanticDigest({ recentCommitLimit: 2, now: () => 0 });
  sink.beginEpoch(1);
  sink.beginTransaction(1);
  sink.appendEvent(draft({ transaction: 1 }));
  sink.beginEpoch(2);
  assert.equal(sink.snapshot().unresolvedCount, 1);
  for (let id = 2; id <= 4; id += 1) {
    sink.beginTransaction(id);
    sink.appendEvent(draft({ transaction: id, resourceId: id }));
    sink.commitTransaction(id);
  }
  assert.deepEqual(sink.snapshot().recentCommits.map((entry) => entry.transaction), [3, 4]);
});

test("overlapping transactions fail closed instead of forking committed history", () => {
  const sink = createWgpuSemanticDigest({ now: () => 0 });
  sink.beginEpoch(1);
  sink.beginTransaction(1);
  assert.throws(
    () => sink.beginTransaction(2),
    /overlapping semantic transactions/
  );
  assert.equal(sink.snapshot().openTransactionCount, 1);
  assert.equal(sink.snapshot().mismatchCount, 1);
});

test("transaction-zero events cannot be overwritten by a later branch commit", () => {
  const sink = createWgpuSemanticDigest({ now: () => 0 });
  sink.beginEpoch(1);
  sink.beginTransaction(1);
  assert.throws(
    () => sink.appendEvent(draft({ transaction: 0 })),
    /cannot interleave with an open transaction/
  );
  assert.equal(sink.snapshot().committedEventCount, 0);
  assert.equal(sink.snapshot().mismatchCount, 1);
});
