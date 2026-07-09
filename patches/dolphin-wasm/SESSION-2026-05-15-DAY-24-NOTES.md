# Session 2026-05-15 (Day 24) — real shader modules + an architectural finding

Goal: wire `WebGPUGfx::CreateShaderFromSource` →
`GlslToWgsl` → `wgpuDeviceCreateShaderModule`. Done — and it surfaced
a structural blocker that reshapes the remaining hardware-renderer
plan.

## What landed

- `WebGPUShader` now holds a real `WGPUShaderModule` + the translated
  WGSL (released in dtor). Module-less fallback keeps the Software
  path alive on any failure.
- `WebGPUGfx` takes the `WGPUDevice` (from `VideoBackend::Initialize`).
- `WebGPUShaderTranslator` now prepends Dolphin's `SHADER_HEADER`
  (Vulkan backend's verbatim — `#version 450`, extensions,
  `ATTRIBUTE_LOCATION` / `UBO_BINDING` / `float2→vec2` macros) before
  glslang. Dolphin's shader-gen emits no preamble; every backend adds
  its own.
- Per-attempt diagnostics via EM_ASM console.log (Dolphin's LogManager
  isn't wired to the browser console here).

## The finding (why this can't be incremental)

Measured on real Dolphin shaders: **xlat ok=6 fail=58**, `device=0`.
First failure dumped this GLSL:

    {
      v_tex0 = float3(float((id << 1) & 2), float(id & 2), 0.0f);
      opos = float4(v_tex0.xy * float2(2,-2) + float2(-1,1), 0, 1);
    }

That's the screen-quad vertex shader's *body only* — no
declarations, no `void main()`. Root cause:
`FramebufferShaderGen::GetAPIType()` returns
`g_backend_info.api_type`. **Day 21 set that to `APIType::Nothing`**
so VideoCommon's vertex transform matches the Software CPU rasteriser
(the exploded-geometry fix). For `APIType::Nothing`,
`EmitVertexMainDeclaration` / `EmitSamplerDeclarations` / … all hit
`default: break;` and emit nothing — the Software renderer never
compiles GLSL, so shadergen deliberately produces stubs. They're not
real shaders, so they can't be translated. The 6 that pass + the
Day-23 smoke prove the translator itself is sound on *complete*
shaders.

`api_type` simultaneously controls:

1. shadergen dialect + completeness (Nothing ⇒ stubs; Vulkan ⇒ full
   compilable GLSL), and
2. vertex-transform / clip-space conventions used by VideoCommon.

The Software hybrid needs (2) = `Nothing`. Real shader translation
needs (1) = `Vulkan`. They're mutually exclusive. **There is no
"translate shaders while Software still rasterises" intermediate.**

Also confirmed orthogonally: `device=0` — the Day-15 device-
forwarding gap (emscripten_webgpu_get_device returns null on the
thread Initialize runs on). Must be fixed for the GPU path regardless;
tracked separately.

## Revised plan for the real hardware renderer

It's one coherent commit, not a staircase:

1. Flip `g_backend_info.api_type` to a real GPU API (Vulkan dialect —
   Dolphin's most WGSL-translatable GLSL) and restore the matching
   Vulkan vertex-transform / backend-info caps (revert the Day-21
   `Nothing` shape).
2. Real `WGPURenderPipeline` from `AbstractPipelineConfig` (blend /
   depth / raster state mapping), real `WGPUBuffer` vertex+uniform,
   bind-group layouts for UBO_BINDING/SAMPLER_BINDING.
3. EFB/XFB as real `WGPUTexture`s; `Draw`/`DrawIndexed` →
   `wgpuRenderPassEncoderDraw`; EFB→XFB copy on the GPU.
4. Fix Day-15 device forwarding so `WebGPUGfx` actually gets a device
   on the Initialize thread.
5. Retire the Software-rasteriser delegation in the same step.

The Day 22–24 scaffolding (translator, SHADER_HEADER, shader-module
wiring, diagnostics) is all directly reused once api_type flips —
nothing here is throwaway. What changed is the understanding that the
flip is a single big step, not a sequence of small visible ones.
`?video=wgpu` keeps rendering via the Software path (unchanged, no
regression) until that lands; `?video=webgpu` hybrid remains the
stable fallback.

## Files touched (project-tracked)

- `cores/dolphin/dolphin-core-upstream.{js,wasm}` — rebuilt.
- `patches/dolphin-wasm/SESSION-2026-05-15-DAY-24-NOTES.md` — this.

Vendor (gitignored): `WebGPUGfx.{cpp,h}`,
`WebGPUShaderTranslator.cpp`, `VideoBackend.cpp`.
