# Current-source Melee CPU attribution

A fresh Great Bay battle profile identifies substantial block-dispatch overhead and replay-worker allocation cost. It does not establish a speed improvement. Production defaults remain unchanged.

The profile uses a separate symbol-map build, `c4f03dad2de17a1f31220eb8bb6a5aa6965fdaf09f746fa079be74fe003c9cc0`, and worker `624c4f619038a2d6d0d364be65db56ed1cd7a2bba0be4c239ac032d6db8b7a10`. Adding only `--emit-symbol-map` during the isolated relink changed executable section ordering, so its 12,694-entry map must never name production `7479b6c803ff1d19e4c03b3654c69e4fe95a6a4367b411ba11769c65730b112c` functions by index. All 73 pinned original relink inputs and production files remained unchanged.

After 60 emulated seconds of settling, the harness paused and fenced the renderer for a scene check, then recorded 30 wall seconds across 18 CDP targets at 1 ms sampling. Both boundary screenshots show the same active battle, with the timer advancing from 04:01.76 to 03:45.59. Native input updates remained zero, JIT stayed enabled, and both GPU completion barriers passed. There were 479 new compilations, so this is active gameplay with continuing compilation. An initial attempt that queried the worker before mount was excluded; the harness now waits for worker readiness.

Percentages below are each named worker's own non-idle sample residence, including named waits. They are not CPU utilization and cannot be summed across workers.

| Worker | Function/category | Self sample time | Worker sample share |
| --- | --- | ---: | ---: |
| Guest CPU | ExecuteOneBlock | 4.657 s | 15.30% |
| Guest CPU | JitBaseBlockCache::Dispatch | 4.269 s | 14.03% |
| Guest CPU | RunWasmBlock wrapper | 2.672 s | 8.78% |
| Guest CPU | FastInteger | 1.336 s | 4.39% |
| GPU emulation | SetCPStatusFromGPU | 7.445 s | 24.47% |
| GPU emulation | Named waits | 11.579 s | 38.05% |
| Replay JavaScript | Garbage collector | 4.469 s | 31.86% |
| Replay JavaScript | drainWebGpuCmdRing | 2.463 s | 17.56% |
| Replay JavaScript | writeBuffer | 1.650 s | 11.77% |
| Replay JavaScript | copyWgpuUploadPayload | 1.417 s | 10.10% |

Recorded JIT ancestry accounts for 47.25% of the guest CPU worker's samples. Shared dispatch control serves both native and compiled callbacks; its self time cannot all be labelled interpreter fallback. Inlined or absent ancestors remain unknown. The parked workers' roughly 30-second futex sample residence is excluded from CPU-work claims.

Separate OS process measurements total 160.371 CPU seconds over 30.603 wall seconds, or 5.24 average CPU-core equivalents across this browser's processes. GPU-process CPU time is not GPU hardware execution time. Profiling overhead and continuing compilation prevent treating this capture as an ordinary FPS benchmark.

The next isolated experiment targets repeated immediate queue-buffer upload allocation. The current path copies each payload to a fresh ordinary ArrayBuffer. The [WebGPU writeBuffer algorithm](https://gpuweb.github.io/gpuweb/#dom-gpuqueue-writebuffer) snapshots the source on the content timeline, allowing private scratch storage to be reused after the call returns. Held uploads still need independently owned bytes until consumed. A bounded scratch prototype must pass real GPU byte checks and uninstrumented, matched gameplay comparisons before promotion; this profile alone proves no gain.

Block-dispatch frequency remains a separate target. Existing short-prefix admission and short-block fusion interact: lowering the threshold to two instructions prevents the current fusion gate from firing. Historical trials and current path eligibility must be checked before repeating either toggle.

The machine-readable summary is [melee-current-cpu-profile-2026-09-07.json](melee-current-cpu-profile-2026-09-07.json). Raw profiles, game screenshots, exact symbol binding and analyzer checks stay private under `.omx/full-speed/current-profiles`, `current-profile-symbols` and `current-profile-analysis`. The minimap fixture recovery and remaining GPU save-state readback gap are documented separately in [the viewport report](../webgpu-viewport-fix.md).
