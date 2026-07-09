# Session 2026-05-14 (Day 14) — WebGPU video backend scaffold

User asked to "expand scope so we can realistically speed up the
performance with the GPU renderer." Day-11 Chrome tracing pinpointed
the OGL freezes as `gpu::GLES2::ReadPixels` blocking 1-3 seconds on
GPU command-buffer drain — a structural limit of the WebGL2 + pthread-
proxy + readback architecture. Day-12 detached path proved the
no-readback model works (input latency 240× better) but is still
constrained by WebGL2's per-call proxy overhead and lack of fine-
grained command batching.

The native answer is a WebGPU backend. WebGPU was designed for the
modern async + command-buffer model the existing Dolphin Vulkan/
Metal/D3D11 backends already target. **Research summary** (research
ran by document-specialist subagent, full transcript in this session):

- **Path A: Vulkan API shim on top of WebGPU.** Architecturally
  mismatched (WebGPU deliberately strips bindless, fine-grained
  barriers, timeline semaphores, push-constant inlining). No prior
  art at production level. **Wrong bet.**
- **Path B: Custom WebGPU backend.** Dolphin's abstract `AbstractGfx`
  interface is well-factored — adding a fifth backend (alongside OGL,
  Vulkan, D3D11, Software, Null) is the same pattern the project has
  been adding backends with for years. 3-6 months to playable.
  **Right bet.**
- **Path C: wgpu cross-platform.** Long-term sound, requires C++/Rust
  FFI which is risky for Dolphin's existing codebase. Defer.

**Verdict: Path B.** Day 14 is the scaffold day.

## What landed (Day 14 scaffold)

New directory: `vendor/dolphin/Source/Core/VideoBackends/WebGPU/`
(gitignored vendor tree — files exist in the local checkout, surfaced
into the wasm output via the build).

Files (all parallel a Null backend file, named `WebGPU*` instead of
`Null*`, namespace `WebGPU` instead of `Null`):

```
VideoBackend.h
VideoBackend.cpp
WebGPUGfx.h           ← AbstractGfx subclass
WebGPUGfx.cpp
WebGPUTexture.h       ← AbstractTexture + StagingTexture + Framebuffer
WebGPUTexture.cpp
WebGPUVertexManager.h ← VertexManagerBase subclass
WebGPUVertexManager.cpp
WebGPUBoundingBox.h
PerfQuery.h
TextureCache.h
CMakeLists.txt
```

Every function body is a no-op or returns a placeholder polymorphic
object — same surface contract as the Null backend. The plumbing exists
so future days add one real WGPUDevice call at a time without breaking
the build or the working OGL / Software / Null backends.

Build-system wiring (under-vendor, captured by the wasm rebuild):

- `vendor/dolphin/Source/Core/VideoBackends/CMakeLists.txt` —
  `add_subdirectory(WebGPU)`. Unconditional so the source tree
  compiles cleanly for desktop builds too; runtime registration is
  what's gated.
- `vendor/dolphin/Source/Core/VideoCommon/VideoBackendBase.cpp` —
  `#include "VideoBackends/WebGPU/VideoBackend.h"` and
  `backends.push_back(std::make_unique<WebGPU::VideoBackend>())`,
  both gated on `#ifdef HAS_WEBGPU`.
- `vendor/dolphin/Source/Core/Core/CMakeLists.txt` — links
  `videowebgpu` into `core` (unconditional, harmless on desktop) and
  sets `HAS_WEBGPU` as a compile definition only on the
  `dolphin_web_core` (Emscripten) target.

Project-side wiring (in-tree, committed):

- `src/core-host.js::requestedVideoBackend` accepts `?video=webgpu` and
  returns the string `"WebGPU"`.
- `core/upstream/dolphin_web_core.cpp::SetVideoBackend` accepts
  `"WebGPU"` and stores it for `ActivateBackend` to find.

## Verified end-to-end

20-second probe with `VIDEO=webgpu`:
- Build: clean, 454 ninja steps, 9 new object files
- `Dolphin upstream core mounted` status pill fires
- JIT cache works (`jit-cache: discio recorded 10 new compiles`)
- distinct canvas hashes = 2 (the boot black + one stale buffer state
  — expected, the backend renders nothing yet)

## What's coming Day 15+

Each day adds one real WebGPU pipeline stage:

- **Day 15:** Acquire a `WGPUDevice` via `emscripten_webgpu_get_device()`
  inside `WebGPU::VideoBackend::Initialize()`. Configure swap chain on
  the visible canvas. Clear-color render every frame so `?video=webgpu`
  produces a visible non-black canvas.
- **Day 16:** Implement `WebGPUTexture` against `wgpuDeviceCreateTexture`.
  Upload pattern + format mapping.
- **Day 17:** Render passes + command encoder. Implement `Draw` /
  `ClearRegion` / `PresentBackbuffer`.
- **Day 18-25:** WGSL pipelines. The hardest part — Dolphin emits
  custom GLSL for TEV stages, vertex transforms, post-processing.
  Either retarget the emitter (cleaner, bigger code change) or run the
  GLSL through Naga/Tint to WGSL (slower but mechanical).
- **Day 25+:** EFB readback, texture cache, perf tuning. Production.

The Day-15 milestone (clear-color visible) is the next concrete
deliverable. Everything past that is incremental.

## Files touched this session (project-tracked)

- `src/core-host.js` — `?video=webgpu` accepted.
- `core/upstream/dolphin_web_core.cpp` — `SetVideoBackend("WebGPU")`
  accepted.
- `cores/dolphin/dolphin-core-upstream.{js,wasm}` — rebuilt.
- `patches/dolphin-wasm/SESSION-2026-05-14-DAY-14-NOTES.md` — this file.
