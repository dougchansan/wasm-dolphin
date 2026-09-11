import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { requestedWgpuVpDiag } from "../src/wgpu-replay-diagnostics.js";

const worker = await readFile(
  fileURLToPath(new URL("../src/upstream-discio-worker.js", import.meta.url)),
  "utf8"
);

test("vpdiag is off unless explicitly asked for", () => {
  assert.equal(requestedWgpuVpDiag(""), false);
  assert.equal(requestedWgpuVpDiag("?video=wgpu&presenter=webgpu"), false);
  assert.equal(requestedWgpuVpDiag("?wgpuvpdiag=0"), false);
  assert.equal(requestedWgpuVpDiag("?wgpuvpdiag=1"), true);
});

test("the dump starts finished rather than running", () => {
  // It previously ran unconditionally for the first 6000 presents -- about
  // five minutes on the hardware path, so every benchmark run was measured
  // with it on. A consumer-thread CPU profile put it at ~15% of that thread.
  assert.match(worker, /let vpDiagDone = true;/);
  assert.doesNotMatch(worker, /let vpDiagDone = false;/);
  assert.match(worker, /vpDiagDone = !requestedWgpuVpDiag;/);
});

test("the per-upload dump costs nothing when disabled", () => {
  // Guarded at the call site, not just inside the callee: this runs on every
  // uniform upload, hundreds of times a frame.
  assert.match(
    worker,
    /if \(!vpDiagDone\) \{\s*vpDiagNoteUpload\(uploadSource, len\);\s*vpDiagNotePsUpload\(uploadSource, len\);\s*\}/
  );
});

test("the harness can turn it back on", () => {
  return readFile(
    fileURLToPath(new URL("../tools/menu-progress-validate.mjs", import.meta.url)),
    "utf8"
  ).then((harness) => {
    assert.match(harness, /\["WGPUVPDIAG", "wgpuvpdiag"\]/);
  });
});

test("every hop of the flag's plumbing is wired", async () => {
  // The flag crosses five files, and the last hop -- the worker's own
  // loadCore({...}) call, which re-lists each option off the payload rather
  // than spreading it -- was missed the first time. The result was an A/B
  // that compared two identical configurations and reported +0.3%.
  const read = async (p) =>
    readFile(fileURLToPath(new URL(p, import.meta.url)), "utf8");
  assert.match(await read("../src/core-host.js"), /wgpuVpDiag: this\.wgpuVpDiag,/);
  assert.match(await read("../src/upstream-worker-adapter.js"), /wgpuVpDiag: this\.wgpuVpDiag,/);
  assert.match(worker, /wgpuVpDiag: payload\.wgpuVpDiag,/);
  assert.match(worker, /wgpuVpDiag: requestedWgpuVpDiag = false,/);
});
