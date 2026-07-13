# Melee hardware-WGPU guarded uniform comparison screen (2026-07-12)

This is a screening result for the default-off `wgpuuniformfast=1` experiment. It is not a promotion result and does not establish a performance improvement.

## Build and fixture

- Branch/commit: `perf/wgpu-tail-flush-gate` at `a694521db1080f5d15f6ca762af87d0a041cedc6`
- Candidate core SHA-256: `2796011f6616f6b280e2d7ffdebbee209517f362529e4500c9a5bd7f1cd98038`
- Candidate size: 12,914,126 bytes
- Melee ISO SHA-256: `1018b65a58ca654056be1611a43e753de5dd5f842ce5266581b29c6a12ce7c67`
- Save-state SHA-256: `620879e2ed3c35248deba9fb2f7b2a39f91f5374d2f6a98d2a2455cb55e156d1`
- Scene: direct Kirby-versus-Link battle load; no character-select automation and no gameplay input
- A/B mode: hardware WGPU null-drain, JIT off, 12 emulated core-seconds per run

## Throughput screen

| Block | Fast path off mean game speed | Fast path on mean game speed | Effect | Validity |
| --- | ---: | ---: | ---: | --- |
| 1 | 47.4705% | 48.2636% | +1.6705% | Valid |
| 2 | 47.7862% | 47.7377% | -0.1014% | Invalid: record-count-per-frame parity exceeded 0.5% |
| Replacement 1 | 48.0874% (two runs) | 48.0461% (one run) | Incomplete | Final run was interrupted by the outer command limit |

The positive first block did not repeat. The result is unresolved/neutral and must not be described as a speed win. The flag remains default-off.

## Visible diagnostic smoke

The correct hardware-WGPU visible harness loaded the same battle and captured 31 distinct canvas hashes from 31 samples. The final screenshot showed correctly colored Kirby-versus-Link gameplay with intact stage geometry and HUD.

This smoke deliberately enabled detailed UBO timing, so its throughput is diagnostic and is not directly comparable to ordinary `metrics=1` runs.

| Metric | Result |
| --- | ---: |
| Average game speed | 47.04% |
| Average core FPS | 28.28 |
| Average presentation FPS | 22.52 |
| Audio active samples | 89.86% |
| Uniform comparisons skipped (VS/PS/GS) | 160,020 / 100,692 / 80,453 |
| Uniform comparisons retained (VS/PS/GS) | 71,793 / 131,121 / 151,360 |
| Changed comparisons after a clean guard (VS/PS/GS) | 0 / 0 / 0 |
| WGPU backlog high-water | 56,667 records |
| WGPU backlog sampled p95 | 2,802 records |
| Maximum replay drain | 2,251.78 ms |
| Queue-write calls | 573,559 |
| Maximum queue-write duration | 2,244.405 ms |
| GPU completions | 56 / 56 sampled; 0 failures |
| GPU completion p95 / max | 89.65 / 2,501.445 ms |

The large command/upload count and tail stalls dominate the small comparison opportunity. The next optimization target is bounded upload/replay batching that reduces queue-write and command-record counts while preserving exact resource and pass ordering.

Raw local artifacts are under `.omx/wgpu-no-lag/uniform-fast-screen-2796011` and `.omx/wgpu-no-lag/uniform-fast-visible-detail-2796011-wgpu`.
