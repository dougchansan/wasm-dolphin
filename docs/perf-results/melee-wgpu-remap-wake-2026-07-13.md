# Hardware-WGPU remap-completion wake screen — 2026-07-13

## Decision

**Reject.** Preempting a delayed replay poll when a mapped staging slot remapped
did remove idle delay, but it also fragmented upload work into far more queue
submissions. Capacity and remap pressure increased, and fixed-work game speed
regressed.

## Fixed-work screen

- Scene: direct-loaded Kirby-versus-Link battle; 12 emulated seconds per run.
- Machine/browser: AMD Ryzen 9 9950X3D, AMD `rdna-4`, headed Chrome
  `150.0.7871.114`; automated audio muted.
- Core SHA-256:
  `fe4448a07a726b67c9b7bd73f2515118b353414a66ac48cc4b1cdd92fb42f2c8`.
- Common mode: `video=wgpu`, dual CPU, JIT off, mapped staging, `0xFFFF`
  affinity, visible output.
- Order: current scheduler A1, remap wake B1, remap wake B2, current scheduler A2.

| Run | Mode | Game speed | Preemptions | Queue submissions | Capacity wait | Visible changes |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| A1 | Current | 67.639% | 0 | 3,148 | 4,053.965 ms | 18/19 |
| B1 | Remap wake | 57.032% | 4,647 | 8,337 | 6,874.020 ms | 22/23 |
| B2 | Remap wake | 57.694% | 3,919 | 7,737 | 6,346.955 ms | 21/22 |
| A2 | Current | 59.274% | 0 | 3,709 | 3,713.240 ms | 21/22 |

The candidate reported 12.46–14.85 seconds of nominal delayed-poll time
avoided, but this is overlapping scheduled delay rather than additive wall
time. Immediate wakeups reduced natural batching: submissions more than doubled
against the comparable closing control, cumulative remap latency grew from
28.23 seconds to 38.51–39.78 seconds, and capacity wait grew 71–85%. Candidate
game speed was 2.66–3.78% below the closing control. The 67.64% opening control
is another run-order outlier and is not used to rescue the candidate.

All runs were valid, visibly changing, and recorded zero WebGPU errors. The
mechanism was active in both candidate runs, so the rejection is not caused by
a dead flag. The candidate remains isolated on `perf/wgpu-remap-wake` and is
not carried into later optimization branches.

Raw ignored artifacts and report SHA-256 values:

- `.omx/wgpu-realtime-100/remap-wake-a1` — `70d43e68b06de5031f0e1cb2cd238bd9e7d083f4848e58f7a923463d3bfc44a8`
- `.omx/wgpu-realtime-100/remap-wake-b1` — `631a43d3bafa77e7493ee68b1c6d123334ea87a7f2e8fe626b86a74d7198cb2f`
- `.omx/wgpu-realtime-100/remap-wake-b2` — `ffb2bc8433672c29da78b4d6399f9360aa7ed88d1ec6c9471e678928326a810f`
- `.omx/wgpu-realtime-100/remap-wake-a2` — `6d780c821a37ff84b34cff8c1d1282f566b251048cb4bd83843397a403be1e83`
