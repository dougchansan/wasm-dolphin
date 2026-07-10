# Melee performance evidence — 2026-07-10

This package records headed-Chrome measurements of the fixed Kirby-versus-Link
battle. It is evidence for the dated
[performance audit](../performance-audit-2026-07-10.md), not a universal
benchmark or a claim that the strict performance gate passed.

## Environment and artifacts

| Field | Recorded value |
| --- | --- |
| OS | Windows x64 `10.0.26200` |
| CPU | AMD Ryzen 9 9950X3D, 32 logical CPUs |
| RAM | 134,876,049,408 bytes |
| Browser | Headed installed Chrome `149.0.7827.201` |
| WebGPU adapter | AMD, architecture `rdna-4` |
| Upstream Dolphin | `e22551eae1c84a7e4d0b6a5c519ef4ed4ef69df1` |
| WASM | 12,807,931 bytes; SHA-256 `3af23a252929edb6a714c1ad4a856dc50921aa93eef7a5b921431ebebfd1301a` |
| ROM SHA-256 | `1018b65a58ca654056be1611a43e753de5dd5f842ce5266581b29c6a12ce7c67` |
| Save SHA-256 | `620879e2ed3c35248deba9fb2f7b2a39f91f5374d2f6a98d2a2455cb55e156d1` |
| Scene | Melee Kirby vs Link fixed battle |
| Input | None; timing starts after direct save load and checkpoint verification |

The authoritative checkpoint uses PPC PC `-2144030364`, core ticks
`15166162443` with a one-CoreTiming-slice negative observation window, exact
dimensions `640x480`, and a raster-mode-specific XFB hash. The harness does not
drive menus or stop at character select.

Software qualification starts timing only after that checkpoint passes. The
three hardware-WGPU diagnostics deliberately continued after the software-XFB
hash check failed (`4b2d0a3b` expected, zero-EFB `6fd97dc5` observed) so the
renderer classifier could run. Those WGPU results are invalid/non-qualifying
diagnostics, not fixed-checkpoint performance samples.

## Evidence labels

- `FAIL` means the run was headed and provenance-complete but contained a hard
  runtime failure or missed a strict target.
- `NON_QUALIFYING` means useful headed evidence was captured, but it did not
  meet every condition for a release performance pass.
- `SCREENING_REJECT` means a balanced two-block screen did not reach the
  declared 3% materiality threshold.
- `STATISTICAL_GATE_PASS` applies only to the tick queue-age comparison. Its
  overall report remains non-qualifying because absolute throughput targets
  were not all met.

Do not rewrite any of these labels as “passed performance validation.”

## Packaged summaries

- [Aggregate run rows](melee-performance-runs-2026-07-10.csv)
- [Machine-readable comparison decisions](melee-optimization-screens-2026-07-10.json)
- [Independent core-build parity](melee-core-build-parity-2026-07-10.json)
- [Raw evidence hashes](melee-raw-evidence-sha256-2026-07-10.txt)

The ignored `.omx/` directories on the validation machine contain each run's
`manifest.json`, `summary.json`, `samples.json`, `samples.csv`, `events.jsonl`,
console log, screenshot, and packaged build-provenance inputs. The hash ledger
lets an archived copy be verified without committing machine-specific absolute
paths or hundreds of megabytes of screenshots and samples. It hashes the WGPU
manifests specifically because the bounded classifier counters live there.

## Key raw directories

| Evidence | Raw directory | Result |
| --- | --- | --- |
| Recommended path, JIT on, 60 s | `.omx/final-qualification/software-default-current/` | `FAIL` |
| No-JIT stability soak, 180 s | `.omx/final-soak/software-nojit-180s/` | `NON_QUALIFYING` |
| Immediate tick versus queued tick | `.omx/final-confirmation/tick-immediate/` | Statistical comparison pass; overall non-qualifying |
| Metrics on/off | `.omx/final-ab/metrics-observer/` | `SCREENING_REJECT` |
| XFB row reuse | `.omx/final-ab/xfb-rows/` | `SCREENING_REJECT` |
| XFB identity decode | `.omx/final-ab/xfb-decode-validated/` | `SCREENING_REJECT` |
| Combined XFB fast paths | `.omx/final-ab/xfb-both/` | `SCREENING_REJECT` |
| Full versus balanced software raster | `.omx/final-ab/fastsw-full-vs-balanced-validated/` | Game-speed screen rejected; visual cadence differs materially |
| WebGL/2D fallbacks | `.omx/final-fallback/{webgl,2d}/` | Valid single route checks; non-qualifying |
| WGPU missing-listener diagnosis | `.omx/final-wgpu/classifier/` | `WAITING_FOR_DRAW` |
| WGPU listener control | `.omx/final-wgpu/classifier-cache-channel/` | `EFB_DRAW_NO_MUTATION` |
| WGPU post-fix `nojitcache=1` | `.omx/final-wgpu/classifier-nojitcache-fixed/` | Transport fixed; `EFB_DRAW_NO_MUTATION` remains |

## Canonical strict command

The final default manifest records:

```powershell
node tools/perf-regression-gate.mjs `
  --base-url http://127.0.0.1:8104/ `
  --duration 60 `
  --out-dir .omx/final-qualification/software-default-current `
  --strict
```

Its effective URL, with the unique probe value omitted, was:

```text
?core=upstream&video=software&cpu=dual&speed=1&present=full&presenter=webgpu&pacing=tick&wasmjit=1&jittier=guarded&jitwarmup=700&oc=1&queue=2&fastsw=1&metrics=1&xfbfast=0
```

Every run also requires the exact ROM/save paths through `ROM` and
`SAVE_STATE_PATH`, `PERF_PROBE_HEADED=1`, and a working Playwright module. See
the audit for the repeated comparison protocol and interpretation.
