// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import { IncrementalSha256, bytesToHex, sha256 } from "./incremental-sha256.js";

export const WGPU_SEMANTIC_DIGEST_SCHEMA =
  "wasm-dolphin.wgpu-semantic-digest.v1";
export const WGPU_SEMANTIC_MAGIC = 0x31534457;
export const WGPU_SEMANTIC_SCHEMA_VERSION = 1;
export const WGPU_SEMANTIC_DOMAIN = "wasm-dolphin-wgpu-semantic-v1";

const DOMAIN_BYTES = new TextEncoder().encode(WGPU_SEMANTIC_DOMAIN);
const DOMAIN_DIGEST = sha256(DOMAIN_BYTES);
const EMPTY_BYTES = new Uint8Array(0);
const DEFAULT_RECENT_COMMIT_LIMIT = 32;

export function encodeWgpuSemanticEvent(event, payloadDigest = null) {
  const args = normalizeArgs(event?.args);
  const payloadBytes = asBytes(event?.payloadBytes ?? EMPTY_BYTES);
  const digest = payloadDigest == null ? sha256(payloadBytes) : exactDigest(payloadDigest);
  const payloadLength = u32(
    event?.payloadLength ?? payloadBytes.byteLength,
    "payloadLength"
  );
  if (payloadLength !== payloadBytes.byteLength && payloadDigest == null) {
    throw new RangeError("payloadLength does not match payloadBytes");
  }
  const bodyBytes = 12 * 4 + args.length * 4 + 4 + 32;
  const encoded = new Uint8Array(4 + bodyBytes);
  const view = new DataView(encoded.buffer);
  let offset = 0;
  offset = putU32(view, offset, bodyBytes);
  offset = putU32(view, offset, WGPU_SEMANTIC_MAGIC);
  offset = putU32(view, offset, WGPU_SEMANTIC_SCHEMA_VERSION);
  offset = putU32(view, offset, u32(event?.kind, "kind"));
  offset = putU32(view, offset, u32(event?.epoch, "epoch"));
  offset = putU32(view, offset, u32(event?.transaction, "transaction"));
  offset = putU32(view, offset, u32(event?.sequenceLo, "sequenceLo"));
  offset = putU32(view, offset, u32(event?.sequenceHi, "sequenceHi"));
  offset = putU32(view, offset, u32(event?.opcode, "opcode"));
  offset = putU32(view, offset, u32(event?.resourceClass, "resourceClass"));
  offset = putU32(view, offset, u32(event?.resourceId, "resourceId"));
  offset = putU32(view, offset, u32(event?.generation, "generation"));
  offset = putU32(view, offset, args.length);
  for (const arg of args) offset = putU32(view, offset, arg);
  offset = putU32(view, offset, payloadLength);
  encoded.set(digest, offset);
  return encoded;
}

export function createWgpuSemanticDigest({
  recentCommitLimit = DEFAULT_RECENT_COMMIT_LIMIT,
  now = defaultNow,
} = {}) {
  const recentLimit = Math.min(256, Math.max(1, Number(recentCommitLimit) | 0));
  const transactions = new Map();
  const recentCommits = [];
  let globalDigest = new Uint8Array(DOMAIN_DIGEST);
  let epochDigest = new Uint8Array(DOMAIN_DIGEST);
  let epoch = 0;
  let sequenceLo = 0;
  let sequenceHi = 0;
  let eventCount = 0;
  let committedEventCount = 0;
  let committedTransactionCount = 0;
  let abortedTransactionCount = 0;
  let payloadBytesHashed = 0;
  let encodedBytesHashed = 0;
  let hashTotalMs = 0;
  let hashMaxMs = 0;
  let unresolvedCount = 0;
  let mismatchCount = 0;
  let overflow = false;

  function beginEpoch(nextEpoch) {
    if (transactions.size !== 0) {
      unresolvedCount += transactions.size;
      transactions.clear();
    }
    epoch = u32(nextEpoch, "epoch");
    epochDigest = new Uint8Array(DOMAIN_DIGEST);
    sequenceLo = 0;
    sequenceHi = 0;
  }

  function beginTransaction(transactionId) {
    const id = requiredTransaction(transactionId);
    if (transactions.has(id)) {
      mismatchCount += 1;
      throw new Error(`semantic transaction ${id} is already open`);
    }
    if (transactions.size !== 0) {
      mismatchCount += 1;
      throw new Error("overlapping semantic transactions are not supported");
    }
    transactions.set(id, {
      events: [],
    });
  }

  function appendEvent(draft, { staged = false } = {}) {
    const transaction = u32(draft?.transaction ?? 0, "transaction");
    const payloadBytes = asBytes(draft?.payloadBytes ?? EMPTY_BYTES);
    const branch = staged ? transactions.get(transaction) : null;
    if (staged && transaction === 0) {
      mismatchCount += 1;
      throw new Error("staged semantic events require a nonzero transaction");
    }
    if (staged && !branch) {
      unresolvedCount += 1;
      throw new Error(`semantic transaction ${transaction} is not open`);
    }
    const startedAt = now();
    const payloadDigest = sha256(payloadBytes);
    const event = immutableEventDraft({
      draft,
      epoch,
      transaction,
      payloadLength: payloadBytes.byteLength,
      payloadDigest,
    });
    eventCount += 1;
    payloadBytesHashed += payloadBytes.byteLength;
    if (staged) {
      branch.events.push(event);
      recordHashTime(startedAt);
      return null;
    }
    const encoded = commitEvent(event);
    recordHashTime(startedAt);
    return encoded;
  }

  function commitTransaction(transactionId) {
    const id = requiredTransaction(transactionId);
    const branch = transactions.get(id);
    if (!branch) {
      mismatchCount += 1;
      throw new Error(`semantic transaction ${id} cannot commit because it is not open`);
    }
    const startedAt = now();
    for (const event of branch.events) commitEvent(event);
    transactions.delete(id);
    committedTransactionCount += 1;
    recentCommits.push({
      epoch,
      transaction: id,
      eventCount: branch.events.length,
      globalDigest: bytesToHex(globalDigest),
      epochDigest: bytesToHex(epochDigest),
    });
    if (recentCommits.length > recentLimit) recentCommits.shift();
    recordHashTime(startedAt);
  }

  function abortTransaction(transactionId) {
    const id = requiredTransaction(transactionId);
    if (!transactions.delete(id)) {
      mismatchCount += 1;
      throw new Error(`semantic transaction ${id} cannot abort because it is not open`);
    }
    abortedTransactionCount += 1;
  }

  function markUnresolved(count = 1) {
    unresolvedCount += positiveCount(count);
  }

  function markMismatch(count = 1) {
    mismatchCount += positiveCount(count);
  }

  function markOverflow() {
    overflow = true;
  }

  function snapshot() {
    return {
      schema: WGPU_SEMANTIC_DIGEST_SCHEMA,
      domain: WGPU_SEMANTIC_DOMAIN,
      epoch,
      sequenceLo,
      sequenceHi,
      globalDigest: bytesToHex(globalDigest),
      epochDigest: bytesToHex(epochDigest),
      eventCount,
      committedEventCount,
      openTransactionCount: transactions.size,
      committedTransactionCount,
      abortedTransactionCount,
      payloadBytesHashed,
      encodedBytesHashed,
      hashTotalMs,
      hashMaxMs,
      unresolvedCount,
      mismatchCount,
      overflow,
      recentCommits: recentCommits.map((entry) => ({ ...entry })),
    };
  }

  function recordHashTime(startedAt) {
    const elapsed = Math.max(0, now() - startedAt);
    hashTotalMs += elapsed;
    hashMaxMs = Math.max(hashMaxMs, elapsed);
  }

  function commitEvent(event) {
    const encoded = encodeWgpuSemanticEvent({
      ...event,
      sequenceLo,
      sequenceHi,
    }, event.payloadDigest);
    [sequenceLo, sequenceHi] = nextSequence(sequenceLo, sequenceHi);
    globalDigest = chain(globalDigest, encoded);
    epochDigest = chain(epochDigest, encoded);
    encodedBytesHashed += encoded.byteLength;
    committedEventCount += 1;
    return encoded;
  }

  return {
    beginEpoch,
    beginTransaction,
    appendEvent,
    commitTransaction,
    abortTransaction,
    markUnresolved,
    markMismatch,
    markOverflow,
    snapshot,
  };
}

function immutableEventDraft({ draft, epoch, transaction, payloadLength, payloadDigest }) {
  return {
    kind: u32(draft?.kind, "kind"),
    epoch,
    transaction,
    opcode: u32(draft?.opcode, "opcode"),
    resourceClass: u32(draft?.resourceClass, "resourceClass"),
    resourceId: u32(draft?.resourceId, "resourceId"),
    generation: u32(draft?.generation, "generation"),
    args: normalizeArgs(draft?.args),
    payloadLength,
    payloadDigest: new Uint8Array(payloadDigest),
  };
}

function chain(previous, encoded) {
  return new IncrementalSha256().update(previous).update(encoded).digest();
}

function nextSequence(low, high) {
  const nextLow = (low + 1) >>> 0;
  return [nextLow, nextLow === 0 ? (high + 1) >>> 0 : high];
}

function normalizeArgs(value) {
  if (value == null) return [];
  if (!Array.isArray(value) && !(value instanceof Uint32Array)) {
    throw new TypeError("semantic args must be an array of u32 values");
  }
  return Array.from(value, (entry) => u32(entry, "arg"));
}

function exactDigest(value) {
  const bytes = asBytes(value);
  if (bytes.byteLength !== 32) throw new RangeError("payload digest must be 32 bytes");
  return bytes;
}

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError("semantic payload must be an ArrayBuffer or view");
}

function putU32(view, offset, value) {
  view.setUint32(offset, value >>> 0, true);
  return offset + 4;
}

function u32(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 0xffffffff) {
    throw new RangeError(`${label} must be a u32`);
  }
  return number >>> 0;
}

function requiredTransaction(value) {
  const id = u32(value, "transaction");
  if (id === 0) throw new RangeError("transaction must be nonzero");
  return id;
}

function positiveCount(value) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new RangeError("count must be a positive safe integer");
  }
  return count;
}

function defaultNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}
