# Session 2026-05-15 (Day 22) — WebGPU hardware-renderer: shader-xlat scaffold

The user clarified the goal: Days 18–21 render correctly and smoothly
but it's still the **CPU Software rasteriser** doing GameCube work,
WebGPU only presenting. They want the real **hardware renderer** —
GameCube GPU emulation as shaders running on the GPU.

## Strategy decision (user-chosen)

A real WebGPU backend needs Dolphin's ~5,900-line GLSL/HLSL shader
generators (PixelShaderGen/VertexShaderGen/UberShader*) producing
shaders the browser's WebGPU accepts. Browser WebGPU is **WGSL-only**
— confirmed: emdawnwebgpu's webgpu.cpp returns
`"ShaderSourceSPIRV requested, but not supported in Wasm"`, so the
"reuse Vulkan SPIR-V" shortcut is dead.

Options put to the user:
1. Hand-write a WGSL emitter in Dolphin's shader-gen (~6k lines).
2. **Bundle a GLSL→WGSL transpiler (Naga/Tint)** ← chosen.
3. Harden the OGL/WebGL2 path instead.

Rationale for (2): reuses ALL of Dolphin's existing shader logic
(TEV correctness is the hard part); the translation is mechanical.

## Pipeline

    Dolphin GLSL ──glslang──▶ SPIR-V ──[Naga, TBD]──▶ WGSL ──▶ wgpuDeviceCreateShaderModule

- **glslang** is already compiled into the wasm build
  (`Externals/glslang`, linked for the Vulkan backend) and exposed via
  `VideoCommon/Spirv.h` (`SPIRV::Compile{Vertex,Geometry,Fragment,
  Compute}Shader`). `videowebgpu` already links `videocommon`, so
  GLSL→SPIR-V is available with zero new deps.
- **spirv_cross** is also in Externals but has no WGSL backend — can't
  use it for the second hop.
- SPIR-V→WGSL needs Naga (Rust) or Tint (C++, from Dawn). emdawnwebgpu
  ships only the webgpu.h bindings + JS shim, NOT Tint (Tint runs
  inside Chrome, not our wasm). So that transpiler is a real
  integration, deferred to the next sub-project.

## What landed Day 22

New `VideoBackends/WebGPU/WebGPUShaderTranslator.{h,cpp}`:

- `GlslToSpirv(stage, glsl)` — wraps `SPIRV::Compile*Shader`
  (APIType::Vulkan dialect, SPIR-V 1.0). **Works today.**
- `SpirvToWgsl(spirv)` — placeholder, returns `nullopt`. The seam the
  Naga integration plugs into.
- `GlslToWgsl(stage, glsl)` — composes the two; `nullopt` until Naga.

`WebGPU::VideoBackend::Initialize` runs a smoke: compiles a
representative Vulkan-dialect GLSL fragment shader and reports the
SPIR-V word count via `EM_ASM(console.log(...))` (Dolphin's LogManager
isn't wired to the browser console in this build, so the validator
only sees ~32 lines; the EM_ASM console.log surfaces as a
`[worker:...]` line it does capture).

## Verified

20s `VIDEO=wgpu` probe console.log:

    [webgpu-shader-xlat] GLSL->SPIR-V words=87 (SPIR-V->WGSL pending Naga)

87 SPIR-V words for the trivial FS is exactly right. GLSL→SPIR-V is
proven functional inside the constrained wasm/browser environment.
Game still renders via the Day-18 Software path (16 distinct hashes,
clean) — nothing regressed; the translator is dormant until WGSL
output exists.

## Honest scope statement

This is the foundation, not the renderer. Remaining for a real
hardware backend, roughly in order:

1. **Naga→wasm SPIR-V→WGSL** (the next sub-project). Naga is wgpu's
   shader translator (Rust, smaller than Tint). Likely compiled to a
   standalone wasm module driven from the discio worker, since
   Rust↔Emscripten C++ in-process linking is awkward. Async shader
   compile (Dolphin's `AsyncShaderCompiler`) makes a worker round-trip
   acceptable.
2. Real `WebGPUGfx` pipeline objects: `WGPUShaderModule` /
   `WGPURenderPipeline` / `WGPUBuffer` vertex+uniform / bind groups.
3. EFB/XFB as real `WGPUTexture`s; `Draw`/`DrawIndexed` issuing real
   render passes; EFB→XFB copy on the GPU.
4. Wire `WebGPUGfx::CreateShaderFromSource` →
   `GlslToWgsl` → `wgpuDeviceCreateShaderModule`, flip
   `SupportsUtilityDrawing`/backend-info to real WebGPU caps, retire
   the Software-rasteriser delegation.

Each is a multi-session step. Day 22 de-risked step 0 (proving the
GLSL→SPIR-V half is reachable in-build) and built the seam.

## Files touched (project-tracked)

- `cores/dolphin/dolphin-core-upstream.{js,wasm}` — rebuilt.
- `patches/dolphin-wasm/SESSION-2026-05-15-DAY-22-NOTES.md` — this.

Vendor (gitignored, captured by the wasm rebuild):

- `VideoBackends/WebGPU/WebGPUShaderTranslator.{h,cpp}` — new.
- `VideoBackends/WebGPU/VideoBackend.cpp` — smoke + includes.
- `VideoBackends/WebGPU/CMakeLists.txt` — adds the translator.
