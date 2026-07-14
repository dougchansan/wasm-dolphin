# Melee visible hardware-WGPU upload closure (2026-07-12)

This campaign closes the corrected visible queue-versus-mapped evidence gap and screens dense UBO packing on direct queue transport. Neither mechanism qualifies for promotion or realtime claims.

## Identity

- Commit: `1986efc` on `perf/wgpu-tail-flush-gate`
- Core SHA-256: `2796011f6616f6b280e2d7ffdebbee209517f362529e4500c9a5bd7f1cd98038`
- Core size: 12,914,126 bytes
- Scene: verified Kirby-versus-Link save loaded at time zero
- Work: eight emulated core-seconds, JIT off, visible hardware WGPU, geometry packing on
- Fairness: AudioWorklet, GPU completion, and six post-load input-marker transitions

## Queue versus mapped

The harness attempted three ABBA replacement blocks (12 runs). Every block was invalid, so no paired effect or promotion statistic exists.

| Transport | Runs | Descriptive mean game speed | Range | Mechanism evidence | Fairness failure |
| --- | ---: | ---: | ---: | --- | --- |
| Queue | 6 | 52.905% | 49.550–54.657% | Mean 506,777 queue writes; maximum write 2,182.640 ms | Every run added 750–1,042 audio underruns; input dispatch max 513 ms |
| Mapped | 6 | 62.930% | 47.349–73.410% | Zero queue writes; maximum capacity wait 1,790.485 ms; maximum remap 2,317.770 ms | Input dispatch max 968 ms |

Mapped staging removes direct queue writes and avoided new timed audio underruns in these six runs, but it replaces the synchronous write tail with unstable capacity/remap waits. Its 26-point speed range is not a stable result. Both transports remain default-off/no-go for promotion.

## Dense UBO on queue transport

One visible activation smoke used `wgpuubopack=1` with queue transport. It reduced queue writes materially and preserved exact input-marker parity, but the multi-second queue stall and audio starvation remained.

| Metric | Dense UBO result |
| --- | ---: |
| Fixed-work game speed | 52.8177% |
| Fixed-work core FPS | 31.7092 |
| Total logical uploads | 347,914 |
| Queue writes | 347,593 |
| UBO uploads | 145,157 |
| Maximum queue write | 2,135.135 ms |
| Queue-write CPU total | 2,849.515 ms |
| Backlog high-water / sampled p95 | 51,830 / 2,741 records |
| Maximum drain | 2,138.285 ms |
| GPU completion p95 / max | 264.700 / 2,263.630 ms |
| Audio underruns / producer timer max gap | 866 / 2,233.615 ms |
| Input dispatch max / marker parity | 24 ms / pass |

Reducing write count by roughly one third did not improve the descriptive queue throughput and did not bound the worst call. This falsifies upload-call-count reduction as a sufficient route to realtime.

## Decision and next gate

Do not repeat mapped slot/arena tuning, giant queue transactions, upload-only renderer workers, replay budgets, geometry ranges, or additional uniform comparison flags without new evidence. Null-drain results independently cap the producer/core-video path near 75%, even when visible GPU replay is removed.

The next scoped experiment is a passive projection for immutable versioned render-pass packages. It must prove exact opcode/resource-generation/draw order and payload-byte reconstruction while projecting a large reduction in native ring publication and per-draw uniform/state preparation. No package runtime path should be implemented unless the passive falsification gate passes.

Raw local artifacts:

- `.omx/wgpu-no-lag/visible-queue-vs-mapped-2796011`
- `.omx/wgpu-no-lag/visible-queue-dense-ubo-2796011`
