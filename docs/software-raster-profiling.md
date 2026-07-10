# Software raster phase profiling

The software renderer exposes a metrics-gated phase profile for separating
triangle traversal, TEV/color work, texture sampling, FIFO pressure, XFB
generation, source-frame cadence, and stale-frame reuse. It is diagnostic
instrumentation only; it does not select a raster mode or change rendered
output.

## Activation and interpretation

Use the normal software-hybrid URL with `video=software&metrics=1`. The worker
enables this profile only for the exact `Software Renderer` backend; WGPU,
OGL, and the legacy `video=webgpu` alias do not pay its hot-path cost. With
`metrics=0`, phase counters and clocks remain inactive. The enable call is a
pre-core-initialization configuration step, not a runtime toggle. A rebuilt
metrics-on software run is invalidated if any required phase never activates.

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
| `fifo*` | Batched gather-pipe bursts/consumes, pending bytes, and sampled continuous-backlog age |
| `fifoDistanceUnderflowCount` | Count of impossible `<32` byte distances clamped by diagnostic instrumentation |
| `xfbGeneration*` | XFB encode calls and exact encode time reported by the existing software XFB hook |
| `frameGeneration*` | Reached `Video_OutputXFB` bridge calls and source-generation intervals |
| `sampledSourceFrame*` | Presenter-bound source frames classified by the existing sampled pixel hash |
| `staleRepaintCount` | Tick paints that intentionally reuse the last stable source frame |

Traversal is clocked once per 64 calls. TEV and texture sampling are clocked
once per 4,096 calls. Durations accumulate as nanoseconds and publish as
microseconds so sub-microsecond calls do not all truncate to zero. Phase
counters publish from the renderer thread at sampled-call boundaries; FIFO
counts publish in batches of 1,024. Fields can therefore lag by one sampling
batch. Fields named `Sampled` are deliberately not extrapolated into total
phase time. Compare average sampled cost and work counts rather than treating
sampled totals as a full-frame breakdown.

`sampledStaleFrameRatio` is based on the existing sparse visual hash, so it is
a classification of sampled output, not a cryptographic equality check.
`fifoConsumerObservedBacklogAge*` is the canonical JSON/CSV name for the age of
a continuously non-empty backlog as observed by the consumer. The deprecated
`fifoOldestPendingAge*` fields remain equal aliases for schema-v2 compatibility;
they do not mean true oldest-item residence time. Age is sampled once per 1,024
consumes to avoid hundreds of thousands of clock reads per second. Read it with
`fifoBytesLast`, `fifoBytesMax`, and the underflow counter; it is not a
producer-to-consumer latency for every 32-byte burst.

## Validated rebuild handoff

Do not claim phase evidence from the older candidate-C artifact: its phase
counters remained thread-local and its FIFO age could wrap to `UINT64_MAX`.
The validated replacement contains the epoch reset, sampled delta publication,
reached XFB frame hook, FIFO batching, and saturated-distance counter.

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

The independent builds matched exactly at WASM SHA-256
`158dde37602442bf1dacf42328501082b46b47768b2455946fcb4c596fcdb5ea`.
Three direct-save metrics-off/on pairs and activation evidence are packaged in
[the software-raster phase result](perf-results/melee-software-raster-phases-2026-07-10.md).

Rollback is one commit: remove snapshot patch
`0009-software-raster-phase-profile.patch`, the bridge header/export, and the
schema-v2 phase fields. The pre-existing XFB and presentation metrics continue
to work independently.
