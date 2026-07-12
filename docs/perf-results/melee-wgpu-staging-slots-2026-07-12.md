# Melee hardware-WGPU staging-slot screen (2026-07-12)

## Decision

**REJECT. Keep the production layout at three 16 MiB mapped slots.** Changing
the same 48 MiB allocation to six 8 MiB slots reduced capacity-wait count and
the worst individual wait, but it did not materially reduce cumulative wait,
continuous-backlog duration, or fixed-work wall time. Mean game speed was
0.50% lower and one balanced block crossed the 2% paired-regression guard.

The next experiment should change when upload batches are sealed and submitted,
not add more remapping slots. Each arm sealed only one slot per batch on
average, and utilization remained 2.67% for three slots versus 5.29% for six.
This confirms premature drain-boundary sealing rather than total mapped memory
as the current lifecycle problem.

## Fixed campaign

- Scene: direct `__battle.sav` load into Kirby versus Link.
- Commit: `96e89bca614405f6b41d3d15b3b0b32e54642590` on
  `perf/wgpu-staging-slots-screen`.
- Core: 12,893,772 bytes, SHA-256
  `2576faf651de4dd6cd9677e2770c6285271e63ceb30e39489b978f9b43bab245`.
- Browser/GPU: headed Chrome 150.0.7871.114, AMD `rdna-4` adapter.
- Common mode: hardware WGPU, mapped uploads, geometry packing on, dense UBO
  and state/UBO caches off, JIT off, AudioWorklet audio, metrics,
  GPU-completion, and input telemetry on.
- Work: eight emulated core seconds with six spaced input events.
- Order: ABBA then BAAB; A is 3 × 16 MiB, B is 6 × 8 MiB.
- Result: eight of eight valid, two valid blocks, no replacements.

Every run used exactly 48 MiB of mapped staging memory. All runs had zero
oversized uploads, remap failures, unsafe-capacity events, timeouts, drops,
aborts, WebGPU errors, GPU-completion failures, and audio underruns. Input was
6/6, visible-frame changes were nonzero, and all runs were qualification
eligible.

## Results

| Metric | 3 × 16 MiB | 6 × 8 MiB | Six-slot change | Gate |
| --- | ---: | ---: | ---: | --- |
| Game speed | 70.811% | 70.460% | -0.495% | Fail: required +3% |
| Capacity-wait count | 67.0 | 47.0 | -29.85% | Descriptive |
| Capacity-wait total | 3,914.0 ms | 3,766.7 ms | -3.76% | Fail: required -20% |
| Capacity-wait max | 1,296.4 ms | 722.6 ms | -44.26% | Improvement |
| Continuous nonempty-backlog age max | 2,487.5 ms | 2,387.7 ms | -4.01% | Fail: required -15% |
| Remap latency total | 20,649.8 ms | 32,943.0 ms | +59.53% | Regression |
| Batches | 1,922.75 | 1,974.00 | +2.67% | Regression |
| Sealed slots per batch | 1.00 | 1.00 | tied | Root-cause evidence |
| Mapped-byte utilization | 2.667% | 5.286% | +98.20% | Still underfilled |

Block game-speed effects for six slots were -2.032% and +1.065%; their median
was -0.483%, with a two-block bootstrap interval of [-2.032%, +1.065%]. This
does not support a throughput improvement.

`backlogNonzeroAgeMaxMs` is reported here as the longest continuously nonempty
period, not oldest-command residence latency and not input latency.

## Evidence boundary

Raw ignored artifacts are under
`.omx/wgpu-no-lag/staging-slots-ab-2576faf/`.

- `report.json`: `11605597c9837bcb8ca0ebc08c4a60e1e8977d0fd25e87003daee71c4759d03d`
- `comparison.json`: `c6562520ec43dc0778f5f4b677f2a8fad6bbcf8a01a3d44744025b651b6aff9a`
- `comparison.csv`: `31fb42fcbac92bd2c89d8a105c5b401610ba04c9987c461a022f0f4ad329c215`
- `tasklist.json`: `2f0a8c3c751b9c29e78c06c0a747c93641d32304056809549b3e7f0431bfa481`
- `runs.csv`: `973cd712d9e8ccae0ec4bc6599775d2cfe4597f1c4d5102ef9138d967b5a0ce6`

Do not merge or enable the six-slot behavior based on this screen. Retain the
passive lifecycle telemetry and proceed to a default-off transaction-staging
branch that defers upload-only drain-boundary sealing to a safe pass, present,
readback, capacity, or fatal boundary.

