# Session 2026-05-12 (Day 5) — SAB pixel transport for OGL + persistent JIT cache investigation

This session set out to do two things:
1. SAB-backed pixel transport for OGL — eliminate the WebGPU presenter +
   OffscreenCanvas auto-mirror chain that capped Day-2's OGL readback path
   at 0.34 distinct hashes/s.
2. Persistent JIT cache — skip the ~12 s post-boot WASM JIT warmup on
   subsequent reloads by persisting compiled blocks to IndexedDB.

**Outcome: (1) shipped, (2) not feasible without an architectural refactor.**

## (1) SAB pixel transport — shipped (`?oglsab=1`)

The new path: at boot, allocate two `SharedArrayBuffer`s — one sized to
`presentationScale × 320 × 240` for pixel data, one 8-byte for an atomic
generation counter. Pass both through the worker bridge. Worker writes
per-readback bytes from `s_framebuffer` into the pixel SAB and
`Atomics.add`s the counter. Main thread's existing `requestAnimationFrame`
loop `Atomics.load`s the counter, and when it's changed copies SAB →
non-shared `ImageData.data` (Chrome refuses to construct ImageData over a
SAB view directly), then `putImageData`s.

Three subtle fixes were needed before it worked:
- `canvasOwnedByAdapter` now includes SAB mode so the host's 250 ms
  stats-poll runs (worker still owns frame production; main owns paint).
- `workerOwnsCanvas` is set true when SAB is on and a moduleCanvas exists,
  same workaround as the existing detached-OGL path — without this the
  presentation loop never starts.
- A publish-rate throttle of 14 ms (~70 Hz) in `publishOglSabFrame`.
  Without it, the worker drives glReadPixels at 150-200 Hz with no
  presenter pacing, eating GPU pthread time the CPU emulation pthread
  needs. Empirically: throttle off → gameSpeed 67 %; throttle on →
  gameSpeed 97 %.

### Measurements (`FORCEJIT=1`, OGL readback, 180 s probe)

| Path                                       | distinct | distinct/s | gameSpeed | visualFps |
|--------------------------------------------|---------:|-----------:|----------:|----------:|
| Non-SAB (existing readback)                |     127  |    0.34    |   98.8 %  |    1.27   |
| SAB (`?oglsab=1`)                          |     121  |    0.67    |   97.2 %  |    1.63   |

~2 × faster visible-canvas progression at parity gameSpeed. Not enough
to displace software+JIT as the recommended URL (software stays at
22 visualFps), but the OGL hardware path is now usefully faster than
before.

### Code touched

- `src/core-host.js` — `?oglsab=1` URL parser, SAB allocation,
  `oglSabEnabled` gating in canvas-ownership logic, SAB-aware paint in
  `renderDolphin()`.
- `src/upstream-worker-adapter.js` — pass-through of the SAB pair in
  the load payload.
- `src/upstream-discio-worker.js` — SAB views, `workerOwnsCanvas`
  promotion in SAB mode, `publishOglSabFrame()` with the 14 ms throttle.
- `tools/menu-progress-validate.mjs` — `OGLSAB` env-var support.
- `README.md` — new row in the measured-status table for SAB.

## (2) Persistent JIT cache — investigated, NOT shipped

The user-visible goal: cut the 12 s of post-boot JIT warmup on repeat
sessions by reusing compiled WASM modules from IndexedDB. The
`DolphinWeb_CachedInterpreterCompileWasmBlock` EM_JS in
`vendor/dolphin/Source/Core/Core/PowerPC/CachedInterpreter/CachedInterpreter.cpp`
is where compilation happens (`new WebAssembly.Module(bytes)` is the
expensive step; instance creation with imports is cheap). Caching the
Module objects would let us skip recompilation.

**The blocker is Emscripten pthread architecture.** The compile call
runs on the Dolphin CPU pthread (or the GPU pthread for OGL-engaged
blocks). Pthreads in Emscripten are spawned Web Workers, each with their
own JS `Module` global initialized from the factory arguments. I
confirmed in Day 3 that custom `Module.*` properties set on the parent
worker (e.g., `Module.dolphinOglReadbackPresent`) come back as
**`undefined`** when read from the pthread side. So none of the obvious
cache designs work:

| Design                                              | Blocker |
|-----------------------------------------------------|---------|
| Load cached `WebAssembly.Module`s in main → post to worker → set as `Module._jitCache` | Pthread doesn't see worker-side `Module.*` additions |
| Pass cache through factory args                     | Same — Emscripten's pthread message protocol drops custom keys |
| Share cache via SAB                                 | `WebAssembly.Module` isn't SAB-storable; only raw bytes are, and bytes still need compilation |
| Pthread proxies cache lookups to worker via `MAIN_THREAD_EM_ASM` | Synchronous proxy blocks the pthread; still no way to async-await IndexedDB |
| Move JIT compile entirely onto the worker thread, pthread RPCs | Multi-session refactor — would break a load of CachedInterpreter invariants |

**Honest assessment:** a real persistent JIT cache requires moving the
compile path off the pthread, which is a structural change to
CachedInterpreter — deferred to a future session.

### What would actually work

If we accept the worker (not pthread) does compile, the design is:
1. Worker holds a `Map<hash, WebAssembly.Module>` populated from
   IndexedDB at boot.
2. Pthread, when it needs a block, posts a message to the worker
   (compile request: bytes + imports). The pthread spinwaits on an
   Atomics-backed flag.
3. Worker compiles (or hits cache), pushes the function to `wasmTable`,
   sets the result table-index in a shared SAB slot, notifies the
   pthread.
4. After compile, worker async-writes the Module to IndexedDB.

The `MAIN_THREAD_EM_ASM` family doesn't cover this — it dispatches to
the *module's main thread*, which IS the worker, but synchronously
*from* the pthread, blocking the pthread until the JS returns. We need
the pthread to wait for the *worker's* event loop to come around to the
postMessage. That's an Atomics.wait + bidirectional buffer pattern.

Doable, but a clean implementation is ~500 LOC of bridge work plus
careful invariant work in CachedInterpreter. Not this session.

## Other things tried this session, didn't ship

- `jittier=mixed` — sustained visualFps drops to 14 (safety guard
  cycles JIT off/on). Stick with guarded.
- `jitwarmup=100` — JIT engages in 3 s instead of 12 s, but visualFps
  drops to 14 because game hasn't reached steady state yet.
- `fastsw=0` — full software quality. visualFps drops to 4.7 — too
  much CPU. fastsw=1 is the right default.

All of these are documented for future sessions to skip.
