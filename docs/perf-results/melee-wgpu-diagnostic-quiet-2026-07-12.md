# Hardware-WGPU diagnostic-log suppression screen — 2026-07-12

This headed Chrome screen tested whether the existing default-off
`wgpudiagquiet=1` filter improves fixed-work throughput by dropping known
non-error diagnostic records. It loaded the verified Kirby-versus-Link battle
save directly and compared the filter off and on in ABBA and BAAB blocks.

## Identity and method

- Harness commit: `e9ee99e77e1ba8eee245f145ba2ee671a69c548c`
- Candidate source commit: `648d6e3dc01365e0cec0618387f7bd245d5a77fe`
- Candidate WASM SHA-256: `8797d56029dcc540c5cae88b7d219712f76c63a00f884ec9aa25f64c90f90ff2`
  (12,909,641 bytes)
- Patch-series SHA-256: `cd3b918cd2d50d626d8d3caafc8556d29a335333a1496af11eb23a69ab655e93`
- Patched vendor tree: `10d0fdabc493a1c016abcb3d88fd20c81e5ea9a7`
- Browser: headed Chrome `150.0.7871.114`
- Machine: AMD Ryzen 9 9950X3D, 32 logical CPUs; AMD `rdna-4` WebGPU adapter
- Work: 12 emulated core seconds per run; two four-run blocks
- Arms: `wgpudiagquiet=0` and `wgpudiagquiet=1`
- Primary metric: fixed-emulated-work game-speed throughput; higher is better
- Predeclared screening threshold: at least `+1%`

All eight scenarios and both comparison blocks were runtime-valid. Overall
qualification eligibility was false because the documentation-only tail-gate
evidence files made the worktree dirty beginning with `block-01-run-4`; the
first three runs recorded a clean worktree. This provenance limitation does
not turn the noisy screen into positive evidence.

## Throughput result

| Block/order | Filter-off mean | Filter-on mean | Relative effect |
| --- | ---: | ---: | ---: |
| 1 / ABBA | 76.6522% | 76.3046% | -0.4535% |
| 2 / BAAB | 76.1084% | 77.7081% | +2.1018% |

The median block effect was `+0.8242%`; the bootstrap interval was
`[-0.4535%, +2.1018%]`. The opposing block effects and median below the `+1%`
threshold produced the exact outcome **`SCREENING_REJECT`**. The statistical
gate failed, the experiment is not promotable, and `wgpudiagquiet` remains
default-off.

Semantic work stayed within the declared `0.25%` bounds:

| Block | Core-tick difference | Frame difference |
| --- | ---: | ---: |
| 1 | 0.0179% | 0.1387% |
| 2 | 0.0217% | 0.1388% |

## Activation and drop evidence

Every off-arm manifest reported schema `wasm-dolphin.wgpu-diagnostic-log-filter.v1`,
`enabled=false`, zero dropped records, and an empty tag map. Each on-arm
manifest reported `enabled=true` and exactly one dropped record:

| Run | Enabled | Dropped | `s28-jittier` | Other tags |
| --- | :---: | ---: | ---: | ---: |
| block-01-run-2 | yes | 1 | 1 | 0 |
| block-01-run-3 | yes | 1 | 1 | 0 |
| block-02-run-1 | yes | 1 | 1 | 0 |
| block-02-run-4 | yes | 1 | 1 | 0 |
| **Total** |  | **4** | **4** | **0** |

The mechanism therefore activated, but it removed only one startup/JIT-tier
diagnostic per enabled run. There was no measured hot diagnostic stream for
this null-drain workload, so the block-to-block throughput spread is not a
credible filter benefit.

## Caveat and decision

The screen used `wgpurenderprobe=null-drain` to isolate producer/core cost.
Null-drain intentionally produces a blank canvas and performs no browser GPU
replay. These runs do not validate visible correctness, presentation FPS, or
end-to-end hardware-renderer throughput. They also cannot measure log traffic
that exists only during real replay.

Keep diagnostic suppression default-off and do not promote it from this
screen. If a future visible capture shows a materially larger, known-safe log
stream, remeasure it with a clean worktree and the same order-balanced fixed
scene; otherwise move profiling to a measured producer phase.

Raw artifacts are retained under
`.omx/wgpu-no-lag/diagnostic-quiet-screening-8797d56/`:

- `report.json`: `d3b1803d18672374e51e6ff913a4c9d3cf8b38bc3a98eb4007c63a9812bde8b5`
- `comparison.json`: `d78d8f299dd55f679b2a370b996a76b52e6478f08db201c32b2dc0a356828611`
- `runs.csv`: `de0b1d17c56f38bf4e5537efd3a161b1e06f9831867aaff986a8679344375600`
- `comparison.csv`: `ebc82b69295bb2e9c6b1a5f5db652a3012f40e45e96f54c638c7901dc3e50f08`

The machine-readable summary is
[`melee-wgpu-diagnostic-quiet-2026-07-12.json`](melee-wgpu-diagnostic-quiet-2026-07-12.json).
