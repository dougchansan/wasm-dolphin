# Hardware WebGPU performance audit - 2026-07-13

## Outcome

Headed/operator validation reports a changing Melee battle image from the true
hardware WebGPU path, but it is not close to full speed on the validation
machine. Muted direct-loaded Kirby-versus-Link comparison screens currently
run at roughly 47-53% game speed and 20-21 presentation FPS; headed audible
validations measured 39-50% game speed. Command replay and buffer upload volume
are major measured pressures. This package does not independently exclude
browser or GPU presentation cost.

The accepted core candidate is content-addressed as
`6a2469a532d205640d6631dfbbebeed71e3a994753b4b76171a5f1d5fac71a7d`
(12,914,873 bytes). Two independent builds matched exactly at the WASM and
normalized-JS levels. A post-load semantic capture paired all 25,481 ownership
records with no drop, mismatch, unresolved dependency, open transaction, or
abort. This proves the captured applied-save prefix, not general renderer
correctness.

No default rendering or JIT flag changed. Automated comparisons used
`AUDIO_MODE=muted`; the separate headed validation used
`AUDIO_MODE=audible` and produced non-silent audio in 239/242 samples.

## Evidence boundary

- Scene: direct-loaded `__battle.sav`, Kirby versus Link. The harness pauses,
  applies the save, and resumes without driving menus or character select.
- ROM SHA-256: `1018b65a58ca654056be1611a43e753de5dd5f842ce5266581b29c6a12ce7c67`.
- Save SHA-256: `620879e2ed3c35248deba9fb2f7b2a39f91f5374d2f6a98d2a2455cb55e156d1`.
- Machine: Windows 11 Pro build 26200; Ryzen 9 9950X3D, 32 logical CPUs,
  125.6 GiB reported RAM; Radeon RX 9070 XT, driver `32.0.31021.5001`.
- Browser: Chrome `143.0.7499.4`; WebGPU adapter reports AMD/RDNA 4.
- Upstream Dolphin: `e22551eae1c84a7e4d0b6a5c519ef4ed4ef69df1`.
- Accepted patch series: 42 patches, SHA-256
  `35e5aa5492d88e433fbba3e36475fd928f58d737038d6fa426576fa2724c78f3`,
  result tree `657e4ef3bd496fa4f5997f1685fe9bb904cba41b`.
- Branch/commit after evidence integration:
  `perf/wgpu-semantic-digest` / `e53d17b3aade75feb8a3baaf9de8b118c2f145f0`.

The hardware `visualFps=0` field is not a valid unique-image metric here: it
still hashes the software XFB source. Browser canvas hashes changed on every
sample in the headed run (61/61), which proves changing presentation but does
not provide a calibrated hardware unique-FPS rate or independently prove the
scene identity. Battle-image identity is operator validation.

## Reproducible candidate

`compare-core-builds` reported `sourceEqual`, `toolchainEqual`, `wasmExact`,
`jsNormalizedExact`, and `reproducible` as true for
`.omx/applied-boundary-core` and `.omx/applied-boundary-core-2`.

| WASM section | Bytes | SHA-256 |
| --- | ---: | --- |
| code | 10,419,762 | `018a11cd76028403a3b1136e5625d8501efba37792763657f7c6601daee8aa6e` |
| data | 2,454,556 | `d323d2605916077c3468c9e1ae73e7e0ba2caa8cfb3b80bbd76a765ccb3e262f` |

## Applied-save semantic proof

Raw artifact:
`.omx/wgpu-semantic/direct-save-candidate-6a2469a5-current-head-muted`;
`summary.json` SHA-256
`011690cba02364dff6cc953f8e85eaaa68aeacb68f18166d23ac253cc7a6a9e8`.

| Check | Result |
| --- | --- |
| Capture | active, frozen, complete, evidence valid |
| Save boundary | generation 1; one load epoch; 351 post-load committed events |
| Ownership | 25,481 prepared / 25,481 accepted / 0 discarded / 0 retried |
| Quiescence | 25,481 paired; 0 pending; 0 open transactions; 0 native drops |
| Independent decode | 25,481 events |
| Transactions | 220 committed / 0 aborted |
| Payload | 10,561,678 bytes hashed; 2,883,112 encoded bytes hashed |
| Parity | 0 mismatches; 0 unresolved dependencies |

The global digest is
`c5e91ce155a24f68753d52b57fbc18048752efe69b26e365d84e09205a366900`;
the applied-load epoch digest is
`4630757d7ce5e7e694ee6458729a2cb2a5860593a692ab73b8704a6d9f5ff0a7`.

## Performance screens

The headed audible 60-second run averaged 39.41% game speed, 24.04 core FPS,
and 19.90 presentation FPS. It processed 4,058,217 commands and 2,099,944
producer-attributed uploads totaling 3,331,261,104 bytes, with zero renderer
errors, command drops, batch aborts, oversize batches, or upload timeouts. It
is an audio/visibility validation, not comparable to the shorter muted runs.
Raw path: `.omx/wgpu-perf/direct-save-candidate-6a2469a5-audible-headed`;
summary SHA-256 `92104eb96d24c0be86936200b45eb6881228bc0265d04da8b0e86a114c60bbff`.

A final 25-second headed confirmation on commit `e53d17b` was also explicitly
audible: 97/99 audio samples were active, all 26 canvas samples had distinct
hashes, and renderer errors, drops, aborts, and upload timeouts stayed zero.
It averaged 49.71% game speed, 30.14 core FPS, and 22.81 presentation FPS.
Raw path:
`.omx/wgpu-perf/direct-save-candidate-6a2469a5-audible-headed-final`;
summary SHA-256
`92961283d6472029ff8f3e44c48ab6efbe37f7942358f36efb1e5c2ed9dd58b4`.

Two repeated 45-second muted cache screens averaged 46.865% with state/UBO
caches off and 49.45% with both on (+5.52% relative). Commands fell about 42%,
upload calls about 15%, upload bytes about 16%, and backlog high-water about
32%. This is encouraging screening evidence only: earlier balanced fixed-work
runs did not qualify a default promotion, so defaults remain unchanged.

A 2-way versus 4-way UBO-cache experiment reduced UBO calls by 8.35% and UBO
bytes by 4.44%, but mean game speed fell 0.50% and presentation FPS fell 4.3%.
The 4-way change was removed.

A geometry-range producer-copy refactor was also rejected. In an
`old/new/new/old` muted 30-second screen, total throughput was noisy and the
new mean was 51.88% versus 50.12% old. However, the targeted sampled
`geometry_commit` cost rose from about 623 ns/call to 691 ns/call (+11%). The
patch, test assertion, vendor edit, and candidate provenance were removed;
the raw artifacts remain under `.omx/wgpu-perf/geomcopy-ab-*`.

## Bottleneck classification

| Bottleneck candidate | Evidence | Confidence | Next action |
| --- | --- | --- | --- |
| CPU/game speed | JIT-off hardware screens remain near half speed while replay/upload counters are very large. The [July 10 audit](performance-audit-2026-07-10.md) classified its long slices as predominantly throttle, not execution or compile. | Medium/high for this scene | Keep CPU/JIT metrics enabled; reclassify after replay load is materially reduced. |
| Software raster/XFB | The recommended software path is source-frame limited, but the hardware WGPU runs do not use software raster for gameplay drawing. | High | Continue software optimization separately; do not use it to explain hardware-WGPU speed. |
| Presentation/canvas | Canvas hashes change, but GPU completion is disabled in these runs and hardware-present timing is not independently attributed. | Low/medium | Add a hardware-valid unique-frame marker and enable GPU-completion/present-phase sampling. |
| WebGPU hardware renderer | Applied-save semantic capture is clean and the battle is visible, but direct-save screens are only 47-53% game speed. | High on this GPU; low generally | Reduce safe upload/replay work without crossing transaction or resource-generation boundaries. |
| JS worker/message/copy | Millions of replayed commands and uploads, multi-gigabyte upload volume, and large backlogs are measured. Cache screens reduce records and improve screening speed. | High | Target UBO and geometry upload publication/copy count with fixed-work A/B gates. |
| Audio | Audible headed run was active for 98.76% of samples. Automated tests mute audio intentionally. | High that audio works; low on causal cost | Keep muted and audible result classes separate; do not tune buffering from cross-class comparisons. |
| Input latency | Existing generation-coded marker reaches browser-canvas visibility; it does not include compositor, scanout, or panel latency. | Medium | Repeat with hardware-valid frame identity and GPU completion in the same headed run. |
| Build flags | Independent release builds match exactly; no build-flag A/B shows a runtime win. | High on reproducibility; low as a bottleneck | Keep build flags stable while optimizing the measured replay path. |

## Ranked optimization backlog

| Rank | Optimization/refactor | Area | Risk | Expected gain | Measurement method |
| ---: | --- | --- | --- | --- | --- |
| 1 | Add hardware-valid presented-frame identity and timed replay/upload phase deltas | Instrumentation | Low | Better classification, no direct speed gain | Same-save repeated muted/headed baselines; raw JSON/CSV |
| 2 | Reduce UBO publication count without changing resource generations or pass ownership | Producer/replay | Medium | Fewer `queue.writeBuffer` calls and shorter backlog | Fixed-work, order-balanced A/B plus semantic digest |
| 3 | Replace per-draw geometry copies with a bounded lifetime-proven arena/ring design | Geometry upload | High | Lower producer copy and upload call pressure | Native wrap/abort tests, semantic parity, repeated direct-save A/B |
| 4 | Bound replay work per presentation turn without splitting atomic transactions | JS scheduling | Medium | Lower long stalls and input latency; throughput may be neutral | GPU completion, backlog age, p95 present interval, game speed |
| 5 | Re-run guarded JIT after replay load falls | CPU/JIT | Medium | Potential game-speed headroom | Compile/run/helper metrics and fixed-save `wasmjit=0/1` pairs |
| 6 | Diagnose on a second GPU/browser build | Compatibility | Low | Confidence, not direct gain | Same content-addressed core and evidence schema |

## Immediate implementation plan

### Today: instrumentation and baselines

- Keep the direct-save, explicit audio-mode, semantic-generation, upload-role,
  producer-phase, GPU-completion, and input-marker evidence paths intact.
- Add a hardware-present identity counter so `visualFps` no longer depends on
  the absent software XFB hash.
- Record replay counters as timed deltas; do not mix replay-op histograms with
  producer-attribution totals.

### Next: low-risk wins

- Screen UBO record suppression/packing variants with identical save,
  duration, audio mode, browser, and core-selection evidence.
- Move only proven non-observable bookkeeping out of per-command JS paths.
- Require zero renderer errors, drops, aborts, timeouts, semantic mismatches,
  and unresolved dependencies before retaining a candidate.

### Then: high-impact renderer/JIT work

- Design a persistent geometry/UBO upload arena whose wrap and submission
  lifetime are explicit and testable.
- Reduce replay backlog only at transaction-safe boundaries.
- Re-run JIT and CPU-core A/Bs after GPU replay pressure no longer dominates.

## Concrete code changes and rollback

| File/module | Exact problem and change | Test | Rollback |
| --- | --- | --- | --- |
| `core/upstream/dolphin_web_core.cpp`, `patches/dolphin-wasm/snapshot/0040-webgpu-applied-load-boundary.patch` | `LoadRequested` used to precede successful state application. It now publishes after `State::Load` applies and waits for ownership quiescence. | Native source/provenance tests and post-load semantic capture | Revert patch 0040 and regenerate provenance. |
| `src/wgpu-semantic-runtime.js`, `src/wgpu-ownership-trace.js` | Pre-load and post-load records could be conflated. Generation gating, frozen capture, and quiescent checkpoint qualification now bind evidence to the applied save. | Semantic runtime, ownership trace, worker integration, and two-successive-load tests | Revert `e53d17b`; feature is metrics-gated/default-off. |
| `tools/menu-progress-validate.mjs`, `tools/perf-artifacts.mjs` | Menu driving stopped at character select and audio state was implicit. `SAVE_STATE_AT=0` now pauses, loads, resumes, then samples; `AUDIO_MODE` is recorded as `muted` or `audible`. | Direct-save and perf-artifact tests; headed audible smoke | Omit direct-save env vars or revert the harness commit. |
| `src/upstream-discio-worker.js` replay loop (proposed) | Large atomic drains can occupy the worker long enough to hurt cadence. Stop only between ownership-safe transactions and expose timed deltas. | Existing replay diagnostics, semantic digest, GPU completion, present p95 | Feature flag to the current unbounded drain. |
| `vendor/dolphin/.../WebGPUVertexManager.cpp` (proposed patch) | Geometry is copied/published too often. Introduce a bounded ring only after wrap, abort, restore, and submission ownership are specified. | Native boundary/wrap/abort tests plus content-addressed A/B | Keep behind default-off URL flag; remove patch if qualification fails. |

## Limits

These measurements cover one machine, one Chrome build, one Melee save, and
one experimental backend. Time-window screens are not deterministic
fixed-work benchmarks. The semantic proof covers a bounded command prefix and
does not prove pixels or all future frames. No claim here establishes full
speed, broad GameCube/Wii compatibility, or release readiness.

The machine-readable companion is
[`perf-results/melee-wgpu-applied-save-and-replay-2026-07-13.json`](perf-results/melee-wgpu-applied-save-and-replay-2026-07-13.json).
