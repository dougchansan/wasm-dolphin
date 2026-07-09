# Session 2026-05-14 (Day 15) — First WebGPU call, visible non-black canvas

Day 14 landed the scaffold (a Null-equivalent WebGPU video backend
registered in VideoBackendBase, reachable via `?video=webgpu`). Day 15's
goal: prove the WebGPU pipeline is alive end-to-end. By the end of the
session the validator screenshots show the canvas cycling
red → green → blue at every refresh while `?video=webgpu` is selected.

## The three concrete steps

1. **Enable the emdawnwebgpu Emscripten port.** The original Day-14 plan
   was to add `-sUSE_WEBGPU=1` to the wasm link. Recent Emscripten has
   removed that flag and replaced it with `--use-port=emdawnwebgpu`,
   which pulls a newer (and intentionally incompatible) webgpu.h spec
   driven by Dawn upstream. The first build with `-sUSE_WEBGPU=1` fails
   loudly:

   > em++: error: invalid command line setting `-sUSE_WEBGPU=1`: No longer
   > supported; replaced by --use-port=emdawnwebgpu

   Switching the link flag fixes it. Emscripten then fetches and caches
   the port from github.com/google/dawn (~MB-scale zip, one-time).

   The compile step for `videowebgpu.a` also needs the port to find
   `<webgpu/webgpu.h>` on the include path. Added
   `target_compile_options(videowebgpu PRIVATE "--use-port=emdawnwebgpu")`
   gated on `EMSCRIPTEN` in
   `vendor/dolphin/Source/Core/VideoBackends/WebGPU/CMakeLists.txt`.

2. **Include `<webgpu/webgpu.h>` from C++ and prove the binding links.**
   First entry point is a smoke call in `WebGPU::VideoBackend::Initialize`:

   ```cpp
   WGPUInstance instance = wgpuCreateInstance(nullptr);
   INFO_LOG_FMT(VIDEO, "WebGPU smoke: wgpuCreateInstance = {}",
                static_cast<void*>(instance));
   if (instance) wgpuInstanceRelease(instance);
   ```

   No-op at runtime, but proves the entire C API is reachable from
   wasm. The public `VideoBackend.h` deliberately *forward-declares*
   `WGPUDevice` (`struct WGPUDeviceImpl; using WGPUDevice = WGPUDeviceImpl*;`)
   so that `videocommon`'s `VideoBackendBase.cpp` — which includes the
   header to call `backends.push_back(...)` — doesn't drag the WebGPU
   port onto every translation unit's include path.

3. **Device acquisition + visible clear-color render pass.**
   `createWebGpuPresenter()` in the discio worker already acquires a
   WGPUDevice and configures a canvas context for the existing
   software-renderer presenter blit. With `?video=webgpu`, we now:

   - Forward that same device to Emscripten via the factory option
     `preinitializedWebGPUDevice: renderGpu.device`. The C++ side
     calls `emscripten_webgpu_get_device()` to retrieve it.
   - Run a JS-side `startWebGpuClearLoop()` that fires a clear-only
     render pass every animation frame (cycling red → green → blue so
     it's obvious the loop is alive). This is the user-facing proof:
     the canvas is no longer black with `?video=webgpu`.

   Validator with `VIDEO=webgpu PRESENTER=webgpu DURATION=15`:
   3 distinct canvas hashes (one per color phase),
   `present webgpu signal:wait mode:smooth fps:31 raw:51` ,
   `100% speed`, `60 core` — pipeline healthy end-to-end.

## Edge cases / non-trivial corners hit

- **Cryptic crash without device-presence guard.** Before adding the
  `Module['preinitializedWebGPUDevice']` JS-side guard, the C++ call to
  `emscripten_webgpu_get_device()` ran when the validator's default
  presenter was `webgl` (so `renderGpu` was null and the factory option
  was `undefined`). emdawnwebgpu's `importJsDevice` does
  `device.queue` and threw `TypeError: Cannot read properties of
  undefined (reading 'queue')` from the worker. Fix: probe `Module`
  with `EM_ASM_INT(...)` before calling the C bridge, and warn loudly
  when no preinitialized device is present.

- **Validator default presenter is `webgl`, not `webgpu`.** The default
  in `tools/menu-progress-validate.mjs:96` keys off `videoMode`:
  `videoMode === "software" ? "webgpu" : "webgl"`. To exercise the new
  WebGPU video backend's end-to-end path the run needs an explicit
  `PRESENTER=webgpu`. Day 16+ might want the validator to default to
  `webgpu` when `VIDEO=webgpu` too.

- **The clear loop is intentionally tiny.** Once the C++ side starts
  emitting real render passes (Day 17+), the JS clear loop will be
  removed — the loop only exists so the user can *see* the WebGPU
  context is configured and presenting while the C++ side is still a
  stub.

## What's still a stub past Day 15

- `WebGPUGfx` still returns placeholder polymorphic objects from every
  factory; no real `wgpuDevice*` calls inside the AbstractGfx ops.
- Dolphin XFB output continues to flow through the old Software ▶
  WebGPU-presenter blit path, not through real WebGPU command
  encoders.
- No swap chain reconfigure on canvas resize.
- No queue submission of Dolphin draw commands.

## Day 16+ direction

- **Day 16:** Move the canvas-context handling into C++ via
  `wgpuSurfaceConfigure` + `wgpuSurfaceGetCurrentTexture`. Replace the
  JS clear loop with a C++-emitted clear-color render pass per frame.
  At that point the JS path becomes pure presenter, not a renderer.
- **Day 17:** Implement `WebGPUTexture` on top of
  `wgpuDeviceCreateTexture`. Add format mapping for the EFB colour
  formats Dolphin actually uses.
- **Day 18-25:** WGSL pipelines. Decide between
  (a) retargeting Dolphin's GLSL emitter to WGSL directly, vs.
  (b) running emitted GLSL through Naga/Tint at boot.
  Option (a) is cleaner long-term, option (b) ships faster.

## Files touched this session (project-tracked)

- `src/upstream-discio-worker.js` — `preinitializedWebGPUDevice`
  forwarded to factory, `startWebGpuClearLoop()` added, status pill
  message added.
- `cores/dolphin/dolphin-core-upstream.{js,wasm}` — rebuilt with
  `--use-port=emdawnwebgpu` linked in and the WebGPU video backend's
  `Initialize()` now probing for a JS-side device.
- `patches/dolphin-wasm/SESSION-2026-05-14-DAY-15-NOTES.md` — this file.

Vendor changes (gitignored, captured by the wasm rebuild):

- `vendor/dolphin/Source/Core/Core/CMakeLists.txt` — `-sUSE_WEBGPU=1`
  replaced with `--use-port=emdawnwebgpu`.
- `vendor/dolphin/Source/Core/VideoBackends/WebGPU/CMakeLists.txt` —
  `target_compile_options(videowebgpu PRIVATE --use-port=emdawnwebgpu)`
  gated on `EMSCRIPTEN`.
- `vendor/dolphin/Source/Core/VideoBackends/WebGPU/VideoBackend.{h,cpp}` —
  `WGPUDevice` member, smoke call to `wgpuCreateInstance`, guarded
  `emscripten_webgpu_get_device()`.
