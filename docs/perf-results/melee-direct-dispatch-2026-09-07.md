# Direct compiled-block dispatch experiment — 2026-09-07

Keep direct dispatch disabled: the Melee comparison shows no repeatable gain. The first pair is 17.17% slower with the candidate; the reverse pair is 4.59% faster. The control's substantial variation under normal Windows scheduling limits conclusions about the cause.

| Run order | Direct dispatch | Core FPS | Emulation speed |
| --- | --- | ---: | ---: |
| A1 | 0 | 41.904 | 69.94% |
| B1 | 1 | 34.710 | 57.94% |
| B2 | 1 | 34.650 | 57.83% |
| A2 | 0 | 33.131 | 55.30% |

The candidate adds an early match for the compiled-block callback and inlines its wrapper. It retains block lookup, guest state updates and the function-table call. An extra comparison on other callback paths and compiler layout choices can offset the intended reduction in dispatch overhead; the measurements do not identify which effect dominates.

## Identity and controls

- Production/control core: `7479b6c803ff1d19e4c03b3654c69e4fe95a6a4367b411ba11769c65730b112c`.
- Candidate core: `091ad7710dcbb965d203416b00cfec58ec00040e80e89ddacf8cc2d21fa0be36`.
- Worker: `624c4f619038a2d6d0d364be65db56ed1cd7a2bba0be4c239ac032d6db8b7a10`, including the viewport correction.
- The baseline object and optimized WASM reproduce production exactly. Candidate compilation changes only the direct-dispatch macro; links use identical flags, without symbol-map or profiling flags. All 1,126 pinned inputs and production artifacts remain unchanged.
- Fresh headed Chrome 143.0.7499.4 per run, Ryzen 9 9950X3D/Radeon RX 9070 XT, normal CPU scheduling, normal emulated clock/speed, full WebGPU presentation, guarded JIT and audible worklet audio. Startup module caches and prebuilt seeds are empty.
- Same battle checkpoint, 20 emulated seconds of warmup, then 30 measured emulated seconds. The routed probe worker is frozen and hashed; its functional policy checks occur after timing.

JIT remains enabled across the intentional pause and every measured sample. Native input-update counts remain zero. Root inspected each before/final screenshot: the same active battle continues with textured stage, fighters, HUD and the expected clock progression. GPU completion fences pass; all measured audio underrun-event/frame deltas are zero. Off probes execute no compiled callbacks; on probes resume them.

Compilation continues during each window (1,657–1,721 additional blocks), so these are results after the stated warmup, not a fully warmed steady state. They do not establish full-speed or all-games performance. They also cannot attribute the difference from older benchmark sessions to this flag, because the unchanged control itself changed speed.

## Wider workload preparation

The repaired Mario Kart Wii checkpoint is selected explicitly. A worker-side input pulse can measure its actual frame interval and reject overshoot. Initial three-frame pulses were exact but occurred before the in-game pause menu accepted input; screenshot review rejected those runs as racing evidence. The revised setup settles the menu first and requires root's scene review before starting the timed window. Paused-menu throughput is excluded from racing results.

With ten emulated seconds of menu settling, both Wii arms accepted exactly three input frames. Root verified the unpaused race, matching kart/course viewpoint and visible map before timing. One screening pair measured **21.752 FPS (control) versus 23.203 FPS (candidate), +6.67%**. This is unreplicated and does not offset the mixed Melee evidence sufficiently to change the global default. The control recorded 11 audio underrun events (1,408 frames); the candidate recorded zero. That difference is reported, not attributed causally to the flag. [Wii screening data](mkw-direct-dispatch-2026-09-07.json) retains the limits.

## Evidence

[Numeric results](melee-direct-dispatch-2026-09-07.json) retain all four runs and paired calculations. Private build commands, hashes and logs are under `.omx/full-speed/direct-dispatch-experiment/`; captures, the audit and benchmark scripts are under `.omx/full-speed/dispatch-bench/`. No production default was changed.
