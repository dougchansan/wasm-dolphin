# Browser performance audit — 2026-07-10

## Outcome

The browser does not have one universal FPS bottleneck. The measured fixed
Kirby-versus-Link battle separates into two materially different paths:

1. On the recommended software-hybrid path, emulation and presentation can
   stay near 60 Hz while the software raster/XFB source changes much less
   often. Distinct-frame production is the primary smoothness limit.
2. On the true hardware-WGPU path, the first completed EFB pass does mutate
   its target and the battle is now visibly rendered. The prior green/checker
   screen was caused by legacy software repaint paths overwriting the
   WGPU-owned canvas.
3. Hardware WGPU is still not full speed. In two JIT-off fixed-battle runs,
   bounded replay averaged about 68% game speed and 30 successful present
   submissions/s. Command replay and GPU queue latency remain substantial.
4. The eight observed JIT emit failures were eight attempts at one opcode,
   `addzex`, disabled accidentally at compile time. Removing that diagnostic
   disable produced zero emit failures in the rebuilt diagnostic. The longest
   CPU slices were VI/CoreTiming callbacks, not compile bursts.
5. Audio is working and had no underruns in the retained hardware latency run.
   Input-to-visible telemetry now exists, but its first result is explicitly
   next-distinct-frame attribution rather than proof that input caused the
   pixel change.

No result in this report means that hardware WGPU is release-ready or that one
machine's game-speed figure generalizes. Raw paths, exact artifacts, rejected
runs, and attribution limits are retained alongside every claim.

## Five-priority follow-up tasklist

- [x] Validate nonzero raster traversal, TEV, texture, FIFO-age, XFB, source
  generation, and stale-reuse counters on the parity-built final core.
- [x] Establish WGPU EFB mutation and remove the competing green/checker
  presentation source.
- [x] Classify the eight JIT emit failures and long CPU slices.
- [x] Reduce WGPU replay backlog only after visible correctness was established.
- [x] Add GPU-completion and input-to-visible latency measurements.

All five priorities now have implementation and direct-save evidence. The
software profiler candidate was built twice byte-identically, then exercised
in three metrics-off/on pairs. This closes instrumentation validation; it does
not claim that the next high-risk raster optimization is already complete.

## Test record

| Field | Value |
| --- | --- |
| Machine | Windows x64 `10.0.26200`; AMD Ryzen 9 9950X3D; 32 logical CPUs; 128 GiB RAM |
| Software evidence browser | Headed Chrome `149.0.7827.201` |
| Current WGPU evidence browser | Headed Chrome `143.0.7499.4` |
| Branch | `perf/next-program` |
| Upstream Dolphin | `e22551eae1c84a7e4d0b6a5c519ef4ed4ef69df1` |
| Scene | Direct-loaded Melee Kirby vs Link fixed battle; no menu or character-select driving |
| ROM/save | SHA-256 `1018b65a…7c67` / `620879e2…56d1` |

The original software qualification evidence is in
[the Melee performance package](perf-results/melee-performance-evidence-2026-07-10.md).
Current hardware evidence, including the exact dirty diagnostic commit/core,
is in [the WGPU replay and latency package](perf-results/wgpu-replay-and-latency-2026-07-10.md).

## Bottleneck classification

| Bottleneck candidate | Evidence | Confidence | Next action |
| --- | --- | --- | --- |
| CPU/game speed | Recommended-path runs can approach 100%, but the retained strict JIT-on run averaged 92.751% and the old soak had lower slices. Eight emit failures were all `addzex`; after fixing that diagnostic disable, the longest sampled slices were `VICallback`/CoreTiming (up to about 59 ms), while compile max was about 1.0 ms and compile-burst max about 1.3 ms. Hardware WGPU JIT-off runs averaged about 68%. | High that CPU slices contribute; high that the eight failures were not eight opcode classes | Measure VI/CoreTiming work around raster and frame-boundary waits; repeat warm/cold JIT A/B on the final artifact before changing defaults. |
| Software raster/XFB | Full and balanced software modes held roughly 100% game speed and 60 presentation FPS in the retained screens, but unique visual cadence was about 5.9 and 13.6 FPS respectively. Three rebuilt profiler runs averaged 12.77 visual FPS and a 78.26% sampled stale-source ratio while presentation averaged 59.67 FPS. Per source frame they observed about 86,962 candidate pixels, 65,438 TEV pixels, and 51,241 texture samples. | High that source-frame/pixel work is the default-path smoothness ceiling | Optimize one measured pixel-path case at a time; require output parity and repeated exact-save confirmation. |
| Presentation/canvas | Immediate tick delivery removed about 12.7 ms average queue age in the prior 24-run comparison. Software WebGPU submit/draw/hash work was sub-millisecond and sampled GPU completion was about 2.8–3.2 ms. Presentation remained near 60 while distinct frames remained low. | High that software presentation is not the current unique-frame ceiling | Keep immediate tick; preserve `legacytickqueue=1` rollback and GPU-completion sampling. |
| WebGPU hardware renderer | Immediate readback after the first completed EFB pass found 182,949 nonzero color bytes of 1,351,680 after 108 draws. The battle is visibly changing. Pump-on runs still averaged only 68.205% game speed and 29.94 presents/s. | High on this AMD validation GPU; low for general GPU compatibility | Profile/batch native command replay and pipeline/state churn without weakening upload lifetime or pass atomicity. |
| JS worker/message/copy | Metrics-off screening did not establish a software-path gain. Hardware replay previously reached 117,979 pending records while referencing 63,369,752 upload bytes through a 32 MiB arena; this was both a lifetime correctness risk and a large worker backlog. A monotonic upload watermark fixed lifetime, and the bounded pump reduced backlog high-water 72.16%. | High that software JS overhead is secondary; high that hardware replay overhead is material | Reduce record count/state replay per draw and measure drain total/max, backlog age, GPU completion, game speed, and errors together. |
| Audio | Sound is present. The retained hardware input/latency run had zero underruns; prior software runs also had zero underruns/overruns. Buffer lead is a latency tradeoff, not the measured throughput blocker. | High for retained runs | Keep buffering unchanged until a separate lead A/B preserves zero underruns. |
| Input latency | Six scripted state changes were applied and core-polled; the next distinct WGPU readback followed in 67.17 ms average and 268 ms p95. Attribution is non-causal and whole-run timing includes scheduler/save transients. | Medium that instrumentation boundaries work; low on gameplay latency generalization | Add an on-screen input marker or deterministic scene response before calling this input-to-photon. |
| Build flags | Release configuration already uses `-O3`, pthreads, SIMD128, LTO, fixed shared memory, and no assertions/growth. Earlier independent builds matched. No build-flag A/B established a runtime win. | High on reproducibility; low that flags are the active bottleneck | Keep flags stable; only compare one content-addressed variant at a time after final parity. |

## Main measured results

| Evidence | Game speed % | Core FPS | Presentation FPS | Unique/visual FPS | Interpretation |
| --- | ---: | ---: | ---: | ---: | --- |
| Recommended path, prior strict JIT-on 60 s | 92.751 mean | 55.581 | 52.689 | 10.557 | Qualification failed its game-speed gate |
| Full software raster, prior four-run mean | 100.018 | 59.958 | 59.677 | 5.903 | Distinct-frame limited |
| Balanced software raster, prior four-run mean | 100.118 | 60.027 | 58.976 | 13.556 | Distinct-frame limited |
| WGPU pump off, two-run mean | 67.120 | — | 19.680 | Canvas changed in both runs | Backlog high-water 58,850.5 |
| WGPU pump on, two-run mean | 68.205 | — | 29.940 | Canvas changed in both runs | Backlog high-water 16,384 |
| WGPU latency diagnostic | 62.140 | 37.000 | 30.550 | 27 sampled canvas hashes | Diagnostics enabled; not a performance baseline |
| Software phase profile, metrics off mean | 99.903 | 59.960 | 59.020 | 12.783 | Three 20 s runs |
| Software phase profile, metrics on mean | 101.077 | 60.627 | 59.670 | 12.767 | Three 20 s runs; no slowdown resolved above variation |

The presenter fallback and WGPU rows are not interleaved general-performance
comparisons. One run or one GPU does not establish a universal backend winner.

## Optimization decisions

| Candidate | Result | Decision |
| --- | --- | --- |
| Immediate tick fresh-frame delivery | Prior confirmation removed queue age without a material game/visual regression | Retained; `legacytickqueue=1` rollback |
| WGPU canvas ownership | Hardware-present success now prevents legacy tick/show-image overwrite; visible battle and changing hashes confirmed | Retained; correctness fix |
| First completed EFB-pass readback | `FIRST_EFB_PASS_MUTATED`, 182,949 nonzero color bytes after 108 draws | Retained as opt-in classifier; does not claim one individual draw |
| Monotonic WGPU upload watermark | Prevents producer reuse until JS has synchronously consumed upload bytes; focused wrap/order/drop tests pass | Retained; correctness prerequisite |
| Bounded WGPU replay pump | Two-run means: backlog −72.16%, presentation +52.13%, p95 submit interval −34.56%, game speed +1.085 points | On by default only for `video=wgpu`; `wgpupump=0` rollback |
| `addzex` emitter restore | All eight old failures were the same accidental compile-time disable; rebuilt diagnostic recorded zero | Retained; runtime `disable=wasmaddze` escape hatch remains |
| Correctness-sensitive JIT flags | No evidence authorizes enabling block merge, short prefix, or fastmem hoist | Defaults unchanged |
| Audio buffering | Zero underruns in retained evidence | Unchanged |

## Ranked optimization backlog

| Rank | Optimization/refactor | Area | Risk | Expected gain | Measurement method |
| ---: | --- | --- | --- | --- | --- |
| 1 | Specialize a measured high-volume TEV/texture pixel case without changing output | Software raster | High | Direct unique-frame improvement on the default path | Pixel/XFB hash parity; three repeated exact-save pairs; stale ratio and visual cadence |
| 2 | Coalesce redundant WGPU state/command records before JS replay | Hardware WGPU | Medium | Lower worker drain cost and command age; possible game/present gain | Record count/draw, drain total/max, backlog, GPU errors, output hashes |
| 3 | Cache replay-ready pipeline/bind/state bundles by stable IDs | Hardware WGPU | Medium | Reduce per-draw JS lookup/descriptor work | Same-save A/B with GPU completion and pipeline/bind cache hit rates |
| 4 | Classify long VI/CoreTiming callbacks against raster/XFB and wait states | CPU/core | Low | Determines whether long slices are useful work, waiting, or scheduling | Timestamp nested VI/CoreTiming phases; p50/p95/max and game-speed lows |
| 5 | Specialize only the measured dominant traversal/TEV/texture case | Software raster | High | Direct unique-frame cadence improvement | Pixel/XFB parity, exact-save repeated A/B, game and visual cadence |
| 6 | Add deterministic input-caused visual marker | Input | Medium | Converts next-distinct-frame timing into causal input-to-visible latency | Scripted sequence IDs through host, core poll, marker draw, GPU completion |
| 7 | Sample GPU completion by phase instead of whole-run aggregation | Both presenters | Low | Separates boot/save spikes from steady scene queueing | Warm-scene windowed p50/p95/max and outstanding submissions |
| 8 | Revisit JIT hot blocks only after warm/cold replay data | PPC/WASM JIT | High | Potential game-speed low reduction; no expected direct unique-FPS gain | Compile/run/helper profile, state hashes, warm/cold fixed-save blocks |
| 9 | Test lower audio lead with a zero-underrun gate | Audio/latency | Medium | Lower feel latency, not throughput | 120/100/80 ms balanced runs; underrun and input-visible p95 |
| 10 | Test build variants one flag at a time | Build | Medium | Unknown CPU/raster gain; possible load-size change | Independent parity builds plus fixed-save repeated A/B |

Risk definitions: Low is instrumentation/logging with no intended behavior
change. Medium is a local reversible refactor with clear tests. High is a
correctness-sensitive emulator, renderer, raster, or JIT change.

## Immediate implementation plan

### Today — instrumentation and baselines completed

- Two independent builds are byte-identical, and every profiler counter
  activates on the exact save.
- Three balanced-order `metrics=0`/`metrics=1` pairs are archived. Paired
  game-speed differences were +4.47, +1.23, and -2.18 points, so no profiler
  slowdown is resolved above variation.
- Metrics-on runs averaged a 78.26% sampled stale-source ratio and zero FIFO
  distance underflows.

### Next — low-risk wins

- Window GPU completion to the steady battle rather than boot/save load.
- Add VI/CoreTiming nested attribution and command-record/state-churn counters.
- Preserve raw JSON/CSV/events and exact core/browser/fixture hashes.

### Then — high-impact renderer/JIT work

- Coalesce WGPU replay records and cache stable replay state in small,
  independently reversible changes.
- Optimize only the software raster subphase shown hot by final counters.
- Revisit JIT block generation only after warm/cold evidence and correctness
  hashes; do not turn on sensitive flags by default.

## Concrete code changes and rollback

| File/module | Exact problem and proposed/implemented change | How to test | Rollback |
| --- | --- | --- | --- |
| `core/upstream/dolphin_web_raster_profile.h`; patch `0009` | Hot phases and FIFO pressure were invisible. Added sampled TLS phase counters, batched FIFO counters, consumer-observed backlog age, saturated distance accounting, and epoch reset. | Rebuilt exact-save metrics run; require activation/nonzero fields, finite ages, `fifouf=0`; compare metrics off/on. | Disable with `metrics=0`; revert profile patch/header. |
| `core/upstream/dolphin_web_discio.cpp::DolphinWeb_RecordVideoOutputProfile` | The old frame hook was not reached on the browser path. Publish source-generation cadence at the reached `Video_OutputXFB` bridge. | Frame count and intervals must advance with XFB output. | Revert bridge publication; existing presentation metrics remain. |
| `src/upstream-discio-worker.js::drainWebGpuCmdRing` | Later clears made present-time EFB samples ambiguous. Encode one opt-in readback immediately after the first completed EFB pass with draws. | Classifier unit tests and exact-save `FIRST_EFB_PASS_MUTATED`. | Omit `wgpuclassify=1`. |
| `src/upstream-discio-worker.js` canvas ownership paths | Legacy tick and show-image repaint overwrote successful hardware output with stale green/checker pixels. Claim ownership after successful hardware submit and suppress those repaint paths. | Headed exact-save screenshot, changing hashes, nonzero present count, zero GPU validation errors. | Revert ownership guards to reproduce only; no runtime flag is recommended. |
| `patches/dolphin-wasm/snapshot/0011-webgpu-upload-watermark.patch`; `src/wgpu-upload-watermark.js` | A 32 MiB upload arena could wrap while old commands still referenced overwritten bytes. Added producer/consumer watermarks, bounded wait, ordered suffix staging, and dropped-tail rollback. | Uint32 wrap/order model, source contract tests, headed replay with zero errors. | Revert protocol patch and JS together; never mix versions. |
| `src/core-host.js`; `src/wgpu-replay-diagnostics.js` | Sparse replay polling allowed a 59k-record backlog after correctness. Default the 16,384-record pump only for `WebGPU-Real`, honoring explicit 0/1. | Two repeated fixed-save runs per arm; record backlog, cadence, game speed, drain and errors. | `wgpupump=0`. |
| JIT snapshot patch `0010`; analyzer/evidence | `addzex` was compiled out by a diagnostic define, manufacturing eight failures. Removed the define while retaining the runtime disable and per-op stats. | Rebuild, exact-save run, `emitfail=0`, state/visual checks. | `disable=wasmaddze`; revert patch if correctness regresses. |
| `src/gpu-completion-telemetry.js`; worker submit sites | Queue submission time did not show GPU completion or outstanding work. Sample `queue.onSubmittedWorkDone()` with bounded cadence. | Unit tests plus software/hardware exact-save samples; no unhandled promise errors. | Omit `gpucomplete=1`. |
| `src/input-latency-telemetry.js`; host/worker input path | Host apply, core poll, and next visible change were not correlated. Added sequence-bound transport/poll/visible timestamps and safe WGPU readback baselines. | Six scripted state changes; match applied/polled/visible counts; reject validation-error runs. | Omit `inputlatency=1`. |
| `tools/menu-progress-validate.mjs`; `tools/perf-artifacts.mjs` | Runs lacked uniform raw causal fields and could be mistaken for menu progression. Preserve JSON/CSV/events/metadata and direct-load the supplied exact save with input disabled. | Fixture hashes, scene marker, save-load success, raw artifact tests. | Revert harness-only changes; never restore menu driving for qualification. |

## Limits and remaining unknowns

- Unique visual FPS is a sampled changing-frame hash, not a perceptual quality
  score.
- The EFB classifier proves the first completed 108-draw pass mutates its
  target. It does not isolate which individual draw first changed a byte.
- Current WGPU numbers are JIT-off diagnostics on one AMD GPU, not a general
  performance claim.
- GPU-completion whole-run maxima include boot and save-load transients.
- The first input result is host-to-next-distinct-GPU-readback after core poll;
  it is not yet causal input-to-photon.
- Wii and general GameCube compatibility remain out of scope.
