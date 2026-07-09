# Melee software-hybrid validation

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
