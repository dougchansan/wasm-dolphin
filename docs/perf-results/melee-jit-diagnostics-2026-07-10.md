# Melee JIT and long-slice classification — 2026-07-10

This report combines the original headed 60-second Kirby-versus-Link run with
the later exploratory, promoted, and structured exact-save runs. The older
rows retain their independent maxima; the final row is a correlated same-slice
trace emitted by patch `0014`.

## Eight old emit failures

The old core exposed only `emitfail:8`, so its raw output cannot identify eight
individual PCs. Source inspection nevertheless classifies all eight attempts
with high confidence:

- The only active compile-time emitter bisection define was
  `DOLPHIN_WEB_DISABLE_FASTOTHER_31ADDZEX_ALONE`.
- The guarded prefix scanner accepted `addzex` (OPCD 31, SUBOP10 202), but that
  diagnostic define made the later emitter return false.
- `BuildWasmCachedInterpreterBlock` returned an empty module and
  `TryWriteWasmBlock` incremented `emitfail` for each attempt.
- Removing the stale diagnostic define retained the runtime
  `disable=wasmaddze` rollback and produced `emitfail:0` in the promoted core.

These were eight attempts at one disabled opcode, not evidence of eight
distinct JIT defects. Current retained evidence has zero emit failures.

## Long CPU-thread slices

Three independent runs align the run-loop, `CoreTiming::Advance`, and VI event
maxima, while PPC execution and JIT compilation remain much smaller:

| Evidence | Run-loop max | Advance max | `VICallback` max | Execute max | JIT compile-burst max |
| --- | ---: | ---: | ---: | ---: | ---: |
| Original headed 60 s | 59.204 ms | 59.139 ms | 59.059 ms | 4.164 ms | 1.264 ms |
| Exploratory rebuilt core | 54.220 ms | 54.169 ms | 54.084 ms | 4.719 ms | 1.451 ms |
| Promoted clean core | 48.015 ms | 47.990 ms | 47.934 ms | 3.045 ms | 0.767 ms |
| Structured candidate, 30 s | 57.590 ms | 57.580 ms | 57.490 ms | 0.009 ms | 1.138 ms whole-run maximum; 0 in the worst slice |

The repeated 46–61 ms class is therefore not explained by a JIT compile burst
or a long block-execution burst. In the promoted run, the VI subphase probe
further split the slow callbacks:

| VI subphase, samples over 5 ms | Count | Conditional p50 | Conditional p95 | Max |
| --- | ---: | ---: | ---: | ---: |
| End-field `fields` | 150 | 40.859 ms | 46.889 ms | 47.755 ms |
| SI-poll `siPoll` | 190 | 24.964 ms | 45.939 ms | 47.599 ms |

Both regions contain calls to `CoreTiming::Throttle`, which reaches
`SleepUntil`. Existing video-output profiling put useful software XFB/publish
work near 0.8–2.1 ms, far below the VI maxima. The evidence-backed current
classification is therefore **VI pacing wait**: most of the long wall-clock
slice is deliberate throttle/scheduler waiting, not CPU saturation.

The rebuilt structured collector then measured the same worst slice directly:

```text
sliceprof:total=57590,advance=57580,execute=9,compile=0,throttle=57235,dvd=0,video=255,event=VICallback
```

Throttle wait owns 99.38% of that slice. The analyzer therefore reports
`pacing-wait` from `structured-correlated-slice`, with only 91 microseconds
unattributed. This is same-slice proof that the retained 50–60 ms class is
deliberate pacing/scheduler wait rather than CPU, JIT, raster, or DVD work.
Removing the throttle merely to shrink the maximum would invalidate pacing,
audio, and latency behavior.

## DVD completion spikes

`FinishReadDVDThread` produced 9–16 ms slow-event samples. Its callback reaches
`m_result_queue.WaitForData()` before result lookup, RAM copy, and command
completion. The queue wait is the likely owner, but no retained run has nested
timers around those operations. Treat this as **probable DVD I/O wait**, not a
measured copy or scheduler result, until the collector captures a DVD-owned
worst slice. The structured collector did run, but its single retained worst
tuple was VI pacing with `dvd=0`. In that final run, `FinishReadDVDThread`
appeared nine times at 12.921 ms average and 16.059 ms p95/max; those are
whole-run event statistics, not same-slice ownership.

## Structured classification contract

Snapshot patch `0014-correlated-core-timing-profile.patch` adds one metrics-gated
thread-local accumulator for each CPU/CoreTiming slice. It records actual
`SleepUntil` time, actual DVD `WaitForData` time, exclusive VI work after
subtracting nested waits, synchronous module-plus-instance JIT time, and the
longest event category. The CPU thread publishes only the greatest-total slice
through a coherent sequence-guarded snapshot; scheduling and pacing calls are
unchanged. With metrics disabled, the per-slice and VI callback clocks are
skipped.

`GetPpcWasmHelperStats` emits that snapshot as one compact record:

```text
sliceprof:total=48015,advance=47990,execute=25,compile=0,throttle=47755,dvd=0,video=210,event=VICallback
```

`tools/jit-diagnostics-analyze.mjs` accepts this record, a direct correlated
tuple, or a tuple nested at `coreTimingProfile.runloop.max`:

```json
{
  "totalUs": 48015,
  "advanceUs": 47990,
  "executeUs": 25,
  "compileUs": 0,
  "throttleWaitUs": 47755,
  "dvdWaitUs": 0,
  "videoWorkUs": 210,
  "event": "VICallback"
}
```

The analyzer compares mutually exclusive ownership buckets and requires one
component to account for at least 80% of `totalUs`. It reports:

- `pacing-wait`
- `dvd-io-wait`
- `video-work`
- `cpu-block-execution`
- `jit-compile`
- `mixed`

`executeUs` includes synchronous compilation in the current run loop, so the
CPU-only bucket is calculated as `max(0, executeUs - compileUs)`. Until a
structured tuple is present, the analyzer preserves the legacy
`core-timing-advance` classification and labels its source
`legacy-independent-maxima`.

## Reproduction

Run the reusable parser against a gate summary and console log:

```powershell
npm run jit:analyze -- `
  --summary <run>/summary.json `
  --console <run>/console.log `
  --out <run>/jit-diagnostics.json
```

The schema-v2 parser discovers a compact or structured tuple when present and
otherwise falls back to legacy helper maxima. Legacy worker/main slow-event
messages are deduplicated by event name, duration, and per-source occurrence
count, so
repeated real samples are retained while mirrored messages are counted once.
The committed machine-readable file retains the original evidence and adds the
structured validation separately. The headed validation used the direct-loaded
Kirby-versus-Link save for 30 seconds on Chrome 143 and is archived at
`.omx/next/final-correlated-slices/software-hybrid-1/`. All components were
finite and bounded by their owning `advanceUs` or `executeUs` region. The run's
only generic health failure was the pre-window `boot-snappy` threshold
(5.630 seconds versus 5 seconds); the timed battle window averaged 98.68% game
speed, 59.28 core FPS, 57.52 presentation FPS, and 12.80 unique visual FPS.
