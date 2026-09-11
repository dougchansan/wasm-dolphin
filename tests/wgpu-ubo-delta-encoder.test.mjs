import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const worker = await readFile(
  fileURLToPath(new URL("../src/upstream-discio-worker.js", import.meta.url)),
  "utf8"
);

// The defect this guards: the delta handler originally recorded its two
// copyBufferToBuffer calls into the frame encoder via ensureEnc(). Uniforms
// are published per draw, which is inside an open RenderPassEncoder, and an
// encoder is locked for recording while one of its passes is open. Chrome
// rejected every copy with
//   "Recording in [CommandEncoder "dolphin-frame"] which is locked while
//    [RenderPassEncoder] is open"
// and Mario Kart Wii rendered black -- the frame counter advanced, draws were
// issued, and no uniform slice was ever reconstructed. The full-upload path is
// unaffected only because queue.writeBuffer is a queue operation rather than
// encoder recording.
const deltaCase = worker.match(
  /case WGPU_CMD_OP_UBO_DELTA_UPLOAD: \{[\s\S]*?\n {8}\}/
);

test("the delta upload case exists and is self-contained", () => {
  assert.ok(deltaCase, "WGPU_CMD_OP_UBO_DELTA_UPLOAD handler not found");
});

test("delta copies never record into the frame encoder", () => {
  assert.doesNotMatch(
    deltaCase[0],
    /ensureEnc\(\)/,
    "delta copies must not use the frame encoder: it is locked while the " +
      "render pass that publishes uniforms is open"
  );
  assert.match(deltaCase[0], /ensureUboDeltaEncoder\(dev\)/);
});

test("the delta encoder never opens a render pass", () => {
  const helper = worker.match(
    /function ensureUboDeltaEncoder\(dev\) \{[\s\S]*?\n\}/
  );
  assert.ok(helper, "ensureUboDeltaEncoder not found");
  assert.doesNotMatch(helper[0], /beginRenderPass/);
  assert.match(helper[0], /createCommandEncoder\(\{ label: "dolphin-ubo-delta" \}\)/);
});

test("the carry-forward never copies a buffer onto itself", () => {
  // WebGPU rejects copyBufferToBuffer with the same source and destination
  // buffer regardless of whether the ranges overlap. The first attempt copied
  // ring -> ring and every delta was dropped with
  //   "Source and destination are the same buffer"
  // leaving Mario Kart Wii on two distinct frames for a whole run.
  assert.doesNotMatch(
    deltaCase[0],
    /copyBufferToBuffer\(\s*ring\s*,[^)]*?,\s*ring\s*,/,
    "the predecessor must hop through a scratch buffer, not ring -> ring"
  );
  assert.match(deltaCase[0], /copyBufferToBuffer\(ring, prevOff, scratch, scratchAt, blockSize\)/);
  assert.match(deltaCase[0], /copyBufferToBuffer\(scratch, scratchAt, ring, newOff, blockSize\)/);
});

test("the scratch slot is large enough for the biggest constant block", () => {
  // VertexShaderConstants is 4112 bytes; a smaller slot would silently
  // truncate the carry-forward and corrupt every slice after the first.
  const slot = worker.match(/WGPU_UBO_DELTA_SCRATCH_SLOT = (\d+)/);
  assert.ok(slot, "scratch slot size not found");
  assert.ok(
    Number(slot[1]) >= 4112,
    `scratch slot ${slot[1]} is smaller than the 4112-byte VS block`
  );
});

test("carry-forward is recorded before the patch", () => {
  const carry = deltaCase[0].indexOf("copyBufferToBuffer(ring, prevOff");
  const patch = deltaCase[0].indexOf("copyBufferToBuffer(staging, stageAt");
  assert.ok(carry >= 0 && patch >= 0, "both copies must be present");
  assert.ok(
    carry < patch,
    "the predecessor must be carried forward before the dirty range is patched " +
      "over it, or the patch is overwritten by stale bytes"
  );
});

test("the delta command buffer is submitted before the render command buffer", () => {
  const submit = worker.match(/const deltaCommandBuffer = takeUboDeltaCommandBuffer\(\);[\s\S]*?\]\);/);
  assert.ok(submit, "delta command buffer is not taken at the frame submit");
  const delta = submit[0].indexOf("deltaCommandBuffer ? [deltaCommandBuffer]");
  const render = submit[0].indexOf("renderCommandBuffer,");
  assert.ok(delta >= 0 && render >= 0);
  assert.ok(
    delta < render,
    "slices must be reconstructed before any draw reads them"
  );
});

test("deltas recorded on an abandoned frame are still submitted", () => {
  // Dropping them would not merely lose one frame: the producer has already
  // advanced its shadow, so the next slice copies forward from this one and
  // the whole chain would carry the gap.
  assert.match(
    worker,
    /const orphanDeltaBuffer = takeUboDeltaCommandBuffer\(\);[\s\S]*?q\.submit\(\[orphanDeltaBuffer\]\)/
  );
});

test("the staging offset resets only after the work is ordered against a submit", () => {
  assert.match(
    worker,
    /gpuCompletionTracker\.recordSubmittedWork\(q, "hardware-replay"\);[\s\S]{0,400}?wgpuUboDeltaStagingOffset = 0;/
  );
});

test("the UBO ring gains COPY_SRC, and with the right bit", () => {
  // 0x0008 is COPY_DST, which the ring already had -- OR-ing it was a silent
  // no-op and the carry-forward kept failing validation. COPY_SRC is 0x0004.
  const widen = worker.match(
    /resourceRole === WGPU_BUFFER_RESOURCE_ROLE_UBO_RING\) \{[\s\S]{0,400}?usage \|= (0x[0-9a-fA-F]+); \/\/ GPUBufferUsage\.COPY_SRC/
  );
  assert.ok(widen, "the UBO ring is never widened for the carry-forward copy");
  assert.equal(Number(widen[1]), 0x0004, "COPY_SRC is 0x0004, not COPY_DST");
});

test("widening the ring is gated on the delta path being on", () => {
  // The control arm of any A/B has to be the shipping configuration.
  assert.match(
    worker,
    /if \(wgpuUboDeltaEnabled &&\s*resourceRole === WGPU_BUFFER_RESOURCE_ROLE_UBO_RING\)/
  );
});
