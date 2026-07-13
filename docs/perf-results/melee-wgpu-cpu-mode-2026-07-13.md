# Hardware-WGPU CPU-mode screen — 2026-07-13

## Decision

**Keep `cpu=dual`; reject `cpu=single` as a performance candidate.** A manual
ABBA block used the same direct-loaded Kirby-versus-Link battle and 12 emulated
seconds of work per run. Single-thread mode averaged 56.666% game speed versus
58.437% for dual-thread mode, a 3.03% relative regression.

## Fixed-work screen

- Machine: AMD Ryzen 9 9950X3D, 32 logical CPUs; AMD `rdna-4` WebGPU adapter.
- Browser: headed Chrome `150.0.7871.114`; automated audio muted.
- Core: 12,916,037 bytes; SHA-256
  `fe4448a07a726b67c9b7bd73f2515118b353414a66ac48cc4b1cdd92fb42f2c8`.
- CPU affinity: `0xFFFF`.
- Common mode: `video=wgpu`, WebGPU presenter, mapped staging, JIT off.
- Order: dual A1, single B1, single B2, dual A2.

| Run | CPU | Game speed | Core FPS | Wall time | Presentation FPS | Visible changes |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| A1 | Dual | 58.490% | 35.055 | 20.654 s | 24.636 | 21/22 |
| B1 | Single | 56.559% | 33.907 | 21.441 s | 23.739 | 22/23 |
| B2 | Single | 56.773% | 34.069 | 21.222 s | 24.043 | 22/23 |
| A2 | Dual | 58.384% | 35.017 | 20.561 s | 24.364 | 21/22 |

Single mode reduced upload-record count by 15.5% while moving essentially the
same bytes, but it increased queue submissions by 5.0%, mapped-capacity misses
by 21.7%, capacity-wait time by 51.3%, and producer upload-wait time by 92.9%.
Its lower backlog count therefore did not translate into lower backlog age or
better throughput.

## Evidence boundary

This is a screening rejection, not promotion evidence. Each run was valid,
reported no WebGPU error, command drop, batch abort, oversize event, upload
timeout, or presentation underrun, and changed 95.5–95.7% of readable canvas
samples. The reports remained non-qualifying because the experimental tree was
dirty. One ABBA block is not a confidence interval. Audio was muted; GPU
completion, input markers, and hardware visual-cadence FPS were not measured.
The legacy `visualFps=0` field is missing hardware-path instrumentation, not
evidence of a static image.

Raw ignored artifacts and report SHA-256 values:

- `.omx/wgpu-realtime-100/cpu-dual-a1` — `f7e25224f78c68c02e041a43bb158ba4bbe9c84eb1153a4a45385f83e7c4b261`
- `.omx/wgpu-realtime-100/cpu-single-b1` — `8d6b5e5b2276f0b16031bcd3d7328d5d4a79302d279a1428fb084bc44804d5b1`
- `.omx/wgpu-realtime-100/cpu-single-b2` — `d5c7447222af3b5013ebb19a6cb2aeb3093ad696bd0d39c6b26da7a85ca7f69c`
- `.omx/wgpu-realtime-100/cpu-dual-a2` — `0e4e381eeeb0e5c814d54d569cdf43a20798593f1bd29c06f37fec4f012ec674`
