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

### A3 step 1-2 landed (dormant, no regression)

User chose "build the full block, then flip & iterate". Step 1
(shared `WebGPU::GetCommandStream()` accessor; `WebGPUGfx::m_cmd_stream`
is now a reference to it) and step 2 (`WebGPU::VertexManager` —
persistent 16 MB vbuf / 4 MB ibuf via `PushCreateBuffer`, `CommitBuffer`
rolls offsets + `UploadAlloc`+`PushUploadBuffer`, `DrawCurrentBatch`
records `SET_VERTEX/INDEX_BUFFER`+`DRAW_INDEXED`) are in.
`WebGPUVertexManager.cpp`/`WebGPUTexture.cpp` added to the WebGPU
CMakeLists (reconfigure needed; done). All dormant — VertexManager not
yet installed in VideoBackend, `CreateTexture` still SWTexture,
`SupportsUtilityDrawing()` still false. Verified `?video=wgpu`: 64/64
shaders, pcfg 64/0, test DRAW replays, Melee renders — no regression.
Checkpoint committed.

Bind layout (from the Day-22 translator SHADER_HEADER + shadergen,
nailed down for step 3/A4):
- `UBO_BINDING(packing,x)` → bind group 0, binding `x-1`:
  PSBlock x=1→b0, VSBlock x=2→b1, CustomShaderBlock x=3→b2 (usually
  absent), GSBlock x=4→b3. PS also declares VSBlock (VS consts in PS).
- `SAMPLER_BINDING(x)` → bind group 1: GX pixel path is the Day-30
  split — `texture2DArray tex_{0..7}u` at b0-7 + one shared
  `sampler samp_ss` at b8.
- `SSBO_BINDING(0)` → bind group 2, binding 0: BBox storage buffer
  (bSupportsBBox=true → PS references it → must be bound).
- UBO data: `system.Get{Vertex,Pixel,Geometry}ShaderManager().constants`
  (+ `.dirty`), upload `sizeof(*Constants)` (ConstantManager.h).
- Auto layout: build bind groups from
  `pipeline.getBindGroupLayout(group)`.

### A3 step 2b landed (producer resources, still dormant)

`WebGPU::VertexManager` no longer overrides `DrawCurrentBatch` — draw
recording is centralised in `WebGPUGfx::DrawIndexed` (it owns
pipeline/framebuffer/texture/UBO state); VM exposes
`GetVertexBufferId()/GetIndexBufferId()` and the base
`DrawCurrentBatch → g_gfx->DrawIndexed` path is used. `WebGPUTexture`
gains a bridge id: ctor emits `CREATE_TEXTURE` (format via
`MapTexFormat`, usage COPY_SRC|DST|TEXTURE_BINDING|RENDER_ATTACHMENT),
`Load()` emits `UPLOAD_TEXTURE`. Still dormant — `CreateTexture`
returns `SWTexture`, `SupportsUtilityDrawing()` false → WebGPUTexture/
VertexManager never instantiated, no opcodes emitted. Compile-verified,
no regression. Checkpoint committed.

### Remaining: Step 3 + A4 + A5 + C (the grind — exact design)

This is the part that only gets a probe signal post-flip. Decisive
design decision after analysis: **use explicit fixed bind-group
layouts, NOT `layout:"auto"`.** With auto layout a bind group must
match exactly the bindings the shader uses (varies per TEV config) —
unmanageable. Dolphin's real backends use one fixed descriptor-set
layout; mirror that:

- Consumer builds 3 fixed `GPUBindGroupLayout`s once:
  - group 0 (uniforms): b0 PSBlock, b1 VSBlock, b2 CustomShaderBlock,
    b3 GSBlock — all `buffer:{type:"uniform"}`, visibility
    VERTEX|FRAGMENT.
  - group 1 (samplers): b0..7 `texture:{sampleType:"float",
    viewDimension:"2d-array"}`, b8 `sampler:{type:"filtering"}`,
    visibility FRAGMENT.
  - group 2 (ssbo): b0 `buffer:{type:"storage"}`, visibility FRAGMENT.
  Make one `GPUPipelineLayout` from the 3; pass it as `layout` in
  `replayCreatePipelineCfg` (drop `"auto"`). Naga-translated WGSL
  declares a subset of these bindings — explicit layout may declare
  bindings the shader omits (allowed); the reverse is not.
- Producer (`WebGPUGfx::DrawIndexed`, centralised): ensure pass open
  (BEGIN_PASS recorded by SetFramebuffer); upload the 3 GX UBOs from
  `system.Get*ShaderManager().constants` when `.dirty`
  (`PushCreateBuffer` once UNIFORM|COPY_DST, `PushUploadBuffer` each
  frame); assemble 3 `CREATE_BIND_GROUP` blobs (always all bindings —
  dummy 1x1 texture / 16-byte buffer / shared sampler for absent
  resources, so groups are uniform) + `SET_BIND_GROUP` 0/1/2;
  `PushSetPipeline` (pipeline id from
  `static_cast<WebGPUPipeline*>(m_current_pipeline_object)`);
  `PushSetVertexBuffer/IndexBuffer` from the VM ids;
  `PushSetViewport/Scissor` (re-emit after each BEGIN_PASS — WebGPU
  resets pass state); `PushDrawIndexed`.
- WebGPUGfx overrides to add: `SetPipeline`, `SetFramebuffer/
  SetAndDiscard/SetAndClearFramebuffer` (end-prev + BEGIN_PASS with
  color/depth ids from `WebGPUTexture::GetBridgeId()` of the
  framebuffer attachments; fbId 0 = backbuffer), `BindBackbuffer`
  (BEGIN_PASS fbId 0), `PresentBackbuffer` (END_PASS + SUBMIT_PRESENT),
  `SetViewport`, `SetScissorRect`, `SetTexture` (cache id[8]),
  `SetSamplerState` (cache → one shared sampler), `DrawIndexed`/`Draw`.
- Consumer executor: replace the coalesced drain with a **sequential**
  executor — maintain `encoder`/`pass`; BEGIN_PASS → (end prev)
  beginRenderPass on EFB color+depth GPUTexture (or canvas for fbId 0)
  with loadOp/clear; SET_* on the pass; CREATE/UPLOAD_* via
  `device.queue` (order-safe, FIFO); END_PASS → pass.end();
  SUBMIT_PRESENT → queue.submit. Keep the old Clear/DrawTest coalesced
  path for the pre-flip test (unused post-flip).
- C (flip, same commit as the executor going live): `WebGPUGfx::
  SupportsUtilityDrawing()`→true; `CreateTexture/CreateStagingTexture/
  CreateFramebuffer` return WebGPU classes; in `WebGPU::VideoBackend::
  Initialize` swap `SWVertexLoader`→`std::make_unique<WebGPU::
  VertexManager>()`, drop `Clipper::Init/Rasterizer::Init/
  SWBoundingBox/SWEFBInterface/SW::TextureCache` (use the existing
  `WebGPUEFBInterface`, `PerfQueryBase`, a real bbox). Then **probe →
  one construct → fix**, repeatedly (expected: bind-group/layout
  mismatches, UBO std140 sizes, EFB depth format, coordinate Y-flip,
  XFB present). `?video=webgpu` hybrid stays a separate untouched path
  throughout.

This remaining block is the documented multi-session grind; every
unknown is now a known mechanical fix-loop, no research left.

## CUTOVER LANDED — hardware path live (Day-33 Phase C)

The full block shipped in one coherent build + flip, then ground with
the probe (user: "build the full block, then flip & iterate" →
"continue until we retire the software delegation").

`SupportsUtilityDrawing()`→true; `CreateTexture/CreateStagingTexture/
CreateFramebuffer` return WebGPU classes; `VideoBackend::Initialize`
uses the **hardware** `InitializeShared` (generic HardwareEFBInterface
+ TextureCacheBase) with `WebGPU::VertexManager` — `SWVertexLoader/
Clipper::Init/Rasterizer::Init/SWEFBInterface/SW::TextureCache` are
gone (SWBoundingBox kept as the CPU bbox). `WebGPUGfx` records the
full AbstractGfx surface (SetPipeline/SetFramebuffer*/SetViewport/
SetScissorRect/SetTexture/Draw/DrawIndexed/BindBackbuffer/
PresentBackbuffer) + UBO upload + 3 fixed bind groups. Consumer is a
sequential opcode executor with explicit fixed bind-group layouts
(group0 UBO b0-3, group1 tex b0-7 + sampler b8, group2 ssbo b0;
replaces layout:"auto").

Probe-driven grind so far (each = one construct, rebuild, reprobe):
1. **Upload 4-alignment** — `queue.writeBuffer` needs offset & size
   ≡0 mod 4; VertexManager now 4-aligns the index region + rounds
   upload lengths (vertex stride is already 4-aligned). Consumer
   defensively rounds too. → the only blocking exec error cleared.
2. **Bind-group explosion** — was 3 new GPUBindGroups *per draw*
   (1.7M/run). group0(UBO)+group2(ssbo) reference fixed buffers →
   built once & reused; group1(tex+sampler) rebuilt only when the
   bound set changes (FNV sig). 1.7M→218k, missBg 43k→24k.

Telemetry (`[webgpu-exec] stats`): emulator runs 100% speed;
`beginFbN≈8k` EFB passes + `drawIdx≈650k` indexed draws per 50s —
**EFB rendering executes**; one `beginFb0`/present (backbuffer blit).
Zero exec/bind-group/validation errors. But canvas = 2 distinct
hashes (static green): the green is the **EFB clear colour** showing
through — the GX geometry draws execute into the EFB but don't produce
visible geometry yet (classic first-light backend bring-up: transforms
/UBO/state not yet pixel-correct). One pcfg still fails (1/65: a
utility shader uses a group-1 binding outside the fixed sampler
layout).

State: `?video=wgpu` is fully off the Software rasteriser and on the
remote WebGPU hardware renderer end-to-end; the remaining grind is
render-correctness (why EFB draws don't yield visible geometry) +
the bind-group LRU + the 1 utility-shader layout. `?video=webgpu`
hybrid remains a separate untouched shipping path.

### Diagnostic findings (probe-measured, not speculation)

One-shot executor logging of the first passes/draws:
- `first backbuffer pass load=clear clear=0,0,0` → the green is NOT
  our backbuffer clear (black). Green is downstream of the blit.
- `EFB pass#1 fb=14(rgba8unorm) depth=15(depth32float) load=clear`
  → the real EFB is correctly structured (color+depth, cleared).
- `EFB pass#2/3/5 fb=47(bgra8unorm) depth=0(none) load=load` →
  intermediate/XFB-format passes with **no depth attachment**.
- `DRAW_INDEXED# idx=6/99/51 firstIdx/baseVtx increasing` → real
  batched GX geometry with sane parameters is being issued.

So geometry draws execute with correct params into a correctly-formed
EFB, zero exec/validation errors *caught*, yet nothing visible.

### Prioritised remaining grind (mechanical, ordered by evidence)

1. **Pipeline/pass attachment-format match.** Pipelines are built
   from `pcfg` `FramebufferState` (MapDepthFormat/MapColorFormat),
   but draws are replayed into whatever texture the bound framebuffer
   is (rgba8unorm+depth32float for EFB, bgra8unorm+none for fb=47).
   A pipeline with `depthStencil` drawn into a no-depth pass, or a
   colour-format mismatch, is a **silent uncaptured WebGPU
   validation failure** (we don't `pushErrorScope` around passes →
   no log). Fix: wrap pass/draw replay in an error scope to surface
   it (get the signal), then make the consumer choose the pipeline
   variant / attachments to match (or rebuild pcfg keyed on the
   actual target formats). This is the #1 suspect for "draws do
   nothing".
2. **`WebGPUGfx::ClearRegion` is a no-op** — the game's per-frame BP
   EFB clear (background colour + depth) is dropped. EFB depth never
   gets the game's clear → depth test rejects geometry. Needs a real
   clear (scoped clear pass / loadOp) on the EFB.
3. **The green source.** Backbuffer clears black; if the XFB blit
   fails (per #1) the canvas should be black, not green — identify
   what paints green (legacy presenter idle? canvas alpha? page
   backdrop) once #1/#2 land.
4. Bind-group LRU (group1 still ~170k/run — reuse by signature
   across frames, not just consecutive).
5. The 1/65 utility pcfg layout fail (group-1 binding outside the
   fixed sampler layout — likely TEXEL_BUFFER_BINDING).

Every item is a known probe→fix cycle; no research left. This is the
documented multi-session first-light bring-up.

### Render-correctness grind (probe→one-construct→fix, error-scoped)

Added `device.pushErrorScope("validation")` around each frame's
encoder so silent uncaptured WebGPU validation surfaces in
`console.log` — then fixed each one-at-a-time. Every one of these was
poisoning the whole frame's submit (one bad op → entire frame
discarded → canvas stuck at 2 hashes); they must ALL clear before
first pixel:

1. **Upload 4-alignment** — `writeBuffer` offset/size ≡0 mod4.
2. **Bind-group reuse** — group0/2 once, group1 by sig (1.7M→~190k).
3. **Scissor/viewport clamp** — VideoCommon emits 640×480 but the
   EFB/canvas target is 320×240; consumer clamps to live pass dims.
4. **No-pipeline-draw guard** + **synchronous pipeline-map insert**
   (the async popErrorScope window caused "No pipeline set").
5. **GetSurfaceInfo → BGRA8** — backbuffer is the bgra8unorm canvas,
   not RGBA8.
6. **Pipeline variants keyed on live (colorFmt,depthFmt)** — Dolphin
   pipeline framebuffer-state vs real WebGPU target formats diverge;
   build/cache a variant per actual pass attachment set
   (`resolvePipeline`). Killed the whole "Attachment state not
   compatible" class.
7. **Texture array layers** — thread `TextureConfig.layers` through
   CREATE_TEXTURE (+ defensive z-skip) — was "copy range z:1 outside
   1-layer texture".
8. **EFB-feedback dummy substitution** — a sampler slot referencing
   the current render target is a read-while-write hazard
   ("writable usage and another usage in the same synchronization
   scope"); substitute the 1×1 dummy (genuine EFB-copy renders to a
   different target so its id won't match).

Method proven, converging — each fix removes one frame-poisoning
validation error; the error-scope probe surfaces the next. Remaining
known-minor: the 1/65 utility shader (group-1 binding outside the
fixed sampler layout — likely TEXEL_BUFFER) and the bind-group LRU.

### DECISIVE: all WebGPU validation now clears, but wrong surface

After fix 8 the error scope reports **zero validation errors** —
every frame's encoder builds & submits cleanly (present=2640,
beginFb0=2640, beginFbN≈7100, drawIdx≈570k, 100% speed). Yet the
canvas stays a static green (2-3 hashes).

Decisive diagnostic: forced our backbuffer (fb=0) pass clear to
**magenta** → the canvas stayed **green**. So our executor's
`fb=0 → renderGpu.context.getCurrentTexture()` render is *not* the
surface the page composites / the validator screenshots. We have
been rendering correctly to the wrong canvas.

`renderGpu` is `createWebGpuPresenter(renderCanvas)` and
`renderCanvas` is the worker's `canvas`. The legacy present path
(`handleWebGpuShowImage → presentFrame → drawFrameBytesToWebGpu`)
is what actually drove the visible canvas pre-cutover; post-cutover
(SupportsUtilityDrawing=true) `ShowImage` is dead so that path gets
no frames and the displayed surface is frozen green, while our
cmd-ring backbuffer pass renders to a context that isn't presented.

**This is the next (and likely last structural) grind item:** route
the cmd-ring's final presented frame onto the surface the page
actually shows — either (a) have the executor's backbuffer pass
target the exact context the page composites (confirm whether
`renderCanvas` is the transferControlToOffscreen'd visible canvas vs
a standalone OffscreenCanvas whose ImageBitmap is posted to main),
or (b) after SUBMIT_PRESENT, push the rendered backbuffer through
the same presentFrame/ImageBitmap mechanism the legacy path used.
All GPU rendering itself is now validation-clean; this is plumbing,
not correctness.
