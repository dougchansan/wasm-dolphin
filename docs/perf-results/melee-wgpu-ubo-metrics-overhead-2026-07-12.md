# Melee hardware-WGPU UBO telemetry overhead — 2026-07-12

This experiment measures the cost of detailed producer-side UBO telemetry that ordinary `metrics=1` previously enabled implicitly. The behavior change does not alter UBO contents, caching, upload order, or rendering. It only keeps per-draw clocks and atomic histograms off unless `wgpuubometrics=1` is explicit.

## Method

- Commit: `bca20256af44e4620599de70e66980701472d59f`
- Core: `14d458cd1a10334a79529c5555ed09c0af4b16d63bc1e25d851ef96a45886efc`, 12,913,696 bytes
- Machine: AMD Ryzen 9 9950X3D, AMD RDNA 4 GPU, Windows 10.0.26200
- Browser: headed Google Chrome 150.0.7871.114, cold ephemeral profiles
- Fixture: verified Kirby-vs-Link battle save loaded at time zero, no gameplay input
- Work: 12 emulated seconds per run
- Order: ABBA followed by BAAB
- Shared settings: hardware WGPU, mapped uploads, geometry packing, null-drain probe, JIT off, general metrics on
- Only changed flag: `wgpuubometrics=1` versus `wgpuubometrics=0`

The perf gate compared requested state with `producerUboCacheMetricsEnabled` on every run. Detailed-on runs recorded 553,581–563,138 timed UBO prepare calls. Detailed-off runs recorded zero calls, zero timing nanoseconds, and zero change-mask samples.

## Result

| Block | Detailed telemetry on | Detailed telemetry off | Relative gain from off |
| --- | ---: | ---: | ---: |
| ABBA | 70.0872% | 71.7833% | +2.4199% |
| BAAB | 70.9032% | 71.6247% | +1.0175% |

Both valid blocks favor the new default. Median effect is +1.7187%; the two-block bootstrap interval is +1.0175% to +2.4199%. Within-arm spread stayed below 0.86%.

This is a positive screening signal, not a promoted performance claim. With only two blocks, the permutation p-value is 0.5 and the statistical gate does not pass. The low-risk default-off refactor remains justified because detailed telemetry is diagnostic-only and the ordinary path retains general correctness, audio, GPU, and pacing metrics.

## Visible validation

The default-off path loaded the fixed state directly and rendered the Kirby-versus-Link battle correctly; all 31 sampled canvases were distinct. The short smoke averaged 67.12% game speed, 40.32 core FPS, and 33.24 presentation FPS. Audio was active in 88.31% of samples with zero underruns.

GPU completion recorded 74/74 completions and zero failures across 2,222 submissions. Completion latency averaged 44.39 ms, with p95 186.80 ms and max 1,945.95 ms. The very large completion tail remains an unresolved smoothness problem and reinforces that this small CPU-side win does not make hardware WGPU realtime.

Raw measurements are in [the companion JSON](./melee-wgpu-ubo-metrics-overhead-2026-07-12.json). Local artifacts are under `.omx/wgpu-no-lag/ubo-metrics-overhead-14d458c` and `.omx/wgpu-no-lag/visible-ubo-metrics-default-off-14d458c`.
