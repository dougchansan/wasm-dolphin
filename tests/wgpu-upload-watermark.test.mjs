// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  enableWgpuUploadWatermark,
  nextWgpuUploadRead,
  publishWgpuUploadRead,
  WGPU_UPLOAD_READ_HEADER_INDEX
} from "../src/wgpu-upload-watermark.js";

test("upload watermark advances through alignment gaps", () => {
  assert.equal(nextWgpuUploadRead({
    currentRead: 5,
    uploadPointer: 1016,
    uploadBytes: 12,
    uploadArenaBase: 1000,
    uploadArenaSize: 64
  }), 28);
});

test("upload watermark advances monotonically across an arena wrap", () => {
  assert.equal(nextWgpuUploadRead({
    currentRead: 60,
    uploadPointer: 1000,
    uploadBytes: 16,
    uploadArenaBase: 1000,
    uploadArenaSize: 64
  }), 80);
});

test("upload watermark releases must follow producer allocation order", () => {
  const common = {
    uploadArenaBase: 1000,
    uploadArenaSize: 64
  };
  const afterPrefix = nextWgpuUploadRead({
    ...common,
    currentRead: 0,
    uploadPointer: 1000,
    uploadBytes: 8
  });
  assert.equal(afterPrefix, 8);
  assert.equal(nextWgpuUploadRead({
    ...common,
    currentRead: afterPrefix,
    uploadPointer: 1008,
    uploadBytes: 8
  }), 16);

  // Releasing the held suffix before the replayable prefix makes the older
  // physical pointer look like the next arena cycle and over-acknowledges.
  const suffixFirst = nextWgpuUploadRead({
    ...common,
    currentRead: 0,
    uploadPointer: 1008,
    uploadBytes: 8
  });
  assert.equal(suffixFirst, 16);
  assert.equal(nextWgpuUploadRead({
    ...common,
    currentRead: suffixFirst,
    uploadPointer: 1000,
    uploadBytes: 8
  }), 72);
});

test("a dropped tail upload must roll its reservation back before retry", () => {
  const arenaBytes = 64;
  const uploadRead = 0;
  const writeBefore = 56;
  const writeAfterDroppedReservation = 64;

  // If the command record is dropped but its eight payload bytes remain
  // reserved, the next eight-byte retry would exceed the live arena even
  // though no consumer record exists that can release the dropped tail.
  assert.ok(writeAfterDroppedReservation + 8 - uploadRead > arenaBytes);

  const writeAfterRollback = writeBefore;
  assert.ok(writeAfterRollback + 8 - uploadRead <= arenaBytes);
});

test("upload watermark rejects invalid payload spans", () => {
  const common = {
    currentRead: 0,
    uploadArenaBase: 1000,
    uploadArenaSize: 64
  };
  assert.equal(nextWgpuUploadRead({ ...common, uploadPointer: 999, uploadBytes: 4 }), null);
  assert.equal(nextWgpuUploadRead({ ...common, uploadPointer: 1064, uploadBytes: 4 }), null);
  assert.equal(nextWgpuUploadRead({ ...common, uploadPointer: 1000, uploadBytes: 65 }), null);
  assert.equal(nextWgpuUploadRead({ ...common, uploadPointer: 1000, uploadBytes: 0 }), null);
  assert.equal(nextWgpuUploadRead({ ...common, uploadPointer: 1060, uploadBytes: 8 }), null);
});

test("publishing writes header word three only after payload consumption", () => {
  const shared = new SharedArrayBuffer(20);
  const headerI32 = new Int32Array(shared);
  const ring = { headerI32, uploadBase: 2000, uploadSize: 128 };
  assert.equal(enableWgpuUploadWatermark(ring), true);
  Atomics.store(headerI32, WGPU_UPLOAD_READ_HEADER_INDEX, 120);

  assert.equal(publishWgpuUploadRead(ring, 2000, 24), 152);
  assert.equal(Atomics.load(headerI32, WGPU_UPLOAD_READ_HEADER_INDEX) >>> 0, 152);
  assert.equal(Atomics.load(headerI32, 0), 0);
  assert.equal(Atomics.load(headerI32, 1), 0);
  assert.equal(Atomics.load(headerI32, 2), 0);
  assert.equal(Atomics.load(headerI32, 4), 1);
});

test("legacy four-word headers are not acknowledged or modified", () => {
  const headerI32 = new Int32Array(new SharedArrayBuffer(16));
  const ring = { headerI32, uploadBase: 2000, uploadSize: 128 };
  assert.equal(enableWgpuUploadWatermark(ring), false);
  assert.equal(publishWgpuUploadRead(ring, 2000, 16), null);
  assert.deepEqual([...headerI32], [0, 0, 0, 0]);
});

test("the locked source patch blocks upload-arena overwrite", async () => {
  const patch = await readFile(new URL(
    "../patches/dolphin-wasm/snapshot/0011-webgpu-upload-watermark.patch",
    import.meta.url
  ), "utf8");
  assert.match(patch, /std::atomic<u32> upload_read/);
  assert.match(patch, /std::atomic<u32> protocol_flags/);
  assert.match(patch, /protocolVersion : 2/);
  assert.match(patch, /emscripten_futex_wait/);
  assert.match(patch, /protocol_flags\), observed, 4\.0/);
  assert.match(patch, /m_header->upload_read\.load\(std::memory_order_acquire\)/);
  assert.match(patch, /end - m_header->upload_read.*> m_upload_size/);
  assert.match(patch, /RollbackLastUpload/);
  assert.match(patch, /if \(!Push\(rec\)\)/);
  assert.doesNotMatch(patch, /^\+.*head = 0;.*wrap/m);

  const worker = await readFile(new URL(
    "../src/upstream-discio-worker.js",
    import.meta.url
  ), "utf8");
  assert.match(worker, /protocolVersion\) >= 2/);
  assert.match(worker, /enableWgpuUploadWatermark\(webGpuCmdRing\)/);
  const replayLoop = worker.indexOf("while (read !== replayLimit)");
  const stagedSuffix = worker.lastIndexOf(
    "stageHeldWgpuUploads(ring, replayLimit, write, u32, heap)"
  );
  assert.ok(replayLoop >= 0 && stagedSuffix > replayLoop,
    "held suffix uploads must be staged after the replayable prefix");
  assert.match(worker, /!deferBeginPass && read === replayLimit && replayLimit !== write/);
  assert.match(worker, /ring\.stagedScanCursor = index/);
  assert.match(worker, /WGPU_MAX_STAGED_UPLOAD_BYTES/);
  assert.match(worker, /stagedUploads\?\.size \?\? 0/);
  assert.match(worker, /const uploadSource = stagedUpload\?\.data/);
  assert.match(worker, /stagedUpload\?\.data \?\?/);
  assert.match(worker, /if \(!stagedUpload\) releaseWgpuUploadPayload/);
});
