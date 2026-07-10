# Software raster phase profiling

The software renderer exposes a metrics-gated phase profile for separating
triangle traversal, TEV/color work, texture sampling, FIFO pressure, XFB
generation, source-frame cadence, and stale-frame reuse. It is diagnostic
instrumentation only; it does not select a raster mode or change rendered
output.

## Activation and interpretation

Use the normal software-hybrid URL with `metrics=1`. The worker calls
`SetSoftwareRasterProfileEnabled(1)` before `CoreInit`. With `metrics=0`, phase
counters and clocks remain inactive; the hot functions retain only an inline
disabled check. A post-rebuild metrics-on run is invalidated if any required
phase never activates.

The C++ profile is published in `GetVideoStats` as `swphase:1` and promoted to
causal telemetry schema v2. Raw `samples.json`, `samples.csv`, and
`events.jsonl` retain these fields:

| Group | Meaning |
| --- | --- |
| `rasterTraversal*` | Calls to scissor-specific triangle traversal and deterministically sampled traversal time |
| `rasterCandidatePixelCount` | Pixels reaching raster work after the selected `fastsw` skip |
| `tevPixelCount`, `tevStageCount` | TEV pixels and total indirect/color stages evaluated |
| `tevTimed*` | Inclusive TEV timing samples; texture work inside those TEV calls remains included |
| `textureSample*` | Texture sample calls and independently sampled texture time |
| `fifo*` | Gather-pipe bursts/consumes, pending bytes, and oldest-pending wall-clock age |
| `xfbGeneration*` | XFB encode calls and exact encode time reported by the existing software XFB hook |
| `frameGeneration*` | Software `ShowImage` calls and generation intervals |
| `sampledSourceFrame*` | Presenter-bound source frames classified by the existing sampled pixel hash |
| `staleRepaintCount` | Tick paints that intentionally reuse the last stable source frame |

Traversal is clocked once per 64 calls. TEV and texture sampling are clocked
once per 4,096 calls. Counts are cumulative and exact at the most recently
published generated frame; fields named `Sampled` are deliberately not
extrapolated into total phase time. Compare their average sampled cost and
work counts rather than treating sampled totals as a full-frame breakdown.

`sampledStaleFrameRatio` is based on the existing sparse visual hash, so it is
a classification of sampled output, not a cryptographic equality check.
`fifoOldestPendingAge*` starts when an empty FIFO receives its first 32-byte
gather burst and is sampled as chunks are consumed. Read it together with
`fifoBytesLast` and `fifoBytesMax`.

## Required rebuild handoff

The committed WASM predates this instrumentation. The ABI manifest therefore
lists `_SetSoftwareRasterProfileEnabled` under
`sourceOnlyExportsPendingRebuild`; no headed result may claim phase evidence
until a new core is built and that pending list is empty.

Produce two independent candidates before promoting generated artifacts:

```powershell
npm run fetch:dolphin
npm run patch:upstream

$env:DOLPHIN_WASM_BUILD_DIR = "build/raster-profile-a"
$env:DOLPHIN_WASM_OUTPUT_DIR = "build/raster-profile-a-output"
npm run configure:upstream
npm run build:upstream:full-core

$env:DOLPHIN_WASM_BUILD_DIR = "build/raster-profile-b"
$env:DOLPHIN_WASM_OUTPUT_DIR = "build/raster-profile-b-output"
npm run configure:upstream
npm run build:upstream:full-core

npm run compare:core-builds -- `
  build/raster-profile-a-output/dolphin-core-upstream.build.json `
  build/raster-profile-b-output/dolphin-core-upstream.build.json
```

Only after byte/section parity should the candidate be run against the exact
Kirby-versus-Link save with the direct-save performance gate. Run repeated
metrics-off versus metrics-on blocks to quantify probe overhead, then retain a
metrics-on fixed-scene run to classify the raster phases. Record the candidate
artifact hash, Chrome version, command, URL, and raw output directory.

Rollback is one commit: remove snapshot patch
`0009-software-raster-phase-profile.patch`, the bridge header/export, and the
schema-v2 phase fields. The pre-existing XFB and presentation metrics continue
to work independently.
