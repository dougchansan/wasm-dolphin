# Melee hardware-WGPU realtime campaign — 2026-07-13

This is an in-progress evidence log, not a realtime/full-speed claim. All
automated runs load the direct Kirby-versus-Link save, use muted audio, and
measure fixed emulated work. The exact scene signature is core ticks
`15166162443`, PPC PC `-2144030364`, XFB hash `6fd97dc5`, `640x480`.

## Current classification

The current hardware path has both CPU and renderer overhead. Frozen-profile
FastBranch runs averaged about 82.28% with browser replay replaced by
`null-drain`, but only 71.74% with visible WGPU replay on the same affinity.
Moving Chrome from affinity `0x5555` to the full V-cache CCD (`0xFFFF`) raised
the two-run visible mean to 75.41%. This is not 100% game speed.

## Completed screens

| Screen | Baseline | Candidate | Result |
| --- | ---: | ---: | --- |
| FastBranch, visible | 71.290% off | 71.739% on | +0.63%; within visible variance |
| FastBranch, null-drain | 80.385% off | 82.284% on | +2.36%; modest CPU-only candidate retained |
| Replay timing clocks | 75.405% exact timing control | about 75.0% sampled timing | Throughput-neutral; exact op counts retained with 1/32 timing samples |
| Mapped `wgpustagefast` BAAB | 78.187% off | 76.674% on | −1.94%; rejected |
| JIT fallback map, null-drain | 86.439% (16 bit) | 91.109% (18 bit) | +5.40%; CPU-path win |
| JIT fallback map, visible | 79.479% (16 bit) | 79.480% (18 bit) | Renderer-masked; keep default-off |
| Upload-run ingest, flat-store control | 79.499% off | 79.470% on | Throughput-neutral; reject behavior path |
| Equal-only sparse UBO | 79.395% off | 79.933% on | +0.68%; within variance and almost no bytes avoided |
| MessageChannel replay wake, A/B/B/A | 69.978% timer | 66.374% fast wake | -5.15%; rejected |
| Mapped-stage timing sampling, eight runs | 71.965% exact | 72.527% stride 64 | +0.78%; small screening result, not promoted |
| Global metrics overhead, eight runs | 73.778% sampled | 74.113% off | +0.46%; within run variance |

Every listed run used the exact scene signature and reported zero WGPU replay
errors and dropped commands. These are screening means, not confidence-bounded
release estimates.

## JIT fallback-map measurement

A diagnostics-only 16-bit map build recorded:

| Counter | Value |
| --- | ---: |
| Direct hits | 338,317,077 |
| Empty misses | 41,609 |
| Collision misses | 1,338,784 |
| Slow lookup found | 1,334,310 |
| Slow lookup missing | 46,083 |

That is 339,697,470 classified dispatches and 1,380,393 slow lookups: about
0.394% collision misses and 0.406% total slow lookups. The rate is measurable
but cannot explain the full deficit. The 18-bit arm reduced mean collision
misses from 1,325,289 to 284,939 (−78.5%) and raised null-drain throughput by
5.40%. Visible throughput was unchanged, so the shipped/default size remains
16 bits while renderer work continues.

## Upload-run projection

Passive observation of one valid visible run found:

| Metric | Value |
| --- | ---: |
| Logical/eligible buffer uploads | 1,035,052 / 1,035,052 |
| Contiguous source runs | 50,223 |
| Projected mapped `.set` calls | 50,223 |
| Projected `.set` reduction | 984,829 (95.1%) |
| Logical payload | 1,569,432,708 bytes |
| Envelope gap | 1,363,980 bytes (0.087%) |
| Source-arena wrap splits | 43 |
| Fallbacks / ownership hazards | 0 / 0 |

The observer changed no replay behavior. These numbers justify a default-off,
test-first upload-run ingest candidate which preserves every logical GPU copy,
destination, order, seal, and submission.

The behavior screen later reduced mean upload-handler accounting from about
2.278 seconds to 0.168 seconds and mean total drain accounting from 2.821
seconds to 1.672 seconds. Against the same flat record store, however, fixed-
work speed was unchanged (79.499% off, 79.470% on). The bytes, GPU copy
commands, submissions, and backlog were not reduced. The behavior path is
therefore rejected as a realtime optimization; call-count reduction alone was
not sufficient.

## Sparse UBO follow-up

The existing `wgpuubosparse=1` path was found to be equal-only in current code:
`maxSparseRanges=0`. In the current screen it classified 282,924 eligible UBO
uploads, but 282,903 fell back to full staging, 12 were equal, and none used a
changed-range sparse plan. The balanced mean was only +0.68%, within observed
variance, and just 8,864 bytes were avoided. A separate default-off 4/8-range
selector is required before the measured 5.18% dirty-coverage opportunity is
actually tested.

## Ordered compute UBO reconstruction

The passive ordered-UBO projection classified 279,695 eligible uploads with
no malformed or unclassified records. It projected a reduction from
818,096,536 logical bytes to 72,672,000 package bytes (91.12%), and from
279,695 legacy copies to 2,889 package copies plus 2,889 compute dispatches
(97.93% fewer copy/dispatch commands than legacy copies).

An experimental `wgpuubocompute=1` behavior path was then implemented behind
an explicit producer UBO-ring role. It reconstructs VS, PS, and GS constants
in order on the GPU and remains default-off. The first valid paired visible
screen on candidate core
`1373f77f3b4606b9910f1dbbdff0749911f6b77bdec58a8233fcc94e24718cb8`
was neutral:

| Arm | Game speed | Visible changes | Presentation FPS |
| --- | ---: | ---: | ---: |
| Legacy mapped uploads | 75.081% | 16/17 readable samples | 29.47 |
| Compute reconstruction | 75.032% | 16/17 readable samples | 29.53 |

The compute arm encoded 284,891 logical uploads into 2,447 packages totaling
79,306,752 bytes and produced the correct changing Kirby-versus-Link battle.
However, JS-side diff/package construction increased drain and GPU work enough
to erase the byte and command savings. This is mechanism/correctness evidence,
not a performance win. Keep the flag experimental and move delta construction
to the producer before another behavior screen.

## Persistent JIT profile maturation

The exact-scene persistent-cache profile is not yet frozen. Eight identical
passes show continuing cache growth, so their speed values are not causal A/B
evidence. Pre-boundary unique compiles fell from 1,633 on the second pass to
138 on the eighth; module misses fell from 3,473 to 329. A complete export
grew from 7,306 entries after pass 6 to 7,737 after pass 7, with different
SHA-256 hashes. Readiness correctly reported zero pending verification,
compilation, and IndexedDB writes and complete required-worker acknowledgments,
but readiness means quiescent at the boundary, not plateaued.

Do not cite the earlier approximately 94% one-off as a stable result. Freeze
the profile only after two consecutive complete exports have identical logical
entry count and hash and three consecutive exact-scene runs remain at the same
module-miss floor. Every A/B arm must use a fresh clone of that frozen master.

## Pass-package projection

One valid visible passive run observed 3,391,755 legacy replay records and
1,079,800 current publications. Safe pass packaging projects 1,079,800 records
but no publication reduction because 1,024,264 uploads and 46,653 resource
records lack producer-transaction ownership at the consumer. The deliberately
unsafe full-envelope estimate is 16,063 publications across 7,966 complete
passes and 8,097 outside segments. It is not eligible for implementation as
measured.

This result narrows the next refactor: transmit producer-owned, pre-encoded UBO
packages across an explicit negotiated opcode/capability. Do not group outside
records in JS by timing or adjacency; that would cross unproven ownership and
rollback boundaries.

## Replay MessageChannel wake screen

A default-off `wgpufastpump=1` experiment replaced zero-delay replay timers
with a bounded `MessageChannel` wake. The exact-scene manual A/B/B/A screen
used the same candidate core, full-CCD affinity, mapped uploads, JIT settings,
muted audio, and visible-output requirements in all four runs.

| Metric | Timer control | MessageChannel | Change |
| --- | ---: | ---: | ---: |
| Fixed-work game speed | 69.978% | 66.374% | -5.15% relative |
| Sampled full-window game speed | 69.669% | 66.231% | -4.93% |
| Fixed-work core FPS | 41.965 | 39.830 | -5.09% |
| Presentation FPS | 30.41 | 26.40 | -13.18% |
| Mean replay backlog | 1,192 records | 624 records | -47.65% |
| Replay backlog p95 | 2,890 records | 2,745 records | -5.00% |
| Maximum nonzero-backlog age | 2,069.6 ms | 2,126.1 ms | +2.73% |
| Mean replay wake delay | 3.023 ms | 0.352 ms | -88.37% |
| Replay schedules | 4,877 | 9,954 | +104.10% |
| Replay drains | 4,084 | 7,778 | +90.45% |
| GPU-completion p95 | 7.192 ms | 6.870 ms | -4.48% |

All four runs reached the exact checkpoint, completed the fixed-work target,
showed changing Kirby-versus-Link output, and reported no WGPU errors, dropped
commands, batch aborts, upload timeouts, or GPU-completion failures.
They are screening evidence rather than release-qualified results: the reports
were captured from a dirty source tree with stale source-contract provenance,
and muted audio separately makes audible-audio claims ineligible. The wake path
reduced scheduler delay, but racing the producer tail fragmented mapped uploads
into many smaller batches. Staging-only submissions rose enough to lower both
game speed and presentation cadence. The behavior change was therefore removed;
it must not be described as a throughput optimization.

## Mapped-stage timing sampling

Exact per-upload mapped-stage timing was compared with timing the first and
every 64th eligible upload. The balanced eight-run screen used candidate core
`1373f77f3b4606b9910f1dbbdff0749911f6b77bdec58a8233fcc94e24718cb8`,
the exact battle save, full-CCD affinity, mapped uploads, visible output, and
muted audio.

| Metric | Exact timing | Stride 64 | Change |
| --- | ---: | ---: | ---: |
| Fixed-work game speed | 71.965% | 72.527% | +0.78% relative |
| Fixed-work core FPS | 43.173 | 43.523 | +0.81% |
| Presentation FPS | 29.22 | 28.60 | -2.14% |
| Eligible upload calls per run | 965,371 | 975,331 | observational |
| Timing samples per run | 965,371 | 15,243 | -98.42% |
| Timing clock calls per run | 1,930,743 | 30,485 | -98.42% |

All runs were valid and showed 17 or 18 readable changing battle samples with
no WGPU errors, dropped commands, or GPU-completion failures. The speed effect
is small compared with observed run variance and presentation did not improve,
so stride 64 remains an explicit diagnostics option rather than a promoted
default. Raw sampled duration counters are not extrapolated into exact totals.

## Metrics-off overhead screen

The gate now obtains a counter-free, fail-closed runtime configuration snapshot
from renderer diagnostics. This allows `metrics=0` runs to prove their active
mapped-upload, UBO-cache, staging, geometry, and tail-gate modes without
re-enabling the counters being measured.

An A/B/B/A plus B/A/A/B screen compared sampled metrics
(`metrics=1&wgpumappedtiming=64`) with global metrics disabled. All eight runs
used commit `f0b54d0`, candidate core
`1373f77f3b4606b9910f1dbbdff0749911f6b77bdec58a8233fcc94e24718cb8`,
the exact battle save, full-CCD affinity, visible hardware WGPU output, no JIT
cache, and muted audio.

| Metric | Sampled metrics | Metrics off | Change |
| --- | ---: | ---: | ---: |
| Fixed-work game speed mean | 73.778% | 74.113% | +0.34 points / +0.46% relative |
| Game-speed sample SD | 1.977 | 1.340 | observational |
| Fixed-work core FPS | 44.245 | 44.475 | +0.52% |
| Presentation FPS | 31.29 | 29.14 | -6.87% |
| Visible changes across four runs | 67 | 67 | equal |

Every run reached the exact checkpoint and fixed-work target and reported no
runtime failures. Muted audio makes these screens ineligible for audible-audio
or release-qualification claims. The +0.46% speed difference is smaller than run-to-run
variation and presentation cadence moved in the wrong direction. Metrics-off
is appropriate for normal play and clean overhead controls, but observer
overhead does not explain the remaining roughly 26% game-speed deficit.

## Local raw artifacts

- `.omx/build/perf-results/fastbranch-visible-abba-*`
- `.omx/build/perf-results/fastbranch-null-abba-*`
- `.omx/build/perf-results/affinity-ffff-*`
- `.omx/build/perf-results/replay-timing-sampled-visible-*`
- `.omx/build/perf-results/stagefast-*`
- `.omx/build/perf-results/fbmap-diag-null-1`
- `.omx/build/perf-results/mapbits-*`
- `.omx/build/perf-results/upload-run-projection-visible-1`
- `.omx/build/perf-results/uploadrun-*`
- `.omx/build/perf-results/sparseubo-*`
- `.omx/wgpu-realtime-100/ubo-compute-1373f77f/`
- `.omx/wgpu-realtime-100/jit-profile-1373f77f/`
- `.omx/wgpu-realtime-100/pass-package-projection-1373f77f/`
- `.omx/wgpu-realtime-100/fast-pump-1373f77f/`
- `.omx/wgpu-realtime-100/mapped-timing-1373f77f/`
- `.omx/wgpu-realtime-100/metrics-overhead-attested-f0b54d0/`

No result in this document establishes realtime, no-lag, or 100% game speed.
