# Melee software-hybrid validation

> **Historical baseline:** this sheet records the earlier 2026-07-09 run. Use
> the [2026-07-10 evidence package](melee-performance-evidence-2026-07-10.md)
> and [audit](../performance-audit-2026-07-10.md) for the current pinned core,
> direct-save protocol, repeated comparisons, and strict-run verdict.

This page is a repeatable results sheet and a place for the current claimed
baseline. It intentionally contains no invented benchmark values. The claim to
validate is: on a suitable modern desktop Chrome setup, the recommended
software-hybrid path can approach 100% game speed, while distinct visual-frame
cadence remains limited by software rasterization.

## Test machine

AMD Ryzen 9 9950X3D, 128 GB RAM, win32 / NT 10.0.26200. Installed display
adapters included an AMD Radeon RX 9070 XT, AMD integrated graphics, and a
Parsec virtual adapter. The Chrome-selected adapter, power mode, and display
refresh rate were not captured.

## Browser

Headed Chrome 143.0.7499.4 with the validator's WebGPU/autoplay launch flags.

## Branch/commit

`perf/instrumentation-baseline` /
`4f60ddcbff3dce8ee5271623b6b078dacadc5cf6`

## Core artifact hash/size

12,800,707 bytes; SHA-256
`03df79d2eb4be6c1e05d58d79ad4ab9590a9407c19fa5ae70e088401f424af3f`.

## ISO/game version

Melee NTSC-U Rev 2 NKit ISO; SHA-256
`1018b65a58ca654056be1611a43e753de5dd5f842ce5266581b29c6a12ce7c67`.

## URL flags

```text
?core=upstream&video=software&presenter=webgpu&cpu=dual&speed=1&wasmjit=1&jitwarmup=700&oc=1&pacing=tick&fastsw=1&metrics=1
```

## Save-state or scene

Direct load into the visually confirmed Kirby-versus-Link battle, with no
scripted input after load. Save-state SHA-256:
`620879e2ed3c35248deba9fb2f7b2a39f91f5374d2f6a98d2a2455cb55e156d1`.

## Duration

Two 45-second JIT-on runs and two 30-second no-JIT controls per selected raster
mode. The table uses the post-JIT window for JIT-on rows and the post-20%
warmup window for no-JIT rows.

## Metrics captured

Timed runs captured game speed, source/XFB FPS, presentation FPS,
unique/visual FPS, interval counters, audio samples, console errors, and raw
JSON/CSV. Screenshots were disabled during timed runs; a separate untimed
visual-confirmation run verified the Kirby-versus-Link scene.

## Results

| Run | Mode | Game speed % | Core FPS | Presentation FPS | Unique/visual FPS | Final 500 ms p95 | Lifetime max | Notes |
| --- | ---- | -----------: | -------: | ---------------: | ----------------: | --------------: | --------------: | ----- |
| JIT-on trial 1 | software + WebGPU presenter, `fastsw=1` | 89.71 | 53.79 | 45.82 | 10.82 | 17.2 | 43.0 | Cold ephemeral profile; post-JIT window |
| JIT-on trial 2 | software + WebGPU presenter, `fastsw=1` | 93.58 | 56.32 | 45.53 | 10.68 | 17.8 | 25.6 | Cold ephemeral profile; post-JIT window |
| JIT-off control 1 | software + WebGPU presenter, `fastsw=1` | 96.64 | 57.80 | 47.84 | 10.68 | 18.0 | 34.0 | Post-warmup window |
| JIT-off control 2 | software + WebGPU presenter, `fastsw=1` | 95.36 | 57.40 | 47.32 | 10.72 | 17.7 | 24.3 | Post-warmup window |

Game speed measures emulation progress relative to the target console timing.
The current “Core FPS” implementation is source/XFB callback cadence, not a
second CPU-throughput counter. Presentation FPS measures recorded fresh-frame
presentation events; tick-mode duplicate repaints are not all counted.
Unique/visual FPS measures how many sampled frames are actually changing. For
software rasterization, unique/visual FPS can be below 60 even when game speed
is near 100%.

The p95 column is only the worker's final 500 ms interval window. Lifetime max
covers the entire run and can occur before the post-JIT/post-warmup averaging
window. Neither interval column describes the same time window as the averaged
FPS values.

See the [full audit](../performance-audit-2026-07-09.md) and
[aggregate CSV](melee-kirby-link-fixed-battle-2026-07-09.csv) for presenter
controls, aggressive raster modes, provenance, and caveats.

## Fixed-battle gate

`perf:gate` no longer navigates Melee's menus or stops at character select. It
requires the exact ISO and Kirby-versus-Link save, verifies both SHA-256 values,
waits for core progress, loads the save with `SAVE_STATE_AT=0`, settles, and
only then starts the timed window. Gameplay input is always `none`; a configured
menu-driving script is rejected before Chrome launches.

```powershell
$env:ROM = '<verified Melee Rev 2 NKit ISO>'
$env:SAVE_STATE_PATH = '<verified Kirby-vs-Link __battle.sav>'
$env:PERF_PROBE_HEADED = '1'
npm run perf:gate
```

If Playwright is installed in the validator's existing isolated probe rather
than this worktree, set `PLAYWRIGHT_MODULE` to its `playwright/index.mjs`.

Every run writes `manifest.json`, `events.jsonl`, `samples.json`, `samples.csv`,
`summary.json`, `console.log`, and `final.png`. Headless mechanics runs are
marked `NON_QUALIFYING` and exit nonzero; performance claims require headed
Chrome plus complete build, patch, toolchain, browser-profile, adapter, cache,
ABI, event-schema, and served-artifact provenance. Summary metrics name the
complete timed window and post-warmup steady-state window separately.
Qualification requires the hermetic build's
`cores/dolphin/dolphin-core-upstream.build.json`. The gate compares that
manifest field-for-field with the committed Dolphin source, core ABI, vendor
snapshot, and WASM toolchain locks, then verifies both generated core artifacts
against the ABI and build manifests. The Naga Cargo lock is checked too. A
dirty benchmark checkout, dirty build manifest, missing lock, changed core JS
or WASM, unsupported schema, or lock/worktree mismatch is non-qualifying.
Legacy provenance environment variables are recorded as untrusted context and
cannot satisfy or override these checks. Each run packages byte-identical
copies of the build manifest and locks under `build-provenance/`.

Before Chrome launches, the gate discovers and hashes the complete local
ES-module dependency closure rooted at the page, app, worker, and generated
core module, then verifies every dependency from the served origin. The run
manifest records the actual launched browser executable/channel and asks the
worker for the requested and accepted Dolphin video backend separately from
the requested and active presenter backend. It also records adapter, device,
fallback, device loss, uncaptured-error, error-scope, retained status history,
and Emscripten `printErr` evidence. Worker RPCs have bounded timeouts; WebGPU
validation, real-clear/show-image failures, WASM link/runtime errors, and
presenter fallbacks invalidate the run instead of disappearing behind the
latest status.

Content-addressed core fallback is explicit in
`rendererDiagnostics.coreSelection`: it records requested and active core
URLs/SHA-256 values, the preflight failure reason, and whether rollback
happened before canvas transfer. A candidate-core 404 remains a console error
unless a dedicated rollback-smoke test declares that exact failure expected;
the generic performance gate must not ignore 404s broadly.

For a bounded A/B screen, pass
[`melee-screening.example.json`](melee-screening.example.json) with
`--comparison-config`. Screening is exactly two fresh-process A/B/B/A and
B/A/A/B blocks and can never promote a default. Confirmation starts with five
blocks, extends one block at a time up to ten, and stops once exact permutation
evidence resolves. One invalid run invalidates the complete four-run block;
the task list, invalid artifacts, block effects, block-bootstrap interval, sign
permutation result, and any `INCONCLUSIVE` outcome remain in the output.

```powershell
npm run perf:gate -- --comparison-config docs/perf-results/melee-screening.example.json
```

Comparison arms currently support explicit `cold` ephemeral profiles or
`disabled` JIT cache (`nojitcache=1`). A true warm-cache protocol remains a
separate experiment because silently treating the first run of a profile as
warm would invalidate the block.
