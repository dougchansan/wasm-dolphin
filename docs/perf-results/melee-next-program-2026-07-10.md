# Melee next-program evidence — 2026-07-10

This package records the final diagnostic pass for the fixed Kirby-versus-Link
battle. Every headed run directly loaded `__battle.sav`; none stopped at or
drove the character-select screen. The machine-readable companion is
[`melee-next-program-2026-07-10.json`](melee-next-program-2026-07-10.json).

## Test identity

| Field | Value |
| --- | --- |
| Machine | Windows `10.0.26200`, Ryzen 9 9950X3D, 32 logical CPUs, 128 GiB |
| Browser | Headed Chrome `143.0.7499.4` |
| Branch/base | `perf/next-program` at `a9bdc3376ab7ae6c517055920c85e4e6edc3a178`, dirty diagnostic tree |
| Final core | 12,846,988 bytes, SHA-256 `f7ce56729d92404082994f97900dc0efb8fe66019b4e179f2321b7822377f523` |
| ROM | SHA-256 `1018b65a58ca654056be1611a43e753de5dd5f842ce5266581b29c6a12ce7c67` |
| Save | 21,170,115 bytes, SHA-256 `620879e2ed3c35248deba9fb2f7b2a39f91f5374d2f6a98d2a2455cb55e156d1` |

These are diagnostic results from one machine. The dirty-tree qualification
and per-run health failures are retained; the numbers are not release claims.

## Software-raster CMPR specialization

Three seeded profiles selected exact texture keys `0xd38a01e` and
`0xd34a01e`. Both are CMPR, bilinear, no-mip, repeat-S/T, power-of-two cases;
their top-two sampled work shares were 73.79%, 72.45%, and 72.16%. TEV's top
three represented only about 43%, so no TEV specialization was added.

The Emscripten-only fast path reuses decoded CMPR endpoints across the four
bilinear taps. It is guarded by the complete measured predicate and falls back
to Dolphin's generic sampler for every other request. A production-decoder
parity harness compared 463,348 samples with seed `0x5a17c0de`; all matched
exactly.

| Arm mean | Game speed % | Core FPS | Presentation FPS | Unique visual FPS | Sampled stale ratio |
| --- | ---: | ---: | ---: | ---: | ---: |
| Baseline | 100.610 | 60.353 | 59.333 | 12.843 | 80.057% |
| Candidate | 99.647 | 60.037 | 59.353 | 13.763 | 77.614% |
| Candidate − baseline | −0.963 pp | −0.317 | +0.020 | +0.920 / +7.16% | −2.443 pp |

All three paired visual deltas were positive: `+1.18`, `+0.41`, and `+1.17`
FPS. Sampled texture cost changed from 0.41076 to 0.39702 µs and traversal
from 5.7526 to 5.2865 µs. The specialization is provisionally retained because
strict byte parity passed and all three visual/stale deltas improved. It is not
a qualified speed win: the tree was dirty and each baseline arm failed only
the pre-window `boot-snappy` check.

Raw summaries: `.omx/next/final-raster-hotcase-ab/`.

## Correlated long-slice attribution

The retained 57.590 ms worst slice was measured as one correlated tuple:

| Component | Time |
| --- | ---: |
| Throttle/pacing wait | 57.235 ms |
| Video | 0.255 ms |
| CPU execute | 0.009 ms |
| Compile | 0 ms |
| DVD | 0 ms |
| Unattributed | 0.091 ms |

Pacing wait owned 99.38% of that slice. Whole-run module compile max was
744 µs, instantiate max 60 µs, compile-burst max 1,138 µs, and emit/compile
failures were zero. `FinishReadDVDThread` still appeared nine times at
12.921 ms average and 16.059 ms p95/max, but the retained worst tuple had
`dvd=0`; this run did not capture a DVD-owned worst slice.

Raw output: `.omx/next/final-correlated-slices/software-hybrid-1/`.

## Atomic hardware-WGPU smoke

The corrected final smoke proved that a real completed EFB pass mutates its
target: 182,949 nonzero color bytes out of 1,351,680 after 120 draws. The XFB
and backbuffer were also nonzero and 21/21 sampled canvas hashes changed.

| Metric | Result |
| --- | ---: |
| Game speed / core / presentation | 69.18% / 41.76 / 35.88 FPS |
| Pass begin / end | 10,925 / 10,925 |
| Pass splits / records outside passes | 0 / 0 |
| Replay errors / dropped commands | 0 / 0 |
| Batch abort / oversize / upload timeout | 0 / 0 / 0 |
| Backlog high-water / final | 62,737 / 717 records |
| Replay drain total / max | 7,006.735 / 1,631.375 ms |
| GPU completion average / p95 | 25.109 / 39.870 ms |

The earlier smoke that logged three `upload-stage-order` errors is rejected.
Those errors exposed an overly broad diagnostic: advancing past a consumed
pass may legitimately retain uploads belonging to the next incomplete suffix.
The replacement check is uint32-wrap-safe and still rejects a retained upload
from the consumed prefix.

Raw output: `.omx/next/final-wgpu-transactions/smoke-cache0-fixed/`.

## WGPU stable-state suppression A/B

Three balanced `cache=0/1`, `1/0`, `0/1` pairs ran for 20 seconds each. All six
runs had zero replay errors, missing resources, dropped commands, pass splits,
records outside passes, batch aborts, oversize batches, upload timeouts, and
upload-overwrite risk. All produced changing canvas hashes and nonzero XFB and
backbuffer samples.

| Arm mean | Game speed % | Core FPS | Presentation FPS | Commands/s | Commands/EFB draw | Backlog high-water | Drain total ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Cache off | 70.277 | 42.097 | 36.803 | 227,730 | 10.010 | 62,795 | 6,281.567 |
| Cache on | 69.960 | 42.000 | 36.237 | 137,206 | 6.063 | 38,543 | 6,069.530 |
| Change | −0.317 pp | −0.097 | −0.567 | −39.75% | −39.43% | −38.62% | −3.38% |

Cache-on suppressed about 1.65 million redundant state records per run. The
structural reduction was consistent, but game/core/presentation cadence did
not improve; the median paired changes were −0.77 game-speed points, −0.35
core FPS, and −0.47 presentation FPS. GPU-completion p95 was noisy and worsened
in two of three pairs. The cache therefore remains default-off behind
`wgpustatecache=1`.

This A/B is non-qualifying for performance promotion for an additional reason:
the opt-in classifier sampled a legitimate one-draw post-load EFB pass with no
color mutation in five arms. A separate final smoke and the third cache-on arm
did prove completed-pass mutation; all A/B arms had nonzero downstream XFB and
backbuffer content. The command-volume result is useful diagnostic evidence,
not permission to change the default.

Raw summaries: `.omx/next/final-wgpu-state-cache-ab/`.

## Deterministic 32×32 input marker

The final software-hybrid run used six scripted state transitions and a 32×32
generation-coded marker, while the browser observer sampled its uniform
top-left 8×8 region. Acceptance was 6/6 applied, core-polled, submitted,
GPU-completed, and browser-canvas-visible with complete monotonic timestamps.
Mismatch, unavailable-generation, expiry, read-error, and raw-drop counters
were all zero; legacy `inputreadback` was disabled.

| Boundary, six samples | Average | p50 | p95/max |
| --- | ---: | ---: | ---: |
| Worker applied → core poll | 28.833 ms | 20 ms | 50 ms |
| Core poll → marker submit | 0.500 ms | 0 ms | 1 ms |
| Marker submit → GPU completion | 2.333 ms | 2 ms | 4 ms |
| GPU completion → browser canvas | 22.334 ms | 19.700 ms | 29.945 ms |
| Input event → browser canvas | 54.185 ms | 51.540 ms | 82.300 ms |

The run averaged 99.0% game speed, 59.9 presentation FPS, and 14.1 unique
visual FPS with zero audio underruns. This is input-to-browser-canvas timing,
not input-to-photon: compositor scheduling, scanout, the display panel, and
light emission are outside the browser observer. Use `INPUTMARKEROBSERVE=0`
with an external camera or photodiode to measure those physical stages without
the observer's per-rAF `drawImage`/`getImageData` perturbation.

Raw output: `.omx/next/final-input-marker/software-hybrid-32px-final/`.

## Final default-path gate

`npm run perf:gate -- --target-mode warn` ran against the final core and exact
save. It exited nonzero with `NON_QUALIFYING`, as it should: the run was
headless, the repository/build evidence was dirty, minimum game speed was
92.767% (below 95%), and minimum presentation was 38 FPS (below 50).

The full-window means were 100.615% game speed, 60.330 core FPS, 57.952
presentation FPS, and 14.571 unique visual FPS, with zero audio underruns.
These numbers are recorded as a rejected gate, not as a pass. Raw output:
`.omx/next/final-default-perf-gate/`; `report.json` SHA-256 is
`20f90e9f7b8e333b7739394c99ab8c0055d1fed40d0d26a6e5e8188c3913785b`.

## Bottom line

- The recommended software path is core-speed capable on this machine; unique
  frame production remains limited by software raster work.
- The measured CMPR specialization improved unique cadence provisionally,
  without changing decoded output in the exhaustive focused parity harness.
- Long retained CPU slices are pacing waits, not JIT compile bursts.
- Hardware WGPU now executes correct visible work, but remains around 70% game
  speed in this diagnostic and is dominated by command replay/backlog.
- State suppression substantially reduces replay traffic but did not improve
  cadence, so it stays experimental and default-off.
- Audio is not the software-path blocker in the retained marker run.
