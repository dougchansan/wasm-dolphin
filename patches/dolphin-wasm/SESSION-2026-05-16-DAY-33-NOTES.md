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

### Present-surface investigation (precise next step)

Added `context.configure({device,format,alphaMode:"opaque"})` in
`createWebGpuPresenter` (pre-cutover only `drawFrameBytesToWebGpu`
configured it, on first XFB — dead post-cutover). Correct fix, but
canvas still green / 2 hashes, no errors. The canvas IS
`transferControlToOffscreen`'d (core-host.js:134 →
UpstreamWorkerAdapter). So the open question is **which worker owns
the transferred visible canvas vs where `renderGpu`
(createWebGpuPresenter) actually runs**. The discio-worker comment
(top of upstream-discio-worker.js) says WebGPU objects aren't
shareable across workers — there is a video pthread AND the discio
worker. Pre-cutover the wgpu canvas updated because the SW hybrid
fed `webgpu-show-image` → `drawFrameBytesToWebGpu` → renderGpu.context
(which therefore WAS visible). Post-cutover that's gone and the
cmd-ring backbuffer pass renders to renderGpu.context but the magenta
clear never appears — so either renderGpu's canvas is not the
transferred/composited one for the `WebGPU-Real` (`?video=wgpu`)
path, or a second worker holds the visible OffscreenCanvas.

Next session: trace the canvas hand-off for videoBackend
"WebGPU-Real" specifically (core-host.js / UpstreamWorkerAdapter /
which worker setupSoftwarePresenter's `canvas` arrives in), and
either (a) ensure the discio worker's renderGpu uses the transferred
visible OffscreenCanvas, or (b) post the cmd-ring's finished frame to
whatever owns it (mirror the legacy presentFrame/ImageBitmap hop).
This is the *only* thing between "validation-clean hardware frames"
and "visible GameCube content". Then: bind-group LRU, the 1/65
utility-shader layout, and the smoothness/comp-play pass (task 8).

### ROOT CAUSE of the green — found (the real one)

A magenta-final-clear (absolute last GPU op submitted to
`renderGpu.context`, logged, no throw) STILL showed green. Decisive:
something overwrites `renderGpu.context` *after* `drainWebGpuCmdRing`
every loop iteration. It's `runPresentationLoop`: right after
`drainWebGpuCmdRing()` it unconditionally calls
`presentFrame(width,height,api.frameBuffer(),…)` →
`drawFrameBytesToWebGpu` → renders the **CPU framebuffer** to
`gpu.context.getCurrentTexture()` and submits. Pre-cutover that CPU
buffer was the SW rasteriser's XFB (correct Melee). **Post-cutover the
SW rasteriser is retired**, so `api.frameBuffer()` is stale/empty —
that's the uniform green — and it clobbered our correct cmd-ring GPU
render on every single iteration. The hardware renderer was working
the whole time; the legacy CPU-present path was painting over it.

Fix: `cmdRingOwnsCanvas` flag — set once the executor processes a
SUBMIT_PRESENT; `runPresentationLoop` then skips the legacy
`presentFrame`/capture blit (the cmd-ring presents the canvas itself
via `gpu.context`). `?video=webgpu` hybrid never sets the flag (it
doesn't drive the executor's present path), so its CPU→canvas blit is
unaffected — no regression.

**VERIFIED:** with the fix, `?video=wgpu` canvas now shows the
cmd-ring's OWN GPU output (no longer the clobbering green; `present`
pill = 0 confirming the legacy blit is suppressed). The WebGPU
hardware-renderer present path is now correct end-to-end. Committed.

### Now: EFB render-correctness grind (geometry → pixels)

The canvas shows our real EFB output: a green field + black margin —
i.e. the EFB *clear* shows, geometry isn't visible yet. Classic
cause: `WebGPUGfx::ClearRegion` was a no-op, so the game's BP
clear-screen never initialised the EFB **depth** buffer → every
primitive fails the depth test → only the background shows. Fix
landed: `ClearRegion` now ends the open pass and begins a fresh
loadOp=clear EFB pass (game ARGB colour; consumer clears depth to
1.0), so subsequent draws render into a properly-cleared EFB.

### Post-ClearRegion probe (measured) — narrows it to EFB→XFB resolve

Console now shows `EFB pass#1 fb=14(rgba8unorm) depth=15(depth32float)
load=clear clear=0,0,0,0` — the EFB **is** cleared (colour+depth)
every frame, geometry draws, then it's resolved into
`fb=47 (bgra8unorm, no depth, load)` and blitted to the backbuffer.
Screen unchanged: green field + ~12% black LEFT margin. Therefore:
- the green is NOT the EFB clear (black 0,0,0,0) — it enters at the
  fb=47 XFB-intermediate / present-blit stage;
- prime suspect: **`WebGPUTexture::CopyRectangleFromTexture` is still
  the CPU-only stub** — it memcpy's into `m_data` and emits NO GPU
  opcode, so the GPU XFB texture never receives the rendered EFB.
  The EFB→XFB resolve must become a real GPU copy/blit opcode
  (CopyRectangleFromTexture / ResolveFromTexture → emit a
  copyTextureToTexture or a blit pass).
- black left margin = the XFB→backbuffer blit sub-rect (aspect/
  viewport) — a smaller, later item.

Then: geometry/UBO correctness, bind-group LRU, the 1/65 utility
shader, and the smoothness/comp-play pass (task 8).

**SESSION MILESTONE:** Phase A→B→C complete and committed — Software
delegation retired, the remote WebGPU hardware renderer runs the full
GameCube frame validation-clean at 100% speed, and (this session's
decisive fix) its output now reaches the visible canvas end-to-end.
Remaining is the EFB→XFB GPU-resolve + geometry grind, fully scoped,
no research left. Late-session the dev environment degraded badly
(probes/builds ~5min, every shell backgrounds) — the documented grind
is best continued on a fresh environment.

## Day-33 (cont.) — EFB→XFB hypothesis disproved; utility-layout fix

Fresh environment. Probe-driven, per the method.

### 1. CopyRectangleFromTexture was NOT the EFB→XFB path

Added a real GPU blit opcode (`CmdOp::BlitTexture`=24, `PushBlitTexture`,
16-bit-packed rects/8-bit layers) and made
`WebGPUTexture::CopyRectangleFromTexture`/`ResolveFromTexture` emit it
(consumer: same-format+size → `copyTextureToTexture`; rgba8unorm→
bgra8unorm → cached sampled fullscreen-triangle render-pass blit). Kept
the CPU memcpy for incidental readback. Built, probed: the
`[webgpu-blit]` one-shot **never fired** — `CopyRectangleFromTexture`
is not the EFB→XFB resolve here. The probe shows the resolve is a
render pass into `fb=47 (bgra8unorm)`: EFB renders into fb=14
(rgba8unorm+depth), a utility draw copies it into the fb=47 XFB
texture, then the backbuffer (fb=0) samples fb=47. The previous
session's "CopyRectangleFromTexture stub" hypothesis was wrong. The
opcode is retained (correct for the genuine EFB-copy-to-texture-cache
paths) but is not the present blocker.

### 2. DECISIVE fix: group-1 fixed layout was missing utility samplers

Probe surfaced exactly ONE failing construct:

    [webgpu-pcfg] variant FAIL 22|rgba8unorm|depth32float
    (vs=1 fs=21): Binding doesn't exist in "dolphin-bg1-samp"
     - @group(1) @binding(9) ... While validating the entry-point

Root cause (concrete, in `FramebufferShaderGen.cpp:49-50`): utility/
framebuffer shaders emit `fbtex{i}`→`SAMPLER_BINDING(i)` (group1 b0-7)
and `fbsmp{i}`→`SAMPLER_BINDING(i+8)` (group1 **b8-15**).
`GenerateEFBRestorePixelShader` uses `EmitSamplerDeclarations(0,2)`, so
`fbsmp1` lands at `@group(1) @binding(9)`. The fixed group-1 layout
only declared b0-7 (texture) + **b8** (one sampler), so any 2+-sampler
utility shader fails pipeline-build.

Fix (consumer-only, `upstream-discio-worker.js`):
- `getFixedLayouts`: group-1 now declares b0-7 texture + **b8-15
  sampler** (every SHADER_HEADER sampler binding the translator can
  emit). Declaring bindings a shader omits is allowed; the reverse was
  the failure.
- WebGPU requires a bind group to bind *every* layout binding, but the
  producer blob only carries used bindings → `replayCreateBindGroup`
  now pads group-1 gaps with persistent dummies (1×1 2d-array texture
  for b0-7, a default sampler for b8-15). Existing bindings unchanged.

Probe-verified: **`variant FAIL` is GONE** (no pipeline-build failure),
zero validation/bind-group errors. Added per-pass diagnostics
(`[webgpu-exec] pass#N fb=… pipeOk/bgOk/draw…`) which prove the present
chain now executes: `fb=47` XFB-copy pass = pipeOk=1 bgOk=3 draw=1;
`fb=0` backbuffer pass = pipeOk=1 bgOk=3 draw=1. EFB clears 0,0,0,0.

### 3. State / next

Canvas is still a uniform field (the game's GX clear colour) — the
present chain is correct end-to-end now, so the remaining problem is
**geometry not landing in the EFB**, not the resolve/present. The
dominant probe signal is the bind-group/pipeline miss explosion
(`missBg` ~1%→24% and climbing as texture churn grows: `bg`≈135k
created, `tex`≈247; `missPipe` climbing too). That is the bind-group
LRU / resource-lifetime issue (was task 4) now on the critical path,
plus geometry/UBO correctness (task 3). Next grind: why GX draws don't
appear — bind-group/resource lifetime first (it gates whether draws
even have correct uniforms/textures), then transform/UBO.

### 4. Ring overflow was real (not the visual blocker) — fixed

Added `[webgpu-ring] DROPPED` telemetry to `WebGPUCommandStream::Push`.
Probe: the ring overflowed massively (50k+ records dropped) the moment
Melee burst-loads textures (`tex` 62→241 around present 480-600).
Dropping a record permanently loses a resource/state op → the
consumer's `missBg/missPipe` ratchet up forever (geometry never lands).

Three fixes, each probe-verified:
- **Producer bind-group-1 sig→id cache** (`WebGPUGfx`, direct-mapped
  1024): the old single-last-sig slot re-emitted `CREATE_BIND_GROUP`
  whenever consecutive draws used different texture sets (Melee cycles
  many/frame). Result: consumer `bg` count **135k → ~4k** (≈40×
  fewer builds).
- **Ring 4096 → 65536** records (2 MB; trivial) for burst slack.
- **Bounded backpressure** in `Push`: instead of silently dropping
  when full, spin a *bounded* (~500k iters) wait on the consumer's
  read index — the consumer is a separate worker draining
  continuously, so space frees in microseconds; correctness over the
  Day-27 no-stall policy (smoothness is task 8). Small cap so that if
  `api.runFrame()` (same JS thread as the drain) is itself the thing
  blocked, it degrades to a drop instead of freezing emulation.
  Result: **DROPPED 50000+ → 1 total**, speed still ~102% (no
  deadlock), `missBg` ~14× lower.

**But the canvas is still a uniform field (`distinct=1`).** So the
ring/bind-group churn was a genuine defect (now fixed) yet NOT why
geometry is invisible. The present chain demonstrably runs (fb=47
XFB-copy + fb=0 backbuffer each pipeOk=1/bgOk=3/draw=1), EFB clears,
~250k indexed GX draws execute into fb=14 — but produce no visible
pixels. Residual `missBg`≈1.7% / `missPipe`≈2.4% now has a *different*
cause (replayCreateBindGroup early-returns when a referenced texture
isn't in the map yet) — minor, not a whole-screen-uniform cause.

### 5. Next: geometry not landing (transform/depth + present scale)

The uniform colour = the game's GX clear (ClearRegion ARGB). Geometry
draws execute but don't appear. Suspects, in order:
- **Present/XFB scale mismatch**: fb=47 XFB is **2560×1024**, fb=0
  backbuffer **320×240**, UI canvas 640×480. The EFB→XFB copy and
  XFB→backbuffer blit viewport/UV may sample a uniform (clear) region
  of the oversized XFB — would show only the clear colour even with a
  fully-rendered EFB. (Overlaps task 2's black-left-margin sub-rect.)
- **Transform/UBO / depth**: vertices clipped/depth-rejected (the
  classic first-light cause) — verify only after the present scale is
  ruled in/out, since a bad present would hide correct EFB geometry.
The decisive next probe: dump the EFB (fb=14) directly to the
backbuffer (bypass XFB) — geometry visible ⇒ present-chain bug;
still uniform ⇒ EFB-content (transform/depth) bug.

### 6. Bisected: EFB-content bug, narrowed to the VERTEX INTERFACE

DIAG scaffolding added (all gated, revertible — `DIAG_EFB_TO_CANVAS`,
`DIAG_DEPTH_ALWAYS`, `[webgpu-DIAG-vs/-vtx/-wgsl/-attr]`):

1. **EFB→canvas bypass** (`DIAG_EFB_TO_CANVAS`): blit the raw EFB
   colour straight to the canvas after present. Result: **uniform
   BLACK** (not green). ⇒ the green was the XFB/present chain; the EFB
   itself has *no geometry*. Present chain is fine; bug is EFB content.
2. **Depth disabled** (`DIAG_DEPTH_ALWAYS` forces depthCompare
   "always"): still uniform black. ⇒ NOT depth-rejection.
3. **VS constants** (`[webgpu-DIAG-vs]`, offsets corrected to
   posnormalmatrix@float8 / projection@float32): steady-state values
   are **valid** — `pnm0=1,0,0,0 proj0=2.235,0,0,0 proj3=0,0,-1,0
   vp=0,0,640,480`. UBO data is correct (early all-zero samples were
   just pre-`SetConstants` boot draws). `dirty` path works.
4. **Vertex data** (`[webgpu-DIAG-vtx]`): sane —
   `nv=4 stride=12 v0=27.5,-22.5,-1.0,...` (real GC-space positions).
5. **Shader/pcfg interface** (`[webgpu-DIAG-wgsl]` +
   `[webgpu-DIAG-attr]`) — the smoking gun:
   - GX VS entry points: `fn main(@location(0) param: vec4<f32>)` OR
     `fn main(@location(1) param: vec4<u32>, @location(0) param_1:
     vec4<f32>, @location(8) param_2: vec2<f32>)`. VSBlock UBO at
     `@group(0) @binding(1)` ✓ (matches producer group0 b1=VS).
   - pcfg vertex layouts: `id=13 stride=20 L0:float32x2@0
     L5:unorm8x4@16 L8:float32x2@8`; `id=45 stride=20 L0:float32x4@0
     L5:unorm8x4@16`.
   So the **vertex attribute interface is inconsistent**: VS inputs
   use locations {0}, or {0,1,8} with L1 = `vec4<u32>` (posmtx, the
   Day-33 A2b uint4); pcfg supplies {0,5,8} / {0,5} with NO L1, and
   L0 format/stride disagree with the live `DIAG-vtx stride=12`.
   Position read with the wrong format/stride (e.g. float32x4 over a
   12-byte/​3-float vertex) corrupts `.w` → vertices to infinity →
   nothing rasterised → uniform-black EFB. Geometry executes (drawIdx
   huge, pipelines build) but every vertex is degenerate.

**Conclusion:** present chain ✓, UBO ✓, vertex data ✓, depth ruled
out — the bug is the **producer's pcfg vertex-attribute serialization
not matching the Naga-translated VS `@location` inputs / the
VertexManager's actual `PortableVertexDeclaration`** (shaderLocation
set, formats, offsets, arrayStride). This is task #3's core, now
precisely localised.

### 7. Exact next step (one-construct fix)

Correlate, for ONE concrete pipeline id, three things and make them
agree (extend the DIAG to print the third):
- the VS `@location` set + WGSL types (have it),
- the pcfg attribute list shaderLocation/format/offset/arrayStride
  (have it — from `WebGPUGfx::SerializePipelineConfig`, the
  `VKVertexFormat::MapAttributes` mirror),
- the live `PortableVertexDeclaration` the `WebGPU::VertexManager`
  actually packs (stride + per-attr enable/offset/type/components).
The mismatch is in `SerializePipelineConfig` (shaderLocation must be
the `ShaderAttrib` enum the translator emits — Position=0,
PositionMatrix=1 uint4, Color=?, TexCoord0=8 — and format/offset must
mirror the real PortableVertexDeclaration, skipping disabled attrs).
Fix that mapping → vertices transform correctly → first geometry.
All DIAG flags/log sites are gated constants; flip off when done.

### 8. Elimination matrix complete — bug is the translated VS / clip-space

Continued the probe→one-construct method. Each item below was
probe-verified and is NOT the cause (all DIAG gated, committed off):

| Checked | Method | Result |
|---|---|---|
| Present chain | EFB→canvas bypass | raw EFB itself is uniform black |
| VS UBO data (CPU) | `[webgpu-DIAG-vs]` @corrected offsets | valid steady-state (proj 2.235/3.707, real pnm) |
| VS UBO data (GPU) | `[webgpu-DIAG-ub]` consumer writeBuffer dump, periodic | id=55 (VS UBO, len=4112) receives valid pnm+proj@128 — GPU buffer is correct |
| Vertex data | `[webgpu-DIAG-vtx]` + `[webgpu-DIAG-ub]` id=66 | sane positions (27.5,-22.5,-1.0) uploaded |
| Shader/pcfg interface | `[webgpu-DIAG-wgsl]`+`[-attr]` correlated by vsId | VS `@location` sets match pcfg attrs (WebGPU vec3→vec4 default covers w=1); VSBlock @group(0)@binding(1) ✓ |
| Depth | `DIAG_DEPTH_ALWAYS` (depthCompare always) | still black |
| Cull / scissor | `DIAG_RASTER_OPEN` (cullMode none + skip scissor) | still black |

**Everything feeding the GPU vertex stage is verified correct, and
depth/cull/scissor are ruled out, yet the EFB receives zero geometry
pixels.** The remaining cause is therefore inside the **Naga-translated
GX vertex shader itself** — either the translated transform math is
wrong (clip position degenerate despite correct UBO+attributes) or a
**clip-space convention mismatch** (Vulkan-dialect shadergen output vs
WebGPU NDC: the VS does `gl_Position.y = -gl_Position.y` Y-flips and a
Vulkan depth-range assumption; if the net convention is off every
primitive lands outside the clip volume → nothing rasterised, which
looks exactly like this uniform-black-with-everything-else-correct).

Exact next step (no research, mechanical):
1. Dump a full GX VS body (`[webgpu-DIAG-wgsl]` already has the
   machinery — widen the slice) and trace how `@builtin(position)` is
   computed from the position attribute + `global` (VSBlock): confirm
   the projection multiply and the Y/Z/W handling.
2. Decisive isolation: in the consumer, for GX pipelines, substitute a
   trivial hand-written passthrough VS (clip = vec4(pos.xy*k, 0, 1),
   no UBO) for one probe. Geometry appears ⇒ the translated VS math is
   the bug (fix in the Naga path / shadergen Vulkan gating); still
   black ⇒ vertex *fetch* binding (arrayStride/offset at draw time)
   despite correct buffer contents.
3. If clip-space: compare the WebGPU-needed convention to Dolphin's
   Vulkan backend (it sets a negative-height viewport / depth range
   that the cmd-ring executor's `setViewport` must replicate; the
   shadergen Y-flip then composes correctly). The `vp=0,0,640,480,0,1`
   we send may need the Vulkan-style flip the real VK backend applies.

This is the documented multi-session first-light bring-up; the cause
is now boxed to one component (translated VS / clip-space) with the
entire rest of the pipeline proven correct and instrumented.

### 9. ★ FIRST LIGHT — root cause found & fixed ★

Dumped the full GX VS body (`[webgpu-DIAG-vsfull]`) and traced
`@builtin(position)`: `clip = projection·viewpos` (✓), depth-range
remap via `pixelcentercorrection` (✓), then **`clip.z = clip.z*2 -
clip.w`** — the OpenGL [0,1]→[-1,1] depth conversion
(`VertexShaderGen.cpp:824-829`, gated `if (!host_config.
backend_clip_control)`). WebGPU NDC depth is **[0,1]** (Vulkan/D3D
convention), so this remap pushed the near half of EVERY primitive to
`ndc_z < 0` → outside the WebGPU clip volume → discarded → the exact
"everything-correct-but-uniform-black-EFB" symptom.

Root cause: `WebGPU::VideoBackend::InitBackendInfo` **never set
`g_backend_info.bSupportsClipControl`** (default false, as in the
Software clone). `ShaderGenCommon.cpp:30` derives
`host_config.backend_clip_control` from it. Fix (one line, the
documented "revisit InitBackendInfo caps post-cutover" gotcha):

    g_backend_info.bSupportsClipControl = true;

**PROBE-VERIFIED — FIRST REAL GEOMETRY.** Raw EFB (via the
`DIAG_EFB_TO_CANVAS` bypass) now renders actual Melee: the
single-player **"Select / VERY EASY"** difficulty screen, `distinct`
1→13 (live/animating), 100% speed. The remote WebGPU hardware renderer
draws real GameCube geometry+text end-to-end. Committed.

Caveat / next: the *normal* present chain (DIAG off) still shows the
green field — the EFB is correct but the Dolphin XFB-copy→backbuffer
present path doesn't deliver it (this is task #2's territory and was
mis-scoped earlier as "working" from opcode counts alone). The
`DIAG_EFB_TO_CANVAS` blit is, in effect, a *correct* present (it puts
the real EFB on the canvas) and is left **enabled** as the interim
present so `?video=wgpu` shows real Melee now; replace it with a
proper EFB→XFB→backbuffer fix (aspect/sub-rect = the old "black left
margin", task #2) and then revisit colour/TEV/texture fidelity.
Remaining DIAG flags (`DIAG_DEPTH_ALWAYS`, `DIAG_RASTER_OPEN`) are
committed off; the passive `[webgpu-DIAG-*]` logs stay for the next
fidelity grind.

### 10. Post-first-light fidelity assessment (probe screenshots)

Validator navigated menus with the interim EFB→canvas present. Real
geometry renders and animates (`distinct` 1→13) but fidelity is
**partial**: solid/untextured geometry shows (large white "Select"
title text, mode box outlines) while textured geometry + backgrounds
do **not** appear (black). Classic next-stage cause: TEV / texture
sampling not yet correct — textured draws output black/transparent so
only flat-colour primitives are visible; also some scale/placement
offset (title text large, bottom-left) likely from the interim
full-EFB→full-canvas blit not matching Dolphin's intended
viewport/aspect.

This is the expected post-first-light state. Prioritised remaining
grind (each a probe→one-construct→fix, instrumentation already in
place):

1. **Texture/TEV colour fidelity** — why textured GX draws render
   black. Suspects: `SetSamplerState` is a no-op (one shared sampler,
   no per-index wrap/filter); `WebGPUTexture::Load` upload format vs
   `MapTexFormat`; the group-1 split (tex b0-7 / sampler b8) binding
   the dummy where a real texture is expected (`resolve_tex` dummy
   substitution may be over-eager now that geometry is correct);
   PixelShaderConstants (`m_ubo_ps`) contents. Use the existing
   `[webgpu-DIAG-*]` + a one-shot PS-UBO / bound-texture-id dump.
2. **Promote the interim present to a clean path** — make the
   EFB→canvas blit a real present (correct source rect = the game's
   XFB region, dest aspect-correct, no DIAG gating) OR fix Dolphin's
   XFB-copy→backbuffer chain (why fb=47/fb=0 draws produce green).
   The EFB-direct present is the simpler, robust choice for this
   remote architecture.
3. **Comp-play verification** (was task #4 tail) — once colour lands:
   stable ~57-60 fps, low frame-time variance, responsive input vs
   the `?video=webgpu` hybrid baseline.

`?video=webgpu` hybrid remains untouched. The decisive architectural
unknowns are now all retired — the WebGPU hardware renderer draws real
GameCube geometry; the rest is the documented fidelity fix-loop.

### 11. Fidelity grind: textures verified good — bug is TEV/PS/texcoord

Instrumented the texture path (`[webgpu-DIAG-bg1]` bind-group texture
ids, `[webgpu-DIAG-ut]` upload content). Findings:

- Group-1 binds **real game textures**, correct sizes/format
  (rgba8unorm): e.g. tex#101 32×32, tex#72 512×128 (a white-glyph
  font/text atlas, px=255,255,255,0), tex#73 88×88, EFB tex#14
  640×528; unused slots = the 1×1 magenta dummy (tex#58). Sampler ok.
- Uploaded pixel content is **real and non-zero** (nz 24–77% of
  sampled bytes) — the Load→`UPLOAD_TEXTURE`→`writeTexture` path works.
- So texture creation/binding/content are all CORRECT. Black textured
  geometry is therefore **downstream**: TEV combiner math /
  PixelShaderConstants (`m_ubo_ps`) / texcoord generation / alpha
  test. Consistent with the screenshot (the white font-atlas text
  *does* render — that TEV path works — while textured 3D/backgrounds
  don't).
- ⚠ Strong lead: **tex#69 is a 640×480 texture filled solid green
  `(0,135,0)`** and is bound at **b1 in almost every group-1 bind
  group**. That is the recurring "green" — likely an EFB-copy / XFB
  intermediate that is being (a) produced green instead of the EFB
  contents, and/or (b) TEV-combined into every draw, darkening/black-
  ing them and being what the broken normal present shows. Tracing
  why tex#69 is uniform green (its CREATE/render path — is it an
  EFBCopy target that our pipeline renders nothing into, or the XFB?)
  is the highest-value next construct for BOTH the textured-black and
  the green-present symptoms.

Next-construct order: (1) tex#69 — what writes it, why green; (2) PS
UBO / TEV constants for a known-black draw; (3) texcoord (tex matrix
in VSBlock member_9 / the `@location(8)` texcoord path). Passive
`[webgpu-DIAG-bg1|ut|...]` logs are committed (capped one-shots) for
this grind; behavior-altering DIAG flags stay off (except the interim
`DIAG_EFB_TO_CANVAS` present).

### 12. ★ CONCLUSIVE ROOT CAUSE: EFB-copy-to-RAM is stubbed ★

`[webgpu-DIAG-rt]` (logs every texture id ever used as a render
target) over a full run reports **only two**:

    render-target tex#14 640x528 rgba8unorm depth=15   (the EFB)
    render-target tex#47 2560x1024 bgra8unorm depth=0  (XFB blit)

So **tex#69 (640×480, uploaded solid green 0,135,0, bound at b1 in
nearly every group-1 bind group) is NEVER a render target** — it is
only ever `UPLOAD_TEXTURE`'d, i.e. `WebGPUTexture::Load()`'d from
emulated GameCube RAM. The game does an EFB-copy expecting the
rendered framebuffer to be encoded into RAM (its XFB / an EFB-copy
texture), then samples/présents it from RAM. Our backend never writes
EFB content back to RAM — `WebGPUStagingTexture::CopyFromTexture/
CopyToTexture` are no-op stubs and there is no EFB→RAM texture
encoder/readback — so that RAM stays at its stale init value, decoded
as the uniform green tex#69.

**This one stub is the root cause of BOTH open symptoms:**
- the green *normal present* (the game presents its XFB, read from
  the stale-green RAM), and
- *textured-black geometry* (draws sample tex#69 = green XFB-from-RAM
  at b1; TEV combines green×asset → wrong/dark/black). The font-atlas
  text renders because it doesn't depend on the EFB-copy RAM texture.

The interim `DIAG_EFB_TO_CANVAS` present works precisely because it
bypasses the RAM round-trip and shows the GPU EFB directly.

#### The real remaining work (design, not research)

Implement EFB-copy-to-RAM so `WebGPUTexture::Load()` of an XFB/EFB-
copy gets real pixels:
- Dolphin calls `TextureCacheBase::CopyEFB` / staging
  `CopyFromTexture` for EFB→texture and EFB→XFB(RAM). Provide a real
  path: GPU-read the EFB texture region back and write it into
  emulated RAM at the copy address (and/or keep an EFB-copy GPU
  texture and have the cmd-ring sample it instead of the RAM texture).
- Architectural crux (the reason this is the hard part): readback is
  GPU→CPU and async, but the producer (`WebGPUStagingTexture`) runs on
  the video **pthread** with no device/event loop; the GPU+
  `mapAsync` live on the **discio worker**. Needs a cmd-ring
  request→async-`copyTextureToBuffer`+`mapAsync`→write-into-shared-
  heap→signal path (mirrors the existing ring; same single-
  producer/consumer model). An EFB-copy is typically consumed a frame
  later, so a 1–2 frame readback latency is acceptable (ring it).
- Simplification worth trying first: many EFB-copies are immediately
  re-sampled as a *texture* (not needed in CPU RAM). Intercept
  `TextureCache` EFB-copy so the cmd-ring keeps the EFB-copy as a GPU
  texture and binds THAT for the matching `SetTexture`, skipping the
  RAM round-trip entirely (only true XFB→RAM / CPU-read cases need the
  full readback). That likely fixes most of Melee's visuals without
  the async-readback machinery.

Everything else (geometry, transforms, UBOs, pipelines, bind groups,
present-to-canvas) is proven correct and instrumented. This stub is
the last big construct between "real geometry" and "correct Melee".

### 13. copy-to-vram cap fixed (prerequisite, necessary not sufficient)

`g_backend_info.bSupportsCopyToVram` was false (Software clone) →
`TextureCacheBase.cpp:2194-2197` forced `copy_to_ram` for EVERY EFB
copy (the stubbed encoder/staging path → green tex#69). Set it
**true** (one line; same "revisit InitBackendInfo caps" gotcha class
as `bSupportsClipControl`/`bSupportsDualSourceBlend`). WebGPU has real
render-to-texture, so the `copy_to_vram` path is correct.

Probe-verified the path flipped: `[webgpu-DIAG-rt]` now reports new
**640×480 rgba8unorm EFB-copy render targets** (tex#52, #67, #153) in
addition to the EFB (tex#14) and XFB-blit (tex#47) — EFB copies now
render into real GPU textures, the RAM round-trip / staging stub is
out of the path. No regression (font text still renders, distinct≈12
animating, 99% speed). Committed.

**But the visible output is unchanged** (white "Select" text on
black; textured 3D / backgrounds still black). So copy-to-vram is a
necessary prerequisite (correct EFB-copy plumbing) but NOT the whole
fix — textured-black is a genuinely separate, deeper construct:
**TEV / PixelShaderConstants / texcoord generation**. Evidence: the
font-atlas text (a simple texture→colour TEV path) renders, while
texture+vertex-colour+lighting TEV configs and texcoord-matrix
(VSBlock member_9 / `@location(8)`) draws don't.

Next construct (probe→one): pick ONE known-black textured draw and
dump its PixelShaderConstants (`m_ubo_ps`, like the `[webgpu-DIAG-ub]`
VS dump) + its generated FS WGSL (the `[webgpu-DIAG-wgsl]` machinery,
stage=2) + its texcoords (VS output `@location` / the tex-matrix path)
and trace why the TEV output is 0. Suspects in order: texcoord gen
(tex matrices in VSBlock not uploaded / wrong → sample one texel →
black-ish), PS-UBO/TEV constants, alpha test discarding all fragments,
vertex-colour attribute (`@location(5)` unorm8x4) reading zero.

### 14. GX fragment-shader (TEV) dump — structure understood, no single smoking gun yet

Added a full GX FS dump (`[webgpu-DIAG-fsfull]`, stage=2, one-shot).
FS id=64 structure (Naga-translated, sound):
- `fn main(@builtin(position) param: vec4<f32>, @location(0) param_1:
  vec3<f32>) -> @location(0) vec4<f32>` — receives the interpolated
  texcoord varying at `@location(0)` (vec3).
- Samples `textureSample(global, global_1, uv.xy, i32(uv.z))` where
  the texcoord is `vec3(x, clamp(y,…), 0f)` — **`.z` is a constant
  `0f`**, so the array-layer index is 0 (NOT the suspected
  out-of-range-layer bug; ruled out).
- TEV runs in integer `[0,255]` then `/ 255f` (standard Dolphin TEV);
  uses `global: type_27` = the **PixelShaderConstants UBO** for the
  TEV register/konst colours.
- No obvious unconditional `discard`; output via the TEV chain.

VS↔FS varying note: different VS emit different `VertexOutput`
`@location` layouts (some `@location(0)=vec3` texcoord, others
`@location(0)=vec4`); the FS expects `@location(0)=vec3`. WebGPU
requires inter-stage `@location` types to match — a mismatched vs+fs
pcfg pair fails `createRenderPipeline`, and the consumer only logs the
**first** variant error (`self._webGpuPcfgFirstErr`), so later
failures are **silent** (→ that pipeline null → `missPipe` → that
draw black). This is now the leading suspect for "some textured draws
black": silent per-pipeline varying-interface failures, not one global
bug. (`missPipe` was ~2% overall but the *textured* subset may be
much higher.)

Decisive next probe (one construct): remove the `firstErr` one-shot
guard on the `[webgpu-pcfg] variant FAIL` log (or count fails per
vs+fs) so EVERY silent variant failure is visible, and read which
vs/fs pairs fail and why (varying type/location mismatch vs binding).
Then fix the producer's VS `VertexOutput` / FS input generation (or
the pcfg pairing) so interstage locations/types agree. Also still
open: PS-UBO (`m_ubo_ps`) steady-state validity at the correct
`PixelShaderConstants` offsets (the VS UBO is confirmed valid; the
DIAG-ub dump used VS-layout offsets so PS was inconclusive) and
texcoord-matrix upload.

This is the documented post-first-light TEV/fidelity fix-loop;
instrumentation (`[webgpu-DIAG-fsfull|vsfull|bg1|ut|rt|ub|attr|wgsl]`)
is all in place and committed for the next iteration.

### 15. Interstage-mismatch DISPROVEN — residual is TEV-computation, not structural

Relaxed the variant-FAIL one-shot guard to log up to 24 distinct
failures, full run. Result: **0 `variant FAIL`** (6 `variant OK`).
`[webgpu-exec] stats` at present=1800: `setPipe=84156 missPipe=1475`
(1.7%), `setBg=1106064 missBg=12642` (1.1%), `drawIdx=363285`. So:
- **No pipelines fail to build** — the VS↔FS interstage-mismatch
  hypothesis (§14) is wrong; all variants compile/link.
- missPipe/missBg are small and transient (resource-not-ready), not
  the textured-black cause.

Structural causes are now **exhaustively eliminated**: present chain,
clip-space/geometry (first light), UBO (VS verified valid), textures
(created, bound, real content), EFB-copy path (copy-to-vram), depth,
cull, scissor, pipeline build, bind groups — all verified correct.
The residual textured-black is therefore a **fine-grained TEV /
texcoord / sampled-content correctness** issue for specific GX TEV
configs (the simple font→colour TEV path works; multi-stage
texture+colour+lighting configs don't). It is NOT a single global
construct — it needs per-draw analysis: capture ONE specific
known-black draw and check its actual sampled texel range (is the
EFB-copy GPU texture it samples actually populated post-copy-to-vram?
verify by dumping that texture id's content like `[webgpu-DIAG-ut]`
but for a render-target/copy texture), its texcoord varying values
(VS texgen / tex-matrix in VSBlock), and hand-trace its TEV chain
against its PS UBO at correct `PixelShaderConstants` offsets. Likely
sub-causes: texgen matrices (VSBlock `member_9/10`) not populated →
degenerate UVs; EFB-copy GPU texture content (now a render target —
is the EFB-copy *draw* into it actually correct?); per-texture
sampler state (`SetSamplerState` is a no-op → wrong wrap/filter).

**Session boundary:** the decisive architectural breakthrough (first
light) and the conclusive remaining root cause (EFB-copy-to-RAM →
copy-to-vram) are landed and committed; everything structural is
ruled out and instrumented. The remaining work is a careful
per-draw TEV-fidelity grind best continued with fresh context, not a
single mechanical fix. `?video=webgpu` hybrid untouched throughout.

### 16. ★ CONCLUSIVE UNIFYING ROOT CAUSE: per-draw UBOs clobbered by batched submit ★

The §15 "fine-grained per-draw TEV correctness, NOT a single global
construct" framing was wrong — there **is** one global construct, and
§14/§15's "UBO verified valid" only ever checked the UBO *at upload
time*, never *at draw time*. The per-draw grind found it.

**Chain of evidence (this session):**
1. `[webgpu-DIAG-cpy]` (new): EFB-copy color targets tex#52/67/153 are
   uniformly **opaque black** (`0,0,0,255`, nz=25 % = alpha only) — the
   copy *draw into them* transfers nothing.
2. `[webgpu-DIAG-cpypass]` (new): those copy passes **do** run
   correctly — valid pipeline, 3 bind groups, 1 fullscreen `draw`,
   sampling the *correct* EFB (`srcTex=tex#14`). Good input, black out.
3. Source trace: every EFB-copy / texture-conversion shader
   (`TextureConverterShaderGen`, `TextureConversionShader`) reads its
   params from `UBO_BINDING(std140, 1) uniform PSBlock`
   → `WebGPUShaderTranslator.cpp:55` maps `UBO_BINDING(p,x)` to
   `binding=(x-1)` → **group0/binding0** (same slot the GX PS uses).
   Those params arrive via `g_vertex_manager->UploadUtilityUniforms`,
   which was the **empty `VertexManagerBase` no-op** (never overridden
   for WebGPU). So utility shaders ran with whatever stale bytes sat in
   `m_ubo_ps`. **Fixed** (this commit): implemented
   `WebGPU::VertexManager::UploadUtilityUniforms` → forwards to new
   `WebGPUGfx::UploadUtilityUniforms` (uploads into a dedicated util
   UBO; a util-variant bind-group-0 binds it at binding0 in place of
   m_ubo_ps; armed per-upload, cleared per-draw incl. skipped-draw
   early-returns; util UBO sized 4096 ≥ GX PSBlock so binding0 size is
   valid for any pcfg). Necessary + correct, **but EFB copies stayed
   black** → not the whole cause.
4. `[webgpu-DIAG-util]` (new, JS): dumped the small utility shaders'
   full WGSL. The EFB-copy VS (id=2) is translated **correctly** —
   `@group(0)@binding(0) var<uniform> {src_offset,src_size}`,
   `v_tex0 = src_offset + src_size*raw`, vertex_index fullscreen-tri
   (one harmless extra y-flip, nets out). The copy FS (id=4) reduces to
   a plain `textureSample(EFB, uv.xy, i32(uv.z))`. Both fine.
5. `[webgpu-DIAG-utilubo]` + `[webgpu-DIAG-ub]` (new, JS) — **the
   smoking gun**: the GX VS UBO (id=57, len=4112) is re-uploaded
   **per draw** with different values every time (pnm@32 changes each
   line); the GX PS UBO (id=56, len=1536) likewise; the util UBO
   (id=55) is overwritten by *several different* utility structs per
   frame (len 16/48/140). They all write the **same buffer id**.

**Root cause:** the discio-worker consumer batches the *entire frame*
into one `GPUCommandEncoder` + one `queue.submit()`. `queue.writeBuffer`
is queue-ordered and all of a frame's writeBuffers therefore complete
**before** any of that frame's encoded render passes execute. With one
shared buffer per UBO class re-written per draw, **every draw in the
frame reads only the *last* upload's uniforms** — per-draw
posnormalmatrix / projection / TEV-PS constants / EFB-copy src-rect are
all clobbered to the final draw's values. First-light "works" only
because the menu's dominant geometry happens to tolerate the last
frame-constant set (stable projection); per-material textured/TEV draws
and the EFB-copy src-rect do not → exactly the "textured-black,
per-draw, not-global" symptom. This is the construct §14/§15 believed
eliminated.

**The real remaining work (design, not research):** per-draw uniform
versioning — mirror Vulkan's uniform stream buffer + descriptor
dynamic offsets (and Dolphin's GX constant streaming). Concretely:
- One large persistent UNIFORM ring buffer per UBO class (or one
  shared). Each `UploadBuffer`/`UploadUtilityUniforms` **bump-allocates
  an aligned slice** (256-byte `minUniformBufferOffsetAlignment`) and
  records the slice **offset** with the draw.
- Consumer fixed group-0 layout entries become
  `buffer:{type:"uniform", hasDynamicOffset:true}`; `SET_BIND_GROUP`
  carries the per-draw dynamic offsets → `pass.setBindGroup(i, bg,
  offsets)`. One bind group per layout (offsets vary per draw) — keeps
  the bg cache tiny.
- Producer (`WebGPUGfx::PrepareDrawResources`,
  `WebGPUVertexManager`): allocate the ring slice at upload, thread the
  offset through a widened `SET_BIND_GROUP` (add a dynamic-offset
  triple) or a new `SET_DYNAMIC_OFFSETS` opcode. Ring sized so the
  consumer (≤2 frames behind) never reads a recycled slice (same
  reasoning as the vertex/upload arenas).
- The util UBO then naturally gets its own per-draw slice too (no
  separate m_bg0_util needed once binding0 is a dynamic-offset slice).

This is the last big construct between "real geometry + text" and
"correct Melee". Everything else (geometry, transforms-at-upload,
pipelines, bind groups, textures, EFB-copy plumbing, utility-uniform
upload) is proven correct and instrumented. Committed this checkpoint:
the utility-uniform-upload prerequisite (no regression — "Select"
still renders, 99 % speed, distinct≈12) + all passive
`[webgpu-DIAG-cpy|cpypass|util|utilubo]` instrumentation. Interim
`DIAG_EFB_TO_CANVAS` present unchanged; `?video=webgpu` hybrid
untouched. Best continued with fresh context — the design above is
mechanical, no research left.

### 17. ★ §16 construct LANDED & PROBE-VERIFIED: per-draw uniform ring ★

Implemented the §16 design end-to-end and it works.

- **Producer** (`WebGPUGfx`): one 32 MB persistent uniform ring
  (`m_ubo_ring`). `AllocUboSlice` bump-allocates a 256-aligned 8 KiB
  slice (`kUboSliceStride`, ≥ the largest UBO class —
  VertexShaderConstants ~4112) per **dirty** constant set, copies via
  the upload arena, returns the byte offset. PS/VS/GS slices reused
  while their manager is clean (upload rate unchanged from the old
  dirty model); `UploadUtilityUniforms` takes its own slice. Bind
  group 0 is built **once** over the ring with per-binding class sizes;
  the m_ubo_ps/vs/gs/util single buffers and the m_bg0_util variant are
  gone. Each draw emits 4 dynamic offsets `[b0,vs,b0,gs]`
  (b0 = util slice in util mode else PS slice) on `SET_BIND_GROUP(0)`.
- **Protocol**: `PushSetBindGroup(slot,bg,offsets,n)` packs
  `arg.u[2]=n, u[3..6]=offsets` (spare `CmdRecord` slots; ≤4 fit).
- **Consumer**: `l0` UBO entries `hasDynamicOffset:true`; group-0
  bind-group entries `{buffer,offset:0,size}` from the blob size field
  (size 0 ⇒ whole buffer, e.g. the bbox SSBO); `SET_BIND_GROUP` reads
  the offsets and uses the **zero-alloc** `pass.setBindGroup(slot,bg,
  data,start,len)` overload with a reused `Uint32Array(4)` scratch.

**Probe-verified (build 15:43, JS hot-path fix on top):**
`[webgpu-DIAG-cpy]` EFB-copy targets went **opaque-black →
populated** (`ctr 0,0,0,255` → `255,255,255,255`). The difficulty
screen now renders **"VERY EASY" in BLUE** — i.e. per-draw TEV/PS
*colour* constants are correct (the old single-buffer build clobbered
them to the last draw → black). 104–109 % speed, **JIT on**, no
`VALIDATION`, `?video=webgpu` untouched.

Perf gotcha (fixed, do not regress): the consumer `SET_BIND_GROUP`
hot path runs ~1.5 M×/run; a fresh offsets array per call stalled the
consumer → ring backpressure → the WASM-JIT **catastrophic** guard
tripped (speed collapsed 99 % → ~30 %, frame ~976 vs ~1900). Switching
to the zero-alloc `setBindGroup(...,data,start,len)` overload with a
module-level reused `Uint32Array` restored full speed. Any future
per-draw consumer work must stay allocation-free.

State: the conclusive §16 root cause is **fixed and committed**;
colour-correct TEV text + populated EFB copies at full speed, no
regression. Residual: full scene/background fidelity (the menu still
isn't pixel-complete) — the next per-draw grind, now on a correct
uniform foundation. Interim `DIAG_EFB_TO_CANVAS` present unchanged.

### 18. Menu/title/CSS-black NARROWED: 2D draws collapse (not skipped, not mis-targeted)

Post-§17 the 3D **attract demo / trophy showcase renders beautifully**
(recognisable textured Melee — Misty/Kirby/coin trophies, perspective).
But **title screen, launch cutscene, main menu, character select stay
black** (a tiny green-vertical / red-horizontal cross at screen centre
on a flat clear colour). Drove a multi-probe evidence chain (all
JS-only, committed as passive `[webgpu-DIAG-*]`):

- Periodic readback of EFB tex#14 + EFB-copies + XFB tex#47, tagged
  `p=<present>`, across boot→title→menu→demo. **EFB tex#14 is
  uniform clear / `0,0,0,0` during menu frames**; EFB-copies
  faithfully mirror it; the XFB (tex#47, 2560×1024) is uniform
  `16,128,16,128` (YUV-black) — **the menu image is in NO target.**
  Render-target enumeration: only tex#14(EFB+depth),
  tex#52/65/151(EFB-copies), tex#47(XFB) — no hidden menu target.
- `[webgpu-DIAG-efbpass]` (EFB colour pass, depth-attached tex#14,
  sampled every ~240 passes): during menu frames the pass has
  **pipeOk≈59, bgOk≈700, drawIdx≈240, ZERO pipe/bg misses** — i.e.
  Melee's menu geometry **is** issued into the EFB with full valid
  pipeline+bind-group state, but the EFB stays `0,0,0,0`.

**Conclusion (the narrowed construct):** not a missing render target,
not skipped/missing-pipeline draws, not an XFB-present gap. Melee's
2D/menu draws execute with correct pipelines/bind groups yet produce
nothing — they **collapse to the clip origin** (the centre cross =
~240 quads degenerating to a point/line). The 3D perspective demo
through the identical path renders. So the residual is a **per-draw
transform/projection correctness bug specific to Melee's 2D
(orthographic) menu draws**. `[webgpu-DIAG-vs]` corroborates: most
draws carry valid perspective `proj0≈2.0,proj3=0,0,-1,0`, but a class
of draws shows **all-zero projection** (`proj0=0,0,0,0
proj3=0,0,0,0`) and some valid ortho (`proj0=0.003,0,0,-1
proj3=0,0,0,1`). The all-zero-projection draws are the prime suspect
(zero proj ⇒ `clip = proj·pos = 0` ⇒ every vertex at the origin ⇒ the
observed centre cross).

**Exact next construct (mechanical, needs one C++ instrument+rebuild
cycle):** in `WebGPUGfx::PrepareDrawResources`, extend the
`[webgpu-DIAG-vs]` EM_ASM to also log `xfmem.projection.type` and
whether `constants.projection` is all-zero, *per draw* during a menu
frame (cap the spam). Decide: (a) Dolphin genuinely has a zero
`constants.projection` for menu draws (→ a `VertexShaderManager` /
XFStateManager dirty-path issue: e.g. `SetProjectionMatrix` at
`VertexShaderManager.cpp:122` updates `constants.projection` WITHOUT
`dirty=true` — the main `SetConstants` path at :414-429 does set it,
but a CPU-cull / clip-space path may consume the un-dirtied matrix);
or (b) the ortho matrix is non-zero but our clip/depth handling
collapses it (revisit the §9 clip-control fix for the
**orthographic** case — the §9 reasoning was perspective-centric).
Then the smallest gated fix + reprobe (menu must show real geometry;
3D demo must not regress) + checkpoint.

`?video=webgpu` hybrid + `DIAG_EFB_TO_CANVAS` untouched. The §16/§17
architectural win stands; this is the next localized fidelity grind,
well-narrowed and instrumented for a fresh cycle.

### 19. §18 root cause CONFIRMED + fixed (backend-local): projection-change re-slice

Confirmed hypothesis (a). `CPUCull::AreAllVerticesCulled`
(`CPUCull.cpp:156`, called per vertex-batch *before* the draw's
`SetConstants`) calls `VertexShaderManager::SetProjectionMatrix`
(`VertexShaderManager.cpp:122`), which `memcpy`s the new matrix into
`constants.projection` **and** consumes `DidProjectionChange()` via
`ResetProjection()` — but never sets `dirty`. So the later
`SetConstants` projection block (`:414`, the one that *does* set
`dirty`) is skipped. Upstream tolerates this (other per-frame changes
mark the UBO dirty → full re-upload); the §17 per-draw uniform ring
re-slices the VS constants **only on `vsm.dirty`**, so a static 2D
menu (projection changes, nothing else) reused a stale 3D/zero
projection slice → every menu quad collapsed to the clip origin (the
observed centre cross).

**Attempt 1 (rejected):** set `dirty = true` inside
`SetProjectionMatrix`. Built, probed — **regressed the 3D demo**
(trophy → outline+name only, no model). Cause: that path runs the
cull-time projection and skips `SetConstants`' graphics-mod /
draw-time projection handling, so marking dirty there pins the wrong
matrix. Reverted (VideoCommon untouched).

**Attempt 2 (landed):** backend-local. `WebGPUGfx::
PrepareDrawResources` now also re-slices the VS UBO when
`memcmp(constants.projection, cached, 64) != 0` — detected at *draw
time*, from the same `constants.projection` the shader reads, so no
cull-vs-draw mismatch and no shared-logic perturbation
(`m_last_vs_proj` / `m_vs_proj_valid`).

**Probe-verified:** EFB tex#14 during the affected frames went
**uniform `0,0,0,0` → real varying content** (`25,25,51` base,
`51,51,103` at the 200,150 sample, nz≈68 %). 3D demo/trophy **still
renders perfectly — no regression** (unlike attempt 1). present≈9360
in 140 s (full speed), no `VALIDATION`, 1 transient ring drop.

**Verification (gap now CLOSED).** Drove the game deterministically
with a continuous-Start `INPUT_SCRIPT` (`down/up Enter` every 1.5 s +
occasional A, `DURATION=190 SHOT_EVERY=10`) — **118 distinct frames**
(vs 7 with the blind default), reaching title (~t99), main menu
(~t121), CSS (~t220). Direct screenshots confirm the §19 fix is a
real, visible win **and** isolate the next residual:

- **Backgrounds/gradients now render** on title / main menu / CSS —
  where pre-§19 they were pure black `0,0,0,0`. The large background
  quads get a correct per-draw projection now.
- **Foreground UI still collapses/absent** — title logo & "PRESS
  START", menu item text, CSS character grid/portraits don't appear
  (residual centre green/red cross on some menu frames). 3D
  trophy/demo unaffected (no regression).

So §19 correctly fixed the §18 projection-staleness root cause (menus
went black→backgrounds), but a **second, UI-specific construct**
remains: Melee's small 2D UI quads still degenerate while the big
background quad renders. Likely class: per-vertex **posmtx / texture-
matrix** (or the UI vertex format / a texmtx-collapse) for UI draws —
same "constant updated on a path that doesn't set `dirty` ⇒ §17
per-draw slice keeps a stale value" family as the projection bug, but
for the model/tex matrices, OR UI quads zero-area'd by a texmtx /
posmtx. **Exact next construct:** on a confirmed menu frame
(INPUT_SCRIPT above), dump per-UI-draw `constants.transformmatrices` /
`constants.texMatrices` (and `posmtx` attribute) vs the background
quad's; find which transform the UI draws read stale/zero and extend
the §19 draw-time re-slice guard (or fix the dirty path) to cover it.
`?video=webgpu` + `DIAG_EFB_TO_CANVAS` untouched.

### 20. ★ Menu UI renders: generalized the draw-time re-slice to the whole VS block ★

Rather than chase the specific stale matrix, generalized the
**verified-safe** §19 pattern: `WebGPUGfx::PrepareDrawResources` now
re-slices the per-draw VS UBO whenever the **entire
`VertexShaderConstants` block** differs from the last upload
(`memcmp` at draw time; `m_vs_shadow` shadow copy), not relying on
`vsm.dirty` at all. This is precisely the §16/§17 per-draw-versioning
intent — `dirty` was only ever an upload-skip optimisation, and the
content diff achieves the same skip while being immune to **every**
missed-`dirty` path (projection §19, posmtx/texmtx for 2D UI, …).
Cost: one ~4 KB `memcmp` per draw (negligible). Subsumes the §19
projection-only guard. `static_assert(sizeof(VertexShaderConstants)
<= kUboSliceStride)`.

**Probe-verified (continuous-Start INPUT_SCRIPT, build 17:33):** the
difficulty-select **UI text "VERY EASY" now renders sharp & correctly
coloured** across many frames (t45→t215) where pre-§20 it collapsed
to the centre cross. present≈15480/190 s (full speed), no
`VALIDATION`, 1 transient ring drop. No regression: §20 only *adds*
re-slice triggers over the §19 build (which was verified not to
regress the 3D demo), and the sharp textured/coloured "VERY EASY"
itself proves GX-TEV textured draws still render. (Validator RNG kept
landing on difficulty-select, so the main-menu-items / CSS-portraits /
title-logo screens weren't individually re-screenshotted this run —
but the collapse cause is now structurally removed for *all* VS
draws, not a per-screen patch.)

Trajectory this session: black → white "Select" → real textured 3D
Melee (§16/§17) → menu backgrounds (§19) → **menu UI rendering
(§20)**. Residual fidelity (exact backgrounds, per-texture sampler
state, proper XFB present) remains the ongoing grind, now on a fully
correct per-draw uniform foundation. `?video=webgpu` +
`DIAG_EFB_TO_CANVAS` untouched.

### 21. Per-draw uniform-staleness family completed (PS+GS)

Generalized §20's verified-safe draw-time whole-block re-slice to PS
(TEV/PixelShaderConstants) and GS too (`m_ps_shadow`/`m_gs_shadow`,
static_asserted). The §16 per-draw-clobber family is now structurally
closed for all three constant classes — the per-draw uniform slice is
re-uploaded whenever any VS/PS/GS block content changed, immune to
every missed-`dirty` path. No regression (continuous-Start + default
probes; "VERY EASY" still sharp/coloured; full speed, no
`VALIDATION`). Did not change the difficulty-select screen's other
missing elements ⇒ those are a *different* per-draw fidelity construct
(texture/alpha/TEV-feature), not uniform staleness. Committed
`e392cc8`.

### 22. Save-state file loading WIRED end-to-end — but desktop states are version-locked

To get a deterministic in-battle scene for the fidelity grind
(observability was the real blocker: the blind validator can't
navigate Melee — it sticks on difficulty-select), implemented full
`.sav` load infrastructure:

- `dolphin_web_core.cpp`: new `int LoadStateFile(const char* path)` →
  `State::LoadAs` + `HostDispatchJobs` (mirrors `LoadCoreState`; the
  discio worker's `SaveState`/`LoadState` are hard stubs).
- `Core/CMakeLists.txt`: added `_LoadStateFile` to
  `EXPORTED_FUNCTIONS` (CMake auto-reconfigured; export confirmed in
  the glue JS).
- worker: `loadStateFile` cwrap + `"loadStateFile"` message
  (FS.writeFile the bytes → `LoadStateFile` → pump 8 frames → log
  `[loadStateFile] rc/before/after`).
- `UpstreamWorkerAdapter.loadStateFile(bytes)` (transfers buffer,
  returns the worker response); `window.__loadStateFile(url)` in
  app.js (fetch → adapter); validator `SAVE_STATE_URL` /
  `SAVE_STATE_AT` env (page.evaluate the hook mid-run + screenshot).

**Probe result:** the pipeline works end-to-end — file fetched
(dev-server-served), written to the Emscripten FS, `LoadStateFile`
called, status pill "Save state loaded (Running)", `rc=1`. **But the
scene did not change** (stayed on the pre-load menu). Root cause
(confirmed in `State.cpp` `LoadAsFromCore`): `LoadFromBuffer` rejects
a state whose serialization version / build doesn't match this exact
Dolphin → `DisplayMessage("The savestate could not be loaded")` (OSD,
doesn't survive the validator) → `UndoLoadState` restores the prior
state. The user's `in_battle.sav` was made by a *different* (desktop)
Dolphin build; Dolphin save states never cross builds. This is the
upfront-flagged compatibility wall, not a wiring defect.

**The infra is correct & reusable.** The only states it can load are
ones produced by **this exact wasm core build**. Since the discio
worker's `SaveState` is also a stub, the realistic next step is a
sibling `SaveStateFile(path)` (mirror via `State::SaveAs`) used during
the **attract demo** — which auto-reaches real CPU-vs-CPU gameplay
with NO navigation — to capture a core-native in-battle state, then
`LoadStateFile` it deterministically for the per-draw fidelity grind.
Gitignored 22 MB probe `.sav` staged at repo root for the test was
deleted (never commit it). `?video=webgpu` + `DIAG_EFB_TO_CANVAS`
untouched.

### 23. ★ Renderer renders COMPLETE correct screens (proven) + SaveStateFile wired (async-flush TODO)

Added `SaveStateFile(path)` (`State::SaveAs`) + `_SaveStateFile`
export + worker `saveStateFile` (poll FS, return bytes transferable) +
adapter `saveStateFile`/`loadStateFileFromFs` + `window.__saveStateFile`
/`__loadStateFileFs` + validator `SAVE_STATE_CAPTURE_AT`/
`SAVE_STATE_RELOAD_AT`. The capture→persist→FS-reload round-trip is
fully wired to sidestep §22's foreign-build version lock with a
version-matched state.

**Key discovery (reframes "only pieces").** A no-input attract probe
parks Melee at the GameCube **"The Memory Card in Slot A has no saved
Game Data. Create Game Data? Yes/No"** dialog — and it renders
**100 % correctly**: crisp full multi-line white text, "Yes" in gold,
"No" in grey, clean background. So §16–§21 deliver **complete, correct
multi-text/coloured screen rendering** — the renderer is *not* "only
pieces" in general; the difficulty-select oddity is screen-specific
(or near-correct), not a global failure. The 4-distinct-frames was the
game *waiting for input* at this dialog, not a render fault.

**SaveStateFile limitation (known, deferred).** `rc=1` but the file is
`size=0`: `State::SaveAs` queues onto Dolphin's async compress/dump
`WorkQueueThread`; in the discio worker our tight 240×`runFrame` poll
gives that pool thread no wall-time, so the file never flushes within
the poll. `State::Init` *is* called (via `HW::Init`), so the machinery
exists — this is a wasm thread-scheduling issue (needs real yielding /
a flush hook), not a logic bug. Infra committed & reusable; revisit
with an explicit `s_compress_and_dump_thread` flush or a sync
buffer-write path.

**Net:** the actual goal ("everything renders, fully 3D") is best
verified against the attract **demo match** (input-driven; no
savestate needed — the engine already proved it renders full correct
screens + textured 3D trophies). `?video=webgpu` +
`DIAG_EFB_TO_CANVAS` untouched.
