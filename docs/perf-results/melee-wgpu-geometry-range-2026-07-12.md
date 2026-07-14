# Melee hardware-WGPU geometry-range screen (2026-07-12)

## Decision

**REJECT as a performance optimization; keep default-off.** A 256 KiB
pass-local geometry range removed 98.67% of geometry upload records, but two
swapped-order headed pairs were effectively tied. Mean fixed-work game speed
was 65.803% with ranges and 65.860% without them (-0.087%). Record count is
therefore not the limiting hardware-WGPU throughput lever in this scene.

The earlier 8 MiB range was also rejected. It reached 59.141% game speed versus
67.926% for the same candidate with ranges disabled while increasing mapped
staging seals and remap latency. Bounding ranges to 256 KiB recovered that
regression but did not create a gain.

## Fixed screen

- Scene: direct verified `__battle.sav` load into Kirby versus Link.
- Browser/GPU: headed Chrome 150.0.7871.114 on AMD `rdna-4`.
- Core: 12,901,633 bytes, SHA-256
  `2fc5e3cd52a77ac1850549eb1a766ab166733d4875e5fd3ec477b1d7222b16ea`.
- Common mode: true hardware WebGPU, mapped uploads, three 16 MiB staging
  slots, 32 MiB upload arena, geometry packing on, JIT off, metrics and GPU
  completion on.
- Work: eight emulated core seconds, no menu or character-select driving.
- Order: range on/off, then off/on.

| Run | Range | Game speed % | Core FPS | Wall s | Geometry calls | Max range bytes | Capacity wait ms | Audio underruns |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | On | 64.735 | 38.848 | 12.536 | 2,112 | 262,136 | 4,353.175 | 1 |
| 2 | Off | 64.874 | 38.892 | 12.419 | 159,060 | 56,100 | 4,383.250 | 2 |
| 3 | Off | 66.845 | 40.099 | 12.120 | 147,749 | 56,100 | 4,579.715 | 0 |
| 4 | On | 66.870 | 40.158 | 11.978 | 1,969 | 262,144 | 4,344.335 | 3 |

All four runs were headed, qualification-eligible, reached the fixed-work
target, changed visible pixels, loaded the selected content-addressed WASM, and
reported zero WebGPU errors, command drops, pass aborts, and upload timeouts.
Three runs were invalid only because the audio integrity gate observed new
underruns, so the speed values are descriptive and cannot promote a default.
The two pairs nevertheless agree that the range has no material throughput
effect.

## Interpretation

The range trades many small `UPLOAD_BUFFER` records for a scratch-vector copy
and one later upload per bounded range. It does not reduce geometry bytes and
does not materially reduce mapped-staging capacity-wait time. A zero-extra-copy
range cannot safely span intervening UBO arena allocations without a separate
geometry arena or an out-of-order upload-release protocol. Since record removal
alone produced no speed gain, that larger refactor is not justified by this
experiment.

Raw ignored artifacts are under `.omx/wgpu-no-lag/geometry-range-256k-*`.
The adjacent JSON file retains the compact values and raw paths.
