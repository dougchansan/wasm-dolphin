# Reusing immediate WebGPU upload memory

An isolated worker change improved both paired Melee measurements by reusing CPU memory for immediate queue-buffer uploads. The two pairs differ in gain size; these results do not establish sustained 60 FPS or an improvement across all games.

| Pair | Original worker | Scratch worker | Change |
| --- | ---: | ---: | ---: |
| A1 / B1 | 45.90 FPS | 48.92 FPS | +6.58% |
| A2 / B2 | 49.45 FPS | 56.77 FPS | +14.80% |

The ratio of mean frame rates improves 10.84%. Runs used fresh Chrome 143.0.7499.4 instances in ABBA order on the Ryzen 9 9950X3D / Radeon RX 9070 XT machine. Both versions used the same explicit `0x5555` process affinity, native core, game and checkpoint hashes, audible worklet audio, 20 emulated seconds of warm-up and 30 emulated seconds of measurement. No profiling, builds or tests overlapped the accepted runs. An earlier control was excluded because overlap with a completed 98 ms VM test could not be ruled out.

The four before/final screenshot pairs show the same active Great Bay battle with Kirby and Link, matching damage values and the timer advancing approximately 04:42 to 04:12. A few frames of timing/camera variation remain. Each run kept JIT enabled, recorded no native input updates, completed both GPU fences, and reported zero audio underrun events/frames, overruns or renderer errors. Compilation continued during measurement.

The production core is `7479b6c803ff1d19e4c03b3654c69e4fe95a6a4367b411ba11769c65730b112c`. The original worker is `624c4f619038a2d6d0d364be65db56ed1cd7a2bba0be4c239ac032d6db8b7a10`; the scratch worker is `f2ff1fda27fde40b7d018303dfa1a9454e39b0619901663634aed3514ab68677`. Benchmark workers added the same post-measurement policy probe; their exact hashes are retained in the [machine-readable result](melee-upload-scratch-2026-09-07.json).

The change adds one private byte buffer that grows geometrically up to 4 MiB. Larger uploads retain the existing allocation path. Only the immediate queue-buffer copy uses this storage; held uploads, mapped staging and textures retain their previous ownership. Every returned view has the exact padded length, and padding is reset to zero. The [WebGPU writeBuffer algorithm](https://gpuweb.github.io/gpuweb/#dom-gpuqueue-writebuffer) snapshots source bytes before issuing later device work, so the scratch buffer can be reused after the call returns.

Seven prototype VM checks passed. A real Chrome GPU probe compared 9,582,512 bytes for each version across 19 sizes, including four-byte padding, shared-memory sources, maximum scratch size, oversized fallback, and immediate source/scratch overwrites before GPU completion. Both readbacks were identical with zero mismatches or validation errors. These establish byte-transfer behavior; game screenshots provide separate visual evidence.

The exact tested worker was applied locally after the Mario Kart Wii smoke run and an independent ownership review found no blocking issue. Six shipping regressions, all 922 repository tests, syntax checking and provenance verification passed; the core ABI record was refreshed. The native WASM is unchanged. The source change is in `src/upstream-discio-worker.js`, with regressions in `tests/wgpu-immediate-upload-scratch.test.mjs`.

The Wii smoke used the repaired minimap checkpoint. The track outline remains visible and no displaced left-side overlay appears in either fenced race capture. Its timer advances approximately 00:30.82 to 01:00.82; the strict three-frame resume pulse matched, input updates remained 2 before/after timing, JIT stayed enabled and audio/renderer error counters stayed clean. It measured 41.85 FPS in this scene with the same `0x5555` process affinity. There is no matched Wii control here, so this is not a Wii speed-improvement claim. General GPU save-state readback remains incomplete; the recovered course image does not repair other missing saved textures.

Private harnesses, byte probes and captures are under `.omx/full-speed/replay-upload-scratch`, `replay-upload-gpu-probe`, `replay-upload-bench`, and `dispatch-bench`. Game assets and captures are excluded from source commits.
