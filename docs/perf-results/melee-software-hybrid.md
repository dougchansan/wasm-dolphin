# Melee software-hybrid validation

This page is a repeatable results sheet and a place for the current claimed
baseline. It intentionally contains no invented benchmark values. The claim to
validate is: on a suitable modern desktop Chrome setup, the recommended
software-hybrid path can approach 100% game speed, while distinct visual-frame
cadence remains limited by software rasterization.

## Test machine

`TODO: CPU, GPU, RAM, operating system, power mode, display refresh rate`

## Browser

`TODO: exact Chrome version, command-line flags, headed/headless state`

## Branch/commit

`webgpu-hardware-renderer` / `TODO: repository commit SHA`

## Core artifact hash/size

`TODO: dolphin-core-upstream.wasm SHA-256 and byte size`

## ISO/game version

`TODO: Melee region/revision and a non-infringing identity/hash record`

## URL flags

```text
?core=upstream&video=software&presenter=webgpu&cpu=dual&speed=1&wasmjit=1&jitwarmup=700&oc=1&pacing=tick&fastsw=1&metrics=1
```

## Save-state or scene

`TODO: exact navigation/input script, save-state identity, and scene boundaries`

## Duration

`TODO: warmup duration, measured duration, and number of repeated runs`

## Metrics captured

Capture game speed, core FPS, presentation FPS, unique/visual FPS, p95 and
maximum presentation intervals, audio symptoms, console errors, screenshots,
and the raw validator output (`samples.json` when produced by the headed Chrome
harness).

## Results

| Run | Mode | Game speed % | Core FPS | Presentation FPS | Unique/visual FPS | p95 interval ms | Max interval ms | Notes |
| --- | ---- | -----------: | -------: | ---------------: | ----------------: | --------------: | --------------: | ----- |
| TODO: fill from next headed Chrome validation run | software + WebGPU presenter, `fastsw=1` | TODO | TODO | TODO | TODO | TODO | TODO | No measured result recorded here yet |

Game speed measures emulation progress relative to the target console timing.
Presentation FPS measures canvas/presenter cadence. Unique/visual FPS measures
how many distinct frames are actually changing. For software rasterization,
unique/visual FPS can be below 60 even when game speed is near 100%.
