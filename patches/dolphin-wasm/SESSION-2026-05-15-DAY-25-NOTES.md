# Session 2026-05-15 (Day 25) — threading finding sets the GPU architecture

Goal: establish the device/thread foundation for the real GPU
pipeline. The probe answered the architecture question.

## The probe

Added `self.__dolphinDiscioWorker = true` on the discio-worker thread
(it owns `renderGpu.device` via createWebGpuPresenter). C++ EM_ASM
checks it at `VideoBackend::Initialize` and `WebGPUGfx::ShowImage`.

Result, both `cpu=single` and `cpu=dual`:

    [webgpu-thread] Initialize on discioWorker=0
    [webgpu-thread] ShowImage  on discioWorker=0
    [webgpu-shader] xlat ... device=0 ...

The video backend runs on a Dolphin pthread (EmuThread/GPU thread),
**never** the discio-worker thread, regardless of cpu mode. WebGPU
objects (device, textures, pipelines, command buffers) are NOT
shareable across Emscripten pthreads — each worker has its own
emdawnwebgpu object table. So:

- The discio worker owns a device + the canvas WebGPU context.
- Dolphin's video code runs on a different thread that can't touch
  that device. `emscripten_webgpu_get_device()` returns null there
  (no preinitializedWebGPUDevice on the pthread's Module) → `device=0`.

There is no thread on which "C++ has the device AND owns the canvas".

## Architecture decision

Options weighed:

- **B — move the OffscreenCanvas to the video pthread.** "Correct"
  (device owns canvas, no readback) but the pthread is Emscripten
  pool-managed with no stable identity/lifecycle we control; cleanly
  transferring a canvas to it is high-risk surgery. Rejected.
- **D — video pthread gets its OWN headless device; rasterise on GPU
  to textures; read back the final XFB; postMessage to the discio
  worker for the canvas blit (existing ShowImage path).** Chosen.

Why D: it achieves the actual goal — move GameCube rasterisation
(TEV, vertex transform, texture sampling) off the CPU and onto the
GPU — while keeping the canvas-present architecture that already
works. The cost is one ~640×480 texture GPU→CPU readback per frame,
which is far cheaper than CPU-rasterising every pixel (today's
ceiling). It sidesteps the cross-thread canvas problem entirely. Once
proven, a later optimisation can revisit B to drop the readback.

## Consequence for the plan

`emscripten_webgpu_get_device()` (the Day-15 preinitialized path) is a
dead end for the render path — that device belongs to the wrong
thread. Day 26 changes from "fix device forwarding" to "**request a
fresh headless WGPUDevice on the video pthread itself**" (pthreads
are Web Workers; they have `navigator.gpu`). Acquisition is async and
Initialize is sync, so:

1. Kick the adapter+device request at Initialize; render via the
   Software path until the device resolves (natural fallback — the
   Day-18 hybrid already does Software).
2. Once the device is ready, switch the WebGPUGfx hot paths
   (CreateShaderModule / pipelines / Draw) onto it.
3. Per frame: rasterise on GPU → XFB texture → copyTextureToBuffer +
   mapAsync readback → the existing ShowImage postMessage → discio
   worker blit.

Then Day 26's api_type flip + the Day 27/28 pipeline objects all run
against that pthread-owned device.

## What landed Day 25

Just the probe + finding (the most valuable output here is knowing
the topology before building on a false assumption). Thread-probe
EM_ASM left in (cheap, one-shot) — useful when the device path
changes. No behaviour change; `?video=wgpu` still Software, no
regression.

## Files touched (project-tracked)

- `src/upstream-discio-worker.js` — `self.__dolphinDiscioWorker` flag.
- `cores/dolphin/dolphin-core-upstream.{js,wasm}` — rebuilt.
- `patches/dolphin-wasm/SESSION-2026-05-15-DAY-25-NOTES.md` — this.

Vendor (gitignored): `VideoBackend.cpp`, `WebGPUGfx.cpp` probes.
