# Project Status — Checkpoint

_Checkpoint of wasm-dolphin progress. Snapshot of what is built, measured, and
decided. See `SESSION-*-NOTES.md` under `patches/dolphin-wasm/` for the
day-by-day trail and `docs/core-roadmap.md` for forward plans._

## Product direction (locked)

**Correct + fast native software hybrid.** The shipping path is Dolphin's
software rasterizer presented through WebGPU (`video=software` +
`presenter=webgpu`). The default page load is always a working build; every
experimental renderer or JIT lever is gated behind an opt-in, default-off URL
flag. Performance effort targets the **CPU (PPC→WASM JIT)** and the
**presentation path**, because profiling showed rendering cost — not the CPU —
is the felt bottleneck, while the CPU JIT is where raw throughput lives.

## What works today

- **Super Smash Bros. Melee boots and plays** in Chrome at ~100% game speed on
  a modern desktop.
- **PPC→WASM JIT with GPR register cache** — default-on, user-verified correct
  under live controller input.
- **Presentation pacing** — `pacing=tick` default; smooth canvas refresh,
  flicker fixed.
- **Audio** — worker-fed presentation with tuned buffering.
- **Save-states, ISO mount (WORKERFS), input, fullscreen** — working.
- **Headed-Chrome validation harness** — boots ISO, loads save-states, samples
  OSD counters + screenshots.

## Measured performance

- **GPR register cache (regcache/regalloc):** clean uncapped A/B, base ~191% →
  regcache ~265% game speed = **+38%**, fully non-overlapping. Default-on
  (`?regalloc=0` to disable).
- **Presentation unique-frame rate (software raster is the ceiling):** in a
  full-motion scene, full-quality `fastsw=1` delivers ~15–22 unique fps while
  the core runs ~60 fps. Making the raster cheaper raises unique frames directly
  (see fast-raster table).
- **Fast-raster modes (Great Bay battle, post-warmup mean visual fps):**
  `fastsw=1` 14.8 · `fastsw=2` 34.5 · `fastsw=3` 28.8. `fastsw=3` (LERP)
  removes `fastsw=2`'s row-doubling banding at ~17% below its throughput.

## Optimization results (what was tried)

| Lever | Result |
|-------|--------|
| GPR register cache (WASM locals) | ✅ **+38%, default-on** |
| `smearcompile` (spread JIT compile) | ✅ Removes mid-match hitches, default-on |
| `pacing=tick` presentation | ✅ Felt-smoothness win, default-on |
| `fastsw=3` LERP tuned raster | ✅ Built; smoother than `fastsw=2`, opt-in |
| N-block JIT chaining (blockmerge/B1) | ⚪ Throughput-neutral — not adopted |
| In-WASM loops (B2) | ⚪ Evidence-against (hot loops already batched) — not built |
| Fastmem bounds-check hoisting | ❌ −8.5% regression — reverted |
| Rust rewrite of core for perf | ❌ No leverage — not pursued |

**Conclusion:** the register cache is the practical in-browser JIT ceiling. The
remaining gap to native is structural: no host memory-trap (fastmem), no WASM
SIMD, baseline-tier V8 codegen.

## Experimental / parked

- **WebGPU hardware renderer (`video=wgpu`).** Would bypass the software-raster
  unique-frame ceiling. Black-3D, flicker, and dark-menu bugs were root-caused
  and fixed, but it **renders black on some Windows GPUs** and is reverted off
  the default. Must be verified on the target GPU's console before any redeploy;
  the default stays the working software hybrid.
- **Rust `naga-spirv-wgsl`** — SPIR-V→WGSL transpiler supporting the WebGPU
  path. Built and linked; only Rust in the project.

## Known issues / the core tradeoff

- **Crisp vs. smooth on the software path.** `fastsw=1` is crisp but capped at
  the raster unique-frame rate (feels slow in heavy motion); `fastsw=2/3` are
  smoother but not full-quality. Both-at-once needs the GPU renderer (parked) or
  a SIMD software rasterizer.
- **WebGPU renderer is GPU-dependent** (black on some GPUs).

## Next candidate levers

1. Prove the WebGPU hardware renderer on the target GPU (biggest win: crisp +
   smooth, bypasses the raster ceiling).
2. SIMD-vectorize the software rasterizer / XFB encode (needs WASM SIMD in the
   toolchain).
3. Optional: SWAR-optimize the `fastsw=3` LERP pass to match `fastsw=2` speed.
