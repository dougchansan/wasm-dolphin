# Session 2026-05-15 (Day 27) — command-ring transport PROVEN

The Day-26 wall: Dolphin's video pthread can't own a WebGPU device
(no event-loop turn for async acquisition; objects don't cross
workers). User chose the command-stream bridge. Day 27 built the
transport and proved it end-to-end.

## Architecture

`WebGPUGfx` on the video pthread becomes a *recorder*. Each render
op is appended as a fixed 32-byte `CmdRecord` into a ring buffer that
lives in the wasm linear memory — which is a SharedArrayBuffer under
USE_PTHREADS, so the discio worker sees it with zero copy. The discio
worker (event-loop-driven, already owns `renderGpu.device`) drains
the ring every presentation tick and *replays* each command on its
real device. The ring is the wire protocol of a remote/deferred
WebGPU backend.

Single-producer (pthread) / single-consumer (discio worker):
monotonic `write`/`read` u32 counters in a `CmdRingHeader`, release
on publish / acquire on drain, slot = idx % capacity (4096 slots =
128 KB). Full ⇒ drop the record (skip a frame's commands rather than
stall the video thread).

## New files (vendor, gitignored)

- `WebGPUCommandStream.{h,cpp}` — ring alloc in shared wasm heap,
  `Push`/`PushClear`, `EnsureRing` (hands header+slots ptrs to the
  discio worker via the Day-19 postMessage pattern).

## Wiring

- `WebGPUGfx::ShowImage` — **not** PresentBackbuffer. Critical: with
  `SupportsUtilityDrawing()==false`, VideoCommon's `Presenter::Present`
  calls `ShowImage` then `return`s *before* `PresentBackbuffer`
  (Present.cpp). ShowImage is the only per-frame hook we get. It
  `EnsureRing()`s, pushes one CLEAR (slow time-cycled colour via
  `emscripten_get_now`), and — while the ring is live — skips the
  Software XFB postMessage so the bridge unambiguously owns the
  canvas. (First Day-27 build wrongly put this in PresentBackbuffer →
  never ran → canvas still showed Software; moved to ShowImage.)
- `src/upstream-discio-worker.js` — `handleWebGpuCmdRing` registers
  the ring (per-pthread, alongside the JIT-cache/show-image
  listeners); `drainWebGpuCmdRing()` (called each `runPresentationLoop`
  tick) acquire-loads `write`, replays CLEAR via
  `getCurrentTexture()` + a real `wgpuRenderPass`, release-stores the
  consumed `read`.

## Verified — bridge proven

30s `VIDEO=wgpu` probe:

- Status pill: **"webgpu-cmd-ring: first CLEAR replayed
  (rgba=0.36,0.99,0.16) — bridge proven"**.
- Canvas = solid clear colour, cycling: teal @ t=12, blue @ t=30
  (28 distinct hashes). The Software character-select content is
  GONE — the bridge owns the canvas, exactly as designed.
- `56 present, 60 core, 101% speed, webgpu/smooth` — pipeline healthy.

The full path is live: video pthread `ShowImage` →
`WebGPUCommandStream` ring (shared heap, atomics) → discio worker
`drainWebGpuCmdRing` → `renderGpu.device` `wgpuRenderPass` → canvas.

## Significance

This bypasses the Day-26 architectural wall. From here, the real GPU
renderer is **opcode-set widening on a proven transport**, not new
architecture:

- Day 28: resource opcodes — CreateBuffer/Texture/Shader/Pipeline
  return ids; the discio worker builds the real wgpu objects (it can:
  it has the device + event loop, incl. async shader compile). Vertex
  data + WGSL go through shared-heap blocks referenced by ptr+len.
- Day 29: state + Draw opcodes → `wgpuRenderPassEncoderDraw`.
- Day 30: EFB/XFB as real wgpu textures; flip api_type→Vulkan so
  shadergen emits complete GLSL (Day-24 finding) → Day-23 Naga path
  → real pipelines; retire the Software delegation.

The Day 22–24 shader-translation infra and Day 23 Naga lib all plug
straight into the discio-worker replay side.

## State

No regression to `?video=webgpu` (hybrid untouched). `?video=wgpu`
now shows the bridge's cycling clear instead of Software content —
expected and intended for this phase (user accepted "broken/black
during the pipeline build"). WIP toward the single big GPU-pipeline
commit; scaffold checkpoint remains `8ed5d3c`.

## Files touched (project-tracked)

- `src/upstream-discio-worker.js` — cmd-ring handler + drain/replay.
- `cores/dolphin/dolphin-core-upstream.{js,wasm}` — rebuilt.
- `patches/dolphin-wasm/SESSION-2026-05-15-DAY-27-NOTES.md` — this.

Vendor (gitignored): `WebGPUCommandStream.{h,cpp}` (new),
`WebGPUGfx.{cpp,h}`, `CMakeLists.txt`.
