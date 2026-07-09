# Project Status — Checkpoint

_Checkpoint of wasm-dolphin progress. Snapshot of what is built, measured, and
decided. See `SESSION-*-NOTES.md` under `patches/dolphin-wasm/` for the
day-by-day trail and `docs/core-roadmap.md` for forward plans._

## Product direction (locked)

**Correct + fast native software hybrid.** The shipping path is Dolphin's
software rasterizer presented through WebGPU (`video=software` +
`presenter=webgpu`). The default page load is always a working build; every
experimental renderer or correctness-sensitive JIT lever is gated behind an
opt-in flag. Current evidence classifies smoothness as a combined
software-GPU/raster, scene-dependent game-speed, and cold-JIT problem. Browser
presentation was not materially separated in two trials per backend, but
asynchronous GPU completion remains unmeasured.

## What works today

- **Super Smash Bros. Melee boots and plays** in Chrome. Game speed is
  machine-, scene-, browser-, and cache-dependent.
- **PPC→WASM JIT with GPR register cache** — default-on, user-verified correct
  under live controller input.
- **Presentation pacing** — `pacing=tick` default; smooth canvas refresh,
  flicker fixed.
- **Audio** — worker-fed presentation with tuned buffering.
- **Save-states, ISO mount (WORKERFS), input, fullscreen** — working.
- **Headed-Chrome validation harness** — boots ISO, loads save-states, samples
  OSD counters + screenshots.

## Measured performance

The figures in this section are historical research-session results and do not
contain the complete provenance now required by the
[2026-07-09 performance audit](performance-audit-2026-07-09.md). Use the audit
for current fixed-scene evidence.

- **GPR register cache (regcache/regalloc):** historical sessions reported
  base ~191% → regcache ~265% game speed. The current audit did not rerun
  `regalloc=0`; treat **+38%** as unprovenanced historical evidence.
- **Presentation unique-frame rate:** historical sessions reported
  balanced/crisp `fastsw=1` at ~15–22 unique fps while source cadence was near
  60. The fixed-state audit measured ~10.7 unique FPS in a different scene.
- **Fast-raster modes (historical Great Bay run):**
  `fastsw=1` 14.8 · `fastsw=2` 34.5 · `fastsw=3` 28.8. `fastsw=3` (LERP)
  removes `fastsw=2`'s row-doubling banding at ~17% below its throughput.

## Optimization results (what was tried)

| Lever | Result |
|-------|--------|
| GPR register cache (WASM locals) | Default-on; historical +38% claim needs a valid rerun |
| `smearcompile` (spread JIT compile) | Default-on; off wrapper fixed, current A/B not run |
| `pacing=tick` presentation | Default-on; felt-smoothness claim remains qualitative |
| `fastsw=3` LERP tuned raster | Built and opt-in; fixed-state results were highly variable |
| N-block JIT chaining (blockmerge/B1) | Historical neutral result; default-off |
| In-WASM loops (B2) | Not built |
| Fastmem bounds-check hoisting | Historical regression; default-off |
| Rust rewrite of core for perf | ❌ No leverage — not pursued |

**Current conclusion:** no JIT ceiling is established by provenance-complete
data. The build already enables WASM SIMD, while the dynamic PPC JIT does not
yet emit SIMD and still performs explicit memory safety checks.

## Experimental / parked

- **WebGPU hardware renderer (`video=wgpu`).** Intended to bypass the
  software-raster ceiling. The current classifier reached the command ring and
  a diagnostic pattern, but not a real game frame. Its exact first-draw failure
  remains unclassified.
- **Rust `naga-spirv-wgsl`** — SPIR-V→WGSL transpiler supporting the WebGPU
  path. Built and linked; only Rust in the project.

## Known issues / the core tradeoff

- **Crisp vs. smooth on the software path.** `fastsw=1` is the crisp fast
  default but is capped at the raster unique-frame rate (feels slow in heavy
  motion); `fastsw=2/3` are lower-quality and can raise distinct cadence, but
  the fixed-state audit also measured lower game speed. They are not universal
  smoothness wins.
- **WebGPU renderer does not yet produce a validated real game frame** in the
  current classifier.

## Next candidate levers

1. Pin the upstream SHA and commit the complete patch chain.
2. Measure raster, TEV, fast-fill, XFB generation, and GPU backlog separately.
3. Add the staged WGPU clear/triangle/checker/translated-shader/first-draw
   classifier.
