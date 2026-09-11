# GPU watermark-store experiment — 2026-09-07

The candidate's Melee gains were **3.86% and 0.16%** in the two paired comparisons. Mean FPS increased 2.02%, but the second pair is effectively neutral at this scale. Keep the change experimental; these results do not justify changing the production default or establish full-speed gameplay.

| Run order | Store elision | Core FPS | Emulation speed |
| --- | --- | ---: | ---: |
| A1 | Off | 44.045 | 73.51% |
| B1 | On | 45.745 | 76.35% |
| B2 | On | 43.734 | 72.99% |
| A2 | Off | 43.665 | 72.88% |

Both arms use the same `0x5555` mask on their own Chrome process families, verified before and after measurement. This is the previously identified group of physical cores sharing this machine's largest L3 cache. It is a controlled benchmark configuration, not a claim about default browser scheduling on other machines.

## Change and build controls

The candidate skips only same-value writes to the two GPU-side FIFO watermark flags. It preserves separate FIFO-distance observations, later flag reloads, CPU-side writes, breakpoint handling, interrupt scheduling, and other synchronization.

- Baseline/core: `7479b6c803ff1d19e4c03b3654c69e4fe95a6a4367b411ba11769c65730b112c`.
- Candidate/core: `53d47d7e59aabfef267fbd1d01308e01165a36d5943e4d402f4d43e182fe5f1c`.
- Worker: `624c4f619038a2d6d0d364be65db56ed1cd7a2bba0be4c239ac032d6db8b7a10`.

VFS overlays keep the compiler's original logical source path while reading private copies. Both the unmodified-copy control and disabled-gate control reproduce the production object and WASM exactly. The enabled candidate is compiled from the same input set, with production files untouched.

The final WASM audit finds only one changed body: index 3539, 487→515 bytes. Two load/compare guards make the existing stores conditional. The required atomic instruction sequence and remaining suffix are preserved; all other sections and 12,342 other function bodies are byte-identical. No old symbol map was used to name functions.

## Correctness evidence

The actual original and candidate GPU status methods match observable flags/interrupt behavior across 262,144 instrumented configurations, 16 reload cases, named interleaving witnesses and delayed-acknowledgement sequences. Repeated unchanged idle calls eliminate the expected redundant stores.

Separate native threaded tests use the unmodified `SPSCQueue`, `BlockingLoop`, `Event` and `Flag` implementations. Both variants transfer 200,000 recognizable queue events and 200,000 32-byte FIFO records through 3,125 ring wraps, with delayed consumers, intact ordered payloads, no loss/duplication/underflow and completed joins. These tests cover specific publication paths; they are not a proof of every C++ weak-memory execution or all emulator integration. FIFO payload lanes use relaxed atomics in the fixture to avoid a data race; production RAM copying and opcode decoding are outside that fixture.

Root inspected all before/final gameplay images. The same Melee battle progresses normally; GPU fences pass, JIT stays enabled, physical input is isolated and unchanged, and measured audio underrun events/frames are zero. Policy probes after timing stop and resume compiled execution correctly.

## Measurement limits and next action

Fresh headed Chrome 143.0.7499.4 runs use normal emulated clock/speed, full WebGPU presentation, guarded JIT, audible worklet audio, and diagnostics off. Each run warms for 20 emulated seconds and measures 30 emulated seconds. Compilation continues during timing; this is not a fully warmed steady-state claim.

Retain the candidate and its evidence without promoting it. A larger optimization should be chosen from a fresh profile of the current renderer/JIT state; further measurements would be needed to distinguish this small gain from variation and assess other titles. The all-games full-speed objective remains open.

[Numeric results](melee-watermark-stores-2026-09-07.json) contain all four runs. Private build, IR/binary audits and native tests are under `.omx/full-speed/watermark-experiment/`; browser artifacts are under `.omx/full-speed/dispatch-bench/results/watermark-melee-*`.
