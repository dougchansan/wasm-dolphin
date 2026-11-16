# Melee diagnostic gating — 2026-09-07

Making viewport diagnostics opt-in did **not produce a repeatable Melee FPS gain**. The balanced comparison measured 25.99 FPS before and 25.74 FPS after. The paired game-speed differences were +0.81% and −2.64%, so these measurements do not support a throughput improvement or establish a consistent regression. Melee remains around 43% game speed in this configuration.

| Arm, in execution order | Core FPS | Game speed | Wall seconds | Emulated seconds | New JIT compiles |
| --- | ---: | ---: | ---: | ---: | ---: |
| A1: original worker | 26.01 | 43.39% | 69.17 | 30.014 | 733 |
| B1: diagnostics gated | 26.21 | 43.74% | 68.61 | 30.011 | 997 |
| B2: diagnostics gated | 25.29 | 42.19% | 71.14 | 30.012 | 1009 |
| A2: original worker | 25.97 | 43.33% | 69.26 | 30.012 | 1001 |

## Change

`src/upstream-discio-worker.js` now collects expensive viewport diagnostics only when `wgpudeepdiag=1` or an explicit capture/render probe requests the necessary data. Ordinary replay skips diagnostic uniform and vertex scans, vertex/index snapshot copies, string formatting, map tallies, and optional shader/bind-group metadata. Frame-capture arguments are formatted only for an active capture frame.

Pipeline tracking, viewport/scissor restoration, backbuffer-source tracking, texture-sampling layout selection, reverse-depth behavior, and failure guards remain active. Debug modes retain their dependencies. Activation uses the current load's `efbDiag` request, preventing a stale previous mode from determining collection.

The change is retained to make diagnostic collection opt-in; it is not presented as a 60 FPS optimization. The next performance investigation should profile Melee's remaining CPU execution and scheduling costs on this exact build before choosing another change. The prior Mario Kart profile's diagnostic cost did not predict a Melee throughput gain.

## Measurement

- Same native core in every arm: `1b99a62abb8c74b9f3cd215b1feca69bac1901b5045ac69e8837238d85d35a13`. No native rebuild or rendering-algorithm change.
- Original worker: `fd4e7274d40e4d6fda491ce3f268fbb08da9cc3e6eb451a8b472c9362e85cf57`.
- Modified worker: `9eba675ef3c9765bb26b30dda4ed7ef9941bc506d1103403144b44ae60f881e3`.
- Each arm used a fresh headed Chrome profile, normal OS CPU placement, the same Melee Rev 2 save, guarded JIT, direct queue uploads, unchanged cache/geometry flags, tick pacing, visual readback, and unmuted AudioWorklet audio.
- Each arm settled through 20 emulated seconds and then measured another 30 emulated seconds. Core tick/frame deltas and worker monotonic timestamps determine throughput. Start/work boundaries are within 0.25% tolerance. Screenshots and GPU-completion fences were outside the timed window.
- Alternating A–B–B–A order reduces order bias. This is two pairs on one machine, with ongoing JIT compilation, not a fully warmed or statistically broad benchmark.

This fixed-work comparison differs from the earlier [60-wall-second benchmark](melee-current-build-2026-09-07.md). The measured portion of the battle is held approximately constant here so a faster arm cannot receive a different workload merely by reaching later gameplay.

## Verification

All four arms advanced the same saved battle, completed the GPU queue fence with an empty replay ring, and recorded no GPU errors, missing pipeline/bind-group draws, or guard-skipped draws. AudioWorklet remained active with a stable epoch and zero additional audio underrun frames/events during measurement. Startup/load underruns are outside that claim. Visual readback errors were zero; busy readback slots are sampling losses rather than dropped rendered frames.

Final before/after images show the same waterfront battle, characters, damage values, stage geometry, and HUD, with small differences in timer/animation phase. Separate 60-second Sunshine and Mario Kart Wii replay checks preserved the beach and race/pause scenes with zero recorded GPU errors. These are targeted rendering regressions, not full playthroughs or new driving benchmarks.

Six new executable tests cover disabled payload access/copying, enabled diagnostic collection, current-load probe activation, preservation of real bindings and presenter source, shader metadata gating, and inactive frame-capture formatting. Existing clear, depth-sampling, and mip tests also pass. The worker's ABI source fingerprint was refreshed after the full test run exposed the expected stale-source failures; affected provenance tests were rerun.

## Artifacts

[Machine-readable results](melee-diagnostic-gating-2026-09-07.json) include exact identities, per-arm metrics, and artifact hashes. Raw runs, frozen worker versions, screenshots, logs, comparison scripts, and game regression captures are retained locally under `.omx/melee-diag-gate/`. ROMs, saves, and screenshots remain outside version control.
