# Melee hardware-WGPU geometry-packing screen (2026-07-11)

This is a screening result, not a promotion result. `wgpugeompack=1` achieved
its mechanical call-reduction goal, but the speed effect was inconsistent and
the candidate did not pass the correctness/liveness gate. The option remains
default-off.

## Environment

| Field | Value |
| --- | --- |
| Commit | `07d9705e330a1b9fefa633e6027ac5086b24ae91` (clean) |
| Core | 12,877,399 bytes; SHA-256 `1eafb703b9cc28aa772a077e3b61809a8c652506e84801708757184a60c98821` |
| Browser | Headed Chrome 150.0.7871.114 |
| CPU | AMD Ryzen 9 9950X3D, 32 logical CPUs |
| GPU | AMD WebGPU adapter, `rdna-4` |
| Game | Melee Rev 2; verified ISO SHA-256 `1018b65a58ca654056be1611a43e753de5dd5f842ce5266581b29c6a12ce7c67` |
| Scene | Direct load of verified Kirby-versus-Link `__battle.sav` at time zero |
| Design | Two balanced fixed-work blocks: ABBA, then BAAB; eight emulated seconds per run |

Both arms used `video=wgpu`, `presenter=webgpu`, `wasmjit=0`, `metrics=1`,
`gpucomplete=1`, `wgpuclassify=1`, and `wgpupump=1`. The only treatment was
`wgpugeompack=0` versus `wgpugeompack=1`.

## Result

| Measure | Legacy | Packed | Interpretation |
| --- | ---: | ---: | --- |
| Mean game speed | 70.48% | 71.91% | Descriptive only |
| Mean core FPS | 42.24 | 43.11 | Descriptive only |
| Mean upload calls | 814,710 | 582,375 | About 28.5% fewer |
| Calls removed per indexed draw | — | 1.000226 | Intended packet path confirmed |
| Bytes per indexed draw | 5,576.106 | 5,573.569 | No material byte inflation |
| Post-load upload timeouts | 0 | 1 | Candidate gate failure |
| Batch aborts | 0 | 1 | Candidate gate failure |
| Dropped records | 0 | 0 | Clean |
| Median GPU-completion p95 | 233.39 ms | 245.61 ms | No repeatable improvement |

Block effects were `+5.3512%` and `-1.2801%`. The median effect was `+2.0356%`
with bootstrap 95% interval `[-1.2801%, +5.3512%]`; the statistical gate did
not pass.

Every run had nonzero final XFB and backbuffer RGB and a correct battle
screenshot. However, every run's first-EFB readback was zero. One packed run
also recorded one post-load upload timeout and one batch abort. The strict
artifact validator therefore rejected the screen.

## Decision and rollback

Keep `wgpugeompack` default-off. The retained optimization is useful because it
removes almost exactly one upload per indexed draw, but it is not yet evidence
of realtime hardware rendering. Rollback is `wgpugeompack=0`.

Before confirmation: classify the zero-EFB evidence, remove the remaining
watermark timeout/abort, and rerun the same preregistered balanced design.

