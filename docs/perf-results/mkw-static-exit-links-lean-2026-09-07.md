# Mario Kart Wii: lean cached-block links — 2026-09-07

The measured lean-context candidate improved core FPS in both pairs: **+8.52% and +12.97%**. This comparison covers a settled, idle-kart Luigi Circuit race checkpoint. Candidate speed was 57–59% of realtime; it does not establish full-speed driving or performance on other tracks. [Numeric results](mkw-static-exit-links-lean-2026-09-07.json) retain the complete measurements and source/build identities.

| Run order | Arm | Core FPS | Emulation speed | Wall seconds |
| --- | --- | ---: | ---: | ---: |
| A1 | Control | 32.584 | 54.39% | 55.180 |
| B1 | Lean links | 35.361 | 59.02% | 50.847 |
| B2 | Lean links | 34.267 | 57.20% | 52.471 |
| A2 | Control | 30.332 | 50.63% | 59.276 |

Pairs are B1/A1 and B2/A2. The ratio of candidate/control mean FPS is **+10.67%**, not the arithmetic mean of the two pair percentages. Both pairs favor the candidate, but control variation and only two pairs limit precision.

The same candidate was measured in the [Melee comparison](melee-static-exit-links-lean-2026-09-07.md). It retains the broad implementation's static link cells and lifetime/state guards while installing one thread-local context per dispatch-loop call and resetting completion, epoch and features for every actual block. The original broad variant's mixed Melee results motivated this change. This Wii campaign compares lean links against the original control; it is not a direct broad-versus-lean Wii comparison.

Every arm used a fresh headed Chrome process, the same repaired checkpoint/ROM, worker and core settings, explicit `0x5555` affinity on the same Ryzen 9 9950X3D Windows host, guarded JIT, full WebGPU presentation and audible worklet audio. Setup allowed ten emulated seconds for the pause menu to settle, applied an exactly measured three-frame A pulse, then allowed twenty emulated seconds of race settling. Recorded scene reviews accepted the matching race-at-curb view, kart/road/HUD and complete minimap before timing. The measured interval was thirty emulated seconds: 30.008–30.013 seconds in practice, with 1,798 core frames in every arm.

Core FPS uses native frame progress divided by wall time, rather than presentation submissions or visual-change cadence. Native link statistics, general metrics and deep replay diagnostics were off in the performance arms. The unpause pulse matched in every run; native input-update counts stayed at two from before to after measurement, with no further driving input. JIT stayed enabled, runtime/error checks passed, and both GPU completion boundaries finished. All four audio intervals reported zero underrun events/frames and overruns. Another 1,027–1,111 blocks compiled during each timed window, so ongoing compilation remains part of the measured workload.

The checkpoint's course image was recovered before this campaign. General GPU save-state readback remains incomplete; these results do not validate arbitrary save states. The settled stationary-player scene also omits many driving, camera and track workloads. Sunshine evidence elsewhere covers a menu only. The separate Melee diagnostic's **82.233% post-block lookup avoidance** demonstrates activation there; no equivalent Wii percentage was measured in this report, and lookup avoidance is not an FPS gain.

Measured control core: `7479b6c803ff1d19e4c03b3654c69e4fe95a6a4367b411ba11769c65730b112c`. Measured candidate core: `e8a1c1bb9aec817bdf96f88f41c9681caa1b8001620a35e658deff7c7a9630a2`. Worker: `f2ff1fda27fde40b7d018303dfa1a9454e39b0619901663634aed3514ab68677`. Four-object reference/disabled controls reproduced the original core, and the shared lean source passed 52 native fixture groups; this does not replace broader runtime testing.

Private raw runs and accepted scene reviews are under `.omx/full-speed/current-bench/results-mkw-settled/lean-static-links-mkw-*`; scoring/build evidence is under `.omx/full-speed/static-exit-links-lean/`. The JSON records the identical ROM, checkpoint, harness and routed policy-worker hashes within this Wii comparison.

The measured JS/WASM were subsequently promoted locally after exact reproduction from the shipping objects. The JSON retains its historical experimental binding and pre-promotion status.
