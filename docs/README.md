# Documentation

- [Current status](current-status.md) — supported scope, recommended path, and
  confidence levels.
- [Rendering modes](rendering-modes.md) — canonical meanings of `video` and
  `presenter` URL flags.
- [JIT flags](jit-flags.md) — PPC-to-WASM JIT controls, safety defaults, and
  metric interpretation.
- [Reproducible build](repro-build.md) — toolchain record and upstream-core
  build sequence.
- [Melee software-hybrid results](perf-results/melee-software-hybrid.md) —
  machine-specific validation template and claimed baseline.
- [WebGPU Naga bridge](webgpu-naga-bridge.md) — SPIR-V-to-WGSL ABI, ownership,
  failure handling, and patched C++ integration.
- [Core roadmap](core-roadmap.md) — longer-term core work.
- [OGL performance plan](ogl-performance-plan.md) — diagnostic OGL research.
- [Upstream WASM probe](upstream-wasm-probe.md) — upstream integration notes.

Historical session notes under `patches/dolphin-wasm/` are research records,
not the canonical user-facing reference. Prefer the documents above for the
current contract.
