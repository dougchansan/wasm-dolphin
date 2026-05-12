# Session 2026-05-12 (Day 4) — readback-path optimization (attempted, REVERTED)

Per `docs/ogl-performance-plan.md` Day-4 plan: profile
`DolphinWebPublishAsyncReadback`, add async PBO readback for parallel
GPU/CPU work, drop internal readback resolution from 320×240 to 160×120.

**Outcome: not shipped.** Both the async-PBO approach and the bandwidth-only
downscale-blit approach made things WORSE under Emscripten's pthread
WebGL proxy. The `vendor/dolphin/Source/Core/Common/GL/GLInterface/Emscripten.cpp`
diff was reverted to the Day-2 state.

## Attempt 1 — async PBO ring with fences (hung)

Two-PBO ring, `glFenceSync`/`glClientWaitSync`, `glBlitFramebuffer`
downscale-step, then `glReadPixels` into PBO[write]; one frame later
`glClientWaitSync` on PBO[read] and `glGetBufferSubData` the result back
to CPU.

**Hang.** `glGetBufferSubData` is a synchronous WebGL2 round-trip through
Emscripten's pthread proxy. With the GL context owned by the GPU pthread
under `OFFSCREENCANVAS_SUPPORT=1`, the call blocked indefinitely. Validator
probe reached t=149 s simulated playtime, then hung for 12+ minutes with no
further progress. Killed manually.

WebGL 2 doesn't expose `glMapBufferRange` (returns null). The only
buffer-read path is `glGetBufferSubData`, which is the broken piece.

## Attempt 2 — downscale-blit + sync glReadPixels (slower than Day-2 baseline)

Dropped the PBO + fence machinery, kept only the GPU downscale step
(160×120 RGBA8 FBO + `glBlitFramebuffer` with LINEAR filter) and direct
`glReadPixels` from that small FBO. Hypothesis: 4× less bandwidth per
frame is a pure win; the added blit is cheap GPU work.

**Hypothesis wrong.** 120-s validator probe:

| Config                                  | distinct | gameSpeed | visualFps |
|-----------------------------------------|---------:|----------:|----------:|
| Day-2 readback (320×240 direct glReadPixels) |     127 |    98.8 % |     1.27  |
| Day-4 downscale-blit to 160×120         |       67 |    90.4 % |     0.56  |

Worse on every metric. The extra `glBlitFramebuffer` + FBO-binding state
changes add round-trip overhead through the pthread proxy that exceeds
the GPU→CPU bandwidth saving. visualFps also dropped because the
smaller buffer has fewer unique pixels — the hash stride (256 bytes)
samples coarser as a fraction of the smaller image, so it misses more
changes that would have registered at 320×240.

## What this teaches us

The OGL readback path isn't bottlenecked on `glReadPixels` bandwidth.
It's bottlenecked on **per-call WebGL proxy overhead**: every GL call
from the GPU pthread is a round-trip through Emscripten's PROXY_ALWAYS
machinery. Adding GL calls (blit, FBO binds, fence ops) makes things
worse. Reducing pixel volume doesn't help when the call count goes up.

The visualFps gap between software (~22/s) and OGL+readback (~1/s) is
the symptom of this proxy overhead. The plan's PBO/lower-res approach
addresses a problem that *isn't* the actual bottleneck for this build's
threading model.

## Realistic next steps for OGL paint

Day-4 as planned is closed. Future OGL-paint improvements need a
different attack:

1. **Eliminate the pthread proxy entirely** — bind GL context directly
   on the discio-worker thread (no `OFFSCREENCANVAS_SUPPORT=1` transfer).
   That requires CPU=single + a Dolphin video backend that runs on the
   main thread. Big refactor.
2. **SAB-backed pixel transport** (per Day-3 notes) — bypass GL pixel
   readback entirely. Use a separate shared array buffer for pixels,
   write to it from a native C helper that owns the canvas, main thread
   reads via `requestAnimationFrame` + `putImageData`.
3. **Accept the OGL limitation** — software + WASMJIT=1 is the
   recommended playable URL post-Day-2. OGL hardware path remains an
   "experimental, works but visually choppy" option for users who want
   to test 3D acceleration.

For now the recommendation is (3): leave OGL as-is, point users at the
software + JIT URL. WASM output is unchanged from Day-2 (`26cb095`); the
Day-4 attempt left no binary trail.
