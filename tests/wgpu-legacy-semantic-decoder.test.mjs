import assert from "node:assert/strict";
import test from "node:test";

import {
  WGPU_LEGACY_COMMAND_OPCODE as OP,
  WGPU_RESOURCE_CLASS as RESOURCE,
  WGPU_SEMANTIC_EVENT_KIND as KIND,
  decodeLegacyWgpuCommandRecord
} from "../src/wgpu-legacy-semantic-decoder.js";

const heap = Uint8Array.from({ length: 256 }, (_, index) => index);

test("legacy decoder exhaustively maps opcodes 0 through 24 to canonical arguments", () => {
  const cases = [
    { op: OP.NOP, words: [], resource: RESOURCE.NONE, id: 0, args: [] },
    {
      op: OP.CLEAR,
      words: [0x3F800000, 0xBF000000, 0x7FC00001, 0x80000000],
      resource: RESOURCE.NONE,
      id: 0,
      args: [0x3F800000, 0xBF000000, 0x7FC00001, 0x80000000]
    },
    {
      op: OP.CREATE_SHADER,
      words: [101, 16, 3, 2],
      resource: RESOURCE.SHADER,
      id: 101,
      args: [101, 2],
      payload: [16, 17, 18]
    },
    {
      op: OP.CREATE_PIPELINE,
      words: [102, 101, 100, 3],
      resource: RESOURCE.PIPELINE,
      id: 102,
      args: [102, 101, 100, 3]
    },
    {
      op: OP.DRAW_TEST,
      words: [102, 6],
      resource: RESOURCE.PIPELINE,
      id: 102,
      args: [102, 6]
    },
    {
      op: OP.CREATE_BUFFER,
      words: [103, 4096, 0x8A],
      resource: RESOURCE.BUFFER,
      id: 103,
      args: [103, 4096, 0x8A]
    },
    {
      op: OP.UPLOAD_BUFFER,
      words: [103, 128, 20, 4, 6],
      resource: RESOURCE.BUFFER,
      id: 103,
      args: [103, 128, 4, 6],
      payload: [20, 21, 22, 23]
    },
    {
      op: OP.CREATE_TEXTURE,
      words: [104, 640, 528, 4, 0x17, 2],
      resource: RESOURCE.TEXTURE,
      id: 104,
      args: [104, 640, 528, 4, 0x17, 2]
    },
    {
      op: OP.UPLOAD_TEXTURE,
      words: [104, 32, 4, 1, 2, 3, 4],
      resource: RESOURCE.TEXTURE,
      id: 104,
      args: [104, 4, 1, 2, 3, 4],
      payload: [32, 33, 34, 35, 36, 37, 38, 39]
    },
    {
      op: OP.CREATE_PIPELINE_CFG,
      words: [105, 48, 5],
      resource: RESOURCE.PIPELINE,
      id: 105,
      args: [105],
      payload: [48, 49, 50, 51, 52]
    },
    {
      op: OP.CREATE_SAMPLER,
      words: [106, 0x89ABCDEF],
      resource: RESOURCE.SAMPLER,
      id: 106,
      args: [106, 0x89ABCDEF]
    },
    {
      op: OP.CREATE_BIND_GROUP,
      words: [107, 64, 6, 2],
      resource: RESOURCE.BIND_GROUP,
      id: 107,
      args: [107, 2],
      payload: [64, 65, 66, 67, 68, 69]
    },
    {
      op: OP.BEGIN_PASS,
      words: [0, 0x3DCCCCCD, 0x3E4CCCCD, 0x3E99999A, 0x3F800000, 1, 104],
      resource: RESOURCE.FRAMEBUFFER,
      id: 0,
      args: [0, 0x3DCCCCCD, 0x3E4CCCCD, 0x3E99999A, 0x3F800000, 1, 104]
    },
    {
      op: OP.SET_PIPELINE,
      words: [105],
      resource: RESOURCE.PIPELINE,
      id: 105,
      args: [105]
    },
    {
      op: OP.SET_BIND_GROUP,
      words: [1, 107, 2, 256, 512, 0xDEADBEEF, 0xA5A5A5A5],
      resource: RESOURCE.BIND_GROUP,
      id: 107,
      args: [1, 107, 2, 256, 512]
    },
    {
      op: OP.SET_VERTEX_BUFFER,
      words: [0, 103, 384],
      resource: RESOURCE.BUFFER,
      id: 103,
      args: [0, 103, 384]
    },
    {
      op: OP.SET_INDEX_BUFFER,
      words: [103, 1, 768],
      resource: RESOURCE.BUFFER,
      id: 103,
      args: [103, 1, 768]
    },
    {
      op: OP.SET_VIEWPORT,
      words: [0x80000000, 0x00000000, 0x44200000, 0x44040000, 0x3F800000, 0],
      resource: RESOURCE.NONE,
      id: 0,
      args: [0x80000000, 0x00000000, 0x44200000, 0x44040000, 0x3F800000, 0]
    },
    {
      op: OP.SET_SCISSOR,
      words: [10, 20, 620, 488],
      resource: RESOURCE.NONE,
      id: 0,
      args: [10, 20, 620, 488]
    },
    {
      op: OP.DRAW,
      words: [3, 2, 9],
      resource: RESOURCE.NONE,
      id: 0,
      args: [3, 2, 9]
    },
    {
      op: OP.DRAW_INDEXED,
      words: [6, 2, 12, 0xFFFF_FFF0],
      resource: RESOURCE.NONE,
      id: 0,
      args: [6, 2, 12, 0xFFFF_FFF0]
    },
    { op: OP.END_PASS, words: [], resource: RESOURCE.NONE, id: 0, args: [] },
    { op: OP.SUBMIT_PRESENT, words: [], resource: RESOURCE.NONE, id: 0, args: [] },
    {
      op: OP.DESTROY,
      words: [1, 103],
      resource: RESOURCE.BUFFER,
      id: 103,
      args: [1, 103]
    },
    {
      op: OP.BLIT_TEXTURE,
      words: [104, 108, pack16(10, 20), pack16(300, 200), pack16(30, 40),
        pack16(600, 400), 7 | (8 << 8) | (9 << 16) | (10 << 24)],
      resource: RESOURCE.TEXTURE,
      id: 104,
      args: [104, 108, 10, 20, 300, 200, 30, 40, 600, 400, 7, 8, 9, 10]
    }
  ];

  assert.deepEqual(cases.map(({ op }) => op), Array.from({ length: 25 }, (_, index) => index));
  for (const spec of cases) {
    const decoded = decodeLegacyWgpuCommandRecord(command(spec.op, ...spec.words), heap);
    assert.equal(decoded.kind, KIND.COMMAND, `opcode ${spec.op} kind`);
    assert.equal(decoded.opcode, spec.op, `opcode ${spec.op} opcode`);
    assert.equal(decoded.resourceClass, spec.resource, `opcode ${spec.op} resource class`);
    assert.equal(decoded.resourceId, spec.id, `opcode ${spec.op} resource id`);
    assert.deepEqual(decoded.args, spec.args, `opcode ${spec.op} args`);
    assert.deepEqual([...decoded.payloadBytes], spec.payload ?? [], `opcode ${spec.op} payload`);
  }
});

test("legacy decoder preserves raw float bits instead of canonicalizing JS numbers", () => {
  const rawBits = [0x7FC00001, 0xFFC12345, 0x80000000, 0x00000001, 0x7F800000, 0xFF800000];
  const decoded = decodeLegacyWgpuCommandRecord(command(OP.SET_VIEWPORT, ...rawBits));
  assert.deepEqual(decoded.args, rawBits);

  const bytes = new Uint8Array(command(OP.SET_VIEWPORT, ...rawBits).buffer);
  assert.deepEqual(decodeLegacyWgpuCommandRecord(bytes).args, rawBits);
});

test("declared payloads are exact heap views and exclude transport pointers", () => {
  const mutableHeap = Uint8Array.from({ length: 96 }, (_, index) => index ^ 0x5A);
  const payloadCases = [
    { record: command(OP.CREATE_SHADER, 1, 8, 5, 0), pointer: 8, length: 5, args: [1, 0] },
    { record: command(OP.UPLOAD_BUFFER, 2, 64, 20, 7, 4), pointer: 20, length: 7,
      args: [2, 64, 7, 4] },
    { record: command(OP.UPLOAD_TEXTURE, 3, 32, 3, 1, 5, 0, 0), pointer: 32, length: 15,
      args: [3, 3, 1, 5, 0, 0] },
    { record: command(OP.CREATE_PIPELINE_CFG, 4, 50, 4), pointer: 50, length: 4,
      args: [4] },
    { record: command(OP.CREATE_BIND_GROUP, 5, 60, 6, 1), pointer: 60, length: 6,
      args: [5, 1] }
  ];

  for (const spec of payloadCases) {
    const decoded = decodeLegacyWgpuCommandRecord(spec.record, mutableHeap);
    assert.equal(decoded.payloadBytes.buffer, mutableHeap.buffer);
    assert.equal(decoded.payloadBytes.byteOffset, mutableHeap.byteOffset + spec.pointer);
    assert.equal(decoded.payloadBytes.byteLength, spec.length);
    assert.deepEqual(decoded.args, spec.args);

    const replacement = (decoded.payloadBytes[0] + 1) & 0xFF;
    mutableHeap[spec.pointer] = replacement;
    assert.equal(decoded.payloadBytes[0], replacement, "heap mutation must remain visible in view");
    decoded.payloadBytes[spec.length - 1] ^= 0xFF;
    assert.equal(
      mutableHeap[spec.pointer + spec.length - 1],
      decoded.payloadBytes[spec.length - 1],
      "view mutation must address the exact declared span"
    );
  }
});

test("legacy decoder fails closed on unknown, structurally malformed, and invalid-resource records", () => {
  assert.throws(() => decodeLegacyWgpuCommandRecord(command(25)), /Unknown legacy WebGPU opcode 25/);
  assert.throws(
    () => decodeLegacyWgpuCommandRecord(new Uint32Array(7)),
    /must contain 8 words/
  );
  assert.throws(
    () => decodeLegacyWgpuCommandRecord(new Uint8Array(31)),
    /must be 32 bytes/
  );
  assert.throws(
    () => decodeLegacyWgpuCommandRecord(command(OP.SET_BIND_GROUP, 0, 1, 5)),
    /dynamic offset count 5/
  );
  assert.throws(
    () => decodeLegacyWgpuCommandRecord(command(OP.UPLOAD_BUFFER, 1, 0, 8, 4, 7), heap),
    /role 7/
  );
  assert.throws(
    () => decodeLegacyWgpuCommandRecord(command(OP.DESTROY, 4, 1)),
    /class tag 4/
  );
  assert.throws(
    () => decodeLegacyWgpuCommandRecord(command(OP.SET_PIPELINE, 0)),
    /resource id is zero/
  );
  assert.throws(
    () => decodeLegacyWgpuCommandRecord(
      command(OP.BLIT_TEXTURE, 1, 2, pack16(0, 0), pack16(0, 1), pack16(0, 0), pack16(1, 1), 0)
    ),
    /source width must be positive/
  );
});

test("legacy decoder validates every declared payload boundary without wrapping", () => {
  assert.throws(
    () => decodeLegacyWgpuCommandRecord(command(OP.CREATE_SHADER, 1, 8, 4, 0)),
    /heap must be/
  );
  assert.throws(
    () => decodeLegacyWgpuCommandRecord(command(OP.CREATE_SHADER, 1, 0, 4, 0), heap),
    /payload pointer is zero/
  );
  assert.throws(
    () => decodeLegacyWgpuCommandRecord(command(OP.CREATE_SHADER, 1, 254, 3, 0), heap),
    /exceeds heap size 256/
  );
  assert.throws(
    () => decodeLegacyWgpuCommandRecord(
      command(OP.UPLOAD_BUFFER, 1, 0, 0xFFFF_FFFE, 4, 0),
      heap
    ),
    /exceeds heap size 256/
  );
  assert.throws(
    () => decodeLegacyWgpuCommandRecord(command(OP.UPLOAD_BUFFER, 1, 0, 8, 0, 0), heap),
    /length must be positive/
  );
});

test("retained upload payloads can be decoded after their transport span is released", () => {
  const retained = Uint8Array.of(7, 8, 9, 10);
  const decoded = decodeLegacyWgpuCommandRecord(
    command(OP.UPLOAD_BUFFER, 4, 12, 0xfffffff0, 4, 2),
    null,
    { payloadBytes: retained }
  );
  assert.deepEqual(Array.from(decoded.payloadBytes), [7, 8, 9, 10]);
  assert.throws(
    () => decodeLegacyWgpuCommandRecord(
      command(OP.UPLOAD_BUFFER, 4, 12, 0xfffffff0, 4, 2),
      null,
      { payloadBytes: retained.subarray(0, 3) }
    ),
    /retained payload length 3 != declared 4/
  );
});

test("texture payload arithmetic uses an exact non-wrapping u32 product", () => {
  const textureHeap = Uint8Array.from({ length: 64 }, (_, index) => index + 1);
  const decoded = decodeLegacyWgpuCommandRecord(
    command(OP.UPLOAD_TEXTURE, 9, 7, 3, 1, 5, 2, 4),
    textureHeap
  );
  assert.equal(decoded.payloadBytes.byteOffset, textureHeap.byteOffset + 7);
  assert.equal(decoded.payloadBytes.byteLength, 15);
  assert.deepEqual([...decoded.payloadBytes], [...textureHeap.subarray(7, 22)]);

  assert.throws(
    () => decodeLegacyWgpuCommandRecord(
      command(OP.UPLOAD_TEXTURE, 9, 7, 0x10000, 1, 0x10000, 0, 0),
      textureHeap
    ),
    /overflows u32/
  );
  assert.throws(
    () => decodeLegacyWgpuCommandRecord(
      command(OP.UPLOAD_TEXTURE, 9, 60, 3, 1, 2, 0, 0),
      textureHeap
    ),
    /exceeds heap size 64/
  );
});

test("BLIT_TEXTURE normalization is unsigned and lossless at packed field limits", () => {
  const decoded = decodeLegacyWgpuCommandRecord(command(
    OP.BLIT_TEXTURE,
    1,
    2,
    pack16(0xFFFF, 0x8000),
    pack16(1, 0xFFFF),
    pack16(0xABCD, 0xFEDC),
    pack16(0xFFFF, 1),
    0xFF80_7F01
  ));
  assert.deepEqual(decoded.args, [
    1, 2,
    0xFFFF, 0x8000, 1, 0xFFFF,
    0xABCD, 0xFEDC, 0xFFFF, 1,
    1, 0x7F, 0x80, 0xFF
  ]);
});

function command(opcode, ...words) {
  assert.ok(words.length <= 7, "test record exceeds command capacity");
  const record = new Uint32Array(8);
  record[0] = opcode;
  record.set(words, 1);
  return record;
}

function pack16(low, high) {
  return ((low & 0xFFFF) | ((high & 0xFFFF) << 16)) >>> 0;
}
