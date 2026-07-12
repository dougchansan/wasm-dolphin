# Hardware-WGPU idle FIFO-tail gate — 2026-07-12

This headed Chrome screen tested whether eliding state-proven no-op
`Flush()`/peek-cache-refresh work at the tail of the WebGPU FIFO path improves
fixed-work throughput. The experiment was default-off, used the verified
Kirby-versus-Link battle save directly, and compared `wgputailgate=0` with
`wgputailgate=1` in ABBA and BAAB blocks.

## Identity and method

- Harness commit: `421376307857c8fff5ea28cb771bfdbef236dcd2`
- Candidate source commit: `648d6e3dc01365e0cec0618387f7bd245d5a77fe`
- Candidate WASM SHA-256: `8797d56029dcc540c5cae88b7d219712f76c63a00f884ec9aa25f64c90f90ff2`
  (12,909,641 bytes)
- Patch-series SHA-256: `cd3b918cd2d50d626d8d3caafc8556d29a335333a1496af11eb23a69ab655e93`
- Patched vendor tree: `10d0fdabc493a1c016abcb3d88fd20c81e5ea9a7`
- Browser: headed Chrome `150.0.7871.114`
- Machine: AMD Ryzen 9 9950X3D, 32 logical CPUs; AMD `rdna-4` WebGPU adapter
- Scene: direct verified Kirby-versus-Link save-state load
- Work: 12 emulated core seconds per run; two four-run blocks
- Primary metric: fixed-emulated-work game-speed throughput; higher is better
- Predeclared screening threshold: at least `+1%`

Both blocks were valid and qualification-eligible. The largest semantic-work
divergence was `0.115%` for core ticks and `0.139%` for frames, within the
predeclared `0.25%` bounds.

## Throughput result

| Block/order | Gate-off mean | Gate-on mean | Relative effect |
| --- | ---: | ---: | ---: |
| 1 / ABBA | 76.6898% | 76.4753% | -0.2797% |
| 2 / BAAB | 76.5647% | 76.8222% | +0.3364% |

The median block effect was `+0.0283%`; the bootstrap interval was
`[-0.2797%, +0.3364%]`. This did not meet the `+1%` screening threshold, so
the exact outcome is **`SCREENING_REJECT`**. The experiment is not promotable
and `wgputailgate` remains default-off.

## Activation evidence

The off arm reported epoch zero and zero counters in all four runs. Each on
run reported schema version 1, epoch 1, period 256, and no dirty-state skip:

| Run | Payload samples | Flush needed | Refresh needed | Both clean | Dirty at skip |
| --- | ---: | ---: | ---: | ---: | ---: |
| block-01-run-2 | 1,552,114 | 999 | 0 | 1,551,115 | 0 |
| block-01-run-3 | 1,536,215 | 966 | 0 | 1,535,249 | 0 |
| block-02-run-1 | 1,518,478 | 972 | 0 | 1,517,506 | 0 |
| block-02-run-4 | 1,515,491 | 968 | 0 | 1,514,523 | 0 |
| **Total** | **6,122,298** | **3,905** | **0** | **6,118,393** | **0** |

Thus `99.9362%` of sampled payload states were both clean. That proves the
target calls were overwhelmingly state-proven no-ops, but the balanced screen
shows that removing them did not materially improve fixed-work throughput.
The high no-op ratio alone is not evidence of a useful optimization.

## Caveat and decision

The screen used `wgpurenderprobe=null-drain` to isolate producer/core cost.
Null-drain intentionally produces a blank canvas and performs no browser GPU
replay, so this package does **not** establish visible correctness,
presentation FPS, or end-to-end renderer throughput for the enabled arm. A
separate no-probe run already provides visible baseline evidence, but a new
visible confirmation was not warranted for this rejected change.

Keep the exact legacy path as the default, do not promote the gate, and move
profiling to the next measured producer phase rather than further optimizing
this tail call site.

Raw artifacts are retained under
`.omx/wgpu-no-lag/tail-gate-screening-8797d56/`:

- `report.json`: `4a3edd6b3a8481d704faa4558a2ffad37964de01e8aae2ae4aa06d4d98aada2a`
- `comparison.json`: `4fdbd4f9f473ddeb32f908d51b773b301623bf5bb2b1c009b196719cb5134a6f`
- `runs.csv`: `330ddb7b4b4d5bdc691a23e1d9bbff84416304baf8ce69948810f2a1994661ff`
- `comparison.csv`: `272dac10bf9f3621dee5542645038d48631e4fcda2edf66055b7e98bc406512e`

The machine-readable summary is
[`melee-wgpu-tail-gate-2026-07-12.json`](melee-wgpu-tail-gate-2026-07-12.json).
