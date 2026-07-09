# Current status

wasm-dolphin is a research prototype built around upstream Dolphin compiled to
WebAssembly with Emscripten. The only best-supported target today is **Super
Smash Bros. Melee**.

The recommended configuration is:

```text
?core=upstream&video=software&presenter=webgpu&cpu=dual&speed=1&wasmjit=1&jitwarmup=700&oc=1&pacing=tick&fastsw=1&metrics=1
```

This is the **software-hybrid path**: Dolphin's software rasterizer produces
the correct frames, and browser WebGPU presents or blits those frames to the
canvas. It is not hardware-accelerated emulation of Dolphin's GPU pipeline.

“Near-100% game speed” describes emulation/core timing. It does not promise
native-smooth unique visual output. The best-quality recommended fast mode can
produce low unique visual FPS during heavy motion even while the game advances
at nearly the intended rate. `fastsw=2` and `fastsw=3` trade more image
quality for distinct-frame cadence, but can also reduce game speed in some
scenes. `fastsw=1` is the balanced/crisp default; literal full-resolution
software rasterization is `fastsw=0`.

The true WebGPU hardware renderer is selected with `video=wgpu`. It is
experimental and parked, and it may render black or stop at a diagnostic
pattern instead of a game frame. Wii and broader GameCube compatibility are
not the current focus.

| Area | Current status | Confidence |
| --- | --- | --- |
| Melee boot/gameplay | Playable on software-hybrid path | High, if locally validated |
| Core/game speed | Near 100% on modern desktop Chrome | Needs machine-specific metrics |
| Unique visual FPS | Software-raster limited | Known limitation |
| Audio | Worker-fed/tuned, but validate per run | Medium |
| True WebGPU hardware renderer | Experimental, GPU-dependent | Low/medium |
| General compatibility | Unverified | Low |

Record machine-specific evidence in
[the Melee software-hybrid results sheet](perf-results/melee-software-hybrid.md)
rather than treating these status statements as universal benchmark results.
