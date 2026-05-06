import assert from "node:assert/strict";
import test from "node:test";

import { parseDolHeader } from "../src/dol.js";

function writeU32BE(bytes, offset, value) {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

test("DOL parser extracts entry point and load sections", () => {
  const bytes = new Uint8Array(0x100);
  writeU32BE(bytes, 0x00, 0x100);
  writeU32BE(bytes, 0x48, 0x80003100);
  writeU32BE(bytes, 0x90, 0x40);
  writeU32BE(bytes, 0x1c, 0x180);
  writeU32BE(bytes, 0x64, 0x80300000);
  writeU32BE(bytes, 0xac, 0x20);
  writeU32BE(bytes, 0xd8, 0x80400000);
  writeU32BE(bytes, 0xdc, 0x1000);
  writeU32BE(bytes, 0xe0, 0x80003100);

  const header = parseDolHeader(bytes);

  assert.equal(header.entryPoint, 0x80003100);
  assert.equal(header.bssAddress, 0x80400000);
  assert.equal(header.bssSize, 0x1000);
  assert.equal(header.loadSections.length, 2);
  assert.equal(header.totalLoadBytes, 0x60);
  assert.deepEqual(header.loadSections[0], {
    kind: "text",
    index: 0,
    fileOffset: 0x100,
    address: 0x80003100,
    size: 0x40
  });
});

test("DOL parser rejects incomplete headers", () => {
  assert.throws(() => parseDolHeader(new Uint8Array(0x20)), /incomplete/);
});
