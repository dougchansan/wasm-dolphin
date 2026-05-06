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

For the current Melee browser path, use the upstream core with the full-resolution presenter:

```text
http://127.0.0.1:8082/?core=upstream&video=software&cpu=dual&speed=1&wasmjit=1&forcejit=1&jitwarmup=1700&oc=1&queue=8&presenter=webgpu&fastsw=1
```

Full 640x480 presentation is now the default. Add `present=half` to that URL only when testing the lower-cost 320x240 fallback.

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
