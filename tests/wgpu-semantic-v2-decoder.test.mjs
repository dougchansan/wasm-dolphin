import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  encodeWgpuSemanticEvent,
  encodeWgpuSemanticEventV2,
} from "../src/wgpu-semantic-digest.js";
import { decodeWgpuSemanticEventV2 } from "../src/wgpu-semantic-v2-decoder.js";

function event(overrides = {}) {
  return {
    kind: 1,
    epoch: 7,
    transaction: 11,
    sequenceLo: 13,
    sequenceHi: 17,
    opcode: 0,
    resourceClass: 0,
    resourceId: 0,
    generation: 0,
    args: [],
    dependencies: [],
    payloadBytes: new Uint8Array(),
    ...overrides,
  };
}

test("independent WDS2 decoder round-trips a canonical linked pipeline", () => {
  const input = pipelineEvent();
  const frame = encodeWgpuSemanticEventV2(input);
  const decoded = decodeWgpuSemanticEventV2(frame);

  assert.deepEqual(decoded, {
    kind: input.kind,
    epoch: input.epoch,
    transaction: input.transaction,
    sequenceLo: input.sequenceLo,
    sequenceHi: input.sequenceHi,
    opcode: input.opcode,
    resourceClass: input.resourceClass,
    resourceId: input.resourceId,
    generation: input.generation,
    args: input.args,
    dependencies: input.dependencies.map((dependency, index) => ({
      ...dependency,
      roleTag: index + 1,
    })),
    payloadLength: input.payloadBytes.byteLength,
    payloadDigest: Array.from(createHash("sha256").update(input.payloadBytes).digest()),
  });
});

test("canonical dependency roles cover bind entries, pass depth, and blit destination", () => {
  const bindGroup = decodeWgpuSemanticEventV2(encodeWgpuSemanticEventV2(bindGroupEvent()));
  assert.deepEqual(bindGroup.dependencies.map((dependency) => [
    dependency.role,
    dependency.resourceClass,
    dependency.binding,
  ]), [
    ["bind-entry", 3, 0],
    ["bind-entry", 4, 7],
    ["bind-entry", 5, 8],
  ]);

  const pass = decodeWgpuSemanticEventV2(encodeWgpuSemanticEventV2(passEvent()));
  assert.deepEqual(pass.dependencies, [{
    role: "depth-attachment",
    roleTag: 4,
    resourceClass: 4,
    resourceId: 53,
    generation: 7,
  }]);

  const blit = decodeWgpuSemanticEventV2(encodeWgpuSemanticEventV2(blitEvent()));
  assert.equal(blit.dependencies[0].role, "blit-destination");
  assert.equal(blit.dependencies[0].resourceId, blit.args[1]);

  const configured = decodeWgpuSemanticEventV2(
    encodeWgpuSemanticEventV2(configuredPipelineEvent())
  );
  assert.deepEqual(
    configured.dependencies.map((dependency) => dependency.role),
    ["vertex-shader", "fragment-shader"]
  );
});

test("canonical validator accepts all 25 legacy command shapes", () => {
  const commands = [
    event(),
    event({ opcode: 1, args: [0, 0, 0, 0] }),
    event({
      opcode: 2,
      resourceClass: 1,
      resourceId: 1,
      generation: 1,
      args: [1, 0],
      payloadBytes: Uint8Array.of(1),
    }),
    pipelineEvent(),
    event({ opcode: 4, resourceClass: 2, resourceId: 2, generation: 1, args: [2, 3] }),
    event({ opcode: 5, resourceClass: 3, resourceId: 3, generation: 1, args: [3, 64, 1] }),
    event({
      opcode: 6,
      resourceClass: 3,
      resourceId: 3,
      generation: 1,
      args: [3, 0, 4, 0],
      payloadBytes: Uint8Array.of(1, 2, 3, 4),
    }),
    event({
      opcode: 7,
      resourceClass: 4,
      resourceId: 4,
      generation: 1,
      args: [4, 16, 16, 1, 1, 1],
    }),
    event({
      opcode: 8,
      resourceClass: 4,
      resourceId: 4,
      generation: 1,
      args: [4, 4, 1, 2, 0, 0],
      payloadBytes: Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8),
    }),
    configuredPipelineEvent(),
    event({ opcode: 10, resourceClass: 5, resourceId: 5, generation: 1, args: [5, 0] }),
    bindGroupEvent(),
    passEvent(),
    event({ opcode: 13, resourceClass: 2, resourceId: 2, generation: 1, args: [2] }),
    event({ opcode: 14, resourceClass: 6, resourceId: 6, generation: 1,
      args: [0, 6, 2, 256, 512] }),
    event({ opcode: 15, resourceClass: 3, resourceId: 3, generation: 1,
      args: [0, 3, 16] }),
    event({ opcode: 16, resourceClass: 3, resourceId: 3, generation: 1,
      args: [3, 1, 32] }),
    event({ opcode: 17, args: [0, 0, 1, 1, 0, 1] }),
    event({ opcode: 18, args: [0, 0, 16, 16] }),
    event({ opcode: 19, args: [3, 1, 0] }),
    event({ opcode: 20, args: [3, 1, 0, 0] }),
    event({ opcode: 21 }),
    event({ opcode: 22 }),
    event({ opcode: 23, resourceClass: 3, resourceId: 3, generation: 1, args: [1, 3] }),
    blitEvent(),
  ];
  assert.deepEqual(
    commands.map((command) => decodeWgpuSemanticEventV2(
      encodeWgpuSemanticEventV2(command)
    ).opcode),
    Array.from({ length: 25 }, (_, opcode) => opcode)
  );
});

test("decoded WDS2 values are immutable snapshots independent of producer storage", () => {
  const frame = encodeWgpuSemanticEventV2(pipelineEvent());
  const decoded = decodeWgpuSemanticEventV2(frame);
  const firstArg = decoded.args[0];
  const firstDigestByte = decoded.payloadDigest[0];
  const firstDependencyId = decoded.dependencies[0].resourceId;

  assert.ok(Object.isFrozen(decoded));
  assert.ok(Object.isFrozen(decoded.args));
  assert.ok(Object.isFrozen(decoded.dependencies));
  assert.ok(decoded.dependencies.every(Object.isFrozen));
  assert.ok(Object.isFrozen(decoded.payloadDigest));
  assert.throws(() => { decoded.args[0] = 99; }, TypeError);
  assert.throws(() => { decoded.dependencies[0].resourceId = 99; }, TypeError);
  assert.throws(() => { decoded.payloadDigest[0] = 99; }, TypeError);

  frame.fill(0);
  assert.equal(decoded.args[0], firstArg);
  assert.equal(decoded.dependencies[0].resourceId, firstDependencyId);
  assert.equal(decoded.payloadDigest[0], firstDigestByte);
});

test("decoder honors an exact byte-view offset and little-endian words", () => {
  const encoded = encodeWgpuSemanticEventV2(event({
    opcode: 1,
    args: [0x1234_5678, 0, 0x8000_0000, 0xffff_ffff],
  }));
  const storage = new Uint8Array(encoded.byteLength + 10).fill(0xa5);
  storage.set(encoded, 6);
  const decoded = decodeWgpuSemanticEventV2(storage.subarray(6, 6 + encoded.byteLength));
  assert.deepEqual(decoded.args, [0x1234_5678, 0, 0x8000_0000, 0xffff_ffff]);

  const wrongEndian = encoded.slice();
  wrongEndian.set([...wrongEndian.subarray(0, 4)].reverse(), 0);
  assert.throws(() => decodeWgpuSemanticEventV2(wrongEndian), /body length/);
});

test("decoder rejects WDS1, wrong WDS2 versions, and non-byte inputs", () => {
  const v1 = encodeWgpuSemanticEvent({
    ...event({ dependencies: undefined }),
  });
  assert.throws(() => decodeWgpuSemanticEventV2(v1), /truncated|magic .*unsupported/);

  const wrongVersion = encodeWgpuSemanticEventV2(event());
  setWord(wrongVersion, 2, 3);
  assert.throws(() => decodeWgpuSemanticEventV2(wrongVersion), /version 3 is unsupported/);
  assert.throws(() => decodeWgpuSemanticEventV2(new Uint32Array(24)), /Uint8Array or ArrayBuffer/);
});

test("decoder rejects trailing, truncated, misaligned, and count-inconsistent frames", () => {
  const encoded = encodeWgpuSemanticEventV2(event({ args: [], dependencies: [] }));
  assert.throws(
    () => decodeWgpuSemanticEventV2(encoded.subarray(0, encoded.byteLength - 1)),
    /body length|truncated/
  );

  const trailing = new Uint8Array(encoded.byteLength + 1);
  trailing.set(encoded);
  assert.throws(() => decodeWgpuSemanticEventV2(trailing), /body length/);

  const alignedTrailing = new Uint8Array(encoded.byteLength + 4);
  alignedTrailing.set(encoded);
  setWord(alignedTrailing, 0, alignedTrailing.byteLength - 4);
  assert.throws(() => decodeWgpuSemanticEventV2(alignedTrailing), /counts require/);

  const misaligned = new Uint8Array(encoded.byteLength + 1);
  misaligned.set(encoded);
  setWord(misaligned, 0, misaligned.byteLength - 4);
  assert.throws(() => decodeWgpuSemanticEventV2(misaligned), /four-byte aligned/);

  const noTrailer = encoded.slice();
  setWord(noTrailer, 12, 9);
  assert.throws(() => decodeWgpuSemanticEventV2(noTrailer), /truncated before|counts require/);
});

test("decoder rejects argument and dependency counts above their exact maxima", () => {
  const noArgs = encodeWgpuSemanticEventV2(event({ args: [], dependencies: [] }));
  setWord(noArgs, 12, 4_097);
  assert.throws(() => decodeWgpuSemanticEventV2(noArgs), /argument count 4097 exceeds 4096/);

  const noDependencies = encodeWgpuSemanticEventV2(event({ args: [], dependencies: [] }));
  setWord(noDependencies, 13, 65_536);
  assert.throws(
    () => decodeWgpuSemanticEventV2(noDependencies),
    /dependency count 65536 exceeds 65535/
  );

  const maliciousCount = encodeWgpuSemanticEventV2(event({ args: [], dependencies: [] }));
  setWord(maliciousCount, 12, 0xffff_ffff);
  assert.throws(() => decodeWgpuSemanticEventV2(maliciousCount), /argument count/);
});

test("decoder rejects unknown dependency roles and incompatible resource classes", () => {
  const baseline = singleDependency({
    role: "vertex-shader",
    resourceClass: 1,
    resourceId: 1,
    generation: 1,
  });
  setWord(baseline, dependencyWord(0), 99);
  assert.throws(() => decodeWgpuSemanticEventV2(baseline), /role tag 99 is unsupported/);

  const wrongShaderClass = singleDependency({
    role: "vertex-shader",
    resourceClass: 1,
    resourceId: 1,
    generation: 1,
  });
  setWord(wrongShaderClass, dependencyWord(1), 3);
  assert.throws(() => decodeWgpuSemanticEventV2(wrongShaderClass), /incompatible resource class 3/);

  const wrongBindClass = singleDependency({
    role: "bind-entry",
    resourceClass: 3,
    resourceId: 1,
    generation: 1,
    binding: 0,
  });
  setWord(wrongBindClass, dependencyWord(1), 6);
  assert.throws(() => decodeWgpuSemanticEventV2(wrongBindClass), /incompatible resource class 6/);
});

test("decoder rejects zero dependency identity and generation", () => {
  const zeroId = singleDependency({
    role: "depth-attachment",
    resourceClass: 4,
    resourceId: 1,
    generation: 1,
  });
  setWord(zeroId, dependencyWord(2), 0);
  assert.throws(() => decodeWgpuSemanticEventV2(zeroId), /resource id must be nonzero/);

  const zeroGeneration = singleDependency({
    role: "blit-destination",
    resourceClass: 4,
    resourceId: 1,
    generation: 1,
  });
  setWord(zeroGeneration, dependencyWord(3), 0);
  assert.throws(() => decodeWgpuSemanticEventV2(zeroGeneration), /generation must be nonzero/);
});

test("decoder enforces canonical binding presence and absent words", () => {
  const invalidPresence = singleDependency({
    role: "bind-entry",
    resourceClass: 3,
    resourceId: 1,
    generation: 1,
    binding: 0,
  });
  setWord(invalidPresence, dependencyWord(4), 2);
  assert.throws(() => decodeWgpuSemanticEventV2(invalidPresence), /exactly 0 or 1/);

  const absentNonzero = singleDependency({
    role: "vertex-shader",
    resourceClass: 1,
    resourceId: 1,
    generation: 1,
  });
  setWord(absentNonzero, dependencyWord(5), 9);
  assert.throws(() => decodeWgpuSemanticEventV2(absentNonzero), /absent binding word must be zero/);

  const bindMissing = singleDependency({
    role: "bind-entry",
    resourceClass: 3,
    resourceId: 1,
    generation: 1,
    binding: 0,
  });
  setWord(bindMissing, dependencyWord(4), 0);
  assert.throws(() => decodeWgpuSemanticEventV2(bindMissing), /bind-entry requires a binding/);

  const shaderWithBinding = singleDependency({
    role: "vertex-shader",
    resourceClass: 1,
    resourceId: 1,
    generation: 1,
  });
  setWord(shaderWithBinding, dependencyWord(4), 1);
  assert.throws(() => decodeWgpuSemanticEventV2(shaderWithBinding), /cannot carry a binding/);
});

test("canonical validator rejects unsupported kinds, opcodes, and primary identities", () => {
  assertDecodeRejects(event({ kind: 2 }), /event kind 2 is unsupported/);
  assertDecodeRejects(event({ opcode: 25 }), /command opcode 25 is unsupported/);
  assertDecodeRejects(event({ resourceClass: 3 }), /resource class 3 must be 0/);
  assertDecodeRejects(event({ resourceId: 1 }), /resource-free primary id and generation/);
  assertDecodeRejects(event({ generation: 1 }), /resource-free primary id and generation/);

  assertDecodeRejects({
    ...pipelineEvent(),
    resourceId: 99,
  }, /primary id 99 does not match argument 0/);
  assertDecodeRejects({
    ...pipelineEvent(),
    generation: 0,
  }, /primary generation must be nonzero/);
  assertDecodeRejects({
    ...passEvent(),
    resourceId: 0,
    generation: 2,
    args: [0, 0, 0, 0, 0, 1, 53],
  }, /virtual framebuffer generation must be 1/);
});

test("canonical validator enforces exact arguments and resource linkage", () => {
  assertDecodeRejects(event({ opcode: 1, args: [1, 2, 3] }), /exactly 4 arguments/);
  assertDecodeRejects(event({ opcode: 19, args: [0, 0, 1] }), /vertex count must be nonzero/);
  assertDecodeRejects(event({ opcode: 20, args: [0, 0, 0, 0] }), /index count must be nonzero/);
  assertDecodeRejects(event({
    opcode: 7,
    resourceClass: 4,
    resourceId: 9,
    generation: 1,
    args: [9, 0, 2, 4, 1, 1],
  }), /width must be nonzero/);
  assertDecodeRejects(event({
    opcode: 14,
    resourceClass: 6,
    resourceId: 9,
    generation: 1,
    args: [0, 9, 2, 16],
  }), /exactly 5 arguments/);
  assertDecodeRejects(event({
    opcode: 14,
    resourceClass: 6,
    resourceId: 9,
    generation: 1,
    args: [3, 9, 0],
  }), /group 3 is unsupported/);
  assertDecodeRejects(event({
    opcode: 23,
    resourceClass: 4,
    resourceId: 9,
    generation: 1,
    args: [1, 9],
  }), /resource class 4 must be 3/);
  const wideSwizzle = blitEvent();
  wideSwizzle.args = [...wideSwizzle.args];
  wideSwizzle.args[10] = 256;
  assertDecodeRejects(wideSwizzle, /channel argument 10 exceeds one byte/);
});

test("canonical validator enforces opcode payload length and empty digest rules", () => {
  assertDecodeRejects(
    event({ payloadLength: 1 }),
    /forbids payload length 1/,
    Uint8Array.from({ length: 32 }, (_, index) => index)
  );
  assertDecodeRejects(
    event(),
    /noncanonical empty-payload digest/,
    new Uint8Array(32)
  );
  assertDecodeRejects(event({
    opcode: 2,
    resourceClass: 1,
    resourceId: 9,
    generation: 1,
    args: [9, 0],
  }), /requires a nonempty payload/);

  assertDecodeRejects(event({
    opcode: 6,
    resourceClass: 3,
    resourceId: 9,
    generation: 1,
    args: [9, 0, 4, 0],
    payloadLength: 3,
  }), /UPLOAD_BUFFER payload length 3 must be 4/, digest(1));
  assertDecodeRejects(event({
    opcode: 6,
    resourceClass: 3,
    resourceId: 9,
    generation: 1,
    args: [9, 0, 4, 7],
    payloadLength: 4,
  }), /upload role 7 is unsupported/, digest(2));
  assertDecodeRejects(event({
    opcode: 8,
    resourceClass: 4,
    resourceId: 9,
    generation: 1,
    args: [9, 0x1_0000, 1, 0x1_0000, 0, 0],
    payloadLength: 1,
  }), /texture upload length overflows u32/, digest(3));
  assertDecodeRejects({
    ...configuredPipelineEvent(),
    payloadBytes: new Uint8Array(105),
  }, /not canonical WPL3/);
  assertDecodeRejects({
    ...bindGroupEvent(),
    payloadBytes: new Uint8Array(71),
  }, /payload length 71 must be 72/);
});

test("canonical validator enforces dependency cardinality, order, and linkage", () => {
  assertDecodeRejects({
    ...pipelineEvent(),
    dependencies: [],
  }, /requires vertex and fragment shader dependencies/);
  assertDecodeRejects({
    ...pipelineEvent(),
    dependencies: [...pipelineEvent().dependencies].reverse(),
  }, /dependency order must be vertex then fragment/);
  assertDecodeRejects({
    ...pipelineEvent(),
    dependencies: [
      { ...pipelineEvent().dependencies[0], resourceId: 99 },
      pipelineEvent().dependencies[1],
    ],
  }, /dependencies do not match pipeline arguments/);
  assertDecodeRejects(event({
    dependencies: [
      { role: "vertex-shader", resourceClass: 1, resourceId: 1, generation: 1 },
    ],
  }), /opcode 0 forbids 1 dependencies/);

  const duplicate = bindGroupEvent();
  duplicate.dependencies = duplicate.dependencies.map((dependency) => ({
    ...dependency,
    binding: 0,
  }));
  assertDecodeRejects(duplicate, /binding 0 is duplicated/);

  assertDecodeRejects({
    ...passEvent(),
    dependencies: [],
  }, /requires one depth-attachment dependency linked to resource 53/);
  assertDecodeRejects({
    ...blitEvent(),
    dependencies: [{
      ...blitEvent().dependencies[0],
      resourceId: 99,
    }],
  }, /requires one blit-destination dependency linked to resource 61/);
});

function pipelineEvent() {
  return event({
    opcode: 3,
    resourceClass: 2,
    resourceId: 23,
    generation: 29,
    args: [23, 31, 37, 0],
    dependencies: [
      { role: "vertex-shader", resourceClass: 1, resourceId: 31, generation: 2 },
      { role: "fragment-shader", resourceClass: 1, resourceId: 37, generation: 3 },
    ],
  });
}

function configuredPipelineEvent() {
  return event({
    opcode: 9,
    resourceClass: 2,
    resourceId: 23,
    generation: 1,
    args: [23],
    dependencies: [
      { role: "vertex-shader", resourceClass: 1, resourceId: 31, generation: 2 },
      { role: "fragment-shader", resourceClass: 1, resourceId: 37, generation: 3 },
    ],
    payloadBytes: filled(104, 3),
  });
}

function bindGroupEvent() {
  return event({
    opcode: 11,
    resourceClass: 6,
    resourceId: 67,
    generation: 9,
    args: [67, 1],
    dependencies: [
      { role: "bind-entry", resourceClass: 3, resourceId: 41, generation: 4, binding: 0 },
      { role: "bind-entry", resourceClass: 4, resourceId: 43, generation: 5, binding: 7 },
      { role: "bind-entry", resourceClass: 5, resourceId: 47, generation: 6, binding: 8 },
    ],
    payloadBytes: filled(12 + 3 * 20, 5),
  });
}

function passEvent() {
  return event({
    opcode: 12,
    resourceClass: 7,
    resourceId: 0,
    generation: 1,
    args: [0, 0, 0, 0, 0, 1, 53],
    dependencies: [
      { role: "depth-attachment", resourceClass: 4, resourceId: 53, generation: 7 },
    ],
  });
}

function blitEvent() {
  return event({
    opcode: 24,
    resourceClass: 4,
    resourceId: 59,
    generation: 8,
    args: [59, 61, 0, 0, 2, 2, 0, 0, 2, 2, 0, 0, 0, 0],
    dependencies: [
      { role: "blit-destination", resourceClass: 4, resourceId: 61, generation: 9 },
    ],
  });
}

function assertDecodeRejects(input, pattern, payloadDigest = null) {
  const frame = encodeWgpuSemanticEventV2(input, payloadDigest);
  assert.throws(() => decodeWgpuSemanticEventV2(frame), pattern);
}

function filled(length, seed) {
  return Uint8Array.from({ length }, (_, index) => (index * 17 + seed) & 0xff);
}

function digest(seed) {
  return Uint8Array.from({ length: 32 }, (_, index) => (index + seed) & 0xff);
}

function singleDependency(dependency) {
  return encodeWgpuSemanticEventV2(event({ args: [], dependencies: [dependency] }));
}

// With zero args the dependency count is word 13 and its first record begins
// at word 14. Keeping these indices local is part of the independent oracle.
function dependencyWord(fieldIndex) {
  return 14 + fieldIndex;
}

function setWord(bytes, wordIndex, value) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .setUint32(wordIndex * 4, value >>> 0, true);
}
