# Session 2026-05-16 (Day 33) — Phase A: full AbstractGfx executor

Continuation of the WebGPU hardware-renderer cutover. Day 30-32 proved
shader translation (64/64) + a real Dolphin VS+FS test pipeline/draw
through the cross-thread command ring. This session executes the
PLAN-webgpu-hardware-renderer-NEXT plan: widen the opcode set to the
full AbstractGfx command set, build the consumer executor, then retire
the Software delegation.

Method (per plan): smallest behavior-preserving increment → build →
probe (`?video=wgpu`, console = signal channel) → screenshot →
checkpoint commit. `?video=webgpu` hybrid must never regress.

## Baseline (HEAD ceb0869, pre-Phase-A)

Two reference probes captured:
- `?video=wgpu` — 64/64 shaders translate, test pipeline 22
  (VS=1+FS=4) builds OK, `first DRAW replayed (verts=3)`, Melee CSS
  renders at full speed (SW hybrid still in the chain via the
  Presenter ShowImage fallback). Artifacts:
  `.omx/menu-progress/2026-05-16T10-02-30-451Z`.
- `?video=webgpu` hybrid — Melee CSS renders, 35 distinct hashes.
  Artifacts: `.omx/menu-progress/2026-05-16T10-10-07-952Z`.

## A1 — opcode set widened + upload arena (behavior-preserving)

`WebGPUCommandStream.{h,cpp}`: added the full Phase-A opcode set
(CreateBuffer/UploadBuffer/CreateTexture/UploadTexture/
CreatePipelineCfg/CreateSampler/CreateBindGroup, BeginPass/SetPipeline/
SetBindGroup/SetVertexBuffer/SetIndexBuffer/SetViewport/SetScissor/
Draw/DrawIndexed/EndPass/SubmitPresent/Destroy — wire form per
DESIGN-webgpu-command-protocol) + `Push*` helpers + a 32 MB per-frame
upload arena (bump-allocated, wraps; no per-frame malloc). The Day-27..
32 opcodes 0-4 keep their exact wire form. `EnsureRing` now also
allocates the arena and hands `uploadPtr/uploadSize` to the discio
worker.

`src/upstream-discio-worker.js`: mirrored the opcode constants, widened
`webGpuObjects` (buffers/textures/samplers/bindGroups maps), captured
the upload arena base in `handleWebGpuCmdRing`. No new producer opcodes
are emitted yet (WebGPUGfx still drives only the proven test path) so
behavior is identical.

Verified: build OK (`[6/6] linked`, only the pre-existing unused
`m_device` warning); probe `?video=wgpu` → 64/64 shaders, pipeline 22
built, `first DRAW replayed`, zero errors, Melee CSS renders — matches
baseline. Checkpoint committed (`f9cdc32`).

## A2 — AbstractPipelineConfig → real GPURenderPipeline

User decision: enum mapping lives **producer-side** (C++ pre-maps every
Dolphin pipeline-state enum to numeric WebGPU codes; consumer just
indexes). Decisive factor: `BlendingState::ApproximateLogicOpWithBlending()`
(DESIGN-required LogicOp handling) is a C++ method, and it matches the
already-established usage/format wire convention.

`WebGPUGfx.cpp`: `SerializePipelineConfig` emits a `'WPL3'` blob —
topology/strip-index, cull (+All flag), depth test/write/compare,
FB color+depth formats, blend (logic-op approximated on a local copy
per DESIGN), write-mask, and the vertex layout mirroring
`VKVertexFormat::MapAttributes` **exactly** (single binding 0,
`ShaderAttrib` locations, `VarToWgpuVertexFormat` ≅ `VarToVkFormat`).
`CreatePipeline` ships it via `PushCreatePipelineCfg`; `WebGPUPipeline`
carries the consumer pipeline id. Draw path unchanged this increment
(still the proven `DrawTest`) so it's behavior-preserving and measures
build coverage like the shader-coverage method.

`upstream-discio-worker.js`: `replayCreatePipelineCfg` parses the blob,
builds a real `GPURenderPipeline` (real blend/depth/raster/vertex
layout; `layout:"auto"` until A4 adds bind groups), defers if shader
modules not yet built, validation-scoped, coverage-counted.

Verified `?video=wgpu`: **64 real pipeline configs build OK, 9 FAIL,
0 defer**; 64/64 shaders; test `DrawTest` still replays; 41 distinct
hashes; Melee CSS renders — no regression. Checkpoint committed.

### Next construct (probe-surfaced, the A2→A3 blocker)

The 9 failures are one systematic cause:

    [webgpu-pcfg] build FAIL id=48: Attribute base type
    (Uint for VertexFormat::Uint8x4) does not match the shader's
    base type (Float) in location (1)

Location 1 = `ShaderAttrib::PositionMatrix` (posmtx). When
`decl.posmtx.integer` is set we emit `uint8x4` (Uint base), but the
Naga-translated WGSL VS declares that input as `Float`. WebGPU's
vertex base-type match is strict (Vulkan is lax).

### A2b — posmtx base-type fix (api_type-gated, CONCLUSIVE)

Root cause was concrete: `VertexShaderGen.cpp` had a `#ifdef
__EMSCRIPTEN__` forcing `in float4 posmtx` for **all** Emscripten
backends. That workaround is an **OGL/WebGL2/ANGLE**
`glVertexAttribIPointer` bug fix only — WebGPU has no such bug and its
vertex format is `uint8x4 → uint4`, matching desktop Vulkan. Gated the
float workaround off the Vulkan dialect (`api_type == APIType::Vulkan
→ in uint4 posmtx`); OGL Emscripten keeps `float4`, desktop unchanged.
The transform body uses `int(posmtx.r)` which is type-agnostic, so no
body change. (Cosmetic `-Wdangling-else` on the new nested if/else —
logic verified correct; explicit braces folded into the A3 edit to
avoid a rebuild solely for a warning.)

Verified `?video=wgpu`: **pcfg ok=64 fail=0 defer=0** (was fail=9) —
**100% of real Dolphin pipeline configs build as valid WebGPU
pipelines**; 64/64 shaders (no translation regression from the VS
change); 45 distinct hashes; Melee CSS renders. Checkpoint committed.

## A3 — real WebGPU VertexManager + AbstractGfx draw recording

Architecture note (load-bearing): `VertexManagerBase::DrawCurrentBatch`
calls `g_gfx->DrawIndexed(...)`; VideoCommon's real Renderer drives
`g_gfx->SetPipeline / BindFramebuffer / SetViewport / DrawIndexed`.
Today `SupportsUtilityDrawing()==false` → VideoCommon takes the simple
`ShowImage(xfb)` SW-hybrid fallback and never calls those, so the
recording machinery built in A3/A4/A5 is **dormant until the Phase-C
flip** (same no-regression pattern as A1/A2). Real end-to-end render
is verified at/after Phase C.

### Decisive consequence for sequencing (read before continuing)

A1/A2/A2b were verifiable per-increment because they ran on paths
VideoCommon already exercises (shader create, pipeline create). A3
(draw/state recording), A4 (binds), A5 (pass/EFB/XFB) are **only
reached once `SupportsUtilityDrawing()` is flipped true and the SW
delegation is retired** (Phase C) — VideoCommon's `ShowImage(xfb)`
fallback never calls `SetPipeline/DrawIndexed/SetFramebuffer`. So none
of A3/A4/A5 produces a probe signal until the flip, and the flip
produces no signal unless A3+A4+A5 are coherent (pipeline[✓] + vertex
buffers + bind groups + render pass + present). The plan's proven
method (probe → one construct → fix) **requires that observability**.
Therefore the remaining work is one coherent block landed together,
then iterated post-flip with the probe — NOT more blind dormant
commits (that is the "batch speculative fixes" anti-pattern the plan
forbids). This is the next session's focused arc.

### Exact A3→C build order (mechanical, no research left)

1. **Shared command stream.** Lift `WebGPUCommandStream` out of
   `WebGPUGfx`'s private member into a backend-global accessor
   (`WebGPU::GetCommandStream()`), since `WebGPU::VertexManager` and
   the `WebGPUGfx` AbstractGfx overrides both produce into it.
   `EnsureRing()` is already idempotent; single-producer holds (video
   pthread).
2. **`WebGPU::VertexManager`** (`WebGPUVertexManager.{h,cpp}`):
   - Keep base `ResetBuffer` (writes into `m_cpu_vertex_buffer` /
     `m_cpu_index_buffer` — base ctor sizes them MAXV/IBUFFERSIZE).
   - One-time: `PushCreateBuffer` a persistent vertex buffer
     (VERTEX|COPY_DST, e.g. 16 MB) + index buffer (INDEX|COPY_DST,
     e.g. 4 MB); store ids.
   - `CommitBuffer(numV,stride,numI,*baseV,*baseI)`: roll an offset in
     each persistent buffer (reset per frame / wrap with N-frame
     headroom); `UploadAlloc` the `numV*stride` vertex bytes + `numI*2`
     index bytes into the upload arena; `PushUploadBuffer` into the
     persistent buffers at the rolled byte offset; set
     `*out_base_vertex = vbyteoff/stride`, `*out_base_index =
     ibyteoff/2`.
   - `DrawCurrentBatch(baseIdx,numIdx,baseVtx)`: `PushSetVertexBuffer
     (0, vbufId, 0)`, `PushSetIndexBuffer(ibufId, /*u16*/0, 0)`,
     `PushDrawIndexed(numIdx, 1, baseIdx, baseVtx)`. (Pipeline + pass +
     binds come from the WebGPUGfx overrides below.)
3. **`WebGPUGfx` AbstractGfx overrides** (record opcodes):
   - `SetPipeline(p)` → `PushSetPipeline(static_cast<const
     WebGPUPipeline*>(p)->GetBridgeId())` (0 ⇒ skip; pipeline blob is
     already A2).
   - `SetFramebuffer / SetAndDiscardFramebuffer /
     SetAndClearFramebuffer` → end any open pass, `PushBeginPass`
     against the framebuffer's color+depth texture ids (EFB) with
     load/clear from the variant. `BindBackbuffer` → begin the
     backbuffer pass (fbId 0). `PresentBackbuffer` → `PushEndPass` +
     `PushSubmitPresent` + XFB present (A5).
   - `SetViewport` → `PushSetViewport`; `SetScissorRect` →
     `PushSetScissor`.
   - `Draw` → `PushDraw`; `DrawIndexed` is driven via the
     VertexManager (above).
4. **A4 — textures/samplers/binds.** `CreateTexture` returns a real
   `WebGPUTexture` (id from `PushCreateTexture`; `Update/Load` →
   `UploadAlloc`+`PushUploadTexture`). `SetTexture`/`SetSamplerState`
   record into a pending bind-group; `UploadUniforms` (VS/PS/GS
   constant buffers via `Update*ShaderConstants`) → `PushCreateBuffer`
   UBO + `PushUploadBuffer` + assemble `PushCreateBindGroup`
   (UBO_BINDING + SAMPLER_BINDING 0-7 split tex + sampler 8, per the
   Day-30 split & DESIGN bind layout) and `PushSetBindGroup` before
   the draw. Consumer builds textures/samplers/bind-groups/UBOs and
   binds them in the pass.
5. **A5/B consumer executor.** Extend `drainWebGpuCmdRing`: maintain
   EFB color+depth `GPUTexture` pair (created via `CREATE_TEXTURE`),
   execute `BEGIN_PASS…SET_*…DRAW(_INDEXED)…END_PASS` into it, then
   present XFB to the canvas (reuse the existing presenter blit).
   Generalize `replayCreatePipelineCfg` to honor an explicit bind
   group layout (drop `layout:"auto"`).
6. **C — flip.** `WebGPUGfx::SupportsUtilityDrawing()` → true; stop
   `CreateTexture/CreateStagingTexture/CreateFramebuffer` returning SW
   classes; in `WebGPU::VideoBackend::Initialize` swap `SWVertexLoader`
   → `std::make_unique<WebGPU::VertexManager>()` and drop
   `Clipper::Init/Rasterizer::Init/SWBoundingBox/SWEFBInterface/
   SW::TextureCache` (use a real EFB-backed `WebGPUEFBInterface` /
   `PerfQueryBase` / bbox). Then **iterate with the probe** — expect
   to revisit `InitBackendInfo` caps to match what truly renders
   (the plan's documented gotcha). `?video=webgpu` hybrid stays
   untouched throughout.

Files the next session will touch (vendor, gitignored — captured via
the wasm rebuild): `WebGPUCommandStream.{h,cpp}` (shared accessor),
`WebGPUVertexManager.{h,cpp}`, `WebGPUGfx.{h,cpp}`, `WebGPUTexture.*`,
`VideoBackend.cpp`; plus `src/upstream-discio-worker.js` (executor)
and the SESSION notes.
