# Session 2026-05-12 (Day 3) — investigation notes, worker-mode painting (NOT shipped)

Day 3's goal per `docs/ogl-performance-plan.md` was to eliminate the OGL
readback round-trip by getting `oglproxy=worker` to reliably paint frames at
gameSpeed ≥ 60 %. After about four hours of investigation, the worker-mode
painting path is not yet shippable. This file records the empirical findings
so the next attempt can skip the wrong turns.

## What was probed

All probes ran on the Day-2 build (carry-op reorder landed). 90 s each
unless noted, OGL backend, `FORCEJIT=1`, queue=8, present=half.

| Path                            | distinct (visible) | gameSpeed | Notes                       |
|---------------------------------|--------------------|-----------|-----------------------------|
| `oglproxy=readback` (default)   |              127   |   98.75 % | Working. Day-2 acceptance.  |
| `oglproxy=readback` + 2D presenter |            66   |   75.74 % | Slower than WebGL/WebGPU.    |
| `oglproxy=readback` + present=full |            40   |   64.82 % | Full-res GPU→CPU is heavier. |
| `oglproxy=worker`               |                1   |   84.92 % | Frozen; transferToImageBitmap fails. |
| `oglproxy=worker` + cpu=single  |                1   |  ~ 6 %    | Canvas still goes to GPU pthread; no fix. |
| `oglproxy=proxy`                |                1   |   75.20 % | OffscreenCanvas auto-mirror inactive. |

## The worker-mode chain — confirmed and disconfirmed

The architecture for worker mode is well-scaffolded in the source already:

1. `core-host.js` creates a `UpstreamWorkerAdapter` with `transferCanvas: null`
   and `visibleCanvas: canvas` (the on-page DOM canvas).
2. `upstream-discio-worker.js` `loadCore` then sees no canvas in the load
   payload and creates a standalone 640×480 OffscreenCanvas (`detachedOglCanvas`),
   passes it as `Module.canvas` for the Emscripten GL backend.
3. Emscripten registers the canvas in `GL.offscreenCanvases` and transfers
   ownership to the GPU pthread when GL init runs there.
4. **Intended**: per-swap the worker calls `detachedOglCanvas.transferToImageBitmap()`
   and posts the bitmap to main via `discio-worker → main` postMessage. Main's
   `UpstreamWorkerAdapter` draws the bitmap onto the visible canvas via 2D
   drawImage in `drawDetachedOglBitmap()`.

**Step 4 fails** because once Emscripten transfers the OffscreenCanvas to
the GPU pthread, the discio-worker side has a *detached* handle. The error
that fires every frame:

> `Failed to execute 'transferToImageBitmap' on 'OffscreenCanvas': Cannot
> transfer an ImageBitmap from a detached OffscreenCanvas`

The user-visible signature: status pill shows the error, distinct stays at
1 (the canvas is never repainted past whatever was visible at boot).

### Attempted fix that worked partially

Moving the bitmap capture into the C++ `DolphinWeb_OnOglSwap` callback
(which runs on the GPU pthread where the canvas now lives) makes the capture
*succeed*. With the right canvas reference — `GL.currentContext.GLctx.canvas`
on the pthread, since `Module` may be undefined in that scope — 3000+ bitmaps
were captured per minute, with no errors logged.

### Where the chain breaks

The follow-on `self.postMessage(...)` from inside the GPU pthread does NOT
reach `discio-worker`'s `addEventListener("message")` handler. Confirmed via
a catch-all counter: the discio-worker receives only `load`, `mixAudio`,
and similar protocol messages — **zero `detachedOglFrame` messages** despite
the pthread emitting them at full rate.

Emscripten's pthread runtime intercepts user-level `self.postMessage` calls
on pthreads and routes them through its own command channel
(`PThread.receiveObjectTransfer`, etc.). Plain `self.postMessage({type:
"detachedOglFrame", bitmap, ...}, [bitmap])` from a pthread is silently
swallowed.

This was the failed working assumption embedded in the original scaffolding
(see the comment near line 122 of `src/upstream-discio-worker.js`:
"The pthread's postMessage lands on its parent (this discio worker)"). It
doesn't.

## What to try next (Day 4 candidates)

1. **SAB-backed pixel transport.** Bypass postMessage entirely. Allocate
   one shared `Uint8ClampedArray` of the rendered resolution. C++ on the
   GPU pthread does `glReadPixels` into that SAB and `Atomics.add` a
   generation counter. Main thread runs a `requestAnimationFrame` loop
   that reads the generation, copies the pixels with `putImageData` on
   the visible 2D canvas when it changes.
   - Pros: avoids the pthread-message problem entirely; main paints at
     vsync; one memcpy + one putImageData per frame.
   - Cons: requires `glReadPixels` (the very thing readback already does);
     speed gain over readback may be small. Worth measuring vs the
     working readback path.

2. **`MAIN_THREAD_ASYNC_EM_ASM`.** Emscripten provides macros to dispatch
   JS to the module's "main runtime thread" (the discio-worker for us).
   The pthread can wrap its postMessage in such a macro. This would
   re-enable the existing scaffolding but with proper routing.
   - Pros: minimal code change to revive the bitmap-transfer path.
   - Cons: blocks the GPU pthread per call (sync variant) or has higher
     latency (async). Need to verify `transferToImageBitmap` can be
     called from the discio-worker after the canvas transfer (it can't —
     the canvas isn't owned there anymore).

3. **`emscripten_proxy_async`.** Lower-level proxy primitive that targets
   a specific pthread. Could let the GPU pthread proxy a function call
   to the discio-worker — but again, the canvas isn't usable on the
   discio-worker side.

4. **Investigate Emscripten's `proxyToWorker`.** It's possible there's
   an opt-in mechanism for non-protocol pthread messages to fall through
   to the parent worker's user handler. Search the Emscripten runtime
   for "non-protocol" or "user message" handling.

The most pragmatic next step is (1): SAB + raw pixels. It cuts out the
bitmap-transfer middleman entirely and the main thread can do exactly one
`putImageData` per browser repaint.

## Code state after Day 3

- `core/upstream/dolphin_web_discio.cpp`: pthread bitmap capture code was
  written, built, and verified to capture successfully. **Removed** in the
  final commit because the downstream transport doesn't work. Empty
  `#ifdef __EMSCRIPTEN__` retained with a comment pointing to this file.
- `src/upstream-discio-worker.js`: `detachedOglFrame` forwarder retained
  unchanged — harmless when no messages arrive.
- `src/upstream-worker-adapter.js`: `drawDetachedOglBitmap` retained
  unchanged — ready for Day 4 SAB approach to repurpose its visible-canvas
  painting (just replace the bitmap source with raw pixel data).
- `vendor/dolphin/Source/Core/Common/GL/GLInterface/Emscripten.cpp`: no
  Day-3 changes (the EM_ASM-via-`GL.currentContext` approach was proven to
  work syntactically but landed nothing useful).

## Diagnostic recipes that were useful

- `OGL_PROXY_MODE=worker DISABLE=... node tools/menu-progress-validate.mjs`
  gives a quick distinct-count signal for whether the canvas updates at all.
- The captured worker console (via the Day-2 polish item) is essential for
  these investigations. Without it, you'd be flying blind on the pthread.
- A catch-all message counter in `discio-worker.addEventListener("message")`
  immediately revealed that pthread→worker isn't a working channel.
