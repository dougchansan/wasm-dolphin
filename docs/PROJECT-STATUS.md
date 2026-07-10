# Project status — measured checkpoint

This is the current repository checkpoint after the seven-part browser
performance program. For exact machine, fixture, commit, raw-artifact hashes,
and verdicts, use the
[2026-07-10 performance audit](performance-audit-2026-07-10.md) and its
[evidence package](perf-results/melee-performance-evidence-2026-07-10.md).

## Product direction

The recommended path remains Dolphin's software rasterizer presented through
browser WebGPU:

```text
?core=upstream&video=software&presenter=webgpu&cpu=dual&speed=1&wasmjit=1&jitwarmup=700&oc=1&pacing=tick&fastsw=1&metrics=1
```

Melee is the only best-supported target. Near-100% game speed describes core
timing, not 60 distinct visual frames per second. The true hardware renderer is
`video=wgpu`; it remains experimental and is not the recommended path.

## What the fixed-battle evidence established

- The exact Kirby-versus-Link save loads directly. Qualification does not
  navigate menus, pause at character select, or send gameplay input.
- The dominant visible limit on the recommended path is distinct software
  frame production. In the repeated full-versus-balanced screen, both arms
  sustained about 100% game speed and 60 presentation FPS, while visual cadence
  was 5.903 FPS for `fastsw=0` and 13.556 FPS for `fastsw=1`.
- Core/game-speed stalls also contribute. The strict 60-second JIT-on run
  averaged 92.751% game speed and fell to 65.049%; it did not pass.
- An avoidable tick presentation queue averaged 12.678 ms. Immediate delivery
  reduced measured queue age to zero in six valid blocks and is retained, with
  `legacytickqueue=1` as rollback.
- XFB row reuse, identity decode, and both combined measured +1.049%, +1.735%,
  and +2.503%. All missed the declared 3% screening threshold and remain
  default-off.
- Observer metrics, host animation-frame work, software presentation, and audio
  did not classify as the primary throughput bottleneck on the measured
  machine. Input-to-photon latency remains unmeasured.
- The WGPU pthread transport now works independently of JIT caching. Hardware
  WGPU reaches real draws and present completion, but bounded post-draw EFB
  readbacks remain zero (`EFB_DRAW_NO_MUTATION`).
- Two independent upstream-core builds matched byte-for-byte. Source, patch,
  toolchain, ABI, JS, WASM, and build identities are pinned and verified.

## Current decisions

| Area | Decision |
| --- | --- |
| Software hybrid | Keep as the default playable route |
| Immediate tick delivery | Retain; confirmed latency improvement |
| `fastsw=1` | Keep as balanced default; visual cadence remains limited |
| XFB fast paths | Keep optional/default-off; measured below threshold |
| JIT defaults | Do not change until emit failures and warm/cold benefit are classified |
| Audio buffering | Keep; no software-run underruns or overruns were observed |
| Hardware WGPU | Park as experimental until the first real draw mutates the EFB |
| Generated core artifacts | Do not change without a provenance-qualified rebuild |

## Next engineering order

1. Instrument software raster traversal, TEV, texture sampling, FIFO generation
   age, and stale-XFB reuse.
2. Classify the eight guarded-JIT emit failures and long CPU slices without
   enabling correctness-sensitive flags.
3. Fix first-draw WGPU state so a real draw mutates the EFB, then address the
   large replay backlog.
4. Add separate GPU-completion and input-to-visible latency diagnostics.
5. Optimize only the measured dominant raster/JIT phase and require state/XFB
   parity plus repeated headed confirmation before promotion.

No strict end-to-end performance qualification has passed yet. The audit is a
bottleneck classification and optimization decision record, not a claim that
the browser build is now lag-free.
