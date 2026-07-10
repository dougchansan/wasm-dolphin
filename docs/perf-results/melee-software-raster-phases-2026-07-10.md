# Melee software-raster phase evidence — 2026-07-10

This is repeated diagnostic evidence for the metrics-gated software-raster
profile. Every run directly loaded the exact Kirby-versus-Link save with no
gameplay input; none navigated menus or stopped at character select. The
machine-readable record is
[`melee-software-raster-phases-2026-07-10.json`](melee-software-raster-phases-2026-07-10.json).

## Reproducible candidate

Two independent builds produced identical 12,815,061-byte WASM files with
SHA-256 `158dde37602442bf1dacf42328501082b46b47768b2455946fcb4c596fcdb5ea`
and identical 261,635-byte raw JS files with SHA-256
`fdd00c8147afa6f23ce5caa022762d797175cf5123b5148dfbc8f60bbba3c74d`.
Code and data sections also matched. The frozen patch series is
`05fc8908…d9dde0`; the vendor result tree is `3cc63e7a…43b91`.

The runs used headed Chrome `143.0.7499.4` on the Ryzen 9 9950X3D / AMD
`rdna-4` validation machine. Common flags were:

```text
core=upstream&video=software&presenter=webgpu&cpu=dual&speed=1&pacing=tick&wasmjit=0&fastsw=1
```

## Metrics-overhead A/B

Three 20-second pairs used balanced order: off/on, on/off, off/on. Screenshots
were disabled. The pair values are fixed-scene post-warmup means.

| Pair | Metrics | Game speed % | Core FPS | Presentation FPS | Unique visual FPS | Health note |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| 1 | Off | 98.59 | 59.06 | 58.76 | 12.59 | Passed |
| 1 | On | 103.06 | 61.88 | 59.24 | 12.41 | Passed |
| 2 | On | 101.29 | 60.71 | 59.71 | 13.24 | Timed window passed; pre-window boot exceeded 5 s |
| 2 | Off | 100.06 | 60.00 | 58.59 | 13.35 | Timed window passed; pre-window boot exceeded 5 s |
| 3 | Off | 101.06 | 60.82 | 59.71 | 12.41 | Timed window passed; pre-window boot exceeded 5 s |
| 3 | On | 98.88 | 59.29 | 60.06 | 12.65 | Passed |
| Off mean | — | 99.903 | 59.960 | 59.020 | 12.783 | Three runs |
| On mean | — | 101.077 | 60.627 | 59.670 | 12.767 | Three runs |

Paired game-speed differences (`on - off`) were `+4.47`, `+1.23`, and
`-2.18` percentage points. The sign changes, and metrics-on is descriptively
faster by 1.17 points on average. Therefore no profiler slowdown is resolved
above run-to-run variation. Three pairs and three pre-window boot-check
failures do not establish a statistical no-regression claim.

Raw output is under `.omx/next/software-raster-metrics-ab/`.

## Phase classification

Across the three metrics-on runs:

| Signal | Mean | Range/meaning |
| --- | ---: | --- |
| Sampled stale-source ratio | 78.26% | 77.80–79.13% |
| Raster traversal sampled call | 5.774 µs | 5.761–5.790 µs |
| TEV sampled call | 0.462 µs | Inclusive of nested texture work |
| Texture sampled call | 0.421 µs | 0.403–0.439 µs |
| Actual EFB→XFB encode | 805.3 µs | 801.8–807.9 µs |
| Candidate pixels/source frame | 86,962 | Stable across the three runs |
| TEV pixels/source frame | 65,438 | Stable across the three runs |
| Texture samples/source frame | 51,241 | Stable across the three runs |
| FIFO distance underflows | 0 | All runs |

The strongest current software-path evidence remains stale source production:
roughly 78% of sampled source observations reused an unchanged frame while the
presenter stayed near 60 FPS. Pixel work is also large and stable per source
frame. The deterministic timing samples are not extrapolated into additive
phase totals, and TEV timing includes texture work, so those rows must not be
summed into a fabricated frame-time breakdown.

The FIFO maximum of 1.86–2.45 seconds means the consumer observed a continuously
non-empty backlog for that long. It is not individual-command residence time.
The canonical JSON fields are `fifoConsumerObservedBacklogAge*`; legacy
`fifoOldestPendingAge*` aliases remain for schema compatibility.

## Activation-only smoke

An earlier headed smoke under `.omx/next/software-raster-phase-final-smoke`
proved all requested counters activate and reconcile: 9,903,553 traversal
calls, 305,614,849 TEV pixels, 246,792,193 texture samples, 1,141 actual XFB
encodes, 4,910 XFB publications, and zero FIFO distance underflows. Its 4,912
sampled sources split exactly into 997 unique plus 3,915 stale frames.

That run overlapped the independent clean build and stretched a configured
20-second window to roughly 101 seconds. It is activation evidence only and
contributes no performance result.
