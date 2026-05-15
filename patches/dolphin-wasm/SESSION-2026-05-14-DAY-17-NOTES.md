# Session 2026-05-14 (Day 17) — real WebGPU video backend path (`?video=wgpu`)

Day 16 made `?video=webgpu` show real game content via a string-level
bridge (SetVideoBackend("WebGPU") → "Software Renderer", JS WebGPU
presenter). Day 17 split off a *real* WebGPU::VideoBackend path so the
hybrid stays as a stable fallback while the real backend is built.

Sub-steps (all four landed):

- **17.1** `?video=wgpu` (and `webgpu-real`/`webgpu2`) → core-host
  returns `"WebGPU-Real"` → `SetVideoBackend` maps it to the real
  `"WebGPU"` backend (no Software bridge). `?video=webgpu` keeps the
  Day-16 hybrid. Both forward the presenter's `WGPUDevice` to wasm.
- **17.2** `WebGPUGfx::BindBackbuffer` captures the clear colour;
  `PresentBackbuffer` flushes it via EM_ASM →
  `self.__dolphinWebGpuClear` → a real `wgpuRenderPass` clear on the
  canvas. First frame content driven from the real backend in C++.
- **17.3** `WebGPUTexture` given real CPU pixel storage
  (layer/level/pixels, mirroring SWTexture) so VideoCommon's
  XFB-from-RAM decoder's `Load()` lands somewhere readable.
- **17.4** `WebGPUGfx::ShowImage` extracts the XFB texture bytes and
  postMessages them to the discio worker, which blits via the existing
  WGPU presenter. Status pill confirmed
  `bytes[0..16]=00 87 00 ff… nonZero=2048/4096` — the pipeline is
  alive end-to-end, but the image was a uniform EFB-clear colour
  because the WebGPU `Pipeline`/`Draw` ops are still no-ops (no GPU
  rasterisation yet).

Day-17 outcome: the real `WebGPU::VideoBackend` is selectable and
drives the canvas through real `wgpuRenderPass` calls, but produces
only the EFB clear (no geometry) — which is why Day 18 wired the
Software rasteriser underneath it for real pixels. See the Day-18/19
notes for the continuation and the Day-21 InitBackendInfo /
JIT-flap fixes.

## Files touched (project-tracked)

- `src/core-host.js` — `?video=wgpu` → `"WebGPU-Real"`.
- `core/upstream/dolphin_web_core.cpp` — `"WebGPU-Real"` → real
  WebGPU backend; `"WebGPU"` → Software hybrid.
- `src/upstream-discio-worker.js` — device forwarded for wgpu;
  `self.__dolphinWebGpuClear` bridge; `handleWebGpuShowImage`.
- `cores/dolphin/dolphin-core-upstream.{js,wasm}` — rebuilt.

Vendor (gitignored): `VideoBackends/WebGPU/{VideoBackend,WebGPUGfx,
WebGPUTexture}.{cpp,h}`.
