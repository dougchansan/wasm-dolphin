import assert from "node:assert/strict";
import test from "node:test";

import {
  WGPU_LEGACY_COMMAND_OPCODE as OP,
  WGPU_RESOURCE_CLASS as RESOURCE,
  WGPU_SEMANTIC_EVENT_KIND as KIND,
} from "../src/wgpu-legacy-semantic-decoder.js";
import {
  WGPU_CORRELATION_EPOCH_KIND,
  WGPU_OWNERSHIP_EVENT,
  createWgpuOwnershipCommandCorrelator,
} from "../src/wgpu-ownership-command-correlator.js";
import { WGPU_RESOURCE_EPOCH_KIND as EPOCH } from
  "../src/wgpu-resource-generation-tracker.js";
import { createWgpuSemanticParitySink } from "../src/wgpu-semantic-parity-sink.js";

const EMPTY = new Uint8Array(0);

test("parity sink composes primary and ordered dependency generations into WDS2", () => {
  const sink = readySink();
  sink.appendEvent(event(OP.CREATE_SHADER, RESOURCE.SHADER, 101, {
    args: [101, 0],
    payloadBytes: Uint8Array.of(1),
  }));
  sink.appendEvent(event(OP.CREATE_SHADER, RESOURCE.SHADER, 102, {
    args: [102, 0],
    payloadBytes: Uint8Array.of(2),
  }));
  const encoded = sink.appendEvent(event(OP.CREATE_PIPELINE, RESOURCE.PIPELINE, 201, {
    args: [201, 101, 102, 3],
  }));

  const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
  assert.equal(view.getUint32(44, true), 1);
  assert.equal(view.getUint32(68, true), 2);
  assert.deepEqual(
    Array.from({ length: 12 }, (_, index) => view.getUint32(72 + index * 4, true)),
    [1, 1, 101, 1, 0, 0, 2, 1, 102, 1, 0, 0]
  );

  const state = sink.snapshot();
  assert.equal(state.schema, "wasm-dolphin.wgpu-semantic-digest.v2");
  assert.equal(state.committedEventCount, 3);
  assert.equal(state.committedDependencyCount, 2);
  assert.equal(state.resourceTracker.knownResourceCount, 3);
  assert.equal(state.dependencyEncodingReady, true);
  assert.equal(state.independentDecodingReady, true);
  assert.equal(state.independentDecodedEventCount, 3);
  assert.equal(state.runtimeIntegrationReady, false);
});

test("load retains resource incarnations while an attested consumer reset clears them", () => {
  const sink = readySink();
  let encoded = sink.appendEvent(event(OP.CREATE_BUFFER, RESOURCE.BUFFER, 7, {
    args: [7, 64, 1],
  }));
  assert.equal(generation(encoded), 1);

  sink.beginEpoch(2, { kind: EPOCH.LOAD });
  encoded = sink.appendEvent(event(OP.UPLOAD_BUFFER, RESOURCE.BUFFER, 7, {
    args: [7, 0, 4, 0],
    payloadBytes: Uint8Array.of(1, 2, 3, 4),
  }));
  assert.equal(generation(encoded), 1);

  sink.beginEpoch(3, { kind: EPOCH.CONSUMER_RESET });
  encoded = sink.appendEvent(event(OP.CREATE_BUFFER, RESOURCE.BUFFER, 7, {
    args: [7, 64, 1],
  }));
  assert.equal(generation(encoded), 1);
  assert.equal(sink.snapshot().resourceTracker.consumerResetEpochCount, 2);
});

test("aborted staged events change neither resource incarnations nor the WDS2 chain", () => {
  const sink = readySink();
  sink.appendEvent(event(OP.CREATE_BUFFER, RESOURCE.BUFFER, 7, { args: [7, 64, 1] }));
  const committed = sink.snapshot().globalDigest;

  sink.beginTransaction(9);
  sink.appendEvent(event(OP.DESTROY, RESOURCE.BUFFER, 7, {
    transaction: 9,
    args: [1, 7],
  }), { staged: true });
  sink.appendEvent(event(OP.CREATE_BUFFER, RESOURCE.BUFFER, 7, {
    transaction: 9,
    args: [7, 128, 1],
  }), { staged: true });
  sink.abortTransaction(9);

  assert.equal(sink.snapshot().globalDigest, committed);
  const encoded = sink.appendEvent(event(OP.UPLOAD_BUFFER, RESOURCE.BUFFER, 7, {
    args: [7, 0, 1, 0],
    payloadBytes: Uint8Array.of(5),
  }));
  assert.equal(generation(encoded), 1);
  assert.equal(sink.snapshot().resourceTracker.discardedStagedEventCount, 2);
});

test("parity sink fails closed when the epoch boundary kind is not proven", () => {
  const sink = createWgpuSemanticParitySink({ now: () => 0 });
  assert.throws(() => sink.beginEpoch(1), /epoch kind undefined is unsupported/);
  assert.equal(sink.snapshot().failed, true);
  assert.equal(sink.snapshot().mismatchCount, 1);
  assert.throws(
    () => sink.beginEpoch(1, { kind: EPOCH.CONSUMER_RESET }),
    /semantic parity sink is failed/
  );
});

test("ownership correlation distinguishes observation start from a load epoch", () => {
  const epochs = [];
  const sink = {
    appendEvent() {},
    beginEpoch(epoch, options) {
      epochs.push([epoch, options.kind]);
    },
  };
  const correlator = createWgpuOwnershipCommandCorrelator({ semanticSink: sink });
  correlator.pushOwnership([ownership(WGPU_OWNERSHIP_EVENT.EPOCH, {
    epoch: 1,
    resourceId: 1,
  })]);
  correlator.pushOwnership([ownership(WGPU_OWNERSHIP_EVENT.LOAD_REQUESTED, { epoch: 2 })]);
  assert.deepEqual(epochs, [
    [1, WGPU_CORRELATION_EPOCH_KIND.OBSERVATION_START],
    [2, WGPU_CORRELATION_EPOCH_KIND.LOAD],
  ]);
});

test("correlator checkpoint recognizes a clean WDS2 sink without accepting other schemas", () => {
  const state = {
    schema: "wasm-dolphin.wgpu-semantic-digest.v2",
    openTransactionCount: 0,
    unresolvedCount: 0,
    mismatchCount: 0,
    overflow: false,
    globalDigest: "0".repeat(64),
    epochDigest: "1".repeat(64),
    committedEventCount: 0,
    independentDecodedEventCount: 0,
    dependencyEncodingReady: true,
    independentDecodingReady: true,
  };
  const sink = { appendEvent() {}, snapshot: () => state };
  const correlator = createWgpuOwnershipCommandCorrelator({ semanticSink: sink });
  correlator.pushOwnership([ownership(WGPU_OWNERSHIP_EVENT.EPOCH, {
    epoch: 1,
    resourceId: 1,
  })]);
  assert.equal(correlator.checkpoint().committedPrefixValid, true);
  state.schema = "wasm-dolphin.wgpu-semantic-digest.v3";
  assert.equal(correlator.checkpoint().committedPrefixValid, false);
});

test("real correlator and parity sink reject an unproven initial resource baseline", () => {
  const sink = createWgpuSemanticParitySink({ now: () => 0 });
  const correlator = createWgpuOwnershipCommandCorrelator({ semanticSink: sink });
  correlator.pushOwnership([ownership(WGPU_OWNERSHIP_EVENT.EPOCH, {
    epoch: 1,
    resourceId: 1,
  })]);
  const checkpoint = correlator.checkpoint();
  assert.equal(checkpoint.valid, false);
  assert.equal(checkpoint.committedPrefixValid, false);
  assert.match(checkpoint.reasons.join(" "), /observation-start is unsupported/);
  assert.equal(sink.snapshot().independentDecodedEventCount, 0);
});

function readySink() {
  const sink = createWgpuSemanticParitySink({ now: () => 0 });
  sink.beginEpoch(1, { kind: EPOCH.CONSUMER_RESET });
  return sink;
}

function event(opcode, resourceClass, resourceId, overrides = {}) {
  return {
    kind: KIND.COMMAND,
    opcode,
    resourceClass,
    resourceId,
    transaction: 0,
    args: [],
    payloadBytes: EMPTY,
    ...overrides,
  };
}

function generation(encoded) {
  return new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength)
    .getUint32(44, true);
}

function ownership(event, {
  epoch,
  transactionId = 0,
  commandSerial = 0,
  opcode = 0,
  resourceId = 0,
  payloadLength = 0,
  auxiliary = 0,
} = {}) {
  return {
    event,
    epoch,
    transactionId,
    commandSerial,
    opcode,
    resourceId,
    payloadLength,
    auxiliary,
  };
}
