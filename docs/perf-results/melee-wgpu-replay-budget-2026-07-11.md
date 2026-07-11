# Melee hardware-WGPU replay-budget screen (2026-07-11)

This screen tested whether a 4 ms worker replay budget could remove the long
hardware-WGPU stalls observed in the direct Kirby-versus-Link battle. It could
yield safely between render passes, but it could not interrupt the dominant
single `UPLOAD_BUFFER` operation. The replay budget remains default-off.

## Environment and design

| Field | Value |
| --- | --- |
| Commit | `99da24a` (clean) |
| Core | 12,876,498 bytes; SHA-256 `151b3bf6fc7b70839ecfc197c9aa8a64d2d27452cfe36300841d7b03b1de50c5` |
| Browser | Headed Chrome 150.0.7871.114 |
| CPU/GPU | AMD Ryzen 9 9950X3D; AMD `rdna-4` WebGPU adapter |
| Scene | Direct verified `__battle.sav` Kirby-versus-Link load |
| Work | Eight emulated seconds per run; 25-second wall cap |
| Design | Fixed 16K replay window versus `wgpureplayms=4`; balanced repeated screen |
| Raw output | `.omx/wgpu-no-lag/item-6-replay-4ms-clean/` |

Every run enabled geometry packing, the 32 MiB upload arena, GPU-completion
telemetry, exact input markers, WebGPU classification, and causal metrics. The
same 12 post-load input transitions were scheduled in every run.

## Result

| Measure | Fixed 16K | 4 ms | Interpretation |
| --- | ---: | ---: | --- |
| Median game speed | 65.56% | 66.56% | Descriptive only; all blocks failed fairness |
| Median core FPS | 39.36 | 39.93 | Same limitation |
| Median maximum drain | 1,729.27 ms | 1,750.16 ms | Long stall unchanged |
| Median GPU-completion p95 | 231.20 ms | 207.10 ms | Improved descriptively, not qualifying |
| Record-window hard-cap stops | 5–6/run | 0/run | Budget removed fixed-window stops |
| Budget yields | 0/run | 106–122/run | Safe-boundary yielding activated |
| Median audio underrun delta | 1 | 1 | No improvement |
| Exact 12-event input parity | 0/4 runs | 0/4 runs | No improvement |

The 4 ms runs had zero upload timeouts, batch aborts, command drops, WebGPU
errors, aborted/incomplete passes, or pass splits. Every run proved a nonzero
first indexed EFB mutation and a nonzero EFB-to-XFB-to-backbuffer chain.

The performance comparison is non-qualifying: both attempted blocks were
invalid because every run recorded at least one battle-window WebAudio underrun
and failed exact 12-event input propagation. These failures occurred in both
arms and are evidence of the existing long worker stall, not evidence that the
4 ms mode regressed correctness.

## Bottleneck classification

The maximum `UPLOAD_BUFFER` replay operation was approximately 1.70–1.77
seconds in every run. The WASM heap-to-local copy inside the same operation was
only 6.8–8.7 ms. Therefore the stall is in or below the synchronous
`GPUQueue.writeBuffer` portion of one indivisible replay record, not the outer
record traversal or heap copy.

A 6 ms budget cannot preempt the same indivisible operation, so a full 6 ms
screen was deferred. The next measurement is UBO co-occurrence and per-role
upload cost; the next optimization candidate is reducing or batching the large
buffer-upload stream. After that change, 4 ms and 6 ms should be compared again
to tune residual scheduling overhead.

## Decision and rollback

Keep the fixed replay path as the default. Retain `wgpureplayms=4|6` as
diagnostic, default-off modes. Do not claim a latency or throughput win from
this screen.
