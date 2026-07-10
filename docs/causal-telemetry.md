# Causal performance telemetry

`?metrics=1` exposes `window.__causalTelemetry` and includes the same object in
`window.__lastFrameInfo.causalTelemetry`. The object has
`schemaVersion: 1`; consumers must reject unknown versions rather than guessing
at field meanings. Existing `ppcWasmHelperStats` and `frameProfileStats`
strings remain available for compatibility.

The performance gate writes the complete object to `samples.json` and each
`sample` event in `events.jsonl`. `samples.csv` contains the JSON object plus
fixed `causal*` columns for the main classification fields. A run manifest
records `causalTelemetrySchema.version` separately from the harness event
schema.

## Measurement groups

| Group | Measurements |
| --- | --- |
| `core` | frame, live worker-observed ticks/PC, tick rate, and CPU-thread after-load checkpoint generation/ticks/PC |
| `softwareRaster` | source XFB count/dimensions/stride/hash/nonzero count, XFB interval/decode, video-output sync/publish/total, and software encode/convert/copy times |
| `presentation` | backend, pacing, queue depth/target/limit/age/lag, underruns/drops, interval and FPS fields, plus structured JS capture/copy/draw/hash/present stage windows |
| `webgpu` | command-ring registration, drain/empty/processed counts, drain duration, backlog/high-water, deferrals, and errors |
| `workerTraffic` | request/one-way/response/notification counts, actual transferable bytes, estimated payload bytes, and per-type counts |
| `audio` | worker mix duration/count/frames, pump gaps/skips, mix round-trip, observable schedule underrun/overrun, lead, and drift |
| `input` | changed states, message posts, SAB writes/generation, worker applies, and observed input age |
| `host` | rAF loop/render/publish duration and main-thread RGBA copy, `putImageData`, and `drawImage` duration |

Counts and directly available byte totals are kept cheaply. Stage timers,
payload estimates, structured parsing, and snapshot cloning are enabled only
by `metrics=1`. The structured snapshot is throttled to at most five updates
per second so normal frame and audio messages do not carry a large telemetry
object.

## Save-state checkpoint timing

`CoreTiming::GetTicks()` is CPU-thread-only, while the legacy `coreTicks` field
is polled by the disc-I/O worker. The existing
`State::SetOnAfterLoadCallback` now captures ticks and PPC PC into atomics as
its first action, before GPU/FIFO resynchronization. A rebuilt core exposes:

- `GetLastLoadedCoreTicksLow`
- `GetLastLoadedCoreTicksHigh`
- `GetLastLoadedPPCPC`
- `GetLastLoadedCheckpointGeneration`

The worker reads a generation-stable snapshot and publishes
`loadedCheckpoint*` fields. Fixed-scene validation prefers that authoritative
CPU-thread capture and retains `legacyCoreTicks` and `legacyPpcPc` for
diagnosis. Older artifacts do not expose these functions; their generation is
zero and validation retains the legacy behavior. Do not loosen the fixed
Kirby-vs-Link checkpoint to hide a worker-thread tick discrepancy.

The C++ source and pinned CMake export list are prepared here, but generated
core artifacts are not committed by instrumentation work. A hermetic core
rebuild must precede qualification of the new checkpoint fields.

## Interpretation

Compare deltas over the same fixed battle and use several interleaved A/B
blocks. A high game-speed value does not clear the software renderer: high
`softwareRaster.encodeTotalMs`, low source XFB cadence, or high XFB decode time
can still limit distinct frames. Likewise, a high presentation FPS does not
mean commands reached the GPU; inspect command-ring processed counts/backlog
and renderer errors. Audio presence does not prove smooth audio; pump gaps,
schedule underruns, and mix round-trip time classify different failure modes.
