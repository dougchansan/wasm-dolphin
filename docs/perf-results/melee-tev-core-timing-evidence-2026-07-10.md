# Melee TEV and CoreTiming evidence - 2026-07-10

This report records headed, direct-save diagnostics from the Kirby-versus-Link
battle fixture. The runs were captured from a dirty research worktree and are
not clean-tree performance qualifications. They support exact-case selection,
shadow correctness, and timing attribution only; they do not prove a speedup.

## Run identity

All four retained runs used the Melee Rev 2 NKit image, loaded the battle save
at time zero, supplied no gameplay input, and ran in headed Chrome on the same
machine.

| Field | Measured value |
| --- | --- |
| Machine | AMD Ryzen 9 9950X3D, 32 logical CPUs, Windows `10.0.26200` x64 |
| Browser | Chrome `143.0.7499.4` |
| Recorded branch/commit | `perf/final-optimization` at `d851b336ca1c9de7da036b73145d3116aef6ec59`, dirty |
| ROM SHA-256 | `1018b65a58ca654056be1611a43e753de5dd5f842ce5266581b29c6a12ce7c67` |
| Save-state SHA-256 | `620879e2ed3c35248deba9fb2f7b2a39f91f5374d2f6a98d2a2455cb55e156d1` |
| Profile/timing core | 12,873,138 bytes; SHA-256 `eaec73b4900d14635ddc2b5d3f825a5279ab6c222ae2890790586193328d3b09` |
| TEV shadow core | 12,875,582 bytes; SHA-256 `a239ee47209605f20f7c078f61567cd90d4adb9a718fc3dc71060a178d006995` |
| Profile/timing artifacts | `.omx/final-opt/tev-timing-capture-2`, `.omx/final-opt/tev-timing-capture-3` |
| Shadow artifacts | `.omx/final-opt/tev-shadow-only`, `.omx/final-opt/tev-execute-shadow` |

The timing profiles used
`video=software&presenter=webgpu&fastsw=1&metrics=1&ppcprof=1` with the guarded
WASM JIT requested. The shadow checks used the cached interpreter
(`wasmjit=0`) so JIT adaptation did not change their execution mode.

## Exact TEV distribution

The two profile runs used independent sparse-case seeds, `4036904915` and
`4222520955`. Those builds did not yet reset the raster profile after loading
the save, so the counts below subtract the exact `save-state-loaded` helper
snapshot from the final cumulative snapshot. Each selected tuple was present
in both endpoint top-eight lists; the subtraction is therefore exact for these
three cases. The post-load totals were 32,203 case samples / 46,447 stage-work
units in capture 2 and 36,243 / 52,373 in capture 3.

| Exact tuple (schema 1 words) | Meaning | Capture 2 samples / share / work share | Capture 3 samples / share / work share |
| --- | --- | ---: | ---: |
| `4011,0,40,0,8fa8f,8ffd0,0,e4,e4` | One texture stage; texture-modulated raster RGB and raster alpha | 8,935 / 27.746% / 19.237% | 10,099 / 27.865% / 19.283% |
| `10,0,0,0,8fffa,8ffd0,0,e4,e4` | No texture; raster RGBA pass-through, cull mode 0 | 8,752 / 27.178% / 18.843% | 9,843 / 27.158% / 18.794% |
| `4010,0,0,0,8fffa,8ffd0,0,e4,e4` | Same pass-through TEV operation, cull mode 1 | 4,364 / 13.552% / 9.396% | 4,911 / 13.550% / 9.377% |
| Combined | All three exact cases | 22,051 / 68.475% / 47.476% | 24,853 / 68.573% / 47.454% |

All three tuples appeared in all 36 samples of both runs with unchanged words.
The two pass-through tuples alone represented 40.729% and 40.709% of post-load
case samples. Fingerprints were retained only as labels; the specialization
matches all nine words and does not use a hash as a correctness predicate.

The need for a post-load reset is visible in capture 3: tuple fingerprint
`3e7a846565c6b65c` ended with 5,132 cumulative samples, but 5,082 existed at
the load snapshot. Only 50 samples, 0.138% of the post-load total, belonged to
the measured battle window. Treating the final cumulative rank as battle
frequency would have selected a boot case. The later shadow core resets the
profile epoch after a successful save load.

## Shadow and execute checks

`tevhot:` serializes
`mode/classified-batches/classified-pixels/specialized-pixels/shadow-pixels/mismatches`.
The retained 20-second runs reported:

| Run | Flags | Final `tevhot` counters |
| --- | --- | --- |
| Shadow only | `swtevfast=0&swtevshadow=1` | `2/32379/55009382/0/55009382/0` |
| Execute plus shadow | `swtevfast=1&swtevshadow=1` | `3/28030/47336624/47336624/47336624/0` |

The shadow-only run compared 55,009,382 classified pixels against the generic
register result with zero mismatches. The execute-plus-shadow run specialized
and shadow-checked 47,336,624 pixels with zero mismatches. A mismatch would
restore the generic register snapshot and latch specialization off.

This is strong same-pixel TEV register parity for the exercised exact cases.
It is not a full EFB/XFB proof: periodic screenshots were disabled, the two
runs advanced to different final frame counts, and no byte-for-byte EFB or XFB
artifact comparison was retained. Their headline game-speed values are not an
A/B result because shadow mode deliberately evaluates both implementations.

## Worst CoreTiming slices

The retained `sliceprof:` and adjacent `slicephase:v=1` tuples agree that each
run's worst slice was a VI callback dominated by deliberate throttle sleep,
not PPC execution or JIT compilation.

| Run | Total | Advance | Execute | Compile | VI throttle | Video | Owner | Requested | Overshoot | Correlated DVD |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| Capture 2 | 47.190 ms | 47.184 ms | 0.005 ms | 0 | 46.929 ms | 0.170 ms | `vi-end-field` | 46.058 ms | +0.871 ms | 0 |
| Capture 3 | 48.555 ms | 48.549 ms | 0.005 ms | 0 | 48.310 ms | 0.184 ms | `vi-end-field` | 46.462 ms | +1.848 ms | 0 |

The process-wide throttle summaries were:

| Run | Site | Count / slow | Total actual | Average | Maximum | Requested at maximum | Overshoot |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Capture 2 | `vi-end-field` | 37 / 31 | 999.428 ms | 27.012 ms | 46.929 ms | 46.058 ms | +0.871 ms |
| Capture 2 | `vi-si-poll` | 506 / 30 | 985.774 ms | 1.948 ms | 45.909 ms | 45.068 ms | +0.841 ms |
| Capture 3 | `vi-end-field` | 141 / 133 | 3,011.011 ms | 21.355 ms | 48.310 ms | 46.462 ms | +1.848 ms |
| Capture 3 | `vi-si-poll` | 722 / 217 | 4,464.985 ms | 6.184 ms | 47.280 ms | 45.906 ms | +1.374 ms |

## DVD maximum is not the worst-slice cause

The independent process-wide `dvdprof:v=1` maximum was queue-wait dominated in
both runs:

| Run | Total | Map | Queue wait | Pop | Copy | Finish | Other | Bytes / loops |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Capture 2 | 17.260 ms | 0 | 17.250 ms | 0 | 0.005 ms | 0 | 0.005 ms | 10,984 / 1 |
| Capture 3 | 16.239 ms | 0 | 16.229 ms | 0 | 0 | 0 | 0.010 ms | 32 / 1 |

Both retained worst slices reported a correlated DVD total of zero. The DVD
maximum is useful aggregate context, but it did not occur in the retained
worst VI slice and cannot explain that slice's duration.

## JIT observations

Both timing runs ended with `emitfail:0` and `compilefail:0`; every compiled
block was reported as full rather than partial. That absence of compiler
failure did not imply high dynamic coverage:

| Run | Attempts / compiled | JIT block runs | `ppcprof` blocks | Run-end JIT-run share | Sampled PPC max |
| --- | ---: | ---: | ---: | ---: | ---: |
| Capture 2 | 1,364 / 639 | 98,265 | 402,450,980 | 0.0244% | 109 us |
| Capture 3 | 2,698 / 1,253 | 166,403 | 443,291,109 | 0.0375% | 5 us |

The share is the run-end cumulative JIT block-run counter divided by the
run-end `ppcprof` dynamic block counter. It is an approximate diagnostic, not
static code coverage: the guarded JIT engaged after warmup and could be
adaptively disabled or re-enabled. Capture 2 ended in a cooldown after an FPS
regression; capture 3 reported the JIT enabled after 2,609 stable video frames.
The data therefore supports "no emit/compile failure observed" and "low
reported dynamic reuse," not a claim that the JIT made the run faster.

## Dirty TEV screening is inconclusive

The separate dirty, metrics-off, no-JIT, `speed=unlimited` screen under
`.omx/final-opt/tev-screening-dirty` completed two four-run blocks. Its primary
game-speed effects contradicted each other:

| Block | Generic mean | Exact-hot-case mean | Effect |
| --- | ---: | ---: | ---: |
| 1 | 159.2293% | 159.0755% | -0.0966% |
| 2 | 150.7357% | 199.5372% | +32.3755% |

The block-bootstrap interval was `[-0.0966%, +32.3755%]`, permutation
`p = 1`, the statistical gate did not pass, and the result was not promotable
or qualification-eligible. Workload drift was large: timed windows began from
core ticks 16.651-17.656 billion, advanced 10.327-16.249 billion ticks, and
produced 1,273-2,004 frames. A fixed wall-time window at unlimited speed thus
compared different emulated horizons. The screen is inconclusive and supports
no TEV speed claim.

## Limits on interpretation

- All retained runs were dirty research runs; none qualifies a default change.
- Sparse case counts estimate frequency, not total TEV time saved.
- The timing run retains one worst slice; it is not a latency distribution.
- `dvdprof` and throttle-site maxima are independent aggregates unless the
  adjacent `slicephase` tuple explicitly correlates them.
- Shadow parity covers register results for classified pixels, not every game,
  TEV program, EFB byte, XFB byte, or browser GPU.
- The screening workload must be stabilized before another performance claim:
  use equivalent emulated horizons or a deterministic loop, clean provenance,
  balanced blocks, and byte/visual correctness checks.
