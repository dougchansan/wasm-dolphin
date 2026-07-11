// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  enableWgpuUploadWatermark,
  nextWgpuUploadRead,
  publishWgpuUploadRead,
  rebaseWgpuStagedUploadWindow,
  WGPU_UPLOAD_READ_HEADER_INDEX
} from "../src/wgpu-upload-watermark.js";

test("held upload staging advances past a consumed prefix", () => {
  assert.deepEqual(rebaseWgpuStagedUploadWindow({
    startIndex: 120,
    writeIndex: 160,
    scanCursor: 140,
    stagedUploadIndices: [125, 139]
  }), {
    ok: true,
    startIndex: 120,
    scanCursor: 140
  });

  assert.equal(rebaseWgpuStagedUploadWindow({
    startIndex: 120,
    writeIndex: 160,
    scanCursor: 110,
    stagedUploadIndices: []
  }).scanCursor, 120, "a cursor in the consumed prefix must restart at the new suffix");
});

test("held upload staging rejects a retained upload from the consumed prefix", () => {
  assert.deepEqual(rebaseWgpuStagedUploadWindow({
    startIndex: 120,
    writeIndex: 160,
    scanCursor: 140,
    stagedUploadIndices: [110, 130]
  }), {
    ok: false,
    startIndex: 120,
    invalidIndex: 110
  });
});

test("held upload staging rebases across uint32 wrap", () => {
  assert.deepEqual(rebaseWgpuStagedUploadWindow({
    startIndex: 0xffff_fffc,
    writeIndex: 0x20,
    scanCursor: 0x10,
    stagedUploadIndices: [0xffff_fffe, 0x08]
  }), {
    ok: true,
    startIndex: 0xffff_fffc,
    scanCursor: 0x10
  });
});

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

test("host plumbing preserves the 32 MiB held-stage cap while screening a 64 MiB arena", async () => {
  const [host, adapter, worker] = await Promise.all([
    readFile(new URL("../src/core-host.js", import.meta.url), "utf8"),
    readFile(new URL("../src/upstream-worker-adapter.js", import.meta.url), "utf8"),
    readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8"),
  ]);

  assert.match(host, /requestedWgpuUploadArenaMiB\(window\.location\.search\)/);
  assert.match(host, /wgpuUploadArenaMiB: this\.wgpuUploadArenaMiB/);
  assert.match(adapter, /wgpuUploadArenaMiB: this\.wgpuUploadArenaMiB/);
  assert.match(worker,
    /setWebGpuUploadArenaMiB\?\.\(wgpuUploadArenaMiB, collectMetrics \? 1 : 0\)/);
  assert.match(worker,
    /case "reset":[\s\S]*?setWebGpuUploadArenaMiB\?\.\(wgpuUploadArenaMiB, collectMetrics \? 1 : 0\)/);
  assert.match(worker,
    /case "loadState":[\s\S]*?setWebGpuUploadArenaMiB[\s\S]*?loadState[\s\S]*?setWebGpuUploadArenaMiB/);
  assert.match(worker,
    /api\.loadStateFile\(path\)[\s\S]*?setTimeout\(r, 1200\)[\s\S]*?setWebGpuUploadArenaMiB/);
  assert.match(worker, /const WGPU_MAX_STAGED_UPLOAD_BYTES = 32 \* 1024 \* 1024/);
  assert.match(worker, /uploadArenaRingHandoffMismatch/);
});

test("the arena-size patch freezes configuration before handoff and exports metrics", async () => {
  const patch = await readFile(new URL(
    "../patches/dolphin-wasm/snapshot/0024-webgpu-upload-arena-size.patch",
    import.meta.url
  ), "utf8");

  assert.match(patch, /kDefaultUploadArenaBytes = 32u \* 1024u \* 1024u/);
  assert.match(patch, /kLargeUploadArenaBytes = 64u \* 1024u \* 1024u/);
  assert.match(patch, /ConfigureUploadArenaMiB\(u32 mib, bool metrics_enabled\)/);
  assert.match(patch, /m_upload_allocation_finalized\.load\(std::memory_order_acquire\)/);
  assert.match(patch, /m_upload_late_reject_count\.fetch_add/);
  assert.match(patch, /requested_upload_bytes == kLargeUploadArenaBytes/);
  assert.match(patch, /m_upload_fallback_count\.fetch_add/);
  assert.match(patch, /SetWebGpuUploadArenaMiB\(int mib, int metrics_enabled\)/);
  assert.match(patch, /wgarena:/);
  assert.match(patch, /'_SetWebGpuUploadArenaMiB'/);
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
  assert.match(worker, /rebaseWgpuStagedUploadWindow\(\{/);
  assert.match(worker, /stagedUploadIndices: ring\.stagedUploads\.keys\(\)/);
  assert.doesNotMatch(worker, /held pass changed with staged uploads pending/);
  assert.match(worker, /WGPU_MAX_STAGED_UPLOAD_BYTES/);
  assert.match(worker, /stagedUploads\?\.size \?\? 0/);
  assert.match(worker, /const uploadSource = stagedUpload\?\.data/);
  assert.match(worker, /stagedUpload\?\.data \?\?/);
  assert.match(worker, /if \(!stagedUpload\) releaseWgpuUploadPayload/);
});
