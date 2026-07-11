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

The true WebGPU hardware renderer is selected with `video=wgpu`. It remains
experimental and is not the recommended path. On the current validation
machine it now reaches the direct-loaded Kirby-versus-Link battle, presents a
changing game image, and produces nonzero XFB/backbuffer readbacks. The first
one-draw post-load EFB pass correctly restores the save's all-zero EFB; it is
not the first gameplay draw and should not be forced to mutate that data. The
path is still far from full speed. A clean fixed-work screen measured roughly
49-52% throughput with diagnostics and exposed 594k-820k buffer-upload calls
plus three upload-timeout/pass-abort events. Results remain GPU- and
machine-dependent. Wii and broader GameCube compatibility are not the current
focus.

| Area | Current status | Confidence |
| --- | --- | --- |
| Melee boot/gameplay | Playable on software-hybrid path | High, if locally validated |
| Core/game speed | Near 100% on modern desktop Chrome | Needs machine-specific metrics |
| Unique visual FPS | Software-raster limited | Known limitation |
| Audio | Worker-fed/tuned, but validate per run | Medium |
| True WebGPU hardware renderer | Fixed battle visible; slow and experimental | Medium on one GPU, low generally |
| General compatibility | Unverified | Low |

Record machine-specific evidence in
[the latest Melee evidence package](perf-results/melee-performance-evidence-2026-07-10.md)
and [software-raster phase result](perf-results/melee-software-raster-phases-2026-07-10.md)
and [final optimization evidence](perf-results/melee-final-optimization-evidence-2026-07-10.md)
rather than treating these status statements as universal benchmark results.
