# OGL Hardware Path — Performance Plan & Handoff

**Last updated:** 2026-05-11 (session that landed commits 1e05b65 and 21636b4)

This document captures the multi-day work needed to get the OGL hardware
rendering path to native-emulation speed in the browser. Read this before
diving in; the session that produced commit `1e05b65` left a lot of context
that isn't obvious from the diff alone.

## TL;DR — current state

| Backend | Speed | Visuals | Playable? |
|---------|-------|---------|-----------|
| `video=software` + `wasmjit=0` + `fastsw=1` + `pacing=smooth` | 100% | Visible 1/4-density pixel dots, smooth | **Yes** |
| `video=software` + `wasmjit=1` | 14% post frame-700 + dot-matrix corruption | Broken | No (JIT bug) |
| `video=ogl` + `oglproxy=readback` + JIT off (default) | 84% | Clean, reaches char select | Slow but works |
| `video=ogl` + `oglproxy=readback` + `forcejit=1` | 100% | 4 distinct frames, geometry submitted but render dead | No (JIT bug) |
| `video=ogl` + `oglproxy=worker` | 52% | Stuck, 1 distinct frame | No (canvas mirror) |

**Recommended playable URL right now:**
```
http://127.0.0.1:8082/?core=upstream&video=software&cpu=dual&speed=1&present=full&presenter=webgpu&pacing=smooth&jittier=guarded&jitwarmup=700&wasmjit=0&oc=1&queue=2&fastsw=1&metrics=1
```

## What's blocking native-speed OGL

Three independent walls. Each needs its own day. They are NOT a single bug.

### Wall 1 — JIT mis-emits opcodes that corrupt 3D rendering
- With `wasmjit=1` (or `forcejit=1` on OGL), starting at frame ~700 (JIT
  engagement threshold), Melee's 3D rendering paths break. Symptoms vary
  by mode:
  - Software: gameSpeed crashes to 14%, pixel-write opcodes mis-emit
    (dotted "skip every other pixel" pattern on title screen)
  - OGL: gameSpeed stays at 100% but `prim:1540 draw:250 verts:0 rast:0`
    — drawcalls submitted but vertex/raster state corrupt. Only 4
    distinct canvas hashes captured.
- We landed two partial fixes during the bisection (both reverted because
  they regressed):
  - `FastMeleeIdlePollLoop` partial-state-commit on `guard_failed=true`
  - `MELEE_IDLE_POLL_LOOP_MAX_BATCH=256` coalescing CoreTiming events
- One non-reverted fix: bumped JIT block emitter's WASM memory page count
  16384→24576 to match the bumped 1.5 GiB heap. That killed a `LinkError`
  but didn't fix the rendering-corruption layer.
- Diagnosis pointer: prior tracer agent (now dead) suspected carry-bit
  propagation across same-block instructions like `addcx`/`addzex`. May
  be worth following up.

### Wall 2 — OffscreenCanvas mirror doesn't paint from worker thread
- `oglproxy=worker` mode renders the GL context's drawing buffer directly
  to the canvas that was `transferControlToOffscreen`'d from main thread.
  In theory the on-page placeholder auto-updates at each task boundary
  in the worker. In practice we see `visualFps:0` even when the worker
  reports it's pushing frames.
- We tried four architectures partially: explicit `requestAnimationFrame`
  yields, render-to-FBO + `transferToImageBitmap` + postMessage, raw
  `OffscreenCanvas.commit()`, SAB-backed pixel buffer. None landed at
  production quality in this session.
- Diagnosis pointer: most likely the worker simply doesn't yield to the
  event loop frequently enough; the GL context's implicit "swap on task
  boundary" semantics need an actual task boundary. Hardcoded yields
  feel hacky; need a clean architectural fix.

### Wall 3 — Readback path has unavoidable `glReadPixels` overhead
- The currently-working OGL config (`oglproxy=readback`) does
  `glReadPixels` every frame to copy GPU framebuffer to CPU memory, then
  hands the bytes to the worker's WebGPU presenter which paints the
  visible canvas. Round-trip is ~10-15ms per frame at 320×240, dropping
  gameSpeed from 100% to 84%.
- This is the *most likely* to yield results in a single day because the
  fix is a known pattern (async PBO + reduced internal res), but it
  caps us at "good not great" — Wall 2 is needed for "great."

## Five-day plan

### Day 1 — Instrumentation & bisection infrastructure
Goal: stop speculating, start measuring.

1. **Per-helper disable URL flags**. In `core-host.js`, add
   `?disable=fastfp,fastmem,fastinputpoll,meleeloop,...`. In
   `core/upstream/dolphin_web_core.cpp` add an `extern "C"` setter that
   takes a bitmask, store in a global atomic. In `CachedInterpreter.cpp`
   gate each `TryWrite*` / `TryEmit*` on the bit. Critical: no rebuild
   between bisection runs.
2. **Validator metric split** (task OO). In
   `tools/menu-progress-validate.mjs` post-processing, split samples on
   `statusPill.includes("JIT enabled")` and report pre/post averages.
   Currently a JIT-on regression hides in the average.
3. **C++ per-frame ring buffer over SAB**. Worker drains and prints.
   Records: `frame`, `prim`, `draw`, `verts`, `xfb_hash`, `glerr`,
   `commit_result`. Lets us see exactly which frame stops rendering.
4. Full validator sweep, confirm no regressions, commit.
   **Done when:** the three tools above work and ship with the next build.

### Day 2 — JIT corruption bisection
Goal: pinpoint which fast-path category miscompiles.

1. With Day 1's disable flags, run `FORCEJIT=1 OGL_PROXY_MODE=readback`
   validator with each category disabled in turn. ~10 runs, 3 min each.
2. Find smallest set that brings `distinctCanvasHashes` 4 → 100+.
3. Read that category's emitter logic in
   `vendor/dolphin/Source/Core/Core/PowerPC/CachedInterpreter/CachedInterpreter.cpp`.
   Suspect: signed/unsigned mismatches in `r3` carry-bit handling;
   byte-order errors in `store8`/`load8` for shared-memory PPC state;
   missing pipeline flushes between dependent emitted instructions.
4. Targeted fix, rebuild, validate.
   **Done when:** OGL + `FORCEJIT=1` reaches char select with
   `distinctCanvasHashes ≥ 100`.

### Day 3 — OffscreenCanvas worker-mirror
Goal: eliminate the readback round-trip.

1. Investigate why `oglproxy=worker` doesn't paint. Run with DBG on,
   capture browser console + DevTools timeline; correlate canvas paint
   ticks vs worker GL commit events.
2. Try four architectures, time-boxed to ~1 hour each:
   - (a) Explicit `setTimeout(0)` or `requestAnimationFrame` in worker
     between GL frames to force a task boundary.
   - (b) Render-to-FBO + per-frame `transferToImageBitmap` + postMessage
     to main + 2D `drawImage` on visible canvas. Scaffolding already
     exists in `upstream-discio-worker.js` (`detachedOglFrame`) and
     `upstream-worker-adapter.js` (`drawDetachedOglBitmap`).
   - (c) `OffscreenCanvas.commit()` if Chrome reintroduced it.
   - (d) SAB-backed pixel buffer the worker writes from GL, main reads
     and `putImageData`. Slower than (b) but architecturally simplest;
     avoids ImageBitmap detach hazards entirely.
3. Pick the winner, validate.
   **Done when:** `oglproxy=worker` reaches char select at
   `gameSpeed ≥ 60%`.

### Day 4 — Readback-path optimization (fallback)
Goal: if Day 3 hits a Chrome/Emscripten wall, make readback 2× faster.

1. Profile `DolphinWebPublishAsyncReadback` in
   `vendor/dolphin/Source/Core/Common/GL/GLInterface/Emscripten.cpp`.
   Time the `glReadPixels` call vs the memcpy to `s_framebuffer`. If GPU
   sync dominates: pipeline with PBOs.
2. Implement async readback: kick off `glReadPixels` for frame N into a
   PBO, fence-wait on frame N-1's PBO, copy that to `s_framebuffer`. One
   frame of latency in exchange for parallel GPU/CPU work.
3. Drop internal readback res to 160×120 (currently 320×240). 4× fewer
   pixels.
   **Done when:** `oglproxy=readback` gameSpeed ≥ 95%.

### Day 5 — Integration, polish, documentation
1. Merge winning changes coherently.
2. Full validator sweep across both backends and all OGL proxy modes.
3. Test in real Chrome AND real Firefox (with someone's actual installs,
   not Playwright bundled — Playwright Firefox lacks WASM/WebGL).
4. Update `patches/dolphin-wasm/` with clean per-feature patches extracted
   properly (the session that ended at commit 21636b4 ducked this by
   writing `SESSION-2026-05-10-NOTES.md` instead — that needs to become
   real patches).
5. Update top-level `README.md` with recommended URLs + architecture
   notes.

## Files most relevant to this work

### In-repo (committed)
- `src/core-host.js` — URL param parsing, adapter wiring
- `src/upstream-discio-worker.js` — Emscripten module factory, worker
  presentation loop, OGL canvas plumbing
- `src/upstream-worker-adapter.js` — main-thread side of the worker
  interface; `detachedOglFrame` handler
- `src/app.js` — page logic; gamepad poll loop; auto-screenshot when
  DBG on
- `core/upstream/dolphin_web_core.cpp` — exported C entry points;
  WASM-JIT block compiler half (other half is in vendor/dolphin)
- `tools/menu-progress-validate.mjs` — Playwright validation harness;
  the one you'll run constantly
- `tools/build-upstream-target.mjs` — `npm run build:upstream` wrapper

### In `vendor/dolphin/` (gitignored)
- `Source/Core/Common/GL/GLInterface/Emscripten.{h,cpp}` — WebGL2 context
  creation, swap, commit_frame handling
- `Source/Core/VideoBackends/OGL/OGLMain.cpp` — OGL backend init,
  `FillBackendInfo`, conservative defaults
- `Source/Core/VideoBackends/OGL/OGLConfig.cpp` — `PopulateConfig`,
  extension probing
- `Source/Core/VideoBackends/OGL/OGLGfx.cpp` — `BindBackbuffer`,
  `PresentBackbuffer`, `RenderXFBToScreen`
- `Source/Core/VideoCommon/Present.cpp` — the `Renderer::Present` flow
  (BindBackbuffer → RenderXFBToScreen → PresentBackbuffer)
- `Source/Core/Core/PowerPC/CachedInterpreter/CachedInterpreter.cpp` —
  WASM JIT block compiler; all `TryWrite*` / `TryEmit*` fast-paths;
  `FastMeleeIdlePollLoop`, `FastMeleeInputStatusInline`, etc.
- `Source/Core/Core/CMakeLists.txt` — `target_link_options` for
  `dolphin_web_core` (memory size, exports list)

### Patches (re-applied on clean vendor/dolphin)
- `patches/dolphin-wasm/0001`–`0009` — existing patch chain
- `patches/dolphin-wasm/SESSION-2026-05-10-NOTES.md` — five session edits
  not yet captured as patches (must be re-applied on top of 0001–0009)

## How to actually start work

1. Restore environment:
   ```
   cd C:\Users\douglaswhittingham\wasm-dolphin
   git pull
   npm install
   npm run serve   # in another shell — serves on 8082
   ```
2. Skim `commit 1e05b65` and `commit 21636b4` to absorb session context.
3. Skim `patches/dolphin-wasm/SESSION-2026-05-10-NOTES.md` for the
   vendor changes.
4. Pick Day 1 — it's pure tooling work, low risk, high leverage. Even
   if Days 2–4 hit walls, Day 1's instrumentation makes the next
   investigation 10× faster.
5. Validator runs:
   ```
   node tools/menu-progress-validate.mjs --duration 180 \
     --out-dir .omx/menu-progress/<run-name>
   ```
   Env vars: `VIDEO=software|ogl`, `OGL_PROXY_MODE=readback|worker|proxy`,
   `FORCEJIT=1`, `WASMJIT=0|1`, `JITTIER=guarded|mixed`, `FASTSW=0|1|2`,
   `PRESENTER=webgpu|webgl|2d`, `PACING=direct|smooth`,
   `BROWSER=firefox|chromium`, `HEADED=1`, `QUEUE_SIZE=`, `OC=`,
   `JITWARMUP=`, `PRESENT=full|half`.
6. Rebuild:
   ```
   node tools/build-upstream-target.mjs dolphin_web_core
   ```
   3 min wall clock on a warm cache. Targets `discio` and others available
   but `dolphin_web_core` is the one that produces the final
   `cores/dolphin/dolphin-core-upstream.{js,wasm}`.

## Things to NOT do

- Don't trust the validator's `avgGameSpeed` over a JIT-on run — it
  averages pre-JIT (good) and post-JIT (broken) samples. Wait for Day 1's
  split-by-JIT-status metric.
- Don't launch unsupervised subagents without a clear bisection mandate.
  One ran 4.5h speculating about carry-bit propagation without making
  progress.
- Don't increase `INITIAL_MEMORY` above 2 GiB — Firefox has a per-worker
  cap there.
- Don't bisect via `MELEE_IDLE_POLL_LOOP_MAX_BATCH` — already tried, too
  aggressive at small values, broke gameSpeed.
- Don't commit the 14K-line full `git diff HEAD` from `vendor/dolphin`
  as a patch — already tried, useless as a versioned artifact. The
  per-feature patches need to be extracted with proper isolation.

## Open questions you'll want to answer

1. Does Chrome's `OffscreenCanvas.placeholder` automatically repaint when
   GL renders to its drawingBuffer from a pthread spawned via Emscripten's
   pthread runtime? Or does it need a yield/RAF/commit?
2. Is the JIT corruption deterministic in WHICH instruction kind it
   miscompiles, or stochastic / timing-dependent? Day 1 instrumentation
   should answer this.
3. Can we get a `transferToImageBitmap` to actually return a non-zero
   bitmap from a `Module.canvas` accessed via Emscripten pthread? Earlier
   attempt returned 0×0 dimensions even though the canvas reported 640×480.

## Contact context

The session that produced commits 1e05b65 and 21636b4 was Claude Opus 4.7
1M-context, working alone with the user (douglaswhittingham@gmail.com).
The full conversation log is at
`C:\Users\douglaswhittingham\.claude\projects\C--Users-douglaswhittingham-wasm-dolphin\5ed56347-3cf4-491a-82d0-142c0e7b48e2.jsonl`.
Task list spans tasks #4–#49. Most of the diagnostic value is in
distinct-hash screenshot trees under `.omx/menu-progress/<name>/`.
