# Browser performance audit — 2026-07-10

## Outcome

The current smoothness problem is a combination, but the dominant visible
limit on the recommended path is now clear:

1. software raster/XFB production yields far fewer distinct frames than the
   emulator and presenter can advance;
2. game-speed stalls still occur, especially in longer runs and with the
   guarded PPC-to-WASM JIT;
3. an avoidable 12.7 ms average presentation queue was removed and confirmed;
4. browser presentation, observer metrics, worker messaging, and audio are not
   the primary software-path throughput bottlenecks on this machine;
5. true hardware WebGPU is not slow game rendering—it is still incorrect. The
   transport now reaches real draws, but the EFB stays zero and command replay
   itself consumes substantial worker time.

No strict end-to-end performance qualification passed. The final recommended
60-second run is a provenance-eligible `FAIL`, and the 180-second no-JIT soak is
valid mechanics evidence but `NON_QUALIFYING`. The only statistical gate pass
is the relative tick queue-latency comparison.

## Seven-part completion tasklist

- [x] Freeze upstream source, patch set, artifacts, and ABI provenance.
- [x] Prove hermetic rebuild parity with two independent builds.
- [x] Direct-load the exact Kirby-versus-Link save and preserve raw A/B data.
- [x] Instrument and classify the true WebGPU hardware-renderer failure.
- [x] Add versioned causal timing and JIT/runtime observability.
- [x] Measure candidate changes and retain only validated, reversible defaults.
- [x] Run strict, soak, fallback, and WGPU diagnostics; package evidence and
  rollback guidance.

## Test record

| Field | Value |
| --- | --- |
| Machine | Windows x64 `10.0.26200`; AMD Ryzen 9 9950X3D; 32 logical CPUs; 134,876,049,408 bytes RAM |
| Browser/GPU | Headed Chrome `149.0.7827.201`; AMD `rdna-4` WebGPU adapter |
| Final behavior commit | `58655af00013c2cab708e317f417eaa190e964d3` on `perf/integration` |
| Final strict-run commit | `7189271e7075135a674993841b0c5acc564afd1b` |
| Core build record | Repository commit `07a69d3ba28fd6deb68fa1810f4fea7fd5b19ddd` |
| Upstream Dolphin | `e22551eae1c84a7e4d0b6a5c519ef4ed4ef69df1` |
| Core artifact | 12,807,931 bytes; SHA-256 `3af23a252929edb6a714c1ad4a856dc50921aa93eef7a5b921431ebebfd1301a` |
| Scene | Direct-loaded Melee Kirby vs Link fixed battle; no gameplay input |
| ROM/save | SHA-256 `1018b65a…7c67` / `620879e2…56d1` |

The full fixture hashes, aggregate rows, comparison decisions, raw paths, and
raw-file hashes are in the
[evidence package](perf-results/melee-performance-evidence-2026-07-10.md).

## Bottleneck classification

| Bottleneck candidate | Evidence | Confidence | Next action |
| --- | --- | --- | --- |
| CPU/game speed | Strict JIT-on run: 92.751% mean, 65.049% min, 55.581 core FPS. JIT compiled 1,030 blocks and ran them 223,724 times (217.2 runs/compile), but recorded 8 emit failures. The 180 s no-JIT soak averaged 88.009% with a 51.345% min. | High that CPU/game-speed stalls contribute; medium on JIT versus scene/raster attribution | Classify the 8 emit failures and long CPU slices; run warm/cold balanced JIT tests before changing defaults. |
| Software raster/XFB | Full `fastsw=0` and balanced `fastsw=1` both held ~100% game speed and ~60 presentation FPS, but unique visual cadence was 5.903 versus 13.556 FPS. Last sampled encode cost averaged 12.7 versus 0.8 ms. Even balanced output remains far below 60 distinct FPS. XFB row/decode/both effects were +1.049%, +1.735%, and +2.503%, all below the 3% screen threshold. | High that distinct-frame production is the leading visible limit; medium on the exact raster/TEV subphase | Instrument raster block traversal, TEV, texture sampling, FIFO generation age, and stale-XFB reuse before a high-risk raster refactor. |
| Presentation/canvas | Six valid blocks/24 runs: queued tick averaged 12.678 ms queue age; immediate tick was 0. Effect 100%, CI `[100,100]`, exact `p=0.03125`. Presentation rose 39.110→57.680 FPS while game speed changed -0.15% and visual cadence -0.91% descriptively. Software WebGPU present/draw/hash were roughly sub-millisecond. | High that queue latency existed and is removed; high that JS presentation is not the current distinct-frame ceiling | Keep immediate tick with `legacytickqueue=1` rollback; add GPU-completion timing before further presenter changes. |
| WebGPU hardware renderer | Before the transport fix, `nojitcache=1` skipped the WGPU pthread listener and the producer dropped records. After decoupling, the ring registers and atomic replay reaches 394,160 real EFB draws and present completion, with 0 pass splits/outside-pass records. Nine post-draw EFB readbacks are all zero: `EFB_DRAW_NO_MUTATION`. The post-fix run averaged 47.622% game speed and 0 game presentation/visual FPS. | High | Debug first-draw uniforms, vertex state, depth/stencil, formats, and raster state; do not optimize replay until a nonzero EFB exists. |
| JS worker/message/copy | Metrics-off screen: -0.252%, CI `[-0.742,0.238]`, `p=1`, rejected. Software-path host rAF work is about 0.1 ms average; present work is sub-millisecond. WGPU replay is a separate problem: post-fix drain total 8.394 s/30 s, max 221.48 ms, backlog high-water 108,858. | High that software host overhead is secondary; high that experimental WGPU replay is expensive | Keep metrics toggle/ACK cleanup as hygiene. Batch or budget WGPU replay only after image correctness. |
| Audio | Sound is present. Strict run: 3,062 mixes, ~0.37 ms/mix, ~15 ms pump cadence, zero underruns/overruns. The 180 s soak also had zero underruns/overruns. Scheduled lead is ~131 ms, a latency tradeoff rather than a throughput failure. | High for this machine/run set | Preserve buffering; test 120/100/80 ms lead separately with a zero-underrun gate before lowering latency. |
| Input latency | Qualifying runs intentionally send no input. Queue latency is measured, but end-to-end input-to-photon is not. The 2 ms polling cadence remains; unchanged gamepad states now early-out. | Low | Add a separate, non-qualifying direct-save input-generation test from host→worker→pad poll→XFB→present. Never reintroduce menu/character-select automation. |
| Build flags | Two independent builds matched exactly: normalized JS, WASM, code, data, source, and toolchain. Build uses Release `-O3 -pthread -msimd128 -flto`; assertions and growth are off and shared memory is fixed at 1.5 GiB. No flag A/B established a runtime win. | High on reproducibility; low that flags are the current bottleneck | Keep flags. Test one content-addressed build variant at a time only after ABI/provenance qualification. |

## Main measured results

| Evidence | Game speed mean/min | Core FPS mean | Presentation FPS mean | Unique visual FPS mean | Verdict |
| --- | ---: | ---: | ---: | ---: | --- |
| Recommended path, JIT on, 60 s | 92.751 / 65.049 | 55.581 | 52.689 | 10.557 | `FAIL` |
| No-JIT stability soak, 180 s | 88.009 / 51.345 | 52.752 | 49.204 | 11.000 | `NON_QUALIFYING` |
| Full software raster, four runs | 100.018 / — | 59.958 | 59.677 | 5.903 | Game-speed `SCREENING_REJECT` |
| Balanced software raster, four runs | 100.118 / — | 60.027 | 58.976 | 13.556 | Game-speed `SCREENING_REJECT` |
| WebGL fallback, one run | 100.279 / 94.738 | 60.115 | 58.774 | 13.452 | `NON_QUALIFYING` route check |
| 2D fallback, one run | 100.355 / 69.211 | 60.164 | 59.032 | 14.000 | `NON_QUALIFYING` route check |
| WGPU post-fix, one diagnostic | 47.622 / 39.564 | 28.546 | 0 | 0 | `FAIL`, `EFB_DRAW_NO_MUTATION` |

The fallback rows are not interleaved comparisons. Their single-run means do
not establish a faster presenter.

## Optimization decisions

| Candidate | Result | Decision |
| --- | --- | --- |
| Immediate tick fresh-frame delivery | Confirmation pass: 100% queue-age reduction, `p=0.03125`; no material game/visual regression | Retained by default; rollback `legacytickqueue=1` |
| XFB encoded-row reuse | +1.049%, CI `[0.197,1.902]` | Keep optional/default-off |
| XFB identity decode | +1.735%, CI `[1.466,2.003]` | Keep optional/default-off |
| Combined XFB fast paths | +2.503%, CI `[2.401,2.605]` | Keep optional/default-off; below 3% threshold |
| Disable detailed observer metrics | -0.252%, CI `[-0.742,0.238]` | No performance claim; retain functional toggle |
| WGPU atomic pass replay | Synthetic boundary tests pass; headed atomic replay recorded zero split/outside-pass records | Retained for experimental WGPU; rollback `wgpuatomic=0` |
| Always-on pthread renderer transport | Restored command replay under `nojitcache=1`; advanced classifier from `WAITING_FOR_DRAW` to `EFB_DRAW_NO_MUTATION` | Retained; no claim that game rendering works |
| JIT regalloc/smear/correctness-sensitive flags | Base guarded JIT has 8 emit failures; no valid foundation for lever tuning | Defaults unchanged; `blockmerge`, `shortprefix`, `fastmemhoist` remain off |
| Audio lead/buffering | Zero underruns in software evidence | Unchanged |

## Ranked optimization backlog

| Rank | Optimization/refactor | Area | Risk | Expected gain | Measurement method |
| ---: | --- | --- | --- | --- | --- |
| 1 | Add raster/TEV/texture/FIFO-generation-age phase counters | Software raster | Low | Classification of the primary measured software-path route toward higher unique FPS | Exact save, balanced blocks; phase sums, generation age, stale-XFB count |
| 2 | Fix first real WGPU draw→EFB mutation | Hardware renderer | High | Potentially removes the CPU-raster ceiling if correctness is reached | Clear/triangle/checker/translated shader/first draw ladder; EFB readbacks |
| 3 | Classify/fix JIT emit failures and long compile/run slices | CPU/JIT | High | Could remove severe game-speed lows | Cold/warm blocks, emit categories, 217× reuse baseline, state/hash parity |
| 4 | Bound and batch WGPU command-ring drain after correctness | WGPU/JS | High | Current replay consumes seconds of worker time and creates 100k-scale backlog | Drain total/max/backlog, game speed, audio gaps, GPU errors |
| 5 | Specialize only the measured hot raster traversal/TEV states | Software raster | High | Direct distinct-frame improvement | Byte/state/XFB parity plus confirmation visual/game metrics |
| 6 | Add browser GPU-completion timestamps | Presentation | Low | Classification only | Submit→completion latency and outstanding work by presenter |
| 7 | Timestamp input-to-visible response | Input | Low | Measurement, then latency work | Direct-save generation markers; p50/p95 per boundary |
| 8 | Transfer/reuse audio buffers or introduce an SAB ring | Audio/worker | Medium | Small allocation/copy reduction; unlikely to be FPS-class | Mix RTT, allocations, bytes, underruns, input latency |
| 9 | Revisit combined XFB paths only with a lower product threshold | XFB | Medium | Measured ~2.5%; cannot solve visual ceiling | Six-block confirmation if product policy changes |
| 10 | Prune unused CMake dependency probes | Build | Medium | Configure/build time only | Clean configure wall time and identical artifacts |

Risk definitions: Low is instrumentation/logging with no intended behavior
change; Medium is a local reversible refactor with clear tests; High is a
correctness-sensitive emulator, renderer, or JIT change.

## Immediate implementation plan

### Today — completed

- Pinned upstream, patch, vendor-tree, toolchain, ABI, and core identities.
- Replayed the patch series transactionally and proved two independent builds
  byte-identical.
- Changed qualification to direct-load the exact Kirby/Link save; no menu or
  character-select driving remains.
- Added raw JSON/CSV/events/screenshots/manifests and causal timing across the
  core, XFB/output, presentation, worker, WGPU, audio, input, and host.
- Ran strict/default, 180-second soak, repeated raster/XFB/metrics screens,
  six-block tick confirmation, fallback checks, and WGPU classifiers.
- Retained immediate tick and the WGPU transport/atomicity fixes; rejected
  default promotion of sub-threshold XFB/metrics candidates.

### Next — low-risk wins

- Instrument software raster subphases and stale-frame generation age.
- Add a separate direct-save input latency diagnostic.
- Add GPU queue-completion timing and archive raw `.omx` bundles with the hash
  ledger.
- Classify the eight JIT emit failures without changing default JIT flags.

### Then — high-impact renderer/JIT work

- Make the first real WGPU draw mutate the EFB, then reduce replay backlog.
- Optimize the measured dominant raster/TEV phase with strict output parity.
- Re-evaluate guarded JIT only after emit failures are zero and warm/cold cache
  comparisons are valid.

## Concrete code changes and rollback

| File/module | Exact problem and change | How tested | Rollback |
| --- | --- | --- | --- |
| `src/presentation-pacing.js`; worker presentation loop | Tick mode queued fresh frames despite its contract. Fresh frames now present immediately; duplicate tick repaint remains. Added queue-age/depth/delivery counters. | Unit tests plus 24-run confirmation | `legacytickqueue=1` |
| `src/upstream-discio-worker.js::installDolphinPthreadChannels` | `nojitcache=1` skipped essential WGPU/OGL pthread listeners. Renderer transport is now always installed; cache broadcast/listener/lazy fill remain gated. | 118 passed tests, 2 expected skips, provenance, and headed WGPU post-fix classifier | Revert `1f84298`; temporary WGPU workaround is omit `nojitcache=1` |
| `src/wgpu-replay-diagnostics.js`; worker replay | Black/green output had no bounded failure classifier and passes could split at drain snapshots. Added ordered classifier and atomic pass replay. | Synthetic diagnostics and headed pass/draw/readback evidence | `wgpuatomic=0`; omit `wgpuclassify=1` |
| `core/upstream/dolphin_web_xfb_fastpaths.h`, `dolphin_web_discio.cpp`, patched `SWEfbInterface.cpp` | Added independently selectable byte-identical row reuse and identity decode. | Exhaustive parity plus three repeated screens | `xfbfast=0` (default) |
| `tools/perf-regression-gate.mjs`, `tools/perf-artifacts.mjs` | Old validation could stop at character select, compare inconsistent runs, or reject valid load timing noise. It now direct-loads the exact save, locks per-raster XFB identity, bounds one scheduler slice, records raw evidence, and enforces activation/provenance. | Fixture/checkpoint/provenance/comparison unit tests and headed runs | Revert harness-only commits; never restore menu driving for qualification |
| Worker metrics collection and causal telemetry | Metrics-off still needed explicit proof that observer work was actually absent. Added mode-aware counter/schema checks. | 8 valid metrics A/B runs | `metrics=1` |
| `src/app.js`/`src/input.js` gamepad path | Unchanged 500 Hz states caused avoidable host/worker churn. Quantized unchanged states early-out. | Input unit tests; no live input-to-photon claim | `legacygamepadpoll=1` |
| Worker adapter/protocol reply planner | Known one-way controls received discarded success replies. Only whitelisted successful ACKs are suppressed; errors remain replies. | Transport tests and counters | `legacyonewayack=1` |
| Fetch/patch/configure/build/provenance tools | Moving/incomplete source and cumulative patch preflight prevented exact reproduction. Added locked ordered transactional replay and independent build comparison. | Fresh fetch/patch twice, exact build A/B, provenance verifier | Use the content-addressed known core; do not qualify unlocked builds |

## Limits and remaining unknowns

- Unique visual FPS is a hash-based changing-frame cadence, not a perceptual
  motion-quality score.
- The full-vs-balanced screen statistically gated game speed, not visual FPS;
  the visual difference is a consistent descriptive result across four runs
  per arm.
- Input-to-photon remains unmeasured because qualification correctly sends no
  gameplay input.
- Hardware WGPU still shows a diagnostic pattern rather than game content.
- The current recommended URL still includes `wasmjit=1`; the audit does not
  authorize changing that default from one machine's invalid JIT evidence.
- Wii and general GameCube compatibility remain out of scope.
