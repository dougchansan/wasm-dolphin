# Melee current-build WebGPU benchmark — 2026-09-07

The current renderer measured **26.59 core FPS**, **26.49 sampled distinct-image FPS**, and **44.37% game speed** across two measured runs. Each run followed 45 seconds of settling and lasted at least 60 wall seconds.

| Measure | Run 2 | Run 3 |
| --- | ---: | ---: |
| Measured wall seconds | 60.56 | 60.62 |
| Core FPS | 25.76 | 27.42 |
| Game speed % | 42.97 | 45.76 |
| Submitted presentations/s (approx.) | 25.63 | 27.48 |
| Sampled distinct-image FPS (approx.) | 25.54 | 27.43 |
| HUD p95 cadence metric, mean | 19.33 | 21.05 |
| New JIT compiles | 873.00 | 854.00 |
| Visual readback samples skipped while busy | 5.00 | 3.00 |
| Audio underrun events during measurement | 0.00 | 0.00 |
| Recorded GPU errors | 0.00 | 0.00 |

## Configuration

- Core SHA-256: `1b99a62abb8c74b9f3cd215b1feca69bac1901b5045ac69e8837238d85d35a13`. The current core includes the Mario Kart and Sunshine renderer fixes. Source/core provenance verification passed.
- AMD Ryzen 9 9950X3D 16-Core Processor, 32 logical CPUs, AMD RDNA 4 adapter (installed RX 9070 XT), Chrome 143.0.7499.4, headed, Windows.
- Melee USA Rev 2, direct-loaded Kirby versus Link battle on the waterfront stage. No scripted input during the measurement.
- Fresh browser per repeat, normal OS CPU placement, guarded WASM JIT, tick pacing, speed 1, CPU overclock 1, optional causal metrics/deep diagnostics off, visual readback on, unmuted AudioWorklet audio.
- Existing renderer upload and geometry defaults; no special CPU affinity, trained persistent browser profile, or experimental queue/geometry flags.

```text
http://127.0.0.1:8081/?core=upstream&video=wgpu&presenter=webgpu&cpu=dual&speed=1&wasmjit=1&jittier=guarded&jitwarmup=60&pacing=tick&present=full&queue=4&oc=1&metrics=0&wgpudeepdiag=0&corelog=0&mainprof=0&wgpuvisual=1&audiotransport=worklet
```

## Verification and interpretation

Both completed runs used the pinned current core, kept the same loaded-state generation, advanced core frames/ticks, and ended with a paused core, empty replay ring, and a completed GPU queue fence. Before/after screenshots were visually inspected: Kirby, Link, the waterfront stage, textures, water, timer and HUD render, and the timer, damage and character positions advance. Draw counters recorded no missing pipelines, missing bind groups, or guard-skipped draws.

AudioWorklet remained active and its epoch stayed stable. PCM consumption advanced, with zero additional underrun frames/events during each timed interval. Startup/load underruns occurred before the measured windows; this does not certify flawless audio throughout startup or subjective audio quality.

Core FPS uses fresh core frame-counter deltas divided by the worker monotonic elapsed time. Game speed uses core tick deltas divided by ticks per second and elapsed time. Presentation and visual endpoint counters are taken from the latest frame telemetry, so their rates are approximate. Distinct-image FPS counts changed hashes from 96×72 GPU readbacks; skipped readback samples are not dropped rendered frames. The HUD FPS value includes a p95 frame-interval cap and should not be read as presentation throughput.

Compilation continued after settling. This is a current-build gameplay measurement with ongoing compilation, not a fully warmed steady-state benchmark. No screenshots, CPU profiles, or GPU fence pauses occurred inside the timed windows.

The earlier near-60 FPS result used an older experimental build with CPU placement/cache/upload tuning. This run does not reproduce that configuration and cannot isolate a regression from the recent correctness fixes.

An initial pilot used the wrong harness property name for successful quiescence and was excluded. Its GPU fence had actually completed. The corrected harness then completed both reported runs.

## Artifacts

Machine-readable results and raw artifact hashes are in [the companion JSON](melee-current-build-2026-09-07.json). Local raw samples, console logs, screenshots, harness source, and the excluded pilot are under `.omx/melee-benchmark-20260907/`. ROMs, saves, browser data, and screenshots remain outside version control. No renderer code was changed for this benchmark.
