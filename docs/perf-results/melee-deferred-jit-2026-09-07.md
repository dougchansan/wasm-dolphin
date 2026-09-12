# Melee deferred-JIT experiment — 2026-09-07

The rebuilt production core reached **29.73–30.51 FPS** in the fixed battle, versus **23.40–26.17 FPS** for the previous production core. The two paired improvements were **16.61% and 27.08%**. Mean throughput increased from 24.783 to 30.123 FPS (+21.55%). This is approximately **50% emulation speed**, not 60-FPS gameplay or completion of the all-games goal.

These corrected runs use normal Windows CPU scheduling, the same worker with pause/load timing fixed, 20 emulated seconds of warmup and 30 measured emulated seconds. JIT stays on at the intentional measurement boundary and in every measured sample. All four input-update counters remain zero; GPU completion fences and screenshot inspection pass, with zero measured audio underrun events or frames.

| Corrected production order | Core FPS | Emulation speed | Distinct sampled images/s |
| --- | ---: | ---: | ---: |
| Previous A1 | 26.168 | 43.65% | 25.994 |
| Rebuilt B1 | 30.514 | 50.93% | 30.140 |
| Rebuilt B2 | 29.733 | 49.63% | 29.435 |
| Previous A2 | 23.398 | 39.05% | 23.189 |

[Machine-readable results](melee-deferred-jit-2026-09-07.json) include exact build identities, counters, paired calculations and limits. Compilation continues during these windows, so they measure performance after the stated warmup, not a fully warmed steady state. Two pairs on one scene do not establish a confidence interval or performance across the library.

## Excluded preliminary comparison

The initial input-isolated comparisons improved core throughput by **13.25% and 9.70%**, but subsequent review found that the measurement pause triggered the JIT guard's cooldown. These results describe that interrupted workload and **are not accepted as steady gameplay performance**. A corrected comparison is pending; the all-games goal remains active.

| Execution order | Core FPS | Emulation speed | Distinct sampled images/s |
| --- | ---: | ---: | ---: |
| Control A1 | 31.605 | 52.75% | 31.500 |
| Candidate B1 | 35.791 | 59.71% | 35.413 |
| Candidate B2 | 32.786 | 54.72% | 32.549 |
| Control A2 | 29.886 | 49.89% | 29.820 |

The mean of the two control runs was 30.746 FPS; the candidate mean was 34.289 FPS. Two pairs do not establish a confidence interval or a sustained-play guarantee.

## Change under test

Blocks rejected by the JIT's per-slice compilation budget previously remained cached as native fallbacks. The candidate retries them by invalidating at most eight pending blocks between CPU slices. Requests distinguish the address, CPU feature flags, and current callback entry; recompilation cancels obsolete requests. Cache clearing and shutdown remove pending requests.

JIT requests now use an atomic requested policy. The owning CPU applies it between callbacks and clears the old code cache. Disabling the original build left 559,581 and 552,556 compiled callbacks executing during its roughly 30-frame off probes. The candidate executed zero during both off probes and resumed compiled execution after enabling. Policy probes run after the performance window.

Three native regressions compile the actual proposed queue/retry helper, policy functions, and getter cache logic. All passed without skips, covering replacement and cancellation, bounded storage and draining, CPU ownership, cache clearing, and tier text refresh with unchanged counters.

## Conditions and validity

- Control core: `6e207b7152b6f7e2a4704a5cd8c621a917605162aef1f90822b92ac518852262`.
- Candidate core: `f0fd77ca7cad9b9adf8440cedb8b39db63bc6f928140d4ed23a409d1b26e21f6`.
- Base worker: `9eba675ef3c9765bb26b30dda4ed7ef9941bc506d1103403144b44ae60f881e3`; policy-probe worker: `6b564ed53b193e61bf3d2cfa5d92dd546eeb97db5199ed6c6da359a0b85fc0b5`.
- Fresh headed Chrome 143.0.7499.4 per run; Ryzen 9 9950X3D, Radeon RX 9070 XT, Windows. Both arms pin only their benchmark Chrome process families to `0x5555`, verified against this machine's topology and running process masks.
- The same battle state, 20 emulated seconds of warmup and 30 measured emulated seconds; normal emulated clock, full presentation, guarded JIT, diagnostics off, audible worklet audio.
- Primary FPS is native frame-counter delta divided by worker wall time. Distinct-image sampling is a separate 96×72 readback metric; neither HUD smoothing nor a menu counter substitutes for gameplay.
- Physical gamepads and trusted keyboard/pointer input are isolated. Native input-update counts stayed zero throughout all four measurements.
- Every before/final image was inspected: the same battle continued from approximately 4:42 to 4:12 with textured stage, fighters and HUD. GPU completion fences passed. Measured audio underrun-event and underrun-frame deltas were zero.

Compilation still occurred in the observation window. Longer gameplay, additional titles, normal CPU placement and a production rebuild require separate validation. These isolated cores are not the shipping build.

The preexisting worker status formatter referenced an undefined `baseline` after the JIT guard's disable bookkeeping. This was observed in these runs and fixed with four passing VM regressions; the empty fatal-error arrays must not be read as proof that no status error occurred.

Review then identified a separate guard defect: the intentional warm-boundary pause lasted 1.64–2.27 seconds while JIT liveness monitoring kept running. This triggered a 300-frame cooldown at, or immediately after, the paused frame. A1/B2/A2 re-engaged exactly 300 frames after their held frame. The candidate's corrected native disable behavior makes this pause-induced cooldown materially different from the original build. Pause/load timing must be corrected and the comparison repeated before claiming steady-state improvement. No checkpoint frame-counter jump was observed in these runs.

An earlier candidate result of 55.884 FPS is **excluded**: its native input count changed from 50 to 122 and the battle exited to a memory-card menu. It is not evidence of near-60-FPS gameplay.

## Local evidence

Untracked reproduction builds, runtime logs and private game captures remain under `.omx/full-speed/deferred-jit-v2/`. The four accepted scene runs and compact comparison are in `bench-isolated/`. No game data or screenshots belong in source commits.

## Production build and corrected validation

Snapshot `0065-jit-retry-deferred-blocks-and-apply-policy.patch` records the tested native changes and new `WasmDeferredCompileQueue.h`. A full optimized rebuild produced core `7479b6c803ff1d19e4c03b3654c69e4fe95a6a4367b411ba11769c65730b112c` (12,956,039 bytes). The corrected worker is `8e684849113319a589d8ed79bb45ea6d4f770cf5cb95fb569bc59eb0ebde21d8`.

The worker suspends JIT enable/fuse evaluation during accepted native pauses and load operations. Resume resets rolling and stall timing; accepted loads invalidate the prior scene baseline. JIT mode, thresholds, cooldown, replay resources and lifetime counters are preserved. Thirteen VM regressions pass, including a pause exceeding five seconds, rejected/throwing operations, and genuine running stalls.

The full 902-test run passed 901 tests; its sole failure was the source-path count increasing from 110 to 111 for the new header. After updating that expectation, all 11 tests in the affected provenance suite passed. Syntax checking and provenance verification passed. ABI and source manifests were refreshed for the new build.

The corrected runtime comparison uses the previous production core `1b99a62abb8c74b9f3cd215b1feca69bac1901b5045ac69e8837238d85d35a13`, the rebuilt production core, and the same corrected worker for both arms. It uses normal operating-system CPU scheduling, isolated input, and rejects any measurement that changes JIT mode. All four runs passed under `bench-pause-fixed/`; the earlier affinity-pinned results are not substituted for them.
