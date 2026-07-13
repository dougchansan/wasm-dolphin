# Documentation

- [Hardware WebGPU performance audit (2026-07-13)](performance-audit-2026-07-13.md) - applied-save semantic proof, reproducible candidate, current bottleneck classification, rejected refactors, and next optimization plan.
- [Machine-readable applied-save and replay evidence](perf-results/melee-wgpu-applied-save-and-replay-2026-07-13.json) - content hashes, run statistics, comparison decisions, and evidence limitations.
- [WGPU visible upload closure](perf-results/melee-wgpu-visible-upload-closure-2026-07-12.md) - corrected queue/mapped fairness failure, dense-UBO queue no-go, and the immutable pass-package next gate.
- [WGPU pass-package projection](perf-results/melee-wgpu-pass-package-projection-2026-07-12.md) - passive direct-battle publication accounting, unresolved native ownership, observer-control limits, and the semantic-digest gate before runtime work.
- [WGPU native ownership trace](perf-results/melee-wgpu-native-ownership-trace-2026-07-12.md) - zero-drop pending/active/outside attribution, upload ownership, observer limits, and the semantic-digest handoff.
- [WGPU semantic replay evidence](wgpu-semantic-replay-evidence.md) - default-off runtime ownership/legacy correlation, trusted startup reset attestation, independent WDS2 decoding, and current parity limits.

- [WGPU guarded uniform-comparison screen](perf-results/melee-wgpu-uniform-fast-2026-07-12.md) - default-off correctness evidence, unresolved throughput screen, and upload/replay backlog diagnosis.

- [Current status](current-status.md) — supported scope, recommended path, and
  confidence levels.
- [Causal performance telemetry](causal-telemetry.md) — versioned core,
  raster, presentation, worker, WebGPU, audio, and input measurements.
- [Software raster phase profiling](software-raster-profiling.md) —
  metrics-gated traversal, TEV, texture, FIFO, XFB, and stale-frame evidence.
- [Software raster phase results](perf-results/melee-software-raster-phases-2026-07-10.md) —
  parity-built activation, three-pair metrics overhead, and phase classification.
- [Rendering modes](rendering-modes.md) — canonical meanings of `video` and
  `presenter` URL flags.
- [JIT flags](jit-flags.md) — PPC-to-WASM JIT controls, safety defaults, and
  metric interpretation.
- [Reproducible build](repro-build.md) — toolchain record and upstream-core
  build sequence.
- [Melee software-hybrid results](perf-results/melee-software-hybrid.md) —
  machine-specific validation template and claimed baseline.
- [Performance audit (2026-07-09)](performance-audit-2026-07-09.md) —
  provenance-complete fixed-battle measurements and ranked optimization work.
- [Performance audit (2026-07-10)](performance-audit-2026-07-10.md) — current
  bottleneck classification, five-priority follow-up, decisions, and rollback
  paths.
- [Final optimization evidence](perf-results/melee-final-optimization-evidence-2026-07-10.md) —
  clean TEV confirmation, rejected WGPU UBO screen, strict replay failures,
  and the measured hardware upload bottleneck.
- [Machine-readable final optimization evidence](perf-results/melee-final-optimization-evidence-2026-07-10.json) —
  experiment identity, primary statistics, validation status, and decisions.
- [WGPU upload coalescing plan](wgpu-upload-coalescing-plan.md) — scoped
  geometry-packing refactor, lifetime invariants, tests, promotion gate, and
  rollback.
- [WGPU upload attribution results](perf-results/melee-wgpu-upload-attribution-2026-07-11.md) —
  conserved role/opcode accounting and artifact hashes for the direct battle.
- [WGPU geometry-packing results](perf-results/melee-wgpu-geometry-pack-2026-07-11.md) —
  balanced default-off screen and no-promotion decision.
- [WGPU upload-arena results](perf-results/melee-wgpu-upload-arena-2026-07-11.md) —
  32/64 MiB screen and retained 32 MiB default.
- [WGPU replay-budget results](perf-results/melee-wgpu-replay-budget-2026-07-11.md) —
  atomic 4/6 ms scheduling evidence and indivisible-stall finding.
- [WGPU UBO attribution results](perf-results/melee-wgpu-ubo-attribution-2026-07-11.md) —
  role timing, packing screen, and cache no-go.
- [WGPU queue-relief results](perf-results/melee-wgpu-queue-relief-2026-07-11.md) —
  rejected asynchronous-relief smokes and second-GPU limitation.
- [WGPU mapped-staging smoke](perf-results/melee-wgpu-mapped-staging-2026-07-11.md) —
  corrected single-arm mechanism evidence and the invalidated prior A/B.
- [WGPU dense-UBO screen](perf-results/melee-wgpu-dense-ubo-2026-07-12.md) —
  record reduction, alignment repair, and audio-inconclusive balanced evidence.
- [WGPU second-GPU availability](perf-results/melee-wgpu-second-gpu-2026-07-12.md) —
  forced-low-power adapter attempt and explicit single-GPU limitation.
- [WGPU AudioWorklet screen](perf-results/melee-wgpu-audio-worklet-2026-07-12.md) —
  SHA-verified headed A/B, underrun evidence, and default-off decision.
- [WGPU queue-pressure design record](wgpu-queue-pressure-relief.md) —
  removed experiment, safety invariants, and next architecture.
- [WGPU staging-slot results](perf-results/melee-wgpu-staging-slots-2026-07-12.md) —
  valid equal-memory A/B and rejection of additional remap slots.
- [WGPU renderer-worker canary](perf-results/melee-wgpu-renderer-worker-canary-2026-07-12.md) —
  nested-worker, shared-memory, and headless WebGPU feasibility evidence.
- [WGPU upload-isolation screen](perf-results/melee-wgpu-upload-isolation-2026-07-12.md) —
  renderer-worker rejection, null-drain ceiling, and the intentional-blank probe boundary.
- [WGPU producer phase profile](perf-results/melee-wgpu-producer-profile-2026-07-12.md) —
  validated profiler overhead, visible WGPU confirmation, and the 22.2-million-per-second
  idle FIFO-tail call pattern.
- [WGPU draw-resource profile](perf-results/melee-wgpu-draw-profile-2026-07-12.md) —
  default-off TLS remediation, stability-gated overhead proof, visible smoke,
  and sampled draw-resource phase ranking.
- [WGPU deep-diagnostic gate](perf-results/melee-wgpu-deep-diagnostic-gate-2026-07-12.md) —
  reproducible header repair, balanced fixed-work screen, console-volume reduction,
  rollback smoke, and visible GPU-completion evidence.
- [WGPU detailed-UBO telemetry overhead](perf-results/melee-wgpu-ubo-metrics-overhead-2026-07-12.md) —
  explicit diagnostic flag, two-block positive screening signal, visible validation,
  and remaining GPU-completion tails.
- [WGPU idle FIFO-tail gate screen](perf-results/melee-wgpu-tail-gate-2026-07-12.md) —
  order-balanced activation evidence and rejection after state-proven no-op
  elision produced no fixed-work throughput gain.
- [WGPU diagnostic-log suppression screen](perf-results/melee-wgpu-diagnostic-quiet-2026-07-12.md) —
  exact filter activation evidence and rejection after only one known-safe
  record was suppressed per enabled run.
- [WGPU transaction-staging results](perf-results/melee-wgpu-transaction-staging-2026-07-12.md) —
  valid batching A/B, critical-path regression, and no-merge decision.
- [WGPU batched queue-staging smoke](perf-results/melee-wgpu-batched-queue-staging-2026-07-12.md) —
  synchronous queue-write stall, audio failure, and activation rejection.
- [WGPU dirty-range projection](perf-results/melee-wgpu-dirty-range-projection-2026-07-12.md) —
  two headed fixed-battle captures, global coalescing rejection, and the
  geometry-only 99.2% projected copy-reduction candidate.
- [WGPU geometry-range screen](perf-results/melee-wgpu-geometry-range-2026-07-12.md) —
  bounded implementation, repeated headed pairs, and rejection after a 98.7%
  record reduction produced no fixed-work speed gain.
- [Final next-program evidence](perf-results/melee-next-program-2026-07-10.md) —
  CMPR parity/A-B, correlated slices, atomic WGPU smoke, state-cache A-B, and
  deterministic 32×32 input-marker results.
- [2026-07-10 evidence package](perf-results/melee-performance-evidence-2026-07-10.md) —
  aggregate rows, machine-readable decisions, and raw-artifact hashes.
- [Melee JIT diagnostics](perf-results/melee-jit-diagnostics-2026-07-10.md) —
  guarded emit failures and long-CoreTiming-slice classification.
- [Independent core-build parity](perf-results/melee-core-build-parity-2026-07-10.json) —
  machine-readable source, toolchain, JS, WASM, code, and data equality.
- [GPU completion and input propagation diagnostics](perf-results/melee-latency-diagnostics-2026-07-10.md) —
  opt-in queue completion, legacy propagation bounds, and causal
  input-to-browser-canvas marker measurements.
- [WGPU replay and hardware-latency diagnostics](perf-results/wgpu-replay-and-latency-2026-07-10.md) —
  historical nonzero EFB-pass output, repeated replay-pump A/B, GPU
  completion, and GPU-readback input-to-visible evidence.
- [WGPU post-load restore classification](perf-results/wgpu-post-load-restore-classification-2026-07-10.md) —
  zero-payload save proof, first-pass source mapping, classifier semantics,
  and remaining depth/staging risks.
- [Fixed-battle result CSV](perf-results/melee-kirby-link-fixed-battle-2026-07-09.csv) —
  aggregate rows for the audit's headed Chrome runs.
- [Worker transport A/B](worker-transport.md) — one-way reply suppression,
  rollback flag, and measurement counters.
- [WebGPU Naga bridge](webgpu-naga-bridge.md) — SPIR-V-to-WGSL ABI, ownership,
  failure handling, and patched C++ integration.
- [True WebGPU replay classifier](wgpu-real-classifier.md) — bounded pass,
  resource, pass-local EFB output, draw, and present diagnostics for
  `video=wgpu`.
- [Historical first-EFB WGPU evidence](perf-results/wgpu-first-efb-2026-07-10.json) —
  older present-time draw state and nonzero observations retained for context.
- [WGPU replay epoch evidence](perf-results/wgpu-replay-epoch-2026-07-10.json) —
  save-load boundary, upload-arena pressure, EFB/source/backbuffer chain, and
  detached-presentation evidence.
- [Core roadmap](core-roadmap.md) — longer-term core work.
- [OGL performance plan](ogl-performance-plan.md) — diagnostic OGL research.
- [Upstream WASM probe](upstream-wasm-probe.md) — upstream integration notes.

Historical session notes under `patches/dolphin-wasm/` are research records,
not the canonical user-facing reference. Prefer the documents above for the
current contract.
