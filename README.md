# wasm-dolphin

Run the **Dolphin** GameCube/Wii emulator in a Chrome tab, compiled to
WebAssembly. The current focus and best-supported title is **Super Smash Bros.
Melee**, which can approach 100% game speed on a modern desktop browser, with
visual smoothness limited by the software rasterizer on the default path.

Under the hood this is the upstream [Dolphin](https://github.com/dolphin-emu/dolphin)
C++ codebase cross-compiled with Emscripten, driven by a small JavaScript host
that owns the canvas, audio, input, save-states, and file mounting. A custom
PowerPC→WASM JIT and a software-rendering + WebGPU-presentation pipeline make
real-time play possible inside the browser sandbox.

> **License note:** Dolphin is GPLv2+. Any distributed combined build that
> includes the vendored Dolphin sources or the built core `.wasm` must comply
> with GPLv2+. See [License](#license).

**Project references:** [current status](docs/current-status.md) ·
[rendering modes](docs/rendering-modes.md) · [JIT flags](docs/jit-flags.md) ·
[reproducible build](docs/repro-build.md) ·
[Melee validation results](docs/perf-results/melee-software-hybrid.md)

---

## Status at a glance

| Area | State |
|------|-------|
| Melee boot + gameplay (software hybrid) | ✅ Playable, ~100% game speed |
| PPC→WASM JIT with GPR register cache | ✅ Default-on, +38% throughput |
| Presentation smoothness (pacing, fast raster) | ✅ Tunable; software rasterizer caps unique-frame rate |
| Audio | ✅ Worker-fed presentation, tuned buffering |
| WebGPU **hardware** renderer (`video=wgpu`) | ⚠️ Experimental / parked — renders on some GPUs, black on others |
| Wii / broader GameCube compatibility | 🔬 Not a focus; unverified |

The default configuration is deliberately the **correct, always-working**
software-hybrid path. Experimental renderers and JIT levers are gated behind
opt-in URL flags and default to off, so the default page load is always a
working build.

The recommended playable path is `video=software&presenter=webgpu`. The true
hardware WebGPU renderer is `video=wgpu` and remains experimental.

---

## Quick start

Requires Node.js (for the dev server and tooling). A prebuilt core `.wasm` is
committed, so you do **not** need to build anything to play.

```powershell
npm install
npm test          # optional: unit tests
npm start         # serves the app; prints a local URL
```

Open the printed URL in **Chrome** (WebGPU + SharedArrayBuffer required — the
dev server sends the necessary COOP/COEP headers). Drag a Melee ISO onto the
page to boot. About 12 seconds in, the status pill announces *"Experimental
WASM JIT enabled after N stable video frames"*, after which gameplay runs at
near-100% speed.

### Recommended playable URL

The default settings already select the software-hybrid path. This explicit URL
pins every knob for reproducibility:

```text
/?core=upstream&video=software&presenter=webgpu&cpu=dual&speed=1&wasmjit=1&jitwarmup=700&oc=1&pacing=tick&fastsw=1&metrics=1
```

- `video=software` + `presenter=webgpu` — software rasterizer, presented to the
  canvas through a WebGPU blit (the "software hybrid").
- `wasmjit=1` — the PowerPC→WASM JIT (with register cache) is active.
- `pacing=tick` — repaint the canvas on a steady tick for smoother scrolling
  (default for software paths).
- `fastsw=1` — full-quality software raster (see [Raster quality](#raster-quality-fastsw)).

---

## Architecture

```
 ┌─────────────────────── Chrome tab ───────────────────────┐
 │  Main thread (src/)                                       │
 │   app.js · core-host.js · input.js · audio · settings     │
 │        │  canvas (WebGPU present)   ▲ audio   ▲ input      │
 │        ▼                            │         │            │
 │  Web Worker: upstream-discio-worker.js                    │
 │        │ mounts ISO via Emscripten WORKERFS                │
 │        ▼                                                   │
 │  dolphin-core-upstream.wasm  (Emscripten build of Dolphin)│
 │    • PowerPC CPU: CachedInterpreter → WASM JIT + regcache  │
 │    • Software VideoBackend: rasterizer → EFB → XFB encode  │
 │    • DSP audio, DiscIO, scheduler, save-states             │
 │    • (opt) WebGPU hardware backend + Naga SPIR-V→WGSL      │
 └───────────────────────────────────────────────────────────┘
```

### CPU: the PowerPC → WASM JIT

Dolphin's `CachedInterpreter` is extended to emit a **WebAssembly module per
basic block** instead of interpreting PowerPC ops one at a time. The key
optimization is a **GPR register cache**: the 32 PowerPC general-purpose
registers are held in WASM locals for the life of a block (loaded in the
prologue, flushed at block end and around calls) instead of round-tripping to
the emulated register file on every access.

- Clean A/B measurement: **+38% raw throughput**, and it is **on by default**.
- Escape hatch: `?regalloc=0` disables it.
- `?smearcompile=1` (default-on) spreads JIT compilation to remove mid-match
  compile-burst hitches at no throughput cost.

The browser sandbox constrains how far this can go: there is no host memory-trap
("fastmem") path, and every emulated memory access is bounds-checked in
software. See [the JIT flag reference](docs/jit-flags.md) and
[`docs/core-roadmap.md`](docs/core-roadmap.md).

### Rendering: the software hybrid (default)

The default path uses Dolphin's **software rasterizer** for correctness, then
**presents** the framebuffer to the page via WebGPU (or WebGL/Canvas fallback).
The pipeline is:

```
software rasterizer → EFB → XFB (YUV encode) → WebGPU presenter → <canvas>
```

The felt smoothness bottleneck is **not** the CPU — the game logic runs at
~60 fps — but the scalar software rasterizer + XFB encode, which cap the number
of *unique* frames reaching the screen during heavy motion. Two knobs address
this:

#### Pacing

`?pacing=` controls how the canvas is refreshed:
`tick` (default; steady re-paint, smoothest scroll), `smooth` (paced queue), or
`direct` (paint only on new unique frames). The WebGPU hardware backend uses
`smooth`.

#### Raster quality (`fastsw`)

`?fastsw=` trades image quality for a higher unique-frame rate by thinning the
software raster and XFB encode:

| `fastsw` | What it does | Quality | Unique fps (battle) |
|:--:|------|------|--:|
| `1` (default) | Full-quality encode | Crisp | ~15–22 |
| `2` | Half-row encode with **row duplication** | Blocky vertical banding | ~35 |
| `3` | Half-row encode with **vertical interpolation (LERP)** | Smooth, no banding | ~29 |

`fastsw=3` reconstructs the rows that `fastsw=2` duplicates by interpolating
between neighbors — same throughput class as `fastsw=2`, without the
venetian-blind banding. All fast modes share a quarter-resolution *shading* skip,
so none of them are full-quality; `fastsw=1` remains the crisp default.

### Rendering: WebGPU hardware backend (experimental, parked)

`?video=wgpu` selects a true WebGPU hardware renderer (ubershaders) that would
bypass the software-raster unique-frame ceiling entirely. It works on some GPUs
but currently renders **black on some Windows GPUs**, so it is **not** the
default and must not be shipped to the default page until verified on the target
GPU. Prior black-3D, flicker, and dark-menu issues have been root-caused and
fixed; the remaining blocker is GPU-specific.

This path needs Dolphin's shaders in WGSL. Dolphin generates GLSL → glslang
compiles it to SPIR-V (in C++) → the Rust crate below does the final hop.

### Rust: `tools/naga-spirv-wgsl`

A small Rust staticlib that transpiles **SPIR-V → WGSL** using wgpu's
[`naga`](https://github.com/gfx-rs/wgpu). It is compiled for
`wasm32-unknown-emscripten` and linked directly into the core `.wasm`, giving
`WebGPUShaderTranslator::SpirvToWgsl` a synchronous C-ABI call with no async
worker round-trip. Built with `cargo build --release --target
wasm32-unknown-emscripten`; `panic = "abort"` so a translation failure can never
unwind across the FFI boundary (it returns null + a `naga_last_error()` string
instead).

> This is the **only** Rust in the project, and it exists solely to support the
> experimental WebGPU renderer — the performance work (the JIT register cache)
> is C++ in the vendored Dolphin tree, not Rust.

See [the Naga bridge reference](docs/webgpu-naga-bridge.md) for the ABI,
ownership rules, and patched C++ call site.

---

## Performance & tuning flags

URL parameters are read at load time and need no rebuild. Use the canonical
[rendering-mode](docs/rendering-modes.md) and [JIT flag](docs/jit-flags.md)
references when constructing experiments. Save the complete URL with every
result.

---

## Building the core

A prebuilt core is committed; build only when changing the C++/Rust core.

The full prerequisites, version record, assumptions, outputs, and release
checklist are in [the reproducible build guide](docs/repro-build.md).

```powershell
# One-time: fetch and patch upstream Dolphin into vendor/dolphin
npm run fetch:dolphin
npm run patch:upstream
npm run configure:upstream

# Build the gameplay core (→ cores/dolphin/dolphin-core-upstream.{js,wasm})
npm run build:upstream:full-core
# or, faster, with explicit parallelism:
#   BUILD_PARALLELISM=8 node tools/build-upstream-target.mjs dolphin_web_core
```

Other targets: `build:upstream:discio` / `build:upstream:bridge` (DiscIO
metadata bridge), `build:core` (the standalone native scaffold under
`core/native`). The vendored Dolphin tree (`vendor/`) is gitignored; source
changes to the rasterizer, JIT, or shaders are baked into the committed core
`.wasm`.

---

## Testing & validation

```powershell
npm test          # Node unit tests (tests/*.test.mjs)
npm run check     # syntax-check all JS entry points
npm run perf:gate # perf regression gate
```

Real-browser gameplay validation uses a headed-Chrome harness that boots the
ISO, optionally loads a save-state, and samples the OSD counters (game speed,
core fps, unique/visual fps) to `samples.json` plus screenshots:

```powershell
$env:HEADED="1"; $env:VIDEO="software"; $env:FASTSW="1"
node tools/menu-progress-validate.mjs --out-dir .omx/menu-progress/run1
```

Throughput A/B drivers live in `tools/ab-*.ps1`. Headless Chrome has no WebGPU,
so rendering paths must be validated headed.

---

## Project layout

```
src/                     Browser host (main thread + worker)
  app.js                 UI, settings wiring
  core-host.js           Flag parsing, core lifecycle, presentation pacing
  upstream-discio-worker.js  Worker that owns the core + ISO mount + present
  settings.js input.js audio.js …
core/
  upstream/              C-ABI shim compiled with Dolphin (dolphin_web_core.cpp)
  native/                Standalone from-scratch native core scaffold
cores/dolphin/           Committed prebuilt core (.js/.wasm) the host loads
vendor/dolphin/          Upstream Dolphin sources (gitignored; fetched+patched)
patches/dolphin-wasm/    Build gates + browser-platform patches + session notes
tools/
  serve.mjs              Dev server (COOP/COEP)
  build-upstream-target.mjs   Emscripten build driver
  menu-progress-validate.mjs  Headed-Chrome validation harness
  naga-spirv-wgsl/       Rust SPIR-V→WGSL transpiler (WebGPU path)
  ab-*.ps1               Throughput A/B drivers
docs/                    Roadmaps and investigation trail
tests/                   Node unit tests
```

---

## Controls

- GameCube A / B / X / Y: `X`, `Z`, `S`, `A`
- Start: `Enter`
- L / R / Z: `Q`, `E`, `C`
- D-pad: arrow keys
- Main stick: `W`, `A`, `S`, `D`

Standard browser gamepads are also polled.

---

## Known limitations

- **Crisp *and* smooth is not achievable on the software path.** Full-quality
  raster (`fastsw=1`) is capped at the rasterizer's unique-frame rate during
  heavy motion; the fast modes buy smoothness by reducing image quality. The
  only way to get both is the WebGPU hardware renderer (parked) or a
  SIMD-vectorized software rasterizer.
- **WebGPU hardware renderer is GPU-dependent** — verify on the target GPU
  before relying on it; it can render black on some Windows GPUs.
- In-browser structural limits (no fastmem trap, no WASM SIMD, baseline-tier
  codegen) bound how close the JIT can get to native speed.

---

## License

**wasm-dolphin is licensed under the GNU General Public License, version 2 or
later (GPLv2+).** The full text is in [LICENSE](LICENSE).

This project builds on [Dolphin](https://github.com/dolphin-emu/dolphin), which
is GPLv2+. The core `.wasm` is compiled from patched Dolphin sources, and the
JavaScript host in `src/` is combined with it into a single running program, so
the combined work is GPLv2+ in its entirety — not just the vendored C++.

Because the built core is distributed in this repository, GPLv2 §3 requires the
complete corresponding source for it. That is satisfied by three pinned inputs
together, documented in [the reproducible build guide](docs/repro-build.md):

- `vendor/dolphin` — submodule pinned to a fixed upstream revision
- `patches/dolphin-wasm/wasm-dolphin-full.patch` — the complete delta
- `patches/dolphin-wasm/nested/*.patch` — changes inside Dolphin's own submodules

The Rust `naga-spirv-wgsl` crate depends on `naga` (MIT/Apache-2.0), which is
GPL-compatible.

**No game data is included or distributed.** Provide your own GameCube ISO,
dumped from a disc you own. Save states, memory-card files, and the prebuilt
JIT cache contain or derive from copyrighted game code and are gitignored —
do not commit or publish them.
