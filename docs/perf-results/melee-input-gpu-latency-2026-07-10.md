# Melee input-marker and GPU-completion evidence - 2026-07-10

This report packages four headed, direct-save diagnostics from the fixed
Kirby-versus-Link battle. The runs validate browser-boundary input-marker and
GPU-completion telemetry. They are not clean-tree performance qualification,
physical input-to-photon measurements, or proof of a renderer speedup.

## Run identity

All four runs loaded the same save at time zero, used the same six-transition
input script, sampled for 10 seconds at 250 ms intervals, and retained 41
harness samples. Save loading succeeded in every arm.

| Field | Recorded value |
| --- | --- |
| Machine | AMD Ryzen 9 9950X3D, 32 logical CPUs, Windows `10.0.26200` x64, 134,876,049,408 bytes RAM |
| Browser | Headed Chrome `143.0.7499.4` |
| Branch/commit | `perf/final-optimization` at `d851b336ca1c9de7da036b73145d3116aef6ec59`, dirty |
| ROM | Melee Rev 2 NKit, 1,430,679,552 bytes; SHA-256 `1018b65a58ca654056be1611a43e753de5dd5f842ce5266581b29c6a12ce7c67` |
| Save state | `__battle.sav`, 21,170,115 bytes; SHA-256 `620879e2ed3c35248deba9fb2f7b2a39f91f5374d2f6a98d2a2455cb55e156d1` |
| Core | `dolphin-core-upstream.wasm`, 12,875,582 bytes; SHA-256 `a239ee47209605f20f7c078f61567cd90d4adb9a718fc3dc71060a178d006995` |
| Input script | SHA-256 `c352dc027796527d51aee952f47ef210f5e22a17f38e7bd7a3a89198690f3255` |

The common effective query, excluding the generated `probe` value, was:

```text
core=upstream&video=software&cpu=dual&speed=1&presenter=webgpu&pacing=tick&jittier=guarded&present=full&wasmjit=0&queue=4&jitwarmup=700&oc=1&fastsw=1&metrics=1
```

| Arm | Additional effective flags | Canvas observer | Raw directory |
| --- | --- | --- | --- |
| Control | `inputphoton=0&inputlatency=0&gpucomplete=0` | Off | `.omx/final-opt/input-photon-control` |
| Marker, unobserved | `inputphoton=1&inputphotonsize=160&inputlatency=1&gpucomplete=0` | Off | `.omx/final-opt/input-photon-unobserved` |
| Marker, observed | `inputphoton=1&inputphotonsize=160&inputlatency=1&gpucomplete=1` | On | `.omx/final-opt/input-photon-observed` |
| GPU completion only | `inputphoton=0&inputlatency=0&gpucomplete=1` | Off | `.omx/final-opt/gpu-completion-only` |

The complete generated URL for each arm remains in its `run-metadata.json`.

## Three-arm cadence snapshot

These are the `summary.overall` values over 33 samples per arm, plus lifetime
presentation statistics. There was only one run per arm. The observed arm also
enabled sampled GPU completion, so this table must not be treated as a
controlled estimate of marker or observer cost.

| Arm | Game speed % | Core FPS | Presentation FPS | Unique/visual FPS | Interval stddev ms | Lifetime max ms | Drop rate % |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Control | 99.82 | 59.82 | 55.09 | 10.33 | 4.75 | 27.6 | 1.13 |
| Marker, unobserved | 99.12 | 59.33 | 57.67 | 10.61 | 4.32 | 29.8 | 0.82 |
| Marker, observed | 98.58 | 59.15 | 58.36 | 10.42 | 4.30 | 26.0 | 0.78 |

All three arms were near real-time in core/game progress while distinct visual
cadence remained about 10.3-10.6 FPS. That separation is measured here; this
single-run set cannot quantify the smaller differences between arms.

## Synchronous marker-path accounting

With `inputphoton=1&metrics=1`, the worker counted the complete JavaScript
software-frame copy plus optical ROI/barcode paint. It also counted the
synchronous video-stat fetch and pad-stat parse used to associate an input
generation with an exact core poll. These counters end at CPU work and do not
include GPU execution, compositing, scanout, or panel response.

| Arm | Copy/paint calls | Source bytes | Painted bytes | Total ms | Average ms/call | Max ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Marker, unobserved | 1,642 | 1,967,001,600 | 174,866,432 | 158.985 | 0.096824 | 1.660 |
| Marker, observed | 1,395 | 1,601,740,800 | 148,561,920 | 134.600 | 0.096487 | 0.715 |

| Arm | Poll/parse calls | UTF-16 source bytes | Total ms | Average ms/call | Max ms | Parse failures |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Marker, unobserved | 46 | 121,868 | 3.230 | 0.070217 | 0.200 | 0 |
| Marker, observed | 35 | 92,802 | 2.905 | 0.083000 | 0.195 | 0 |

The observed arm additionally executed `drawImage` plus `getImageData` every
animation frame. It completed 3,676 canvas reads with no read errors or raw
observation drops. Readback averaged 1.355 ms and reached 119.010 ms once.
That observer is deliberately perturbing and must stay disabled for an
external-sensor trial.

## Causal browser-canvas marker result

The observed arm looked for the first matching 8x8 sample from the 32x32
generation-coded marker. Acceptance passed for all six scripted transitions:

| Boundary count | Expected | Applied | Core-polled | Submitted | GPU-completed | Browser-canvas visible |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Accepted generations | 6 | 6 | 6 | 6 | 6 | 6 |

All six records had complete worker timestamps and monotonic timestamps.
Expiry, in-flight expiry, generation mismatch, and unavailable-generation
counters were zero.

| Stage, six samples | Average ms | p50 ms | p95 ms | Max ms |
| --- | ---: | ---: | ---: | ---: |
| Input event -> adapter start | 0.486 | 0.030 | 1.550 | 1.550 |
| Adapter call duration | 0.000 | 0.000 | 0.000 | 0.000 |
| Adapter finished -> worker applied | 0.167 | 0.000 | 1.000 | 1.000 |
| Worker applied -> core poll | 31.333 | 22.000 | 58.000 | 58.000 |
| Core poll -> marker submit | 0.500 | 0.000 | 1.000 | 1.000 |
| Marker submit -> GPU completion | 3.167 | 3.000 | 5.000 | 5.000 |
| GPU completion -> browser-canvas visible | 1.146 | 0.885 | 1.875 | 1.875 |
| Input event -> browser-canvas visible | 36.798 | 27.360 | 63.640 | 63.640 |

Within this six-sample run, waiting from worker application to the next exact
core poll was the largest measured stage. The result is causal for the
diagnostic marker, not for a game animation or gameplay response.

## Isolated software-present GPU completion

The GPU-only arm sampled `GPUQueue.onSubmittedWorkDone()` after every 30th
successful software-present submission without awaiting it in the present
loop.

| Submits | Requests | Completed | Failed | Unsupported | Average ms | p95 ms | Max ms | In-flight high-water |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,472 | 49 | 49 | 0 | 0 | 2.9767 | 5.000 | 5.510 | 1 |

This 49/49 result measures browser queue-completion notification for the
software-present route. It does not include compositor scheduling, display
scanout, panel response, or a physical photon timestamp.

## Raw evidence integrity

| Artifact | SHA-256 |
| --- | --- |
| `input-photon-control/run-metadata.json` | `0bf5914a0dd9bbd48a0b8b2cd3527c604136e406c31706fa3db3fe5fcdaef069` |
| `input-photon-control/summary.json` | `02798a983448dc1460fd2ae81634f0947f5f6cae77db72ad14d59b8578ec039b` |
| `input-photon-unobserved/run-metadata.json` | `1257d38bd5377df06bdacf3c95f39d963ed7d79f548ce5545ed9de43bfb3e89d` |
| `input-photon-unobserved/summary.json` | `9478eb87c340664b49e1074404534a87f16b94525eb89520ec3bc288e9b2a1eb` |
| `input-photon-observed/run-metadata.json` | `47d8b4cda0437e37a4d6df59231852ec88f7ea2a4198b4f3a4b98a3eb012e2c7` |
| `input-photon-observed/summary.json` | `a6952989ed7498cdf0154dee0fc1c0080da37828834c30f5589e9a5f8ab833f6` |
| `input-photon-observed/input-marker-observations.json` | `53369707ad92f0f1df141ced827f8f21e8d2b7ce37c054ef591fa709ae291172` |
| `gpu-completion-only/run-metadata.json` | `f0ea2225f790da0383f750e1852f8f107c4fe3a8d156df8d4c648fbbe6e162bf` |
| `gpu-completion-only/summary.json` | `fc31e18ede496df728e9669208d2354607be75ae37204b4b7e164a582a96c528` |

The hashes above refer to files beneath `.omx/final-opt/`. The worktree was
dirty, there was only one run per arm, and the browser observer changes the
workload. Re-run balanced, randomized arms from a clean commit before using
these values as a regression threshold. Physical input-to-photon qualification
still requires an external electrical input edge and optical sensor.
