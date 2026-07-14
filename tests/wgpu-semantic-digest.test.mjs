import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  WGPU_SEMANTIC_MAGIC,
  WGPU_SEMANTIC_MAGIC_V2,
  WGPU_SEMANTIC_SCHEMA_VERSION,
  WGPU_SEMANTIC_SCHEMA_VERSION_V2,
  createWgpuSemanticDigest,
  createWgpuSemanticDigestV2,
  encodeWgpuSemanticEvent,
  encodeWgpuSemanticEventV2,
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
    sink.appendEvent(draft({ transaction: 2, payloadBytes: payload }), { staged: true });
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
  candidate.appendEvent(draft({ transaction: 8 }), { staged: true });
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
  sink.appendEvent(draft({ transaction: 1 }), { staged: true });
  sink.beginEpoch(2);
  assert.equal(sink.snapshot().unresolvedCount, 1);
  for (let id = 2; id <= 4; id += 1) {
    sink.beginTransaction(id);
    sink.appendEvent(draft({ transaction: id, resourceId: id }), { staged: true });
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

test("published events interleave with a private branch without being overwritten", () => {
  const sink = createWgpuSemanticDigest({ now: () => 0 });
  sink.beginEpoch(1);
  sink.beginTransaction(1);
  sink.appendEvent(draft({ transaction: 1, opcode: 6 }), { staged: true });
  sink.appendEvent(draft({ transaction: 1, opcode: 5, payloadBytes: new Uint8Array() }));
  const beforeCommit = sink.snapshot();
  assert.equal(beforeCommit.committedEventCount, 1);
  sink.commitTransaction(1);
  assert.equal(sink.snapshot().committedEventCount, 2);
  assert.equal(sink.snapshot().mismatchCount, 0);
});

test("aborting a private branch preserves already-published events with the same owner", () => {
  const candidate = createWgpuSemanticDigest({ now: () => 0 });
  candidate.beginEpoch(1);
  candidate.beginTransaction(4);
  candidate.appendEvent(draft({ transaction: 4, opcode: 6 }), { staged: true });
  candidate.appendEvent(draft({ transaction: 4, opcode: 5, payloadBytes: new Uint8Array() }));
  const publishedDigest = candidate.snapshot().globalDigest;
  candidate.abortTransaction(4);
  assert.equal(candidate.snapshot().globalDigest, publishedDigest);
  assert.equal(candidate.snapshot().committedEventCount, 1);
  assert.equal(candidate.snapshot().abortedTransactionCount, 1);
});

test("staged event inputs are immutable before commit", () => {
  const payload = Uint8Array.of(1, 2, 3, 4);
  const args = [9, 64, 4, 1];
  const sink = createWgpuSemanticDigest({ now: () => 0 });
  sink.beginEpoch(1);
  sink.beginTransaction(5);
  sink.appendEvent(draft({ transaction: 5, payloadBytes: payload, args }), { staged: true });
  payload[0] = 99;
  args[0] = 99;
  sink.commitTransaction(5);

  const expected = createWgpuSemanticDigest({ now: () => 0 });
  expected.beginEpoch(1);
  expected.beginTransaction(5);
  expected.appendEvent(draft({ transaction: 5 }), { staged: true });
  expected.commitTransaction(5);
  assert.equal(sink.snapshot().globalDigest, expected.snapshot().globalDigest);
});

test("WDS2 independently frames ordered dependency generations", () => {
  const event = {
    ...draft(),
    epoch: 5,
    transaction: 7,
    sequenceLo: 11,
    sequenceHi: 13,
    dependencies: [
      { role: "vertex-shader", resourceClass: 1, resourceId: 101, generation: 3 },
      {
        role: "bind-entry",
        resourceClass: 3,
        resourceId: 9,
        generation: 2,
        binding: 0,
      },
    ],
  };
  const encoded = encodeWgpuSemanticEventV2(event);
  const oracle = encodeWds2Oracle(event);
  assert.deepEqual(encoded, oracle);
  const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
  assert.equal(view.getUint32(4, true), WGPU_SEMANTIC_MAGIC_V2);
  assert.equal(view.getUint32(8, true), WGPU_SEMANTIC_SCHEMA_VERSION_V2);
  assert.equal(view.getUint32(68, true), 2);
  assert.deepEqual(
    Array.from({ length: 12 }, (_, index) => view.getUint32(72 + index * 4, true)),
    [1, 1, 101, 3, 0, 0, 3, 3, 9, 2, 1, 0]
  );
});

test("WDS2 dependency order, generation, and binding presence affect the chain", () => {
  const dependencies = [
    { role: "vertex-shader", resourceClass: 1, resourceId: 1, generation: 1 },
    { role: "fragment-shader", resourceClass: 1, resourceId: 2, generation: 1 },
  ];
  const run = (value) => {
    const sink = createWgpuSemanticDigestV2({ now: () => 0 });
    sink.beginEpoch(1);
    sink.appendEvent(draft({ dependencies: value }));
    return sink.snapshot();
  };
  const baseline = run(dependencies);
  assert.notEqual(baseline.globalDigest, run([...dependencies].reverse()).globalDigest);
  assert.notEqual(
    baseline.globalDigest,
    run([{ ...dependencies[0], generation: 2 }, dependencies[1]]).globalDigest
  );
  assert.notEqual(
    run([{ role: "bind-entry", resourceClass: 3, resourceId: 9, generation: 2, binding: 0 }])
      .globalDigest,
    run([{ role: "bind-entry", resourceClass: 3, resourceId: 9, generation: 2, binding: 1 }])
      .globalDigest
  );
  assert.equal(baseline.schema, "wasm-dolphin.wgpu-semantic-digest.v2");
  assert.equal(baseline.domain, "wasm-dolphin-wgpu-semantic-v2");
});

test("WDS2 snapshots dependency inputs before a staged commit", () => {
  const dependencies = [
    { role: "bind-entry", resourceClass: 3, resourceId: 9, generation: 2, binding: 0 },
  ];
  const sink = createWgpuSemanticDigestV2({ now: () => 0 });
  sink.beginEpoch(1);
  sink.beginTransaction(2);
  sink.appendEvent(draft({ transaction: 2, dependencies }), { staged: true });
  dependencies[0].generation = 99;
  dependencies[0].binding = 99;
  sink.commitTransaction(2);

  const expected = createWgpuSemanticDigestV2({ now: () => 0 });
  expected.beginEpoch(1);
  expected.beginTransaction(2);
  expected.appendEvent(draft({
    transaction: 2,
    dependencies: [
      { role: "bind-entry", resourceClass: 3, resourceId: 9, generation: 2, binding: 0 },
    ],
  }), { staged: true });
  expected.commitTransaction(2);
  assert.equal(sink.snapshot().globalDigest, expected.snapshot().globalDigest);
});

test("WDS2 rejects noncanonical dependency roles, classes, generations, and bindings", () => {
  const encoded = (dependency) => encodeWgpuSemanticEventV2({
    ...draft(),
    epoch: 1,
    transaction: 0,
    sequenceLo: 0,
    sequenceHi: 0,
    dependencies: [dependency],
  });
  assert.throws(
    () => encoded({ role: "unknown", resourceClass: 1, resourceId: 1, generation: 1 }),
    /dependency role/
  );
  assert.throws(
    () => encoded({ role: "vertex-shader", resourceClass: 3, resourceId: 1, generation: 1 }),
    /requires resource class 1/
  );
  assert.throws(
    () => encoded({ role: "depth-attachment", resourceClass: 4, resourceId: 1, generation: 0 }),
    /generation must be nonzero/
  );
  assert.throws(
    () => encoded({ role: "bind-entry", resourceClass: 3, resourceId: 1, generation: 1 }),
    /requires a binding/
  );
  assert.throws(
    () => encoded({
      role: "blit-destination",
      resourceClass: 4,
      resourceId: 1,
      generation: 1,
      binding: 0,
    }),
    /cannot carry a binding/
  );
});

test("WDS2 transaction commit is atomic when a later event cannot encode", () => {
  const sink = createWgpuSemanticDigestV2({ now: () => 0 });
  sink.beginEpoch(1);
  sink.beginTransaction(3);
  sink.appendEvent(draft({ transaction: 3 }), { staged: true });
  sink.appendEvent(draft({ transaction: 3, args: Array(4_097).fill(1) }), { staged: true });
  const before = sink.snapshot();
  assert.throws(() => sink.commitTransaction(3), /argument count exceeds 4096/);
  const after = sink.snapshot();
  assert.equal(after.globalDigest, before.globalDigest);
  assert.equal(after.epochDigest, before.epochDigest);
  assert.equal(after.sequenceLo, 0);
  assert.equal(after.sequenceHi, 0);
  assert.equal(after.committedEventCount, 0);
  assert.equal(after.committedDependencyCount, 0);
  assert.equal(after.openTransactionCount, 1);
});

function encodeWds2Oracle(event) {
  const roleTags = new Map([
    ["vertex-shader", 1],
    ["fragment-shader", 2],
    ["bind-entry", 3],
    ["depth-attachment", 4],
    ["blit-destination", 5],
  ]);
  const payload = Buffer.from(event.payloadBytes);
  const payloadDigest = createHash("sha256").update(payload).digest();
  const bodyWords = 12 + event.args.length + 1 + event.dependencies.length * 6 + 1;
  const bytes = Buffer.alloc(4 + bodyWords * 4 + payloadDigest.length);
  let offset = 0;
  const word = (value) => {
    bytes.writeUInt32LE(value >>> 0, offset);
    offset += 4;
  };
  word(bytes.length - 4);
  word(0x32534457);
  word(2);
  for (const value of [
    event.kind,
    event.epoch,
    event.transaction,
    event.sequenceLo,
    event.sequenceHi,
    event.opcode,
    event.resourceClass,
    event.resourceId,
    event.generation,
    event.args.length,
  ]) word(value);
  for (const value of event.args) word(value);
  word(event.dependencies.length);
  for (const dependency of event.dependencies) {
    word(roleTags.get(dependency.role));
    word(dependency.resourceClass);
    word(dependency.resourceId);
    word(dependency.generation);
    word(Object.hasOwn(dependency, "binding") ? 1 : 0);
    word(dependency.binding ?? 0);
  }
  word(payload.length);
  payloadDigest.copy(bytes, offset);
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
