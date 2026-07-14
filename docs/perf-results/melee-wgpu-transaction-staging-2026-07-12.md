# Melee hardware-WGPU transaction-staging screen (2026-07-12)

## Decision

**REJECT. Do not merge or enable `wgputransactionstaging=1`.** Deferring
upload-only drain submissions cut mapped batch count by 45.8% and cumulative
remap-completion latency by 20.6%, but it created larger critical-path bursts.
Game speed regressed in both balanced blocks, the worst capacity wait rose to
2.41 seconds, and mean GPU-completion p95 rose from 18.85 to 76.97 ms.

The result narrows the next design: reducing submission count alone is not
enough. A later transport must avoid both hundreds of thousands of direct
queue writes and large deferred mapped-buffer bursts. The next candidate is a
bounded batched queue-staging transport with one `queue.writeBuffer` per safe
transaction followed by ordered scatter copies.

## Safety fixes before measurement

Review found that a reset or state load could invalidate the mapped pool while
old `mapAsync` callbacks remained pending. Those stale callbacks could later
mark the new renderer epoch fatal. Commit `ee6261187d29936d2f52e5c93fc697100e9b883a`
generation-fenced success, rejection, and cleanup callbacks to their original
pool and promise set.

The perf gate also became explicitly fail-closed on replay fatal state, unsafe
in-pass capacity, remap failure, oversized upload, activation mismatch,
timeout, drop, abort, WebGPU error, and GPU-completion failure. A valid
eight-core-second activation smoke passed all those gates before the A/B.

## Fixed campaign

- Scene: direct `__battle.sav` load into Kirby versus Link.
- Commit: `ee6261187d29936d2f52e5c93fc697100e9b883a` on
  `perf/wgpu-transaction-staging`.
- Core: 12,893,772 bytes, SHA-256
  `2576faf651de4dd6cd9677e2770c6285271e63ceb30e39489b978f9b43bab245`.
- Browser/GPU: headed Chrome 150.0.7871.114, AMD `rdna-4` adapter.
- Common mode: hardware WGPU, mapped uploads, three 16 MiB staging slots,
  geometry packing on, dense UBO/state/UBO caches off, JIT off, AudioWorklet
  audio, metrics, GPU-completion, and input telemetry on.
- Work: eight emulated core seconds with six spaced input events.
- Order: ABBA then BAAB; A is current drain-boundary sealing, B defers
  upload-only drains until a pass, present, capacity, or explicit boundary.
- Result: eight of eight valid, two valid blocks, no replacements.

All runs had exact core identity, visible battle output, 6/6 inputs, zero audio
underruns, zero WebGPU/GPU-completion failures, and zero replay fatal, unsafe
capacity, remap failure, oversized upload, timeout, drop, or abort events.

## Results

| Metric | Current/off | Transaction/on | Change |
| --- | ---: | ---: | ---: |
| Game speed | 69.574% | 67.528% | -2.941% |
| Capacity-wait count | 271 | 230 | -15.13% |
| Capacity-wait total | 17,043.0 ms | 16,385.4 ms | -3.86% |
| Capacity-wait max | 1,632.4 ms | 2,412.1 ms | +47.77% |
| Mapped batches | 7,499 | 4,067 | -45.77% |
| Remap-completion latency total | 86,551.4 ms | 68,707.5 ms | -20.62% |
| Weighted slot utilization | 2.548% | 4.806% | +88.62% |
| Continuous nonempty-backlog age mean max | 2,679.2 ms | 2,590.8 ms | -3.30% |
| GPU-completion p95 mean | 18.85 ms | 76.97 ms | +308.43% |

Block game-speed effects were -2.547% and -3.328%; median effect was -2.938%
with a two-block bootstrap interval of [-3.328%, -2.547%]. Both blocks failed
the 2% paired-regression guard.

The enabled arm recorded 3,600 deferred upload-only drains, 1,570 forced
present flushes, and submission reasons of 1,574 presents, 2,699 atomic passes,
and 13 staging-capacity boundaries. Maximum retained state was 386.225 ms,
9,523,772 bytes, and 2,268 copy records.

`backlogNonzeroAgeMaxMs` remains the age of a continuously nonempty episode,
not oldest-command residence latency or input latency.

## Evidence boundary

Raw ignored artifacts are under
`.omx/wgpu-no-lag/transaction-staging-ab-2576faf/`.

- `report.json`: `47536942bdd2393299deaf6e021c9da34ecce110dd819eb4eaca5d151deae3e7`
- `comparison.json`: `6ec6556cafb4c246901114c933e52c75bb627c169a806fb8770c929030d47c86`
- `comparison.csv`: `0ab89682463f80a72e155592b64f054697ed37e0d8686effe1aa1046c1a7fc95`
- `runs.csv`: `4465d59de96c9361e2d549b480c99f0a050397adca1bafa7b545bf18363b35f9`
- `tasklist.json`: `9c8a08ddab73b2dea44c4d59a8031db0e47acf2dab1ce2e34d2bda55fb2cb883`

The earlier four-core-second smoke is not performance evidence: it failed only
because one input release dispatched 106 ms late. The replacement
eight-core-second smoke passed and established activation/correctness, but the
balanced campaign above is the decision evidence.

