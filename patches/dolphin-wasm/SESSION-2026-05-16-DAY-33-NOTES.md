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
vertex base-type match is strict (Vulkan is lax). This is the next
single-construct fix and is load-bearing for A3 (real vertex buffers
+ draw) — pursue before/with A3.
