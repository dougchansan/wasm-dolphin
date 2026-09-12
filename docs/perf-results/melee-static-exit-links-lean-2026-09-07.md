# Melee: lean cached-block links — 2026-09-07

The lean-context candidate increased measured core FPS in both paired comparisons: **+9.52% and +11.09%**. Candidate speed remained 77–79% of realtime in this Great Bay battle; this is an improvement in one scene, not a full-speed result. [Numeric results](melee-static-exit-links-lean-2026-09-07.json) retain the exact measurements and identities.

| Run order | Arm | Core FPS | Emulation speed | Wall seconds |
| --- | --- | ---: | ---: | ---: |
| A1 | Control | 42.178 | 70.37% | 42.652 |
| B1 | Lean links | 46.195 | 77.06% | 38.944 |
| B2 | Lean links | 47.269 | 78.89% | 38.037 |
| A2 | Control | 42.549 | 70.99% | 42.281 |

Pairs are B1/A1 and B2/A2. The ratio of candidate/control mean FPS is **+10.31%**; the two individual pairs are the primary evidence. These four runs do not provide a confidence interval or establish performance across scenes.

The [earlier broad implementation](melee-static-exit-links-2026-09-07.md) produced mixed Melee pairs, −13.53% and +9.32%. It installed and restored a thread-local execution context for every cached block. The lean version installs one context per `ExecuteOneBlock` call, resets completion/epoch/features at each actual block, and restores the previous context before miss compilation or profiling/return. Link cells, supported exits, invalidation and state/accounting checks remain the same. Separate sessions had substantially different control speeds, so their absolute FPS must not be treated as a direct broad-versus-lean comparison or proof that TLS setup alone caused the difference.

Each arm used a fresh headed Chrome process on the same Ryzen 9 9950X3D Windows host, explicit `0x5555` affinity, the same ROM/checkpoint and worker, guarded JIT, normal emulated clock/speed, full WebGPU presentation and audible worklet audio. ABBA order followed 20 emulated seconds of warmup with a 30-emulated-second measurement. Actual work was 30.009–30.015 emulated seconds and 1,798–1,799 core frames. Core FPS is native frame-counter progress divided by wall time; presentation submissions and visual-change cadence are separate metrics. General metrics, deep replay diagnostics and native link counters were disabled in these performance runs.

Recorded before/final scene reviews accepted the same textured Great Bay battle, fighters/HUD, damage progression and approximately 30 seconds of game-clock movement. Subsecond animation/camera differences remain. JIT stayed enabled, native input-update counts stayed zero, and both GPU completion boundaries passed. The harness accepted runtime diagnostics without reported errors or renderer fallback. All four audio intervals recorded zero underrun events/frames and overruns. Compilation continued during measurement—1,657–1,732 new blocks—so these are results after the stated warmup, not a fully compiled steady state.

A separate statistics-enabled core recorded **714,120,840 linked transitions out of 868,406,913 post-block lookup decisions: 82.233% lookup avoidance**. Including initial entry lookups reduces that share to 82.128%. These are executed counter deltas with a stable owner and advancing publication sequence. They demonstrate that links were used; they are neither an FPS gain nor a cost-weighted estimate. The diagnostic run's FPS is excluded from the performance comparison, and this Melee lookup percentage should not be transferred to other games.

Measured control core: `7479b6c803ff1d19e4c03b3654c69e4fe95a6a4367b411ba11769c65730b112c`. Measured lean core: `e8a1c1bb9aec817bdf96f88f41c9681caa1b8001620a35e658deff7c7a9630a2`; diagnostic core: `2ca2f9e5b4b7141c222bcd9f8af0b15880a90175b0a0a9081bdd1d8180dc8c0d`. All arms used worker `f2ff1fda27fde40b7d018303dfa1a9454e39b0619901663634aed3514ab68677`. Independent reference/disabled controls reproduced all four original objects and the control core. The lean source passed 52 native fixture groups, including consecutive-block reset, nested restoration and lifetime guards; fixture adapters and browser execution remain distinct validation scopes.

Private build/test evidence is under `.omx/full-speed/static-exit-links-lean/`; raw runs are under `.omx/full-speed/current-bench/results/lean-static-links-melee-*`. [Mario Kart Wii](mkw-static-exit-links-lean-2026-09-07.md) supplies a separate settled idle-race comparison. Sunshine checks cover a menu only; sustained gameplay and full-library behavior remain unverified.

The measured JS/WASM were subsequently promoted locally after exact reproduction from the shipping objects. The JSON retains its historical experimental binding and pre-promotion status.
