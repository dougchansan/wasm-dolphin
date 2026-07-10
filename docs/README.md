# Documentation

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
- [2026-07-10 evidence package](perf-results/melee-performance-evidence-2026-07-10.md) —
  aggregate rows, machine-readable decisions, and raw-artifact hashes.
- [Melee JIT diagnostics](perf-results/melee-jit-diagnostics-2026-07-10.md) —
  guarded emit failures and long-CoreTiming-slice classification.
- [Independent core-build parity](perf-results/melee-core-build-parity-2026-07-10.json) —
  machine-readable source, toolchain, JS, WASM, code, and data equality.
- [GPU completion and input propagation diagnostics](perf-results/melee-latency-diagnostics-2026-07-10.md) —
  opt-in queue-completion and host-to-visible-bound measurements.
- [WGPU replay and hardware-latency diagnostics](perf-results/wgpu-replay-and-latency-2026-07-10.md) —
  immediate EFB-pass mutation, repeated replay-pump A/B, GPU completion, and
  GPU-readback input-to-visible evidence.
- [Fixed-battle result CSV](perf-results/melee-kirby-link-fixed-battle-2026-07-09.csv) —
  aggregate rows for the audit's headed Chrome runs.
- [Worker transport A/B](worker-transport.md) — one-way reply suppression,
  rollback flag, and measurement counters.
- [WebGPU Naga bridge](webgpu-naga-bridge.md) — SPIR-V-to-WGSL ABI, ownership,
  failure handling, and patched C++ integration.
- [True WebGPU replay classifier](wgpu-real-classifier.md) — bounded pass,
  resource, EFB-mutation, draw, and present diagnostics for `video=wgpu`.
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
