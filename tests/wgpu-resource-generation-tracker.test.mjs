import assert from "node:assert/strict";
import test from "node:test";

import {
  WGPU_LEGACY_COMMAND_OPCODE as OP,
  WGPU_RESOURCE_CLASS as RESOURCE,
  WGPU_SEMANTIC_EVENT_KIND as KIND,
} from "../src/wgpu-legacy-semantic-decoder.js";
import {
  WGPU_RESOURCE_EPOCH_KIND as EPOCH,
  WGPU_RESOURCE_GENERATION_TRACKER_SCHEMA,
  createWgpuResourceGenerationTracker,
} from "../src/wgpu-resource-generation-tracker.js";

const EMPTY = new Uint8Array(0);

test("create, use, destroy, and recreate identify the affected incarnation", () => {
  const tracker = readyTracker();

  assert.equal(tracker.decorate(event(OP.CREATE_BUFFER, RESOURCE.BUFFER, 7)).generation, 1);
  assert.equal(tracker.decorate(event(OP.UPLOAD_BUFFER, RESOURCE.BUFFER, 7)).generation, 1);
  assert.equal(
    tracker.decorate(event(OP.DESTROY, RESOURCE.BUFFER, 7, { args: [1, 7] })).generation,
    1
  );
  assert.equal(tracker.decorate(event(OP.CREATE_BUFFER, RESOURCE.BUFFER, 7)).generation, 2);
  assert.equal(tracker.decorate(event(OP.SET_VERTEX_BUFFER, RESOURCE.BUFFER, 7)).generation, 2);

  const state = tracker.snapshot();
  assert.equal(state.schema, WGPU_RESOURCE_GENERATION_TRACKER_SCHEMA);
  assert.equal(state.failed, false);
  assert.deepEqual(
    state.resources.find((entry) => entry.resourceClass === RESOURCE.BUFFER),
    { resourceClass: RESOURCE.BUFFER, resourceId: 7, generation: 2, alive: true }
  );
});

test("equal numeric ids in separate resource classes never share generations", () => {
  const tracker = readyTracker();
  tracker.decorate(event(OP.CREATE_BUFFER, RESOURCE.BUFFER, 9));
  tracker.decorate(event(OP.CREATE_TEXTURE, RESOURCE.TEXTURE, 9));
  tracker.decorate(event(OP.DESTROY, RESOURCE.BUFFER, 9, { args: [1, 9] }));
  assert.equal(tracker.decorate(event(OP.CREATE_BUFFER, RESOURCE.BUFFER, 9)).generation, 2);
  assert.equal(tracker.decorate(event(OP.UPLOAD_TEXTURE, RESOURCE.TEXTURE, 9)).generation, 1);

  const idNine = tracker.snapshot().resources.filter((entry) => entry.resourceId === 9);
  assert.deepEqual(
    idNine.map(({ resourceClass, generation }) => [resourceClass, generation]),
    [
      [RESOURCE.BUFFER, 2],
      [RESOURCE.TEXTURE, 1],
      [RESOURCE.FRAMEBUFFER, 1],
    ]
  );
});

test("staged overlays are isolated on abort and become authoritative on commit", () => {
  const tracker = readyTracker();
  tracker.decorate(event(OP.CREATE_BUFFER, RESOURCE.BUFFER, 3));

  tracker.beginTransaction(10);
  assert.equal(tracker.decorate(
    event(OP.DESTROY, RESOURCE.BUFFER, 3, { transaction: 10, args: [1, 3] }),
    { staged: true }
  ).generation, 1);
  assert.equal(tracker.decorate(
    event(OP.CREATE_BUFFER, RESOURCE.BUFFER, 3, { transaction: 10 }),
    { staged: true }
  ).generation, 2);
  tracker.abort(10);
  assert.equal(tracker.decorate(event(OP.UPLOAD_BUFFER, RESOURCE.BUFFER, 3)).generation, 1);

  tracker.beginTransaction(11);
  tracker.decorate(
    event(OP.DESTROY, RESOURCE.BUFFER, 3, { transaction: 11, args: [1, 3] }),
    { staged: true }
  );
  const stagedCreate = tracker.decorate(
    event(OP.CREATE_BUFFER, RESOURCE.BUFFER, 3, { transaction: 11 }),
    { staged: true }
  );
  assert.equal(stagedCreate.generation, 2);
  tracker.commit(11);
  assert.equal(tracker.decorate(event(OP.UPLOAD_BUFFER, RESOURCE.BUFFER, 3)).generation, 2);
  assert.equal(tracker.snapshot().committedTransactionCount, 1);
  assert.equal(tracker.snapshot().abortedTransactionCount, 1);
});

test("an aborted staged create does not consume a generation", () => {
  const tracker = readyTracker();
  tracker.beginTransaction(4);
  tracker.decorate(
    event(OP.CREATE_SAMPLER, RESOURCE.SAMPLER, 55, { transaction: 4 }),
    { staged: true }
  );
  tracker.abort(4);
  assert.equal(tracker.decorate(event(OP.CREATE_SAMPLER, RESOURCE.SAMPLER, 55)).generation, 1);
});

test("load preserves the observed registry while a consumer reset clears it", () => {
  const tracker = readyTracker();
  tracker.decorate(event(OP.CREATE_BUFFER, RESOURCE.BUFFER, 12));
  tracker.beginEpoch(2, { kind: EPOCH.LOAD });
  assert.equal(tracker.decorate(event(OP.UPLOAD_BUFFER, RESOURCE.BUFFER, 12)).generation, 1);
  assert.equal(tracker.snapshot().baselineKnown, true);

  const reset = tracker.beginEpoch(3, { kind: EPOCH.CONSUMER_RESET });
  assert.equal(reset.knownResourceCount, 0);
  assert.equal(reset.liveResourceCount, 0);
  assert.equal(tracker.decorate(event(OP.CREATE_BUFFER, RESOURCE.BUFFER, 12)).generation, 1);
});

test("activation at a load boundary fails closed on an unobserved live resource", () => {
  const tracker = createWgpuResourceGenerationTracker();
  assert.throws(
    () => tracker.beginEpoch(1, { kind: EPOCH.LOAD }),
    /cannot establish a resource baseline midstream/
  );
  assert.equal(tracker.snapshot().failed, true);
  assert.equal(tracker.snapshot().baselineKnown, false);

  tracker.beginEpoch(2, { kind: EPOCH.CONSUMER_RESET });
  assert.equal(tracker.snapshot().failed, false);
  assert.equal(tracker.decorate(event(OP.CREATE_BUFFER, RESOURCE.BUFFER, 1)).generation, 1);
});

test("pipeline dependencies preserve vertex/fragment order for direct and exact WPL3 forms", () => {
  const tracker = readyTracker();
  tracker.decorate(event(OP.CREATE_SHADER, RESOURCE.SHADER, 101));
  tracker.decorate(event(OP.CREATE_SHADER, RESOURCE.SHADER, 102));

  const direct = tracker.decorate(event(OP.CREATE_PIPELINE, RESOURCE.PIPELINE, 201, {
    args: [201, 101, 102, 3],
  }));
  assert.deepEqual(direct.dependencies, [
    dependency("vertex-shader", RESOURCE.SHADER, 101, 1),
    dependency("fragment-shader", RESOURCE.SHADER, 102, 1),
  ]);

  const packaged = tracker.decorate(event(OP.CREATE_PIPELINE_CFG, RESOURCE.PIPELINE, 202, {
    args: [202],
    payloadBytes: wpl3(101, 102, [[0, 2, 0]]),
  }));
  assert.equal(packaged.generation, 1);
  assert.deepEqual(packaged.dependencies, direct.dependencies);
  assert.ok(Object.isFrozen(packaged));
  assert.ok(Object.isFrozen(packaged.dependencies));
  assert.ok(packaged.dependencies.every(Object.isFrozen));
});

test("exact WBG1 entries preserve wire order, binding, class, and generation", () => {
  const tracker = readyTracker();
  tracker.decorate(event(OP.CREATE_BUFFER, RESOURCE.BUFFER, 301));
  tracker.decorate(event(OP.CREATE_TEXTURE, RESOURCE.TEXTURE, 302));
  tracker.decorate(event(OP.CREATE_SAMPLER, RESOURCE.SAMPLER, 303));

  const bindGroup = tracker.decorate(event(OP.CREATE_BIND_GROUP, RESOURCE.BIND_GROUP, 400, {
    args: [400, 1],
    payloadBytes: wbg1(1, [
      [0, 0, 301, 0, 16],
      [7, 1, 302, 0, 0],
      [8, 2, 303, 0, 0],
      [3, 0, 301, 64, 256],
      [4, 3, 301, 0, 0],
    ]),
  }));

  assert.deepEqual(bindGroup.dependencies, [
    dependency("bind-entry", RESOURCE.BUFFER, 301, 1, 0),
    dependency("bind-entry", RESOURCE.TEXTURE, 302, 1, 7),
    dependency("bind-entry", RESOURCE.SAMPLER, 303, 1, 8),
    dependency("bind-entry", RESOURCE.BUFFER, 301, 1, 3),
    dependency("bind-entry", RESOURCE.BUFFER, 301, 1, 4),
  ]);
});

test("framebuffer aliases, depth attachments, and blits carry exact generations", () => {
  const tracker = readyTracker();
  tracker.decorate(event(OP.CREATE_TEXTURE, RESOURCE.TEXTURE, 41));
  tracker.decorate(event(OP.CREATE_TEXTURE, RESOURCE.TEXTURE, 42));
  tracker.decorate(event(OP.CREATE_TEXTURE, RESOURCE.TEXTURE, 43));

  const pass = tracker.decorate(event(OP.BEGIN_PASS, RESOURCE.FRAMEBUFFER, 41, {
    args: [41, 0, 0, 0, 0, 1, 43],
  }));
  assert.equal(pass.generation, 1);
  assert.deepEqual(pass.dependencies, [
    dependency("depth-attachment", RESOURCE.TEXTURE, 43, 1),
  ]);
  assert.equal(tracker.decorate(event(OP.BEGIN_PASS, RESOURCE.FRAMEBUFFER, 0, {
    args: [0, 0, 0, 0, 0, 0, 0],
  })).generation, 1);

  const blit = tracker.decorate(event(OP.BLIT_TEXTURE, RESOURCE.TEXTURE, 41, {
    args: [41, 42],
  }));
  assert.equal(blit.generation, 1);
  assert.deepEqual(blit.dependencies, [
    dependency("blit-destination", RESOURCE.TEXTURE, 42, 1),
  ]);

  tracker.decorate(event(OP.DESTROY, RESOURCE.TEXTURE, 41, { args: [2, 41] }));
  tracker.decorate(event(OP.CREATE_TEXTURE, RESOURCE.TEXTURE, 41));
  assert.equal(tracker.decorate(event(OP.BEGIN_PASS, RESOURCE.FRAMEBUFFER, 41, {
    args: [41, 0, 0, 0, 0, 0, 0],
  })).generation, 2);
});

test("unproven package envelopes and malformed WPL3/WBG1 payloads fail closed", () => {
  const raw = readyTracker();
  assert.throws(() => raw.decorate(new Uint32Array(8)), /raw package records are unsupported/);
  assert.equal(raw.snapshot().failed, true);

  const badPipeline = readyTracker();
  badPipeline.decorate(event(OP.CREATE_SHADER, RESOURCE.SHADER, 1));
  badPipeline.decorate(event(OP.CREATE_SHADER, RESOURCE.SHADER, 2));
  const extraWord = new Uint8Array(wpl3(1, 2).byteLength + 4);
  extraWord.set(wpl3(1, 2));
  assert.throws(
    () => badPipeline.decorate(event(OP.CREATE_PIPELINE_CFG, RESOURCE.PIPELINE, 3, {
      payloadBytes: extraWord,
    })),
    /does not match attribute count/
  );
  assert.equal(badPipeline.snapshot().failed, true);

  const badBindGroup = readyTracker();
  badBindGroup.decorate(event(OP.CREATE_BUFFER, RESOURCE.BUFFER, 1));
  const malformed = wbg1(0, [[0, 0, 1, 0, 4]]);
  new DataView(malformed.buffer).setUint32(0, 0x12345678, true);
  assert.throws(
    () => badBindGroup.decorate(event(OP.CREATE_BIND_GROUP, RESOURCE.BIND_GROUP, 2, {
      args: [2, 0],
      payloadBytes: malformed,
    })),
    /invalid magic/
  );
  assert.equal(badBindGroup.snapshot().failed, true);
});

test("commit rejects a staged read whose base incarnation changed concurrently", () => {
  const tracker = readyTracker();
  tracker.decorate(event(OP.CREATE_BUFFER, RESOURCE.BUFFER, 5));
  tracker.beginTransaction(9);
  tracker.decorate(
    event(OP.UPLOAD_BUFFER, RESOURCE.BUFFER, 5, { transaction: 9 }),
    { staged: true }
  );
  tracker.decorate(event(OP.DESTROY, RESOURCE.BUFFER, 5, { args: [1, 5] }));
  tracker.decorate(event(OP.CREATE_BUFFER, RESOURCE.BUFFER, 5));
  assert.throws(() => tracker.commit(9), /changed while transaction 9 was staged/);
  assert.equal(tracker.snapshot().failed, true);
});

test("committed, accepted, and discarded staged counters remain distinct", () => {
  const tracker = readyTracker();
  tracker.decorate(event(OP.CREATE_BUFFER, RESOURCE.BUFFER, 1));

  tracker.beginTransaction(1);
  tracker.decorate(event(OP.UPLOAD_BUFFER, RESOURCE.BUFFER, 1, { transaction: 1 }), {
    staged: true,
  });
  tracker.decorate(event(OP.CREATE_SAMPLER, RESOURCE.SAMPLER, 2, { transaction: 1 }), {
    staged: true,
  });
  tracker.abort(1);

  let state = tracker.snapshot();
  assert.equal(state.acceptedEventCount, 3);
  assert.equal(state.decoratedEventCount, 1);
  assert.equal(state.discardedStagedEventCount, 2);
  assert.equal(state.createCount, 1);
  assert.equal(state.useCount, 0);

  tracker.beginTransaction(2);
  tracker.decorate(event(OP.CREATE_SAMPLER, RESOURCE.SAMPLER, 2, { transaction: 2 }), {
    staged: true,
  });
  tracker.commit(2);
  state = tracker.snapshot();
  assert.equal(state.acceptedEventCount, 4);
  assert.equal(state.decoratedEventCount, 2);
  assert.equal(state.createCount, 2);
});

test("texture aliases reserve two bounded resource keys atomically", () => {
  const tracker = createWgpuResourceGenerationTracker({ maxTrackedResources: 1 });
  tracker.beginEpoch(1, { kind: EPOCH.CONSUMER_RESET });
  assert.throws(
    () => tracker.decorate(event(OP.CREATE_TEXTURE, RESOURCE.TEXTURE, 7)),
    /resource tracking limit 1 exceeded/
  );
  const failed = tracker.snapshot();
  assert.equal(failed.knownResourceCount, 0);
  assert.equal(failed.liveResourceCount, 0);

  const exact = createWgpuResourceGenerationTracker({ maxTrackedResources: 2 });
  exact.beginEpoch(1, { kind: EPOCH.CONSUMER_RESET });
  exact.decorate(event(OP.CREATE_TEXTURE, RESOURCE.TEXTURE, 7));
  assert.equal(exact.snapshot().knownResourceCount, 2);
});

test("tombstone retention is bounded without consuming recreate generations", () => {
  const tracker = createWgpuResourceGenerationTracker({ maxTrackedResources: 1 });
  tracker.beginEpoch(1, { kind: EPOCH.CONSUMER_RESET });
  tracker.decorate(event(OP.CREATE_BUFFER, RESOURCE.BUFFER, 1));
  tracker.decorate(event(OP.DESTROY, RESOURCE.BUFFER, 1, { args: [1, 1] }));
  assert.equal(tracker.decorate(event(OP.CREATE_BUFFER, RESOURCE.BUFFER, 1)).generation, 2);
  tracker.decorate(event(OP.DESTROY, RESOURCE.BUFFER, 1, { args: [1, 1] }));
  assert.throws(
    () => tracker.decorate(event(OP.CREATE_BUFFER, RESOURCE.BUFFER, 2)),
    /resource tracking limit 1 exceeded/
  );
  assert.equal(tracker.snapshot().knownResourceCount, 1);
});

test("dependency payload parsing is bounded before decoding", () => {
  const tracker = createWgpuResourceGenerationTracker({ maxDependencyPayloadBytes: 100 });
  tracker.beginEpoch(1, { kind: EPOCH.CONSUMER_RESET });
  tracker.decorate(event(OP.CREATE_SHADER, RESOURCE.SHADER, 1));
  tracker.decorate(event(OP.CREATE_SHADER, RESOURCE.SHADER, 2));
  assert.throws(
    () => tracker.decorate(event(OP.CREATE_PIPELINE_CFG, RESOURCE.PIPELINE, 3, {
      payloadBytes: wpl3(1, 2),
    })),
    /WPL3 payload exceeds 100 bytes/
  );
  assert.equal(tracker.snapshot().knownResourceCount, 2);
});

test("annotations retain derived evidence without copying the command payload", () => {
  const tracker = readyTracker();
  tracker.decorate(event(OP.CREATE_BUFFER, RESOURCE.BUFFER, 1));
  const payloadBytes = wbg1(0, [[3, 0, 1, 0, 4]]);
  const annotation = tracker.decorate(event(OP.CREATE_BIND_GROUP, RESOURCE.BIND_GROUP, 2, {
    args: [2, 0],
    payloadBytes,
  }));
  payloadBytes.fill(0);
  assert.deepEqual(Object.keys(annotation), ["generation", "dependencies"]);
  assert.deepEqual(annotation.dependencies, [
    dependency("bind-entry", RESOURCE.BUFFER, 1, 1, 3),
  ]);
  assert.ok(Object.isFrozen(annotation));
  assert.ok(Object.isFrozen(annotation.dependencies[0]));
});

test("WBG1 group and binding identity fail closed", () => {
  const wrongGroup = readyTracker();
  assert.throws(
    () => wrongGroup.decorate(event(OP.CREATE_BIND_GROUP, RESOURCE.BIND_GROUP, 1, {
      args: [1, 1],
      payloadBytes: wbg1(0, []),
    })),
    /does not match canonical group/
  );

  const duplicate = readyTracker();
  duplicate.decorate(event(OP.CREATE_BUFFER, RESOURCE.BUFFER, 1));
  assert.throws(
    () => duplicate.decorate(event(OP.CREATE_BIND_GROUP, RESOURCE.BIND_GROUP, 2, {
      args: [2, 0],
      payloadBytes: wbg1(0, [[3, 0, 1, 0, 4], [3, 0, 1, 4, 4]]),
    })),
    /binding 3 is duplicated/
  );
});

test("epoch controls fail sticky and recover only through an exact consumer reset", () => {
  const tracker = createWgpuResourceGenerationTracker();
  assert.throws(() => tracker.beginEpoch(1), /must be load or consumer-reset/);
  assert.equal(tracker.snapshot().failed, true);
  tracker.beginEpoch(1, { kind: EPOCH.CONSUMER_RESET });
  assert.equal(tracker.snapshot().failed, false);

  assert.throws(
    () => tracker.beginEpoch(3, { kind: EPOCH.CONSUMER_RESET }),
    /does not follow 1/
  );
  assert.throws(
    () => tracker.decorate(event(OP.CREATE_BUFFER, RESOURCE.BUFFER, 1)),
    /tracker is failed/
  );
  tracker.beginEpoch(2, { kind: EPOCH.CONSUMER_RESET });
  assert.equal(tracker.snapshot().failed, false);
  assert.equal(tracker.snapshot().consumerResetEpochCount, 2);
});

test("a failed tracker cannot advance through a load boundary or grow failure evidence", () => {
  const tracker = readyTracker();
  assert.throws(
    () => tracker.decorate(event(OP.UPLOAD_BUFFER, RESOURCE.BUFFER, 99)),
    /no known live incarnation/
  );
  const first = tracker.snapshot();
  assert.equal(first.epoch, 1);
  assert.equal(first.reasons.length, 1);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    assert.throws(
      () => tracker.decorate(event(OP.UPLOAD_BUFFER, RESOURCE.BUFFER, 99)),
      /consumer-reset required/
    );
  }
  assert.throws(
    () => tracker.beginEpoch(2, { kind: EPOCH.LOAD }),
    /consumer-reset required/
  );
  const stuck = tracker.snapshot();
  assert.equal(stuck.epoch, 1);
  assert.equal(stuck.epochCount, 1);
  assert.equal(stuck.reasons.length, 1);
  assert.equal(stuck.historicalFailureCount, 1);

  tracker.beginEpoch(2, { kind: EPOCH.CONSUMER_RESET });
  assert.equal(tracker.snapshot().failed, false);
});

test("snapshot discloses that dependency encoding and runtime integration are not ready", () => {
  const state = readyTracker().snapshot();
  assert.equal(state.dependencyEncodingReady, false);
  assert.equal(state.runtimeIntegrationReady, false);
});

function readyTracker() {
  const tracker = createWgpuResourceGenerationTracker();
  tracker.beginEpoch(1, { kind: EPOCH.CONSUMER_RESET });
  return tracker;
}

function event(opcode, resourceClass, resourceId, overrides = {}) {
  return {
    kind: KIND.COMMAND,
    opcode,
    resourceClass,
    resourceId,
    args: [],
    payloadBytes: EMPTY,
    ...overrides,
  };
}

function dependency(role, resourceClass, resourceId, generation, binding = null) {
  const value = { role, resourceClass, resourceId, generation };
  if (binding != null) value.binding = binding;
  return value;
}

function wpl3(vertexShaderId, fragmentShaderId, attributes = []) {
  const words = new Uint32Array(26 + attributes.length * 3);
  words[0] = 0x57504c33;
  words[1] = vertexShaderId;
  words[2] = fragmentShaderId;
  words[25] = attributes.length;
  attributes.forEach((attribute, index) => words.set(attribute, 26 + index * 3));
  return leBytes(words);
}

function wbg1(group, entries) {
  const words = new Uint32Array(3 + entries.length * 5);
  words[0] = 0x57424731;
  words[1] = group;
  words[2] = entries.length;
  entries.forEach((entry, index) => words.set(entry, 3 + index * 5));
  return leBytes(words);
}

function leBytes(words) {
  const bytes = new Uint8Array(words.length * 4);
  const view = new DataView(bytes.buffer);
  words.forEach((word, index) => view.setUint32(index * 4, word, true));
  return bytes;
}
