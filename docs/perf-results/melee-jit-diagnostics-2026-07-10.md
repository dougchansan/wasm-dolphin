# Melee JIT and long-slice classification — 2026-07-10

This report re-analyzes the headed 60-second fixed Kirby-versus-Link run from
commit `44e5553d8c749b4986807e8600ff69f295036c7c`. It does not claim the strict
performance gate passed; that run failed with eight guarded-JIT emit failures
and throughput lows.

## Eight emit failures

The old core exposed only `emitfail:8`, so its raw output cannot name eight
individual PCs. Source inspection nevertheless classifies the failure path
with high confidence:

- `patches/dolphin-wasm/snapshot/0003-ppc-wasm-jit.patch` contains the only
  active compile-time `DOLPHIN_WEB_DISABLE_*` emitter bisection define:
  `DOLPHIN_WEB_DISABLE_FASTOTHER_31ADDZEX_ALONE`.
- The guarded-tier prefix scanner accepts `addzex` (OPCD 31, SUBOP10 202) as a
  direct candidate, but that compile-time define makes the later emitter
  return false.
- `BuildWasmCachedInterpreterBlock` then returns an empty module and
  `TryWriteWasmBlock` increments `emitfail`.
- Project history already records `addzex` as the carry instruction that did
  not share the fixed add/extend carry-ordering bug. Runtime `disable=wasmaddze`
  remains available as a rollback.

These are eight failed block-emission attempts, not evidence of eight distinct
emitter defects. The production compile-time bisection residue should be
removed, guarded with a regression test, and validated with a rebuilt core and
the exact save before changing any other JIT default.

## Long CPU slices

| Measurement | Result |
| --- | ---: |
| Run-loop maximum | 59.204 ms |
| `CoreTiming::Advance` maximum | 59.139 ms |
| Block-execution maximum | 4.164 ms |
| Synchronous WASM module compile maximum | 1.015 ms |
| Compile burst maximum | 1.264 ms / 8 modules |

The worst slice is therefore a CoreTiming scheduled-event slice, not a JIT
compile or block-execution burst. The existing event probe logged two event
classes over its 5 ms threshold:

| Scheduled event | Samples over 5 ms | Conditional average | p95 | Max |
| --- | ---: | ---: | ---: | ---: |
| `VICallback` | 143 | 21.381 ms | 46.475 ms | 59.059 ms |
| `FinishReadDVDThread` | 45 | 11.779 ms | 15.539 ms | 15.899 ms |

Those averages describe only callbacks that crossed the logging threshold.
They are not averages over every callback. `VICallback` owns the worst observed
slice and includes the video/XFB work that the raster phase instrumentation is
intended to split further.

## Reproduction

Run the reusable parser against a gate summary and its console log:

```powershell
npm run jit:analyze -- `
  --summary <run>/summary.json `
  --console <run>/console.log `
  --out <run>/jit-diagnostics.json
```

The parser deduplicates the worker/main mirrored event messages, reports the
Advance/execute/compile split, and understands the per-op `emitkey` fields
emitted by the follow-up instrumentation. Machine-readable current evidence is
in [melee-jit-diagnostics-2026-07-10.json](melee-jit-diagnostics-2026-07-10.json).
