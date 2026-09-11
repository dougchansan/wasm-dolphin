# Melee CPU profile after static block linking

The updated core still spends substantial guest-CPU sample time in block execution and its compiled-block wrapper. This supports a controlled retest of the existing direct-dispatch option with static links enabled. It establishes a new optimization target, not another speedup.

The capture used a fresh optimized symbol core, `d0dbae33cd73af7e9206d60ea768c1895ce1d335c587cc74c176586d4832ce81`, with renderer worker `f2ff1fda27fde40b7d018303dfa1a9454e39b0619901663634aed3514ab68677`. Adding only symbol-map emission changed executable sections and 173 exported function indices relative to shipping `e8a1c1bb…`. Its 12,699-entry map applies only to the captured core. All 891 link inputs and the production runtime remained unchanged.

After 60 emulated seconds of warmup, the harness paused and fenced the Great Bay battle for visual review, attached all 18 debugger targets, then sampled for 30 wall seconds at 1 ms intervals. The first attempt failed before sampling and is excluded. The successful attempt used the existing bundled WebSocket client with observable errors and verified target identity; no handshake retry was needed. The original connection failure remains unreproduced, and the unused optional retry-wrapper tests are not accepted evidence.

The battle advanced from 04:01.37 to 03:38.41, with coherent stage, fighters and HUD. Native input updates stayed zero, JIT remained enabled, and both GPU completion barriers passed. Audio used the audible worklet with zero recorded underrun events/frames or overruns. Another 537 blocks compiled, so this is gameplay with continuing compilation, not a steady-state or uninstrumented FPS benchmark. The pause-boundary UI displayed a stale boot-stall warning; native progress resumed and advanced throughout capture.

These are each function's **self samples within the guest CPU target**, excluding profiler idle/program samples. They are not process CPU utilization or a removable-performance budget.

| Function | Self sample time | Share |
| --- | ---: | ---: |
| CachedInterpreter::ExecuteOneBlock | 6.845 s | 22.755% |
| CachedInterpreter::RunWasmBlock | 3.614 s | 12.015% |
| DolphinWeb_OnXfb | 2.134 s | 7.093% |
| CachedInterpreter::FastInteger | 1.918 s | 6.375% |
| JitBaseBlockCache::Dispatch | 1.494 s | 4.968% |

Observed JIT ancestry covers 49.627% of guest samples, including overlapping wrapper and helper work. Of the wrapper's self samples, 92.804% have ExecuteOneBlock as their immediate recorded parent. Missing or inlined ancestry remains unknown. The current gate-zero build reaches the generic callback; gate one adds an early RunWasmBlock arm and requests inlining. Prior pre-link pairs were mixed (−17.17%, +4.59%), so any retest needs exact disabled controls and fresh paired results before promotion. ExecuteOneBlock also contains link resolution, accounting and guards; its entire sample share is not attributable to the callback ladder.

The replay target's leading shares were command-ring drain 27.035%, writeBuffer 14.984%, immediate upload copy 7.332%, and garbage collection 6.722%. In the separate GPU-emulation target, named waits account for 36.777% and SetCPStatusFromGPU for 28.503%. These worker percentages cannot be added together. Independent OS counters report 94.997 CPU seconds over 30.291 wall seconds (3.136 average CPU-core equivalents); GPU-process CPU time is not GPU hardware time.

The independent consumer audit confirms that OnXfb still decodes presentation pixels with real WebGPU; only worker-owned WebGL currently bypasses the native publication. A decode-only bypass needs acknowledged hardware presentation and explicit CPU-pixel-demand handling: inactive-loop and no-canvas fallback paths still consume RGBA. Preserve dimensions, frame/tick signaling and the raw-XFB hash. Save-state texture serialization and canvas screenshots do not use this decoded bridge buffer. The profile does not establish that all OnXfb time can be removed. The source/consumer and test matrix is saved privately in `.omx/full-speed/post-links-xfb-audit/audit.md`; no decode bypass is implemented yet.

The [numeric report](melee-post-links-cpu-profile-2026-09-08.json) contains identities, counters and per-target attribution. Raw captures, debugger probes, exact maps and parser checks remain private under `.omx/full-speed/post-links-*`. The installed [static-linking optimization](static-exit-links-promotion-2026-09-07.md) remains unchanged. General GPU save-state readback, active Sunshine gameplay coverage and sustained full speed across games remain open.
