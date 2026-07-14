# Hardware-WGPU dirty-range projection — 2026-07-12

Two headed Chrome runs directly loaded the verified Kirby-versus-Link battle
save and measured whether the existing per-upload WebGPU staging copies could
be replaced by coarse destination dirty ranges. The projection was passive:
it did not change uploads, draws, queue submissions, or emulator behavior.

## Identity

- Commit: `7c5b8b7bf7131d27b7e672bfb6440841214664ff`
- Core SHA-256: `2576faf651de4dd6cd9677e2770c6285271e63ceb30e39489b978f9b43bab245`
- Browser: headed Chrome `150.0.7871.114`
- CPU: AMD Ryzen 9 9950X3D; 32 logical CPUs
- GPU adapter: AMD `rdna-4`
- Scene: direct verified `__battle.sav` load; Kirby versus Link; no menu or
  character-select driving
- Fixed work: eight emulated core seconds per run
- Relevant flags: `video=wgpu`, `presenter=webgpu`, `wasmjit=0`,
  `wgpuuploadtransport=mapped`, `wgpugeompack=1`, `wgpudirtyranges=1`,
  `metrics=1`

Both scenario summaries report `valid=true`, verified fixtures, the exact core
SHA, active `WebGPU-Real`, no renderer errors, and the fixed-work target
reached. The top-level reports say `NON_QUALIFYING` because the generic gate's
software-path 95% speed/FPS target was intentionally left in warning mode;
that label is not a provenance or runtime-validity failure.

## Global projection result

| Run | Game speed | Core FPS | Buffer uploads | Buffer bytes | Hazards | 64-byte-gap copy reduction | 64-byte-gap byte inflation | 4 KiB-gap copy reduction | 4 KiB-gap byte inflation |
| ---: | ---------: | -------: | -------------: | -----------: | ------: | -------------------------: | -------------------------: | ------------------------: | ------------------------: |
| 1 | 73.05% | 43.81 | 553,337 | 1,196,149,968 | 117 | 38.60% | 0.20% | 67.03% | 53.86% |
| 2 | 73.46% | 44.02 | 536,791 | 1,158,012,912 | 115 | 38.64% | 0.20% | 67.04% | 53.91% |

No global gap threshold met the predeclared gate of at least 80% fewer copies,
at most 20% byte inflation, and zero unresolved hazards. A renderer-wide
dirty-range transport is therefore rejected.

The hazards were destination-order regressions and upload-arena source wraps;
there were no destination overlaps, out-of-arena spans, record-order hazards,
or record-index wraps.

## Role classification

The failure is not uniform across upload classes. Approximate timed-window role
deltas from the raw samples show:

| Run | Role | Uploads | Bytes | Projected copies at 64-byte gap | Copy reduction | Byte inflation |
| ---: | ---- | ------: | ----: | --------------------------------: | -------------: | -------------: |
| 1 | Geometry | 215,292 | 392,546,180 | 1,682 | 99.22% | 0.61% |
| 2 | Geometry | 209,366 | 379,629,724 | 1,640 | 99.22% | 0.61% |
| 2 | UBO | 325,078 | 779,856,512 | 325,078 | 0.00% | 0.00% |

Geometry is the only clear next candidate. The existing packed geometry ring
produces many nearly contiguous ranges separated by at most small alignment
gaps. UBO ranges do not coalesce at small gaps, so a general arena or UBO-first
implementation is not justified by these captures.

## Decision

- Reject a renderer-wide dirty-range transport.
- Do not move replay to another worker as a throughput fix; it would improve
  scheduling isolation but would not reduce this command volume.
- Scope one default-off geometry-only producer arena/packet experiment. It must
  prove that the small gaps are non-live alignment padding, preserve ring-wrap
  and draw-order semantics, and retain the current per-upload path as rollback.
- Require a headed activation smoke and balanced A/B before promotion. The
  projection itself is not a performance win and no realtime claim is made.

Raw artifacts are retained locally under:

- `.omx/wgpu-no-lag/dirty-range-projection-run-1/software-stable/`
- `.omx/wgpu-no-lag/dirty-range-projection-run-2/software-stable/`

The machine-readable summary is
[`melee-wgpu-dirty-range-projection-2026-07-12.json`](melee-wgpu-dirty-range-projection-2026-07-12.json).
