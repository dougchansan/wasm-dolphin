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
[reproducible build](docs/repro-build.md) · [latest audit](docs/performance-audit-2026-07-10.md) ·
[validation evidence](docs/perf-results/melee-performance-evidence-2026-07-10.md)

---

## Status at a glance

| Area | State |
|------|-------|
| Melee boot + gameplay (software hybrid) | ✅ Playable when locally validated; speed is scene/machine dependent |
| PPC→WASM JIT with GPR register cache | ⚠️ Default-on; old `addzex` failures are fixed, benefit remains scene-dependent |
| Presentation smoothness (pacing, fast raster) | ✅ Tunable; software rasterizer caps unique-frame rate |
| Audio | ✅ Worker-fed/tuned audio buffering |
| WebGPU **hardware** renderer (`video=wgpu`) | ⚠️ Fixed battle visible on one validation GPU; still slow and experimental |
| Wii / broader GameCube compatibility | 🔬 Not a focus; unverified |

The default configuration is the recommended, locally validated
software-hybrid path. Experimental renderers and correctness-sensitive JIT
levers remain behind opt-in URL flags.

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
page to boot. After the configured warmup, the status pill may announce
*"Experimental WASM JIT enabled after N stable video frames"*. Game speed and
visual cadence remain scene-, cache-, browser-, and machine-dependent.

### Recommended playable URL

The default settings already select the software-hybrid path. This explicit URL
pins every knob for reproducibility:

```text
/?core=upstream&video=software&presenter=webgpu&cpu=dual&speed=1&wasmjit=1&jitwarmup=700&oc=1&pacing=tick&fastsw=1&metrics=1
```

- `video=software` + `presenter=webgpu` — software rasterizer, presented to the
  canvas through a WebGPU blit (the "software hybrid").
- `wasmjit=1` — request guarded PPC→WASM JIT; verify each run's metrics.
- `pacing=tick` — repaint the canvas on a steady tick for smoother scrolling
  (default for software paths).
- `fastsw=1` — balanced/crisp fast software mode (see [Raster quality](#raster-quality-fastsw)).

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

- A historical local A/B reported **+38% raw throughput**. The eight later
  fixed-scene emit failures were all an accidental `addzex` diagnostic disable
  and are fixed, but no current repeated A/B reproduces the +38% claim.
- Escape hatch: `?regalloc=0` disables it.
- `?smearcompile=1` (default-on) spreads JIT compilation to reduce mid-match
  compile bursts.

The browser sandbox constrains how far this can go: there is no host memory-trap
("fastmem") path, every emulated memory access is bounds-checked in software,
and the dynamic PPC JIT does not yet emit SIMD. See
[the JIT flag reference](docs/jit-flags.md) and
[`docs/core-roadmap.md`](docs/core-roadmap.md).

### Rendering: the software hybrid (default)

The default path uses Dolphin's **software rasterizer** for correctness, then
**presents** the framebuffer to the page via WebGPU (or WebGL/Canvas fallback).
The pipeline is:

```
software rasterizer → EFB → XFB (YUV encode) → WebGPU presenter → <canvas>
```

The main measured smoothness limit on the default path is the software GPU:
game timing can approach its target while the rasterizer produces relatively
few distinct frames. Three profiler runs averaged about 59.7 presentation FPS
but only 12.8 unique visual FPS, with 78.3% sampled stale-source reuse. Raster,
TEV, texture, FIFO, and XFB phase counters now identify where to optimize
without changing correctness. Two knobs expose the tradeoff:

#### Pacing

`?pacing=` controls how the canvas is refreshed:
`tick` (default; immediate fresh frames plus duplicate re-paints), `smooth`
(paced queue), or `direct` (immediate fresh frames only). WebGPU hardware uses
`smooth`; `legacytickqueue=1` restores the old queued `tick` route for rollback.

#### Raster quality (`fastsw`)

`?fastsw=` thins the software raster and XFB encode. Aggressive modes can
raise unique-frame cadence, but are not guaranteed to raise game speed:

| `fastsw` | What it does | Quality |
|:--:|------|------|
| `0` | Upstream full-resolution raster/encode | Literal full quality; slowest |
| `1` (default) | 2×2 sampled raster with replicated cells | Crispest recommended fast mode |
| `2` | 4×4 sampled raster with row duplication | Most aggressive; blocky bands |
| `3` | 4×4 sampled raster with vertical interpolation | Aggressive; smoother bands |

`fastsw=3` reconstructs the rows that `fastsw=2` duplicates by interpolating
between neighbors. Mode 1 shades one sample per 2×2 cell; modes 2 and 3 shade
one per 4×4 cell. None is literal full quality; `fastsw=1` remains the crisp
default. Results are scene-dependent—see the
[measured performance audit](docs/performance-audit-2026-07-10.md).

### Rendering: WebGPU hardware backend (experimental)

`?video=wgpu` selects the true WebGPU hardware renderer command path, intended
to bypass the software-raster unique-frame ceiling. On the validation GPU, the
first completed 108-draw EFB pass contains nonzero color and the fixed battle
is visible. This does not isolate which individual draw first changed the EFB.
Replay still averages only about 68% game speed and 30 presents/s in the
retained JIT-off runs, so it is **not** the default.

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

Real-browser qualification uses headed Chrome and directly loads the exact
Kirby-versus-Link save. It verifies ROM/save/checkpoint identities, sends no
menu or gameplay input, and writes raw JSON/CSV/events plus screenshots:

```powershell
$env:ROM='<verified Melee Rev 2 ISO>'; $env:SAVE_STATE_PATH='<verified Kirby-vs-Link save>'
$env:PERF_PROBE_HEADED='1'; npm run perf:gate
```

Use a comparison config for repeated A/B blocks. Older menu and `ab-*.ps1`
drivers are research aids, not qualifying evidence. Headless runs are always
non-qualifying for renderer claims.

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
  perf-regression-gate.mjs    Direct-save headed-Chrome qualification harness
  naga-spirv-wgsl/       Rust SPIR-V→WGSL transpiler (WebGPU path)
  ab-*.ps1               Historical/non-qualifying research drivers
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

- **Crisp *and* smooth is not yet achieved on the software path.** The balanced
  raster (`fastsw=1`) is capped at the rasterizer's unique-frame rate during
  heavy motion; the fast modes buy smoothness by reducing image quality. The
  main routes to both are fixing hardware WGPU or optimizing, vectorizing, or
  parallelizing the measured hot software-raster phases.
- **WebGPU hardware renderer is GPU-dependent** — verify on the target GPU
  before relying on it; it can render black on some Windows GPUs.
- In-browser structural limits (no fastmem trap and no SIMD emission in the
  dynamic PPC JIT) bound how close the JIT can get to native speed.

---

## License

This project builds on [Dolphin](https://github.com/dolphin-emu/dolphin), which
is licensed **GPLv2+**. The vendored sources and any distributed combined build
(including the core `.wasm`) are subject to GPLv2+. The Rust `naga-spirv-wgsl`
crate depends on `naga` (MIT/Apache-2.0). Provide your own game ISOs — none are
included.
