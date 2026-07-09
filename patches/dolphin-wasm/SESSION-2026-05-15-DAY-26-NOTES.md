# Session 2026-05-15 (Day 26) — the architectural wall

Day 25 chose Option D: the video pthread acquires its own headless
WebGPU device. Day 26 implemented it and hit a fundamental blocker.

## What was built

- `VideoBackend::Initialize` kicks an async `navigator.gpu`
  adapter+device request on the video pthread (idempotent, guarded by
  `self.__dolphinPthreadWgpuStatus`).
- `WebGPUGfx::EnsureDevice()` polls per-frame; on `ready` it sets
  `Module.preinitializedWebGPUDevice` and calls
  `emscripten_webgpu_get_device()` to import the JS device into this
  pthread's emdawnwebgpu table; Software path renders until then.
- Device acquisition fully centralised in WebGPUGfx (constructor no
  longer takes a device).

## The wall (measured, not theorised)

Diagnostic poll output, every run, the entire session:

    [webgpu-dev] poll: hasNavGpu=1 status=pending

- `hasNavGpu=1` — the Dolphin video pthread *is* a dedicated Web
  Worker and *does* expose `navigator.gpu`.
- `status=pending` — `requestAdapter()` / `requestDevice()` promises
  **never resolve**, across 30 s, every poll.

Root cause: Emscripten runs Dolphin's video code as a blocking C++
thread function on the pthread/worker. WebGPU adapter/device
acquisition is inherently async and resolves via a *host callback*
(GPU process → worker event loop). That callback can only run when
the worker returns control to its JS event loop. Dolphin's video
thread never does — it runs a tight FIFO/present loop and only
briefly re-enters JS via EM_ASM (which does NOT pump the event
loop / promise jobs from host APIs). So the promise is created and
never gets a chance to settle.

This is independent of cpu mode (Day-25: video is on a pthread for
both single and dual) and independent of WebGPU availability (it's
present). It's the Emscripten pthread ↔ async-host-API impedance
mismatch.

## Why the obvious escapes don't work

- **emscripten_webgpu_get_device (Day-15 path):** that device belongs
  to the discio-worker thread; WebGPU objects don't cross pthreads.
- **Transfer the device from discio worker → pthread:** GPUDevice is
  neither structured-cloneable nor Transferable. Impossible.
- **Acquire during a pthread yield window:** there is none after the
  thread enters Dolphin's loop; Initialize is synchronous.
- **ASYNCIFY to yield the pthread:** build-wide ASYNCIFY is a large
  size/perf hit and high-risk against this tuned pthread build;
  targeted ASYNCIFY around device acquisition is intricate and the
  project doesn't use ASYNCIFY at all today.

## The honest options (all large, genuinely different)

1. **Command-stream bridge.** Keep Dolphin's video on the pthread but
   make WebGPUGfx *record* the AbstractGfx command stream into shared
   memory; a real WebGPU backend on the discio worker (event-loop
   driven, already owns a device) replays it. Architecturally sound,
   no async-on-pthread problem — but it's essentially writing a
   remote/deferred WebGPU backend (serialise pipelines, buffers,
   textures, draws, state) on top of the renderer. Many sessions.
2. **ASYNCIFY the device-acquisition path** so the pthread yields
   until the device resolves, then proceed synchronously. Smaller in
   concept but ASYNCIFY interacts with the whole pthread/JIT build;
   real risk of broad regression; needs careful scoping.
3. **Run Dolphin video on the discio-worker thread.** Investigate
   whether Dolphin can be driven with no separate EmuThread/GPU
   thread so video Initialize/Draw run on the discio worker (which
   owns a device and pumps its event loop). Uncertain it's possible
   given Dolphin's core threading; deep Dolphin-internals work.
4. **Accept the hybrid as the realistic ceiling.** Days 18–21 already
   deliver a *GPU-accelerated* path: Software rasterises, but WebGPU
   does the present/scale (57 fps, 17.5 ms pacing, 0 drops, correct
   geometry). In Emscripten + Dolphin's pthread model, "GPU does the
   final image, CPU does GameCube raster" may simply be the feasible
   architecture. The shader-translation infra (Days 22–24) stays
   valuable if option 1/2/3 is revisited.

## State

No regression: `?video=wgpu` still renders via Software (the device
never resolves, EnsureDevice stays in fallback), `?video=webgpu`
hybrid intact. Diagnostics left in (cheap, rate-limited). This is WIP
toward the (now-blocked) single GPU-pipeline commit; scaffold
checkpoint remains at `8ed5d3c`.

## Files touched (project-tracked)

- `src/upstream-discio-worker.js` — `self.__dolphinDiscioWorker` flag
  (Day-25, carried).
- `cores/dolphin/dolphin-core-upstream.{js,wasm}` — rebuilt.
- `patches/dolphin-wasm/SESSION-2026-05-15-DAY-26-NOTES.md` — this.

Vendor (gitignored): `VideoBackend.cpp`, `WebGPUGfx.{cpp,h}`.
