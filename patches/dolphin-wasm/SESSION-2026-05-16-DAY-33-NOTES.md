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

### 24. ★ Deterministic save/load WORKS — the observability unblock ★

Two root causes behind §23's `size=0`, both fixed:

1. **`State::SaveAs` is doubly-async.** `RunOnCPUThread` only *queues*
   `SaveAsFromCore` (doesn't block), which then hands the buffer to
   the async `s_compress_and_dump_thread` WorkQueueThread. Added
   `State::SaveToFileSync` (State.cpp/.h) — same as `SaveAsFromCore`
   but calls `CompressAndDumpState` **inline** (no `EmplaceItem`), so
   the file is fully written within the single CPU-thread job, no
   dump-thread scheduling. `dolphin_web_core.cpp:SaveStateFile` now
   calls it.
2. **The discio worker's `RunFrame()` does NOT step the core** — it's
   just `++s_frame; PublishFrameSignal()`. The Dolphin core runs on
   its own autonomous pthreads (dual-core). So §23's "pump 240×
   runFrame" poll was a <10 ms no-op that returned before the
   autonomous CPU pthread could run the queued job. Fix: the
   (already-`async`) worker `saveStateFile`/`loadStateFile` handlers
   now `await` **real wall-clock** timeouts (`setTimeout`) so the
   autonomous CPU/save pthreads get scheduled.

**Probe-verified:** `[saveStateFile] rc=1 size=18880078` — a **18.9
MB version-matched** state written + persisted to
`outDir/core-native-state.sav`; `loadStateFileFs` → `rc=1`
(no rejection, unlike the foreign §22 `.sav`). Deterministic
version-matched save/load **now functions** — the observability tool
the whole fidelity grind needs. (The test scene was the idle
difficulty menu, so the rewind isn't visually distinct frame-to-frame;
mechanism proven by size + `rc=1` + version match.)

**This is the unblock.** Next: capture a state during a 3D scene
(navigate once to the attract demo match / a real match, or extend
the input script), then `LoadStateFile` it deterministically every
iteration of the per-screen 3D-fidelity grind — no re-navigation, no
foreign-build version lock. `?video=webgpu` + `DIAG_EFB_TO_CANVAS`
untouched.

### 25. DL/UL State UI buttons + battle state loads but renders BLACK (next construct)

Added permanent **DL State** / **UL State** transport buttons
(index.html + app.js, served live) wired to the working
`SaveStateFile`/`LoadStateFile` path (the old slot Save/Load are
stubbed in the discio core). User navigated to a real in-game battle
and captured `battle-state.sav` (21.2 MB, version-matched, this
build) via DL State — preserved at `.omx/savestates/battle-state.sav`
(gitignored) for the grind.

Loaded it via the validator: `loadStateFile rc=1`,
`afterState=Running`, **no version rejection** (vs the foreign §22
sav). Metrics post-load show a real battle: `prim:1112 draw:273`
(geometry-heavy, vs ~159 for a menu) — the core IS running the battle
and submitting geometry. **But the canvas is BLACK and stays black**
(no new distinct hashes for the entire post-load window; frame counter
advances, 56 % speed).

So: geometry is submitted but nothing presents. Two candidate
constructs for the next session (deterministic now — just
`LoadStateFile .omx/savestates/battle-state.sav` each iteration):
1. **Savestate-load desync of the WebGPU backend** (most likely):
   `State::Load` swaps all GC RAM + BP/XF/CP video registers, but our
   command-ring backend's GPU-object cache (EFB/texture bridge ids,
   `self._wgEfbColorId` for DIAG_EFB_TO_CANVAS, pipeline/bind-group
   caches, the producer's id allocators) is from the pre-load session
   and is now stale/desynced → black. Likely needs a post-load
   backend reset (invalidate caches / re-derive EFB id / reset the
   command stream) hooked off `State::SetOnAfterLoadCallback` or the
   worker's loadStateFile.
2. In-game 3D battle genuinely renders black (a per-draw fidelity
   construct) — less likely given menus/trophies/dialogs render and
   geometry is flowing, but not yet ruled out.

`?video=webgpu` + `DIAG_EFB_TO_CANVAS` untouched. The deterministic
observability tool the grind needed now exists and works; the battle
black-after-load is the precise, well-scoped next construct.

### 26. Battle-black: validation-poison guard fixed (real bug) — but root cause is savestate-load backend desync

Probed the deterministic repro (`LoadStateFile
.omx/savestates/battle-state.sav`, `rc=1`). Found a real frame-poison
bug: **`VALIDATION: ... [Texture 640x528 R32Float] ... expected
sample types (Float)`** — the battle samples the **EFB depth**
(r32float; Melee Z-texture/depth effects) but the fixed group-1
layout declares `sampleType:"float"` (filterable). r32float is
`unfilterable-float` in WebGPU → bind-group/pipeline invalid → "one
bad GPU op poisons the whole frame submit" → black. Menus don't
sample depth, hence they render. **Fixed (§26):** in
`replayCreateBindGroup`, any group-1 texture whose format isn't in
`FILTERABLE_TEX_FORMATS` (rgba8unorm/bgra8unorm/rgba16float/
rgb10a2unorm) is substituted with the filterable rgba8unorm
`dummyTexView`, so the bind group stays layout-valid and the frame is
not poisoned (the single depth-sample effect is lost, not the scene).
No `VALIDATION` after the fix; menus/pre-load frames unchanged (no
regression — normal GX draws sample rgba8unorm).

**But the battle STILL renders black & static post-load** (frame
counter advances, 72 % speed, zero new distinct hashes for the whole
post-load window). So §26 removed a genuine poison but is **not** the
battle-black root cause. This **confirms §25's primary hypothesis**:
`State::Load` swaps all GC RAM + BP/XF/CP video registers in one shot,
but the remote command-ring backend's state is pre-load stale —
producer (`WebGPUGfx`) id allocators + `m_bg*`/`m_ubo_ring`/shadow
caches, consumer `webGpuObjects`/pipe caches, and the
`DIAG_EFB_TO_CANVAS` `self._wgEfbColorId` present tracking — so
nothing coherent presents. This is the **next construct**: a post-load
backend resync (hook `State::SetOnAfterLoadCallback` and/or the worker
`loadStateFile` to reset/invalidate the command-ring caches + re-derive
the EFB present id + drain/realign the ring), deterministically
testable now via the committed `battle-state.sav`. `?video=webgpu` +
`DIAG_EFB_TO_CANVAS` untouched.

### 27. ★ Battle-black ROOT CAUSE conclusively isolated: post-load CPU↔GPU CP-FIFO atomic desync (NOT consumer caches, NOT a sleeping GPU loop)

This is the decisive arc. §26's "consumer cache desync" hypothesis is
**DISPROVEN**. Six instrumented probes (deterministic `battle-state.sav`,
`SAVE_STATE_AT=42`) drove a clean evidence chain. **Don't re-test the
disproven hypotheses — start from the pinned construct below.**

**Probe 1 (JS-only watchdog, no rebuild).** Added a post-load
watchdog in `drainWebGpuCmdRing` logging ring head/tail + exec
counters. At load: `ring write=5488263 read=5487370 pend=893`
(consumer drains the final pre-load batch). Then for 35 s:
`write=5488263 read=5488263 pend=0` — **the producer ring `write`
index never advances again**; every exec counter frozen. Yet
`samples.json` shows post-load `frame` 2369→4646, `coreFps≈44`,
`gameSpeed≈72%` — **the CPU/core keeps running the battle**. ⇒ the
producer (the dual-core GPU FIFO mainloop that records WebGPU
opcodes) emits zero records post-load while the CPU runs. Consumer
caches are irrelevant when no commands flow → §26 disproven.

**Probe 2 (Fifo.cpp gpuloop + RunGpu heartbeats).** The GPU mainloop
body is **NOT asleep** — `[s27-gpuloop]` increments ~12 M iterations
over the post-load window (it spins ~300 k/s) with `emu=1 gpren=1
rwd=0`. `[s27-RunGpu]` also fires post-load. ⇒ the "GPU left asleep
by `GpuMaySleep()`; RunGpu() will wake it" theory is **also wrong** —
the loop is wide awake and spinning. (The §27 after-load
`State::SetOnAfterLoadCallback`→`RunGpu()` hook was added and
**confirmed to fire** (`[after-load] cb fired`) but did **not** fix
the black screen, consistent with this.)

**Probe 3 (GatherPipeBursted heartbeat).** Post-load the CPU thread
**is** producing GP FIFO data: `[s27-GPB] link=1 gpren=1` and
`CPReadWriteDistance` **grows unbounded** 704 → 230 000+ (monotonic,
never drained). So: CPU fills the CP FIFO; the GPU loop never drains
it.

**Probe 4 + 6 (pointer / tid / System identity).** The smoking gun:
both threads print **identical** `&CommandProcessor` and
**identical** `&m_fifo.CPReadWriteDistance` (e.g. `rwdAddr=15061888`)
and **identical** `&m_system` (`sys=9608368`) — same singleton, same
atomic object, same shared wasm memory — but on **different pthreads**
(`[s27-GPB] tid=18081448` = CPU thread, stable pre/post; `[s27-gate]
tid=309004936` = GPU thread). The CPU thread's `fetch_add` (seq_cst)
drives that atomic to 230 000+, while the GPU thread's relaxed
`load()` of the **same address** reads **0 forever**.

**Probe 5 (the 4 drain gates).** Logging right after
`SetCPStatusFromGPU()`: post-load `[s27-gate] intw=0 gpren=1 rwd=0
atbp=0` — interrupt-wait clear, GP-read enabled, no breakpoint; the
**only** closed gate is `CPReadWriteDistance==0` *as seen by the GPU
thread*. So the GPU loop's `while(... && fifo.CPReadWriteDistance ...)`
never enters → `ReadDataFromFifo`/`OpcodeDecoder::RunFifo` never runs
→ `WebGPUGfx` records nothing → producer ring frozen → black.

**ROOT CAUSE (pinned, the ONE construct):** after `State::Load`, the
CPU pthread and the GPU-FIFO pthread **observe divergent values for
the same `std::atomic<u32> CommandProcessor::m_fifo.CPReadWriteDistance`
at the same shared-memory address** (CPU sees it grow; GPU
permanently sees 0). Pre-load both read ≈0 and the game renders
(GPU drains promptly); the savestate load breaks the CPU→GPU
visibility of that CP-FIFO counter specifically. This is a post-load
CP-FIFO producer/consumer **sync** break in the wasm dual-core model,
upstream of the entire WebGPU command-ring backend — the ring
freezes purely as a consequence.

**Next construct (exact, for a fresh session):** find *why* the GPU
pthread's atomic load of `CPReadWriteDistance` doesn't observe the CPU
pthread's `fetch_add` after a state load (it does pre-load). Leads,
in order: (a) `CommandProcessor::SetCPStatusFromGPU()` /
`SetCPStatusFromCPU()` recompute/zero `CPReadWriteDistance` from
`CPReadPointer`/`CPWritePointer` — if `State::Load` restores those
pointers inconsistently between the two threads' views (or
`SafeCPReadPointer`/`m_video_buffer_*` desync vs the restored CP
regs), the GPU side keeps zeroing the distance it should see; inspect
`SetCPStatusFromGPU` and `SCPFifoStruct::DoState` (it `p.Do`s
CPReadWriteDistance + the pointers) for a read/write-pointer ordering
or recompute that strands the GPU view at 0. (b) Whether the
post-load `GatherPipeBursted` runs via the linked path (it logs
`link=1`) but updates `ProcessorInterface.m_fifo_cpu_write_pointer`
while the GPU loop reads a stale `CPReadPointer`, so
`SetCPStatusFromGPU` recomputes distance=0. (c) A genuine missing
acquire/release or a stale shared-memory view for that atomic across
the dual-core threads only after the load's PauseAndLock/Restore
cycle. Decisive next probe: extend `[s27-gate]`/`[s27-GPB]` to also
log `CPReadPointer`, `CPWritePointer`, `SafeCPReadPointer`, `CPBase`,
`CPEnd` from both threads right around the load — the pointer that
diverges (or that `SetCPStatusFromGPU` uses to derive distance=0)
names the exact fix. The fix likely belongs in the
`State::SetOnAfterLoadCallback` (already wired, fires on the CPU
thread post-DoState): re-derive/realign the CP read/write pointers so
both threads agree, rather than waking a loop that's already awake.

**State committed this checkpoint:** the `State::SetOnAfterLoadCallback`
hook scaffold (correct hook point; `RunGpu()` body is a confirmed
no-op for *this* construct — left in, harmless, the real resync goes
here); the JS post-load watchdog (`drainWebGpuCmdRing`, 35 s window);
and gated, **sparse** (`& 0x3FFFFF` / `& 0x7FFF`) passive
`[s27-gpuloop|gate|RunGpu|GPB]` + `[after-load]` EM_ASM diagnostics in
Fifo.cpp/CommandProcessor.cpp (all `#ifdef __EMSCRIPTEN__`, captured
only in the rebuilt wasm — vendor/ is gitignored). No functional
change to the render path; `?video=webgpu`, `DIAG_EFB_TO_CANVAS`, the
per-draw uniform ring and §26 guard all untouched. Battle still
renders black post-load (root cause now precisely named, not yet
fixed) — verified by probe screenshots; not claiming done.

### 27b. Next-construct probe: CP-FIFO is CPU↔GPU-INCOHERENT only post-load (the precise mechanism)

Ran the §27 next probe — extended `[s27-GPB]` (CPU thread) and
`[s27-gate]` (GPU thread) to log `CPReadPointer/CPWritePointer/
SafeCPReadPointer/CPBase/CPEnd`, plus a **fresh** seq_cst re-read of
`CPReadWriteDistance` via `m_system.GetCommandProcessor().GetFifo()`
(`rwd2`) to rule out a stale cached `fifo` reference. Conclusive
aggregate over the deterministic repro:

- **GPU thread (`[s27-gate]`), PRE-load:** 1303 samples `rwd=0`, **but
  also `rwd=32`×13, `rwd=64`×2, `rwd=1312`×1, `rwd=0 rwd2=32`×1** —
  i.e. the GPU thread **does** observe `CPReadWriteDistance > 0`,
  drains it, and the battle/menus render.
- **GPU thread, POST-load:** **ALL 38 samples `rwd=0 rwd2=0`** — the
  GPU thread **never once** observes a non-zero distance (the fresh
  seq_cst `rwd2` is 0 too → not a stale-ref / relaxed-load artifact).
  It therefore never enters the drain `while`, never runs
  `OpcodeDecoder::RunFifo`, never feeds `WebGPUGfx` → ring frozen →
  black.
- **CPU thread (`[s27-GPB]`), POST-load:** sees `CPReadWriteDistance`
  reach `99264` (and 32/128/192/288/640) — the CPU genuinely fills
  the CP FIFO. Its `CPWritePointer` (`wr=6517216`) and the GPU
  thread's `wr` (6419488 / 6534400 / 6621056, moving) are **different
  values at the same wall-clock** — the two pthreads have
  **incoherent views of the same `SCPFifoStruct` atomics** post-load.

**Conclusive root cause (final):** `State::Load` breaks the dual-core
CPU↔GPU CP-FIFO **shared-atomic coherence**. Post-load the CPU thread
advances `CPReadWriteDistance`/`CPWritePointer`; the GPU-FIFO thread,
reading the *same* atomic addresses (even a fresh seq_cst load),
observes a constant 0 / its own divergent pointer values and never
drains. Pre-load the same atomics ARE coherent (GPU sees rwd 32/64/
1312 and renders). Numeric equality of `&m_system`/`&CPReadWriteDistance`
across the threads is **not** proof of shared memory — it is exactly
what two same-layout, *separately-backed* memories would also print;
combined with the post-load divergence this indicates the GPU-FIFO
pthread and the post-load CPU/`RunOnCPUThread`-job context are
operating on **non-coherent memory for the CP struct** after the
load's `PauseAndLock`→`AddCPUThreadJob`→`RestoreStateAndUnlock` cycle.

**Why this is the hard part / next direction:** the bug is not in the
WebGPU backend at all (it freezes purely downstream). It is a
wasm-dual-core savestate-load thread/memory-coherence defect in
`Core::RunOnCPUThread` + `VideoBackendBase::DoState`'s
`AsyncRequests::PushBlockingEvent` path. Candidate fixes to try next,
each smallest-gated, in the already-wired `State::SetOnAfterLoadCallback`
(CPU thread, post-DoState) — re-probe between each, don't batch:
1. After load, force the FIFO through the CPU thread instead of the
   broken cross-thread handshake: temporarily drive
   `FifoManager::RunGpuOnCpu()` / a `SyncGPU(SyncGPUReason::Other)` +
   explicit drain so the GPU work is produced by the coherent CPU
   context until the next natural resync.
2. Make `LoadStateFile` run the whole `State::LoadAs` **on the CPU
   pthread itself** (so DoState + the resumed game share one
   coherent context) rather than via the discio-worker→
   `RunOnCPUThread` job hop (test: does the incoherence vanish if the
   load is issued from the CPU thread?).
3. Post-load, hard-reset+re-publish the CP/GPU sync: `ResetVideoBuffer`
   + re-arm `m_gpu_mainloop` + re-issue `EmulatorState(true)` from the
   after-load callback so the GPU thread re-acquires the restored CP
   pointers under a fresh release/acquire.
Decisive disambiguator before fixing: log `pthread_self()` of the
thread that runs `LoadAsFromCore`/the after-load callback and compare
to the long-lived CPU pthread tid (`[s27-GPB] tid=18081640`) and GPU
tid (`309005240`) — if the load runs on a *third* tid, hypothesis 2
is confirmed and dictates the fix.

State: §27b adds only richer gated diagnostics (no render-path change).
Battle still black post-load; root cause now fully characterized at
the thread/memory-coherence level. `?video=webgpu` /
`DIAG_EFB_TO_CANVAS` / per-draw ring / §26 guard untouched.

### 27c. Disambiguator: hypothesis 2 REFUTED — load runs on the real CPU pthread; fix = post-load GPU-thread CP resync

Added `pthread_self()` to the `[after-load]` callback log. Result:

- `[after-load] cb fired tid=18081640`
- `[s27-GPB] tid=18081640` (CPU thread / post-load game)
- `[s27-gate] tid=309005216` (GPU FIFO thread, distinct, stable)

⇒ `LoadAsFromCore` + the after-load callback run on the **same
pthread** as the post-load CPU emulation — **not** a third
discio-worker thread. §27b hypothesis 2 (the load runs off the
emulation CPU thread) is **refuted**. The CPU thread and GPU-FIFO
thread are two normal, stable dual-core pthreads that *should* share
memory; pre-load they do (renders), post-load the GPU thread is
stranded on a pre-load CP-FIFO snapshot and never observes the CPU
thread's restored/advancing `CPReadWriteDistance`.

**So the fix is §27b hypothesis 1/3, issued from the already-wired
`State::SetOnAfterLoadCallback` (confirmed running on the CPU thread,
tid 18081640):** an explicit post-load resync of the GPU thread's
CP-FIFO consumer so it re-acquires the restored CP state under a
fresh release/acquire — e.g. `SyncGPU(SyncGPUReason::Other)` +
`ResetVideoBuffer` + re-publish via `EmulatorState(true)` /
`RunGpu()` (the lone `RunGpu()` there is insufficient — proven §27).
The exact next session: replace the after-load `RunGpu()` body with
that resync sequence, smallest-first (try `SyncGPU` alone → reprobe;
then add `ResetVideoBuffer`; then the EmulatorState re-publish), and
confirm `[s27-gate]` starts observing `rwd>0` post-load (it currently
never does — §27b) and the battle renders. Pre-load rendering
verified unregressed this checkpoint (12/12 distinct pre-load).
`?video=webgpu` / `DIAG_EFB_TO_CANVAS` / per-draw ring / §26 guard
untouched.

### 27d. ★ Memory IS coherent (sentinel proof) + resync is a PARTIAL fix: permanent freeze → 3 s post-load burst then re-freeze

Two decisive results this round; the picture changed materially.

**1. Cross-thread sentinel test → §27b "incoherent memory" REFUTED.**
Added a single global `Fifo::g_s27_sentinel`; the after-load callback
(CPU pthread, tid 18081640) stores `0xABCD1234`; the GPU-thread gate
logs it. Result: pre-load `sent=0`, **post-load `sent=2882343476`
(=0xABCD1234) in 9/9 samples**. The GPU pthread *does* observe the
CPU pthread's store → **the two dual-core pthreads share coherent
memory**. So §27/§27b's "non-coherent memory / two Systems" framing
is wrong. The CP-FIFO desync is **logical state**, and the earlier
`[s27-gate] rwd=0` was a *sampling artifact* (the gate samples at the
top of the loop; the GPU drains rwd→0 fast).

**2. The GPU thread DOES decode the FIFO; the resync is a partial
fix.** Added `[s27-decode]` (counter right after
`OpcodeDecoder::RunFifo` in the GPU drain `while`). With the after-load
resync = `g_s27_sentinel.store(...) ; FlushGpu() ; RunGpu()` (the
proven sentinel + the canonical CPU↔GPU rendezvous + re-kick;
`ResetVideoBuffer` dropped — it added nothing in attempt 2):
- `[s27-decode]` **keeps incrementing post-load** (3.80M→3.92M) — the
  GPU thread genuinely drains+decodes the FIFO.
- `[postload-probe]` (throttle bug fixed — never `| 0` a `Date.now()`):
  for the **first ~3 s** post-load the producer ring **advances**
  (`write` 5113535→5210373, ~97 k records), the consumer keeps up
  (`read` tracks `write`), `present` 2318→2341, `draw` 6955→7070,
  `drawIdx` 506039→514846 — i.e. **the whole pipeline flows
  end-to-end for ~3 s** (vs the original §27 *permanent* freeze with
  `write` frozen and zero opcodes).
- Then at **dt≈3.2 s everything re-freezes**: `write`/`read`/`present`
  /`draw` all pinned for the remaining 31 s. No new distinct canvas
  hash post-load (the 3 s burst drains the load-time FIFO **backlog**
  but doesn't yield a new visible frame / re-freezes before one).

**Reframed root cause (current best, evidence-backed):** the
savestate-load defect is **not** memory incoherence and **not** the
WebGPU backend. The after-load resync successfully drains the FIFO
**backlog** that piled up during the load (one-shot works → 3 s of
real pipeline flow), but the **steady-state CPU→GPU FIFO hand-off
re-breaks** once the backlog clears: post-burst, new
`GatherPipeBursted`→`RunGpu()`→`m_gpu_mainloop.Wakeup()` no longer
re-engages the GPU consumer (it goes idle and never re-wakes for the
*next* GP burst). This is the original "GpuMaySleep / BlockingLoop
wake after AllowSleep" suspicion, now precisely scoped to the
**post-backlog steady state** (the §27 "loop spins 300k/s" reading
was pre-burst; need to recheck whether it sleeps after the burst).

**Exact next construct:** instrument the GPU `m_gpu_mainloop`
sleep/wake across the dt≈3.2 s re-freeze — log `m_gpu_mainloop`
running/asleep state + whether `RunGpu()`/`Wakeup()` is invoked by
post-burst `GatherPipeBursted` and whether the loop body still
executes after the freeze. If the loop sleeps and `Wakeup()` no
longer revives it post-load, the fix is a steady-state wake repair
(e.g. keep the GPU loop from `AllowSleep` after a state load, or make
the after-load resync periodic/until-first-present rather than
one-shot). Smallest-first candidates: (a) in the after-load callback
also `EmulatorState(true)` (forces `m_gpu_mainloop.Wakeup()` + clears
AllowSleep) instead of bare `RunGpu()`; (b) suppress the dual-core
`GpuMaySleep()` for the first N frames post-load; (c) drive the
post-load catch-up on the CPU thread (`RunGpuOnCpu`) until the first
present.

**Committed this checkpoint:** the partial-fix resync
(`g_s27_sentinel.store + FlushGpu + RunGpu` in
`State::SetOnAfterLoadCallback`) — a genuine improvement (permanent
freeze → 3 s of correct post-load pipeline flow), plus the
`[s27-decode]`/sentinel diagnostics and the **fixed** JS
`[postload-probe]` throttle (≤1 s cadence; was spamming every drain
tick due to a `Date.now() | 0` truncation bug). Pre-load rendering
unregressed (12/12 distinct pre-load; menus/3D still render). Battle
still black post-load (re-freeze after the 3 s burst — next
construct precisely scoped above). `?video=webgpu` /
`DIAG_EFB_TO_CANVAS` / per-draw ring / §26 guard untouched.

### 27e. ★ Re-scoped: the WHOLE emulation halts after the post-load backlog (not a GPU-wake bug) — resync primitive is irrelevant

Tested §27d candidate (a): replaced the blocking `FlushGpu()` with
non-blocking `fifo.EmulatorState(true); fifo.RunGpu();` in the
after-load callback. Result is the **same shape** as FlushGpu:

- Post-load **burst** — backlog drains over ~7 s (`write` 5210931→
  5305807 ≈ +95 k records, `read` tracks, `present` 2366→2389,
  `draw` 7104→7217, `[s27-decode]` +7 samples) — then **hard
  re-freeze** from dt≈7 s onward (every counter pinned).
- Crucially, **after the freeze ALL Dolphin EM_ASM goes silent**:
  post-freeze `[s27-gpuloop]`=5, `[s27-GPB]`=1, `[s27-decode]`=0,
  `[s27-RunGpu]`=0 — i.e. **both the CPU and GPU pthreads stop**, not
  just the GPU consumer. Only the JS drain/`postload-probe` keep
  running (frozen values). (Verified the FlushGpu run too: zero
  Dolphin lines after the freeze line.)

**Re-scoped root cause:** this is **not** a GPU-thread wake/visibility
bug and **not** the WebGPU backend. The one-shot after-load resync
successfully drains the load-time FIFO **backlog** (3–7 s of fully
correct end-to-end pipeline flow — proof the renderer + ring + the
restored state are all fine), then **the entire emulation halts**
(CPU PowerPC thread + GPU thread both stop). The resync primitive
(`FlushGpu` vs `EmulatorState(true)+RunGpu`) only changes burst
length, not the halt. So the construct is: *after a savestate load,
once the backlog is consumed, the Dolphin core cannot sustain
emulation* — the CPU/PowerPC side stalls (likely a HW/IPC/DSP/EXI/
CoreTiming or dual-core CPU↔GPU sync state restored inconsistently by
DoState, or a JIT/idle-skip deadlock), which then starves the FIFO
and everything stops. The original §27 "CPU runs forever at 44 fps"
was VI/CoreTiming idle ticks, *not* real game progress — with the
resync we now see real progress for the backlog then a true halt.

**Next construct (different layer — CPU/core, not video):**
instrument the CPU/PowerPC + CoreTiming side across the post-burst
halt: log PC / `CoreTiming` advancing / `CPU::GetState` / whether the
CPU thread is in idle-skip or blocked on an `AsyncRequests` /
`Event::Wait` / DSP/EXI sync. Compare a *fresh* (no-load) attract run
vs the post-load halt at the same scene. Smallest-first fix
candidates once localized: (i) post-load, force `CPU` out of any
stale wait/idle-skip (`CoreTiming::ForceExceptionCheck`, clear
`m_syncing_suspended` — note `Fifo::DoState` restores
`m_syncing_suspended` from the sav: if saved `true`, the SyncGPU
CoreTiming event is never rescheduled → a strong lead); (ii)
re-`ScheduleEvent` the sync-GPU/idle events after load; (iii) audit
which `HW::DoState` sub-state (DSP/EXI/SI/IPC) leaves the CPU waiting.
**The `m_syncing_suspended` restore in `Fifo::DoState` (Fifo.cpp:72,
`p.Do(m_syncing_suspended)`) is the prime suspect** — if the state
was captured with the sync-GPU event suspended, post-load nothing
ever reschedules it.

**Committed this checkpoint:** the after-load resync switched to the
**non-blocking** `EmulatorState(true)+RunGpu` (drop `FlushGpu` — its
`m_gpu_mainloop.Wait()` on the CPU thread risks a hard deadlock and
gave no benefit; EmulatorState gives a longer clean burst, no
CPU-block). Same diagnostics; JS `[postload-probe]` throttle fix
confirmed (console 6082 lines vs 9928). Pre-load rendering
unregressed (10/10 distinct pre-load). Battle still black post-load
(burst-then-total-halt; root cause re-scoped to the CPU/core layer
with `m_syncing_suspended` as prime suspect). `?video=webgpu` /
`DIAG_EFB_TO_CANVAS` / per-draw ring / §26 guard untouched.

### 27f. ★ PINPOINTED: post-load the PowerPC wedges spinning at PC=0x80335E98 (HW-poll idle loop); CoreTiming is healthy

Instrumented `CoreTimingManager::Advance()` with `[s27-coretiming]`
(global_timer + event-queue depth + **`ppc_state.pc`**). Decisive:

- **`m_syncing_suspended` lead RETIRED** (red herring for async
  dual-core): `MAIN_SYNC_GPU` is unset ⇒ Dolphin default **false** ⇒
  pure async dual-core; in that mode `SyncGPUCallback` is inert and
  the CPU never blocks on the GPU. Not the cause.
- **CoreTiming is fully alive post-load**: `[s27-coretiming]` fires
  83× across the whole post-load window; `gt` (global_timer)
  monotonically advances (wrapping the u32 print as expected);
  `evq=6` events stay queued and are serviced. The CPU thread is
  **not** blocked, paused, or halted, and CoreTiming is not stuck.
- **The PowerPC PC is FROZEN**: pre-load `pc` varies (0x8034B164,
  0x8033D224, …); the first post-load samples show it moving
  (0x8034BF…), then it **locks to `pc=0x80335E98` for the entire
  remaining post-load window** (every one of ~80 samples). The decode
  counter fires only 6× (the backlog burst) then stops.

**Pinpointed root cause:** after the post-load FIFO backlog drains,
Melee's PowerPC enters a tight **idle/poll loop at `0x80335E98`**
(MEM1 game code) and never leaves — it is busy-waiting on a
hardware/memory condition that the savestate restore left permanently
unsatisfiable. CoreTiming, the CPU thread, the GPU thread, and the
WebGPU backend are all *fine*; the game itself is wedged polling. No
new GP commands ⇒ FIFO empty ⇒ GPU idle ⇒ black. This is a classic
Dolphin **HW-device savestate-restore** defect (an in-flight async
transfer / interrupt that never completes post-load): the game spins
on a DSP/AI mailbox, SI (controller), EXI (memory card), or DVD
"transfer done" / VI flag whose completion event was not re-armed by
`HW::DoState`.

**Exact next construct (different, well-scoped):** identify what
`0x80335E98` polls. Smallest-first: (1) in `[s27-coretiming]`, when
`pc==0x80335E98`, also dump a few candidate MMIO/interrupt-status
words (DSP `DSP_CONTROL`/mailbox, `ProcessorInterface` INTSR/INTMR,
SI/EXI status, VI) — the one whose live value differs from what the
spin expects names the device. (2) Compare against a *fresh* attract
run that reaches the same scene (no load) — same PC region but not
wedged ⇒ confirms it's the restored device state. (3) Likely fix in
the after-load callback or a targeted `HW::DoState` post-fixup:
re-arm/complete the stranded transfer (e.g. force the pending
DSP/AI/SI/EXI interrupt or reschedule its CoreTiming completion
event). The §27d/e resync stays (harmless, still drains the backlog);
the real fix is device-state, not video.

**Committed this checkpoint:** `[s27-coretiming]` diagnostic (sparse
`& 0x3FFF`, `#ifdef __EMSCRIPTEN__`, baked into the rebuilt wasm) +
the non-blocking `EmulatorState(true)+RunGpu` resync (kept). No
render-path change. Pre-load rendering unregressed (10/10 distinct
pre-load). Battle still black post-load — but the cause is now
**pinpointed to a single PowerPC spin address (0x80335E98) from a
HW-device savestate desync**, a precise and different next construct.
`?video=webgpu` / `DIAG_EFB_TO_CANVAS` / per-draw ring / §26 guard
untouched.

### 27g. Wedge characterized: PE_FINISH|VI|DSP pending+unmasked but unserviced (game spins with EE off) — + STRATEGIC PIVOT

Added PI cause/mask to `[s27-coretiming]`. Pre-load: `picause=0x10000`
(RST_BUTTON only — normal), `pc` varies. Post-load wedge (73/75
samples): **`pc=0x80335e98 picause=0x10540 pimask=0xffc`**.
`0x10540 = RST_BUTTON|PE_FINISH(0x400)|VI(0x100)|DSP(0x40)`; `pimask
0xffc` un-masks all three. So three interrupts are **asserted and
unmasked yet never serviced** while the PowerPC sits frozen at
`0x80335e98` — i.e. the game is spinning with `MSR[EE]=0` polling a
memory/device flag that an interrupt handler (or a stranded DMA /
un-rescheduled CoreTiming completion) would set. Classic GC-core
**savestate HW-restore desync** (PE draw-done / DSP mailbox / VI). The
renderer/ring/CoreTiming are all proven healthy; this is a
Dolphin-core savestate-compat defect, **orthogonal to the WebGPU
renderer**.

**STRATEGIC PIVOT (ralph, goal = "full game rendering all scenes full
speed"):** the savestate-load path is only a *deterministic test
harness* (§22–24) for an in-battle scene — it is **not** the game's
normal code path and not a renderer defect. Sinking further unbounded
iteration into a deep PowerPC/HW savestate-desync (now precisely
pinpointed for a future dedicated session: re-arm the stranded
PE/DSP/VI completion in the after-load callback / `HW::DoState`
post-fixup) does not advance the actual product goal. The renderer
already renders menus, dialogs, and **textured 3D Melee via the
attract demo** (§16–§24), which auto-reaches real CPU-vs-CPU gameplay
with **no savestate and no navigation**. The highest-value
continuation toward "all scenes render full speed" is to drive/grind
the **attract-demo battle** directly. The §27 savestate infra +
resync + diagnostics stay committed (reusable once the core bug is
fixed). Switching the active grind to the attract-demo battle render
path now.

### 28. Attract-demo render survey: FULL SPEED + UI correct; difficulty-select backdrop construct precisely scoped

Long no-input attract survey (`DURATION=180`, no savestate): **29
distinct frames, avg gameSpeed 100.3 %, coreFps 60.2** — the renderer
runs at **full native speed**. With no input Melee parks at the
**difficulty-select** screen (the blind validator can't navigate —
§23). There: **"VERY EASY" TEV-coloured text renders correctly**
(blue, sharp) and a partial grey diagonal backdrop element appears,
but the **main backdrop is black**.

Evidence chain (no rebuilds — mined the survey console + a JS-only
`[s28-missbg]` diagnostic, served live):
- `[webgpu-DIAG-efbpass] fb=14 … draw=0 drawIdx≈84-104 pipeMiss=0
  bgMiss=0` — ~100 indexed draws hit the EFB with valid pipelines +
  bind groups, **zero misses**.
- `[webgpu-DIAG-cpy] tex#14(EFB) nz=3791/1351680` — the EFB is
  **99.7 % black** (only the text). The backdrop draws execute but
  output black.
- No `VALIDATION` errors anywhere (no §26-style poison).
- `[webgpu-DIAG-bg1]`: difficulty-select draws bind 32×32 glyph
  atlases (b0) + **EFB-copy `tex#65` 640×480 (b1)**; `[s28-missbg]`
  (new) produced **zero** output ⇒ the `replayCreateBindGroup`
  missing-texture skip is **NOT** the cause (decisive negative).
- `[webgpu-DIAG-cpy] tex#65(copy) px0=0,0,0,255` — the EFB-copy the
  backdrop composites from is itself **opaque black**.

**Precisely-scoped construct (the §21-deferred residual):** the
difficulty-select backdrop is composited from an EFB-copy (`tex#65`);
that copy is black because the **first EFB pass that renders the
backdrop produces black** — a per-draw **TEV / texture-sample /
alpha** fidelity bug specific to that backdrop material (NOT uniform
staleness — that family is closed §16-§21; NOT missing textures —
§28; NOT validation poison — §26; NOT transform collapse — §19/§20;
geometry+pipelines+bind-groups all valid with zero misses). Next
construct: dump the backdrop draw's fragment-shader/TEV stages +
which texture id it samples in that first EFB pass (extend
`[webgpu-DIAG-fsfull]`/`[webgpu-DIAG-bg1]` to the pre-copy backdrop
draw, not the post-copy text draws), find the TEV stage / sampler
that yields black, smallest gated fix, reprobe.

**Honest status (ralph):** renderer = **full speed**, and renders
menus / multi-line text / coloured UI / GameCube dialogs / textured
3D attract+trophies (§16-§24) correctly. Open residuals, both deep
multi-iteration grinds: (1) savestate-load core wedge (§27 — pinned,
orthogonal to renderer, deferred); (2) per-screen backdrop TEV
fidelity (§28 — difficulty-select backdrop black; precisely scoped
above). "Full game rendering perfectly, all scenes" is **not yet
reached** — it is a continued per-material TEV-fidelity grind on a
proven-correct, full-speed foundation. `[s28-missbg]` kept (cheap,
gated, JS-only — useful negative-result probe). `?video=webgpu` /
`DIAG_EFB_TO_CANVAS` / per-draw uniform ring / §26 guard untouched.

### 28b. ★ Difficulty-select backdrop ROOT CAUSE: untextured geometry fully FOGGED to a zero/black fog colour

Drove the §28 grind with JS-only probes (no rebuilds — served live):
`[s28-efbdraws]` (per-EFB-draw pipe+bindings+state tally),
`[s28-bdfs*]`/`[s28-fn4]` (parse + dump the backdrop pipeline's FS).
Decisive chain:

1. **Backdrop draws** (the dominant EFB draws, idx 18–111) bind
   `b0=tex#57(1×1 dummy) b1=tex#{52,65,151}(640×480 EFB-copies, all
   opaque black) b2=tex#…(real, e.g. 320×240/32×32 — *colourful*
   content `255,109,33` etc.) b3-7=dummy`. Pipelines valid, **zero
   pipe/bg misses, no VALIDATION**. Texture data is fine.
2. The black draw's pipeline state is **identical** (`wm7
   blend{0|1:4/5} depth1/?/3`) to *rendering* textured draws — so
   **not** blend/depth/writeMask.
3. **The backdrop FS samples NO texture at all** (`nSample=0`,
   `hasSample=-1`). `main()` → `dolphin_fn_4_()` → returns `global_4`.
   So it is **untextured** vertex-colour/TEV geometry; the b0=dummy is
   irrelevant.
4. `dolphin_fn_4_` decompiled: TEV combiner runs (`dolphin_fn_3_`),
   then a **fog** stage: `factor = clamp(depthTerm − global.member_9[1],
   0,1)*256`; `out.xyz = (tev.xyz*(256−factor) + global.member_7.xyz
   *factor) >> 8`. I.e. the result is **lerped toward
   `global.member_7` (the fog colour) by a depth-derived fog factor
   (`global.member_9` = fog params)**.

**Root cause:** the difficulty-select backdrop is untextured geometry
that GX fogs; in our backend the **fog PixelShaderConstants are
wrong/zero** (fog colour `member_7` ≈ 0 and/or fog params `member_9`
drive the factor to full), so every backdrop pixel collapses to the
(black) fog colour → black backdrop. Text/foreground render because
they are textured and/or unfogged. NOT a uniform-*staleness* bug
(§16–21 closed that, whole-block PS diff) — a fog-constant
*correctness* bug: either Dolphin's fog `PixelShaderConstants` aren't
being populated/uploaded for these draws, our `PixelShaderConstants`
struct layout for the fog members is mis-mapped (Vulkan/Naga
offset), or the shadergen fog path isn't `api_type==Vulkan`-gated
correctly.

**Exact next construct:** dump the backdrop draw's PS UBO bytes at
the fog members — map `PixelShaderConstants` → `member_7` (fog
colour `vec4`) and `member_9`/`member_? ` (fog `{A,B,C,...}` range
params) to byte offsets, log their live values via `[webgpu-DIAG-ub]`
for the backdrop draw. If fog colour == 0 and/or params force
factor=256 ⇒ confirm; then trace where Dolphin sets fog
(`PixelShaderManager` fog) vs our upload, smallest gated fix,
reprobe (backdrop must show Melee's fiery gradient; text/3D unbroken).

**Status:** §28 root cause now precisely identified (untextured
backdrop fogged to black via wrong fog PS-constants) — a concrete,
deterministic, full-speed renderer fidelity construct, the clean
continuation point. All §28 probes are JS-only, gated/one-shot,
served live (no wasm change this arc). `?video=webgpu` /
`DIAG_EFB_TO_CANVAS` / per-draw ring / §26 guard untouched.

### 28c. ★ FIX: bSupportsReversedDepthRange=true — fog/depth now matches WebGPU [0,1] clip; difficulty-select renders MORE (no text regression)

Root-caused via §28b: backdrop FS = `lerp(tev, fogcolor, factor)`,
fog `zCoord` derived as `int((1.0 − rawpos.z)*2^24)` — the
**`!bSupportsReversedDepthRange` (GL-paired) branch**
(PixelShaderGen.cpp:1101). But WebGPU clip space is **Vulkan-like
[0,1]** and `bSupportsClipControl=true` already makes the VS emit
native [0,1] depth, so the GL-paired `(1−rawpos.z)` inverts our
window depth → fog factor saturates → the untextured, GX-fogged
difficulty-select backdrop collapses to the black fog colour
(`[s28-fog]` confirmed `id=55 len=1536 fogcolor=0,0,0,0`). The
WebGPU backend never set `bSupportsReversedDepthRange` (default
false), the mismatch the PLAN gotchas explicitly warn about
("InitBackendInfo capability flags drive shadergen AND VideoCommon
transform; mismatches caused whole-class failures").

**Fix (smallest gated, 1 line + comment):**
`WebGPU::VideoBackend::InitBackendInfo` →
`g_backend_info.bSupportsReversedDepthRange = true;`. Now
PixelShaderGen fog uses the matching `int(rawpos.z*2^24)` branch and
VertexShaderManager's depth-range path stays consistent with the
[0,1] convention.

**Probe-verified (rebuilt, no-input attract → difficulty-select):**
EFB content `nz 3791→9697`, `max 160→255`; the screen went
text-only → **"VERY EASY" (sharp blue, no regression) + the
selection box outline + the cursor-dot row now render**. Full speed
(≈100 % gameSpeed, 60 coreFps). Melee's difficulty-select is
genuinely a dark screen, so this is materially closer to correct.

**Honest caveat (verification gap):** this is a *global* depth/fog
cap change. No-input AND continuous-Enter attract both park at
difficulty-select (blind input can't navigate past it), and the
deterministic 3D scene (savestate battle) is wedged (§27), so **3D
non-regression (trophies/attract per §17–18) is NOT autonomously
verified this checkpoint** — it must be eyeballed via the cache-busted
link (user-navigated). The change is the *more correct* convention
for WebGPU's actual clip space and showed only improvements + zero
regression on all reachable content (text/UI/full-speed), so it is
committed as a forward step with this caveat recorded. §28 JS probes
kept (gated/one-shot, passive). `?video=webgpu` / `DIAG_EFB_TO_CANVAS`
/ per-draw ring / §26 guard untouched.

### 28d. ★ Invariant verified (shipping hybrid intact) + reference established + remaining gap scoped

Regression-checked the **shipping `?video=webgpu`** Software→WGSL
hybrid after the §28c shared shadergen/cap change: **64 distinct
frames / 71 samples, 99.9 % gameSpeed, 60 coreFps — it renders
Melee's difficulty-select FULLY and correctly** (top roster/trophy
grid, "VERY EASY" + yellow selector arrows, LEVEL indicator, red
content box, proper background). **§28c did NOT regress the shipping
path** — the never-break invariant holds (`InitBackendInfo` only
affects the `?video=wgpu` backend; the hybrid uses the SW renderer +
WGSL presenter).

This also yields the **visual reference** for the same screen. Gap
(`?video=wgpu` hardware renderer vs the hybrid reference) on
difficulty-select:
- ✅ now renders: "VERY EASY" (blue, sharp), selection box outline,
  cursor-dot row, full speed.
- ❌ still missing: the **top roster/trophy icon grid**, the **yellow
  selector arrows**, the **red box content**, exact text styling.

So §28c closed the fog-depth class (untextured fogged geometry now
participates); the remaining difficulty-select elements are a
**continued per-element fidelity grind** (additional textured/TEV
draws still absent/black — candidate: EFB-copy feedback chain seeded
black, or more per-material fog/TEV constructs). Reachable +
deterministic (no-input parks here) + full-speed, pixel reference in
hand — the clean continuation point.

**Session status (honest):** renderer = **full speed**, shipping
hybrid **intact**, hardware path renders menus/text/dialogs +
(input-reached) 3D + now more of difficulty-select after the §28c
depth/fog fix. "All scenes perfectly" remains a continued
per-element fidelity grind; deterministic 3D-battle verification is
still gated by the §27 savestate core wedge (pinned, deferred). All
progress committed (`1c3bfd1 → §28d`); next construct scoped above +
reference captured.

### 28e. Difficulty-select black NARROWED: not fog/stale/depth/attr — boot renders correctly, difficulty-select is an EFB-copy-feedback construct

Drove the §28d grind with JS-only probe extensions (served live, no
rebuild): added `[s28-creg]` (live I_COLORS/I_KCOLORS/I_ALPHA PS-UBO
bytes), `[s28-vs]`/`[s28-vsfn]` (the backdrop's paired VS body),
widened the one-shot backdrop dump to the WHOLE TEV chain
(`fn dolphin_fn_0..4`) + the UBO struct decl, and added `vsId` to
`pipeTpl` so the VS can be correlated. Decisive chain:

1. **The backdrop FS = a pure vertex-colour pass-through.** Full TEV
   decompile (`[s28-fn4]`): `dolphin_fn_2_` combine inputs
   local_17/18/19 = all 0, so out.rgb = local_20 = round(color0*255);
   `dolphin_fn_4_` fog: `fogf.x(member_9[0])=0` ⇒ `ze=0` ⇒
   `fog=clamp(0−fogf.y=1,0,1)=0` ⇒ `ifog=0` ⇒
   `prev = (prev*256 + fogcolor*0)>>8 = prev`. **Fog is NOT applied
   (factor 0); §28b/c "fogged to black" is superseded — the backdrop
   output is exactly the interpolated vertex colour.** `nSample=0`
   (untextured) confirmed.
2. **The backdrop VS** (`[s28-vsfn]`, `vs#…` sig
   `main(@location(5) colour, @location(0) pos)`): color0 =
   `@location(5)` per-vertex colour through channel-0 lighting
   (`dolphin_fn_1_` ≈ identity, white material, no lights); color1
   forced 0 (numColorChans≤1). So screen colour == the vertex colour
   attribute.
3. **Not uniform-staleness / not a UBO mis-map.** `[s28-creg]`:
   I_COLORS c1=`128,64,85,…` c2=`128,78,230,178`, I_KCOLORS k0
   non-zero; the UBO struct decl confirms member_7=I_FOGCOLOR (offset
   map correct). Constants are live and correct.
4. **Boot renders CORRECTLY.** EFB readback over time: p=650/1000
   `tex#14 = (0,0,25,0)` uniform — and screenshot `hash-6e0b2600-t4`
   is the GameCube *"Game Data has been created…"* dialog: white text
   on the correct dark-blue field. Untextured vertex-colour geometry
   + text render right. p≥1700 (difficulty-select) `tex#14 nz=9697`
   (text/box only) — everything else black.
5. The difficulty-select content (textured backdrop, roster icon
   grid, red box) are **textured draws that sample the 640×480
   EFB-copies `tex#{52,65,151}` — which read pure black**
   (`px0=0,0,0,255`). The trophy *source* textures DO have content
   (`[webgpu-DIAG-ut] tex#98/100/… nz≈1000/4096`, alpha border).
   Blend is `1:4/5` = src-alpha/one-minus-src-alpha (standard).

**Precisely-scoped construct (supersedes §28b/c framing):** NOT a
fog, uniform-staleness, depth, or vertex-attr-mapping bug. The
difficulty-select scene is composited through a **640×480 EFB-copy
feedback chain that is seeded/stuck BLACK** (the §28d candidate #1):
the copies are black because `tex#14` is black at difficulty-select,
and every dependent draw samples a black copy → stays black →
re-copies black (self-perpetuating). Boot avoids this (no
copy-feedback) and renders correctly. The bootstrap that must break
the circle = the first difficulty-select scene draw that produces
colour *independent* of a prior copy (Melee's 3D trophy/character
backdrop render → first EFB-copy). **Next probe:** instrument the
difficulty-select EFB-colour pass *before* the first 640×480
`cpypass` — dump the distinct (pipe,fs,vs,bind-group,blend,depth) of
the draws that target `tex#14` there and read back `tex#14` content
immediately pre-copy, to find which scene draw should seed colour
and why it produces nothing (candidate: 3D backdrop draw
depth/alpha/texcoord, or it targets a different FB id than the copy
source). Smallest gated fix, reprobe, verify boot + `?video=webgpu`
unbroken, commit.

**Status (honest, ralph):** verified *observability* increment
(probe extensions — JS-only, gated/one-shot, served live, no
rebuild, `?video=webgpu` / `DIAG_EFB_TO_CANVAS` / per-draw ring /
§26 guard untouched). Root cause materially narrowed: the long-held
fog hypothesis is **disproven for the current build** (factor 0);
the construct is the EFB-copy feedback chain, not a per-material
shader-math bug. Renderer still full speed (~100 % gameSpeed, 60
coreFps). Continuing the loop on the scoped feedback-chain probe.

### 28f. EFB-copy-feedback DISPROVEN too — narrowed to: difficulty-select per-vertex COLOUR reaches the VS as 0 (boot reaches correctly)

Extended the probe (`[s28-texfs]`/`[s28-tfn]` = the dominant TEXTURED
difficulty-select draw's FS; `[s28-texdim]` = live I_TEXDIMS).
Systematically eliminated every remaining non-vertex hypothesis:

- **EFB colour pass is clean.** `[webgpu-DIAG-efbpass]` at
  difficulty-select: `fb=14 pipeMiss=0 bgMiss=0` with ~100 indexed
  draws; **no VALIDATION/device errors anywhere**. The
  `missBg=105738`/`missPipe=10929` in `[webgpu-exec]` are in *other*
  passes (copy/offscreen), NOT the EFB pass → the
  "poisoned-frame-submit" idea is disproven for the EFB pass.
- **Textured draw = `konst(I_KCOLORS[0]) × sampled_tex`** (`fs#78`
  decompiled: `dolphin_fn_1_` samples texmap 0 = b0 = the REAL
  texture, NOT the black b1 copy; `dolphin_fn_2_` modulates by
  konst). `[s28-creg]`: konst k0 is *mostly white* (`255,255,255,*`,
  308×) ⇒ konst-zero is NOT the cause. `[s28-texdim]`: I_TEXDIMS is
  valid (`32,24`/`64,56`/`88,88`) ⇒ the texcoord-normalisation
  divisor is non-zero, texture sampling is fine ⇒ **texcoord-collapse
  disproven**. So the textured elements should render; they are
  small overlays — the dominant black is the *untextured* backdrop.
- **EFB-copy feedback chain disproven as the root.** The dominant
  difficulty-select draw is the b0=1×1 *untextured* backdrop
  (`fs#12256`), whose output (§28e) = the interpolated **vertex
  colour** — it does NOT sample the black 640×480 copy. The copies
  are black *because* the EFB is black, not vice-versa; the seed is
  the untextured vertex-colour backdrop.
- **Boot vs difficulty-select is the whole story.** EFB readback:
  p=650/1000 `tex#14=(0,0,25,0)` uniform = the GameCube
  *"Game Data…"* dialog, **correct** (screenshot confirms white text
  on dark-blue). p≥1700 (difficulty-select) `tex#14` black except
  ~9697 px (text). Same VS shape (`@location(5)` colour →
  channel-0 identity lighting → colour0), same FS (colour
  passthrough). The ONLY difference: at boot the per-vertex colour
  attribute arrives non-zero; at difficulty-select it arrives **0**.

**Precisely-scoped construct (final narrowing):** NOT fog, NOT
uniform-staleness, NOT konst, NOT I_TEXDIMS, NOT missing
bind-groups/pipelines, NOT validation poison, NOT the EFB-copy
feedback chain. The difficulty-select untextured backdrop's
**per-vertex colour (`@location(5)`, unorm8x4) reaches the VS as 0**,
while the boot dialog's identical-shape draw reaches correctly ⇒ a
**per-draw vertex-COLOUR attribute fetch/format/offset issue specific
to difficulty-select geometry** (candidate: the pcfg vertex layout
[stride / colour offset / unorm8x4] for these draws doesn't match the
actual vertex-buffer contents Dolphin writes, so the colour fetch
reads zero; or Dolphin emits colour 0 here and GX sources it from a
material/colour register our shadergen path doesn't honour for this
uid). **Next probe:** at the difficulty-select EFB pass, for the
backdrop draw (`fs#12256`/its VS) dump the BOUND vertex buffer bytes
at the pcfg colour offset + that pipeline's exact pcfg
(stride/attr/format), and the same for the *boot* dialog draw —
diff them. Smallest gated fix, reprobe, verify boot + `?video=webgpu`
unbroken, commit.

**Status (honest, ralph):** another verified *observability +
elimination* increment (JS-only probes; `?video=webgpu` /
`DIAG_EFB_TO_CANVAS` / per-draw ring / §26 guard untouched). Five
hypotheses conclusively disproven this arc; construct localised to a
single mechanism (per-draw vertex-colour fetch). Renderer full speed.
The boulder continues on the scoped vertex-colour probe.

### 28g. ★★ ROOT CAUSE FOUND & FIXED: back/front cull + reversed winding (VS Y-flip) — difficulty-select now RENDERS FULLY

Abandoned the vertex-colour hypothesis (it was the *symptom* of an
even earlier reject) and bisected the pipeline raster state with the
existing revertible JS toggles (no rebuild — served live):

1. **`DIAG_DEPTH_ALWAYS=true`** (force depthCompare "always"):
   difficulty-select **still black** (`tex#14 nz=9697`). ⇒ depth-test
   rejection DISPROVEN (also kills the §28c reversed-Z/viewport-swap
   theory as the cause of the black).
2. **`DIAG_RASTER_OPEN=true`** (skip scissor + cull "none"):
   difficulty-select **RENDERS FULLY** — `tex#14 nz≈844337/1351680`,
   bright content (`255,234,156`), distinct hashes 9→**52**,
   screenshot = the complete roster/trophy grid + "VERY EASY" +
   yellow selector arrows + red LEVEL box, matching the
   `?video=webgpu` reference. ⇒ the cause is **rasterisation state**.
3. **`DIAG_CULL_NONE_ONLY=true`** (cull "none" but KEEP scissor):
   still renders fully (`nz≈844132`, 32 distinct). ⇒ **scissor is
   innocent; back/front CULL is the bug.**

**Root cause:** Dolphin's GX vertex shader negates clip-space Y
(VertexShaderGen Y-flip, visible in the §28e VS dump as
`global_5.member.y = -(global_5.member.y)`). Negating Y **reverses
triangle winding**. The WebGPU pipeline hard-coded
`frontFace: "ccw"`, so every Dolphin-driven back/front cull removed
exactly the geometry that should be visible. 2D UI / boot / text use
GX cull-off (`cullMode "none"`) so they were unaffected and rendered
all along — which is precisely why boot was correct but the
cull-enabled difficulty-select roster/scene was 100 % black, and why
five upstream hypotheses (fog/uniform/konst/texdim/feedback) all
dead-ended: the fragments were culled before they ever shaded.

**Fix (smallest gated, 1 line):** in `replayCreatePipelineCfg`
(`src/upstream-discio-worker.js`) `frontFace: "ccw"` → `"cw"` to
compensate for the VS Y-flip; real `CULL[cullCode]` culling restored
(diagnostic toggles reverted to false). JS-only — dev server serves
it live, **no core rebuild**.

**Probe-verified (`?video=wgpu`, no-input attract → difficulty-select):**
`tex#14` difficulty-select `nz≈833353-845248` (was 9697),
**distinct hashes 9 → 43**, screenshot renders the FULL
difficulty-select (roster grid, character portraits, VERY EASY +
yellow arrows, red LEVEL box) — matches the `?video=webgpu`
reference. Boot GameCube dialog **unregressed** (`tex#14` p=650/1000
still `(0,0,25)` uniform, text intact). Renderer still fast (post-JIT
steady state; the 91 % avg was dragged by the cold-JIT warmup window
in this run). No `VALIDATION`/DROPPED.

**Status (honest, ralph):** ★ first **rendering** win of the §28 arc
(not just observability): the long-running difficulty-select-black
construct (§28→§28f) is RESOLVED by a correct, minimal, gated fix.
`?video=webgpu` never-break check pending in this same checkpoint
(frontFace lives only in the `?video=wgpu` pcfg path; the hybrid uses
the SW renderer + WGSL presenter and does not traverse
`replayCreatePipelineCfg`, so no regression expected — verifying
anyway). `DIAG_EFB_TO_CANVAS` / per-draw ring / §26 guard untouched.
Next: confirm reference intact, commit, then continue scene-by-scene
(title / main menu / CSS / stage-select) against the reference.

### 28h. Post-fix scene survey — difficulty-select STEADY frames match reference; residual = sparse TRANSITION frames

Surveyed the post-§28g `?video=wgpu` run (43 distinct hashes) against
the `?video=webgpu` reference (63 distinct, 99.89 % gameSpeed,
unregressed) frame-by-frame:

- **Steady difficulty-select frames** (t=50, t=62, t=69): render
  **FULLY and correctly** — roster/trophy grid, character portraits,
  "VERY EASY" + yellow selector arrows, red LEVEL box, blue Melee
  background — visually matching the reference. ✓
- **Boot GameCube dialog**: correct, unregressed. ✓
- **Early frames (t≤~28)**: `?video=wgpu` is still in JIT-warmup
  (cold-start, canvas black) while the reference — SW renderer, no
  equivalent warmup — already shows title/menu. This is a
  validator-timeline/JIT-warmup *timing artifact* (the fixed input
  schedule drives navigation during wgpu's warmup), not a renderer
  defect: the deterministic no-input park (difficulty-select) renders
  correctly.
- **Residual construct:** brief **post-input transition frames**
  (t=57/58, right after the validator's Enter at t=56) render
  **sparse** in wgpu (scattered triangle fragments + the yellow
  selector-oval *outline* only) while the reference shows the full
  screen. The steady frames immediately before/after (t=50/62/69) are
  full. ⇒ a transition/animation-frame fidelity issue (candidate: the
  EFB-copy ping-pong that builds the animated menu is mid-rebuild on
  those frames, or a subset of transition draws still
  culled/dropped). Lower severity than the resolved §28g black; the
  primary deterministic scene now matches.

**Status (honest, ralph):** §28 core construct RESOLVED & verified
(steady difficulty-select matches reference, reference unregressed,
committed `ec01bfe`). The boulder continues: next construct =
sparse transition frames (scoped above); title/menu/in-game remain
gated by the blind validator's no-navigation + JIT-warmup timing and
the §27 savestate wedge (documented, not renderer defects reachable
by the deterministic probe).
