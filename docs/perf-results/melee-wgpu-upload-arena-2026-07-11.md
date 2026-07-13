# Melee hardware-WGPU upload-arena screen (2026-07-11)

This balanced screen compared the default 32 MiB producer upload arena with an
opt-in 64 MiB arena after geometry packing. The 64 MiB arm provided more
headroom but regressed throughput and exposed the unchanged consumer staging
limit. The default remains 32 MiB.

## Environment and design

| Field | Value |
| --- | --- |
| Commit | `67fdd21` (clean) |
| Core | 12,876,498 bytes; SHA-256 `151b3bf6fc7b70839ecfc197c9aa8a64d2d27452cfe36300841d7b03b1de50c5` |
| Browser | Headed Chrome 150.0.7871.114 |
| CPU/GPU | AMD Ryzen 9 9950X3D; AMD `rdna-4` WebGPU adapter |
| Scene | Direct verified Kirby-versus-Link save-state load |
| Design | Two balanced eight-emulated-second blocks: ABBA, then BAAB |

Both arms used `video=wgpu`, `presenter=webgpu`, `wgpugeompack=1`,
`gpucomplete=1`, `metrics=1`, and the same 32 MiB held-upload staging cap. The
only treatment was `wgpuuploadmb=32` versus `wgpuuploadmb=64`.

Requested, configured, and ring-handoff byte counts matched in every run.
There were no allocation fallbacks, late configuration rejects, or handoff
mismatches.

## Result

| Measure | 32 MiB | 64 MiB | Interpretation |
| --- | ---: | ---: | --- |
| Mean game speed | 71.28% | 70.13% | 64 MiB was slower |
| Mean core FPS | 42.68 | 42.01 | Same direction |
| Mean physical wraps | 34.75 | 18.00 | Expected capacity benefit |
| Mean inflight high-water | 33,548,422 B | 56,660,579 B | ~100.0% versus ~84.4% of capacity |
| Mean replay-backlog high-water | 56,116.5 records | 94,719 records | 64 MiB increased peak queued work by 68.8% |
| Post-load upload timeouts | 1 | 0 | More headroom avoided one timeout |
| Batch aborts | 1 | 0 | Tracks the timeout |
| Held-stage limit hits | 0 | 8 total | Two in every 64 MiB run |
| Median GPU-completion p95 | 186.17 ms | 239.21 ms | Worse and still highly variable |
| Audio underruns | 0 | 0 | No observed underruns |

Block effects were `-2.7376%` and `-0.5091%`. The median effect was
`-1.6234%` with bootstrap 95% interval `[-2.7376%, -0.5091%]`. The statistical
gate rejected the 64 MiB arm.

The corrected classifier confirmed the first indexed EFB pass mutation and
the nonzero EFB-to-XFB-to-backbuffer chain. The strict validator rejected one
32 MiB run for a timeout/abort and all four 64 MiB runs for held-stage limit
hits.

## Decision and rollback

Keep 32 MiB as the default. `wgpuuploadmb=64` remains a diagnostic capacity
option, not a performance optimization. Although it reduced arena wraps and
avoided one upload timeout, it allowed 68.8% more replay backlog to accumulate
at peak, slowed throughput, and worsened GPU-completion latency. A future
experiment may examine the consumer staging policy independently, but it must
not bundle that change with arena capacity.

Long replay drains and audio mix round trips remained roughly 1.7–1.9 seconds;
capacity did not address the primary lag mechanism.
