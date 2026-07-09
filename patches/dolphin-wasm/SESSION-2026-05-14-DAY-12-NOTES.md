# Session 2026-05-14 (Day 12) — OGL detached paint path lands

Chrome DevTools tracing (Day 11 follow-up) identified the OGL freezes
as `gpu::GLES2::ReadPixels` blocking the worker thread for up to 3
seconds waiting for `CommandBufferHelper::Finish`. Texture upload
bursts during scene transitions fill the GPU command queue; the
synchronous `glReadPixels` then drains all of it.

Day 4 tried PBO async readback (failed — WebGL2 doesn't expose
`glMapBufferRange`) and downscale-blit (failed — per-call WebGL
proxy overhead dwarfed the bandwidth savings). The conclusion was
"OGL is a known-stuttery option, use software".

Day 12 revives the **detached OffscreenCanvas + bitmap transfer**
architecture that Day 3 scaffolded but couldn't get over the line —
the blocker then was that `self.postMessage` from a pthread doesn't
reach the discio worker via `addEventListener("message")`. Day 7's
JIT-cache channel solved the *same* routing problem by attaching the
listener to each `pthreadWorker` handle on the discio side, where it
catches pthread postMessages alongside Emscripten's own onmessage.

## The two-part fix

1. **C++** (`vendor/dolphin/Source/Core/Common/GL/GLInterface/Emscripten.cpp`)

   At the end of `Swap()`, when `worker_owned_webgl` is on AND
   `DolphinWebUseOglReadbackPresent()` is OFF (i.e., detached mode),
   run an `EM_ASM` block that:

   - Grabs `GL.currentContext.GLctx.canvas` (the OffscreenCanvas that
     Emscripten has transferred to this pthread).
   - Calls `canvas.transferToImageBitmap()` to snapshot the rendered
     frame as a transferable `ImageBitmap`.
   - `self.postMessage({type: 'detachedOglFrame', bitmap, width, height}, [bitmap])`
     to the parent (discio worker).

   `transferToImageBitmap` does NOT sync the GPU — it hands off a
   GPU-resident snapshot. This is the whole point: no `glReadPixels`,
   no `CommandBufferHelper::Finish`, no multi-second stall.

2. **JS discio worker** (`src/upstream-discio-worker.js`)

   `installDolphinJitCacheChannel` already iterates
   `Module.PThread.runningWorkers + unusedWorkers` and attaches a
   `worker.addEventListener("message", handleDolphinJitNewCompile)`
   handler. Add a sibling handler `handleDetachedOglFrame` to the
   same loop. When the pthread posts a `detachedOglFrame`, that
   handler runs on the discio worker side, then forwards via
   `self.postMessage` to the main thread.

   The main-thread side was already wired by Day 3 — `upstream-worker-adapter.js`'s
   `drawDetachedOglBitmap` accepts the bitmap and `drawImage`s it
   onto the visible 2D canvas.

The discio loop's own failing `transferToImageBitmap()` call on
`detachedOglCanvas` (Day 3's broken approach) is removed — Emscripten
transferred ownership of the canvas to the GPU pthread on first GL
init, so the discio side can never call that method successfully.

## Measured (60-second OGL `OGL_PROXY_MODE=worker` probe)

| Metric | OGL+readback+SAB (Day 11) | OGL detached (Day 12) |
|--------|--------------------------:|----------------------:|
| Input latency p95 | 1329 ms | **5.5 ms** |
| Drop rate | 5.0 % | **1.1 %** |
| Fast intervals (<20 ms) | 95 % | **99 %** |
| distinct hashes / 60 s | 38-48 | 41 |
| Audio active | 92 % | 87 % |
| Runtime max gap | 3549 ms | 2837 ms |
| Long anim frames / min | 26 | 28 |
| Game speed | 83 % | 166 % (over-running) |

Major wins:
- **Input latency 240× better** (1329 ms → 5.5 ms). The readback path
  was Chrome-process-blocking on every input event because
  `getImageData` on a GPU-promoted canvas forces a GPU sync. The
  bitmap-transfer path doesn't touch the visible canvas as a render
  source — main just `drawImage`s the incoming bitmap.
- **Drop rate 5× better**. Same root cause — no GPU sync per paint.
- **No multi-second stalls from `ReadPixels`** specifically. The 2.8 s
  max gap that remains is shorter and likely from compositor or
  layout work (separate diagnosis).

Regression:
- **Game speed 166 %**. The readback path was implicitly throttling
  the EmuThread via `glReadPixels`'s sync wait. Detached mode has no
  equivalent, so the emulator free-runs.

A naive `std::this_thread::sleep_for(target - elapsed)` at the end of
`Swap()` brought gameSpeed back to 102 %, BUT the canvas went fully
black — the sleep blocked something between the GL render and the
`transferToImageBitmap`, so every captured bitmap was the cleared
backbuffer. Reverted. A proper pacing mechanism (non-blocking yield,
or moving the throttle to a different pthread) is the follow-up.

## Files touched

- `vendor/dolphin/Source/Core/Common/GL/GLInterface/Emscripten.cpp` —
  EM_ASM bitmap-capture block at the end of `Swap()` when in detached
  mode.
- `src/upstream-discio-worker.js` — `handleDetachedOglFrame` listener
  registered per pthread; removed the failing discio-side
  `transferToImageBitmap` loop.
- `cores/dolphin/dolphin-core-upstream.{js,wasm}` — rebuilt.

## Next steps

1. **Add a non-blocking throttle** so detached mode runs at 100 %
   gameSpeed (currently 166 %). Possible avenues:
   - `requestAnimationFrame`-driven Swap dispatch from JS side.
   - Asyncify-aware pthread sleep with a yield point.
   - Throttle the calling EmuThread via Dolphin's existing VI vsync
     emulation if it can be re-enabled in the wasm build.
2. **Diagnose the remaining 2.8 s freezes**. Chrome trace pinpointed
   `ReadPixels` for the Day 11 stalls; now we need to re-trace the
   detached run to see what fills that role.
3. **Pick the production default**. The detached path's input-latency
   and drop-rate wins are big enough that, even with the speed
   regression, it's arguably the better OGL mode. Once throttle is
   fixed, it could become the default for `?video=ogl`.
