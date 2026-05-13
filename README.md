# wasm-dolphin

A Chrome-ready WebAssembly emulator host inspired by mGBA's browser workflow.

This repository ships a working WebAssembly demo core so the canvas, input, save-state, fullscreen, audio, and file-mount paths can be used immediately. It also includes a from-scratch native C++ WebAssembly core scaffold under `core/native`.

The native core is the browser ABI and first boot slice, not a complete GameCube/Wii emulator yet. Full Dolphin compatibility requires porting or integrating the upstream Dolphin CPU, memory, DI, DSP, IOS, video, scheduler, and save subsystems. The fetch/build scripts are included for that next lane.

## Run

```powershell
npm test
npm start
```

Open the printed local URL in Chrome. The app falls back to the demo WebAssembly core when no Dolphin bundle is present.

For the current Melee browser path, use the **recommended playable URL**
(software backend + WASM JIT, post-Day-2 carry-op fix):

```text
http://127.0.0.1:8082/?core=upstream&video=software&cpu=dual&speed=1&present=full&presenter=webgpu&pacing=smooth&jittier=guarded&jitwarmup=700&wasmjit=1&oc=1&queue=2&fastsw=1&metrics=1
```

Drop a Melee ISO onto the page; the status pill announces "Experimental
WASM JIT enabled after 700 stable video frames" ~12 seconds in, after
which gameplay runs at near-100 % game speed.

### Measured status (post-Day-2 fix, validator 180 s)

| Config                                            | game speed | visual fps | playable |
|---------------------------------------------------|-----------:|-----------:|----------|
| `video=software` + `wasmjit=1` (recommended)      |   100.15 % |      22.4  | **Yes — best** |
| `video=software` + `wasmjit=0`                    |    99.4 %  |      25.7  | Yes (slightly choppier startup) |
| `video=ogl` + `oglproxy=readback` + `forcejit=1`  |    98.8 %  |       1.3  | Boots/renders. Distinct hash progression 0.34/s. |
| `video=ogl` + `oglproxy=readback` + `forcejit=1` + `oglsab=1` |    97.2 %  |       1.6  | **2× faster visible progression** via SAB pixel transport (0.67/s distinct); main thread `putImageData`s a SharedArrayBuffer the worker fills per-readback, bypassing the WebGPU presenter + OffscreenCanvas auto-mirror. |
| `video=ogl` + `oglproxy=worker`                   |    n/a     |       0    | Not yet — Emscripten pthread message routing |
| `video=ogl` + `oglproxy=proxy`                    |    n/a     |       0    | Not yet — OffscreenCanvas auto-mirror inactive |

The OGL hardware path is bottlenecked on Emscripten's WebGL pthread proxy
round-trip latency, not on glReadPixels bandwidth. Per-helper bisection
knobs (`?disable=meleeloop,meleecall,...,wasmaddc,wasmsubfc,wasmadde,wasmsubfe,wasmaddze`)
are wired so any future regression in the JIT fast-paths can be isolated
without a rebuild — see `src/core-host.js` for the full bit list and
`patches/dolphin-wasm/SESSION-2026-05-11-DAY-2-NOTES.md` for the rationale.

Full multi-day investigation trail in `docs/ogl-performance-plan.md` and
the `patches/dolphin-wasm/SESSION-*-NOTES.md` files.

## Native Core

Install Emscripten, then build the local core:

```powershell
npm run check:deps
npm run build:core
```

That produces:

```text
cores/dolphin/dolphin.js
cores/dolphin/dolphin.wasm
```

The C++ source lives at `core/native/dolphin_web_core.cpp`. It exposes a stable C ABI for the browser host: mount disc, reset, run frame, set input, save/load state, read framebuffer, and read parsed GameCube disc metadata.

## Upstream Dolphin Lane

To pull the upstream emulator source for the full port:

```powershell
npm run fetch:dolphin
npm run patch:upstream
npm run configure:upstream
npm run build:upstream:discio
npm run build:upstream:bridge
```

This clones `https://github.com/dolphin-emu/dolphin.git` into `vendor/dolphin`. Upstream Dolphin is GPLv2+, so any distributed combined browser build must comply with that license.
The current Emscripten probe state is tracked in `docs/upstream-wasm-probe.md`.

The upstream bridge emits `cores/dolphin/dolphin-upstream.js` and `cores/dolphin/dolphin-upstream.wasm`. It is a DiscIO metadata bridge, not the gameplay core.
Open the browser host with `?core=upstream` to run this bridge in a Web Worker. The worker mounts selected browser files through Emscripten `WORKERFS`, so real GameCube disc images do not need to be copied into MEMFS before DiscIO reads them.
This bridge also exports boot-layout probes for apploader, boot DOL, FST, and raw/file reads. It still does not execute game code.

The host loads the web build here:

```text
cores/dolphin/
  dolphin.js
  dolphin.wasm
  ...
```

The adapter in `src/dolphin-adapter.js` looks for a factory named `createDolphinCore`, a default ESM export, or an Emscripten-style global `Module`.
The upstream worker adapter in `src/upstream-worker-adapter.js` looks for `cores/dolphin/dolphin-upstream.js`.

## Controls

- GameCube A/B/X/Y: `X`, `Z`, `S`, `A`
- Start: `Enter`
- L/R/Z: `Q`, `E`, `C`
- D-pad: arrow keys
- Main stick: `W`, `A`, `S`, `D`

Standard browser gamepads are also polled.
