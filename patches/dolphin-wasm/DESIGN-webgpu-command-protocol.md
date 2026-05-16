# WebGPU remote-backend command protocol (Day 28+ design)

Day-27 proved the transport (single OP_CLEAR over a shared-heap ring,
pthread→discio-worker→real device). This is the wire-protocol design
for widening it into a full GameCube renderer. Pure design — no code
until the Day-27 ring-correctness audit clears the base layout.

## Constraints recap

- Producer: Dolphin video **pthread** (C++ `WebGPUGfx`). No device, no
  event loop, can't do async.
- Consumer: **discio worker** (JS). Owns `renderGpu.device`, runs an
  event loop (so it can `await device.createShaderModule`-style work,
  drain each presentation tick).
- Channel: a `CmdRecord` ring in the wasm linear memory
  (SharedArrayBuffer). 32-byte fixed records. Variable-length payloads
  (WGSL text, pipeline config, vertex/uniform/texture bytes) can't fit
  inline → referenced by `(ptr,len)` into the shared heap.

## Resource identity

Producer assigns ids; consumer keeps `Map<id, GPUObject>`. Ids are
`u32`, monotonically allocated per resource class by the C++ side
(producer is single-threaded for video). Class is implied by opcode,
so one id space per class is fine (shaders, buffers, textures,
pipelines, bind-group-layouts, bind-groups, framebuffers). Id 0 =
"none/backbuffer" sentinel.

## Payload (blob) mechanism

Two payload lifetimes:

1. **Persistent (resource-creation):** WGSL source, serialized
   pipeline config. Created seldom, must outlive the record until the
   consumer builds the object. Producer `malloc`s a blob, passes
   `(ptr,len)` in the record, and **keeps it owned**; the consumer
   copies what it needs at replay (strings/structs are small). Reclaim
   via a deferred-free list keyed on the ring `read` index (free once
   `read` has passed the record that referenced it). Day-28 simplest
   form: pool/leak persistent blobs (shaders+pipelines are bounded,
   Dolphin caches them) — revisit if it grows.

2. **Per-frame (vertex / uniform / texture upload):** large, every
   frame. Do NOT malloc per frame. Use a pre-allocated **upload ring**
   (N MB, mirrors the Day-20 XFB-ring idea): producer bump-allocates
   into it, record carries `(offset,len)`; consumer
   `queue.writeBuffer/writeTexture`s straight from the shared heap
   (zero-copy read). Offsets recycle after N frames — sized so the
   consumer (1-2 frames behind) never reads a recycled region.

## Opcode set

### Day 28 — resources

| op | args (u[] / via blob) | consumer action |
|----|----------------------|-----------------|
| `CREATE_SHADER` | id; blob=(ptr,len) WGSL utf8 | `device.createShaderModule({code})`; stash compilationInfo on failure |
| `CREATE_BUFFER` | id; u0=size; u1=usageFlags | `device.createBuffer` |
| `UPLOAD_BUFFER` | id; u0=dstOffset; u1=srcOffset(upload-ring); u2=len | `queue.writeBuffer` |
| `CREATE_TEXTURE` | id; u0=w; u1=h; u2=wgpuFormat; u3=usageFlags | `device.createTexture` |
| `UPLOAD_TEXTURE` | id; u0=srcOffset; u1=bytesPerRow; u2=w; u3=h | `queue.writeTexture` |
| `CREATE_PIPELINE` | id; blob=(ptr,len) serialized PipelineDesc | build `GPURenderPipeline` (see mapping from API-agent) |
| `CREATE_SAMPLER` | id; u0=filter/wrap packed | `device.createSampler` |
| `DESTROY` | u0=classTag; u1=id | drop from map, `.destroy()` if applicable |

`usageFlags` / `wgpuFormat` are sent as the JS WebGPU numeric enums
(packed C-side constants mirrored from the API-agent's reference) so
the consumer doesn't switch on Dolphin enums.

### Day 29 — state + draw (per render pass)

| op | args | consumer |
|----|------|----------|
| `BEGIN_PASS` | u0=fbId(0=backbuffer); f1..4 clearColor; u5=loadOp; u6=depthFbId | `encoder.beginRenderPass` |
| `SET_PIPELINE` | u0=id | `pass.setPipeline` |
| `SET_BIND_GROUP` | u0=slot; u1=bgId | `pass.setBindGroup` |
| `SET_VERTEX_BUFFER` | u0=slot; u1=bufId; u2=offset | `pass.setVertexBuffer` |
| `SET_INDEX_BUFFER` | u0=bufId; u1=fmt; u2=offset | `pass.setIndexBuffer` |
| `SET_VIEWPORT` | f0..5 | `pass.setViewport` |
| `SET_SCISSOR` | u0..3 | `pass.setScissorRect` |
| `DRAW` | u0=vtxCount; u1=instCount; u2=firstVtx | `pass.draw` |
| `DRAW_INDEXED` | u0=idxCount; u1=instCount; u2=firstIdx; u3=baseVtx | `pass.drawIndexed` |
| `END_PASS` | — | `pass.end()` |
| `SUBMIT_PRESENT` | — | `queue.submit`; canvas presents implicitly |

### Day 30 — EFB/XFB + cutover

- EFB = a `GPUTexture` color+depth pair the pipeline renders into;
  XFB = present source. `CREATE_TEXTURE` + `BEGIN_PASS(fbId=efb)`.
- Flip `g_backend_info.api_type` → Vulkan + restore Vulkan transform
  caps (reverses Day-21) so FramebufferShaderGen emits *complete*
  GLSL → existing C++ `GlslToWgsl` (Day-22/23, glslang+Naga) →
  `CREATE_SHADER`. This is why the Day-22/23 infra was built.
- Retire the Software-rasteriser delegation in `WebGPUGfx`
  (CreateTexture/Framebuffer stop returning SW classes; real
  AbstractGfx Draw path records opcodes instead).

## Bind-group / layout strategy

Dolphin's SHADER_HEADER fixes binding numbers (`UBO_BINDING`,
`SAMPLER_BINDING`). Mirror those into a fixed bind-group layout
created once per pipeline-layout class, so `CREATE_PIPELINE` and
`SET_BIND_GROUP` reference stable layouts. Exact layout entries come
from the API-agent's UBO+sampler reference.

## Ordering / correctness notes (pending audit)

- Resource-create opcodes must be drained **in order** before the
  draw opcodes that reference their ids — the single ring already
  guarantees FIFO, so this holds as long as the producer emits
  create-before-use (Dolphin's AbstractGfx already creates resources
  before binding them).
- Consumer builds objects synchronously at drain except shader
  modules (compile may be async / report errors async) — keep a
  per-shader "pending/ready/failed" state; a pipeline referencing a
  not-yet-ready shader defers that frame (skip draw, don't stall).
- The Day-27 audit must clear: std::atomic↔Atomics layout, wrap,
  union punning, blob lifetime. Implement Day-28 only after.

## API mapping reference (from research agent, condensed)

Numeric enums to mirror C-side (send these, not Dolphin enums):

- `GPUBufferUsage`: VERTEX 0x20, INDEX 0x10, UNIFORM 0x40, COPY_DST
  0x8, COPY_SRC 0x4, STORAGE 0x80, MAP_READ 0x1, MAP_WRITE 0x2.
- `GPUTextureUsage`: COPY_SRC 1, COPY_DST 2, TEXTURE_BINDING 4,
  STORAGE_BINDING 8, RENDER_ATTACHMENT 0x10.
- `GPUShaderStage`: VERTEX 1, FRAGMENT 2, COMPUTE 4.
- `queue.writeBuffer(buf,dstOff,data[,srcOffElems,sizeElems])`;
  byte offsets 4-aligned. `queue.writeTexture({texture,mipLevel,
  origin},bytes,{offset,bytesPerRow,rowsPerImage},[w,h,1])`;
  bytesPerRow multiple of 256 for copies.

Pipeline desc shape: `{layout, vertex:{module,entryPoint,buffers:
[{arrayStride,stepMode,attributes:[{shaderLocation,offset,format}]}]},
fragment:{module,entryPoint,targets:[{format,writeMask,blend?}]},
primitive:{topology,cullMode,frontFace,stripIndexFormat?},
depthStencil?:{format,depthWriteEnabled,depthCompare},
multisample:{count:1}}`. Omit `blend` when blend_enable==0; omit
`depthStencil` when no depth attachment.

Dolphin→WebGPU (file:line are in vendor/dolphin):

- PrimitiveType (RenderState.h:23-29): Points→"point-list",
  Lines→"line-list", Triangles→"triangle-list",
  TriangleStrip→"triangle-strip"(+stripIndexFormat). frontFace "ccw".
- CullMode (BPMemory.h:1141-1147; RenderState.h:52): None→"none",
  Back→"back", Front→"front", All→"none"+writeMask 0 / skip draw.
- DepthState (RenderState.h:111-113): test_enable; update_enable→
  depthWriteEnabled; func (BPMemory.h:1581-1591) Never→"never"
  Less→"less" Equal→"equal" LEqual→"less-equal" Greater→"greater"
  NEqual→"not-equal" GEqual→"greater-equal" Always→"always".
  test_enable==0 → depthCompare "always".
- BlendingState (RenderState.h:145-156): blend_enable (else omit
  blend); color_update/alpha_update→writeMask; subtract→op
  ("add" / "reverse-subtract"); src/dst factor (BPMemory.h:1299-1327)
  Zero→"zero" One→"one" DstClr→"dst" InvDstClr→"one-minus-dst"
  SrcAlpha→"src-alpha" InvSrcAlpha→"one-minus-src-alpha"
  DstAlpha→"dst-alpha" InvDstAlpha→"one-minus-dst-alpha";
  dst's SrcClr→"src" InvSrcClr→"one-minus-src". LogicOp has no WebGPU
  equiv — use Dolphin's ApproximateLogicOpWithBlending() result, map
  the BlendingState. use_dual_src unsupported (shader fallback later).
- Vertex (NativeVertexFormat.h:47-77; CPMemory.h:118-132): stride→
  arrayStride; per AttributeFormat offset→offset, type+components→
  format: Float→"float32[xN]", UByte/4 color→"unorm8x4",
  Byte/4→"snorm8x4", U/Short→"u/snorm16xN" (or u/sint16 if integer).
  shaderLocation by PortableVertexDeclaration order; skip
  enable==false. posmtx→"uint8x4".
- FramebufferState (RenderState.h:76-77): color fmt RGBA8→
  "rgba8unorm" / canvas "bgra8unorm"; depth→"depth24plus"/
  "depth32float".

Bind layout (mirrors Dolphin SHADER_HEADER bindings): UBO_BINDING →
entry {buffer:{type:"uniform"}}, SAMPLER_BINDING → texture
{sampleType:"float",viewDimension:"2d"} + sampler {type:"filtering"}.
Shader create: `device.createShaderModule({code})`;
`await mod.getCompilationInfo()` for errors; wrap pipeline create in
pushErrorScope("validation")/popErrorScope().
