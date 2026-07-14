# Melee hardware-WGPU realtime follow-up — 2026-07-14

This is a diagnostic follow-up, not a promotion result. A fixed Kirby-versus-Link
battle reached `99.716%` game speed once, but adjacent repeats did not reproduce
that result. Hardware WGPU is therefore not yet reliably realtime.

## Fixed test identity

- Machine: AMD Ryzen 9 9950X3D, 32 logical CPUs, 128 GiB RAM.
- Browser: headed installed Chrome `150.0.7871.115`.
- Harness branch/base commit: `perf/wgpu-producer-ubo-packages` at `65cf538`,
  with the uncommitted validation instrumentation described below; these runs
  are deliberately non-qualifying.
- Core candidates: SHA-256
  `474802fafc90f81c6fcda5f32bce97b469e02a85a03cad434de824bfbe5724ba`
  for the retained baseline/experimental runs, and
  `bccf00ade70a776127ff18a95b9a1b7ec610e9a94eba2e822dc3dc718d959249`
  only for the controlled counter-off arm. The paired counter-on arm used the
  first candidate.
- ISO: Melee Rev 2, SHA-256
  `1018b65a58ca654056be1611a43e753de5dd5f842ce5266581b29c6a12ce7c67`.
- Save state: direct Kirby-versus-Link battle, SHA-256
  `620879e2ed3c35248deba9fb2f7b2a39f91f5374d2f6a98d2a2455cb55e156d1`.
- Work unit: 12 emulated core seconds, loaded directly with no menu or
  character-select driving.
- Audio: muted for automated performance runs.
- Common renderer: `video=wgpu`, `presenter=webgpu`, guarded WASM JIT,
  correctness-sensitive JIT flags off.

All retained runs reached the exact fixed-work target. The new post-run fence
paused the core, drained the command ring and mapped work, awaited GPU queue
completion, waited two compositor animation frames, and only then captured
`final.png`. Timed samples were frozen before that fence.

## Results

| Run | Relevant change | Game speed % | Core FPS | Decision |
| --- | --- | ---: | ---: | --- |
| Counter off, controlled | Compile out JIT run counter | 68.601 | 41.160 | Reject |
| Counter on, controlled | Existing behavior | 69.236 | 41.546 | Control |
| Persistent-cache seed | First profile pass | 67.934 | 40.720 | Diagnostic |
| Persistent-cache reuse | 559 restored modules | 91.716 | 54.971 | High-regime observation |
| Persistent-cache reuse 2 | 664 restored modules | 70.203 | 42.124 | Cache not sufficient |
| CPUs 16–31 | Alternate 16-thread mask | 58.844 | 35.313 | Reject |
| All 32 CPUs | Full affinity, direct queue | 59.572 | 35.752 | Reject |
| Background throttling disabled | First 16 threads | 71.095 | — | No material gain |
| Mapped-drain coalescing | Bounded deferred submit | 70.357 | — | Reject; exceeded deadline |
| Direct queue uploads | `wgpuuploadtransport=queue` | 78.203 | — | Promising interaction |
| Direct queue + state cache | Suppress redundant state | 76.437 | — | No gain |
| Direct queue, metrics off | Real-play diagnostic | 78.557 | 47.134 | No telemetry bottleneck |
| Queue + geometry packet | `wgpugeompack=1` | **99.716** | **59.763** | Best, not reproduced |
| Adjacent geometry off | Same warmed profile | 81.894 | — | Control |
| Adjacent geometry on | Exact repeat | 82.277 | — | No isolated gain |
| Queue + geometry + forced high power | Chrome power override | 85.319 | 51.147 | Descriptive only |

The reports are non-qualifying because the instrumentation worktree was dirty
and automated audio was muted. The coalescing run additionally retained uploads
beyond its declared 8 ms limit. The UBO-package request was rejected because
the rebuilt native core reported `requested=1`, `active=0`; no inactive flag was
credited with a performance result.

## Runtime-seam and CPU-topology follow-up

Later runs at `2af87c8` isolated two machine controls that the earlier mixed
campaign had conflated: persistent JIT-cache reuse and CPU topology. The same
core and direct battle measured only `55.400%` and `55.569%` in fresh ephemeral
profiles because the bundled prebuilt cache contains 8,192 entries and the
battle compiled roughly 330 additional blocks. Reusing the battle-trained
profile loaded about 1,480 additional modules and reduced new compilation to
zero or two.

| CPU placement | Repeats, game speed % | Interpretation |
| --- | --- | --- |
| All 32 logical CPUs | 64.960 | Cross-CCD placement is poor on this machine |
| Cache CCD, all 16 logical CPUs (`0xffff`) | 99.685, 86.789, 86.400 | Fast once, not stable |
| Other CCD, all 16 logical CPUs (`0xffff0000`) | 75.994 | Reject on this machine |
| Cache CCD, one even thread per core (`0x5555`) | 99.244, 95.990 | Best repeated topology |
| Cache CCD, one odd thread per core (`0xaaaa`) | 98.309 | Corroborates physical-core placement |
| Cache CCD, four physical cores (`0x55`) | 97.072 | Fewer cores did not improve throughput |

These muted runs used a fixed 12-second emulated work unit, direct queue
uploads, geometry packing, the same verified save and core, and disabled Chrome
background throttling. They had zero ring/upload waits, replay-budget yields,
renderer errors, drops, aborts, and upload timeouts. The best run completed 12
emulated seconds in 12.121 seconds (`59.813` core FPS), but the repeated gate is
not yet met. Raw artifacts are under
`.omx/wgpu-realtime-100/runtime-seam-warm-affinity-*` and
`.omx/wgpu-realtime-100/topology/`.

The result rules out the renderer-runtime ownership seam as the primary cause
of the slow campaign: the same seam can reach realtime when the hot JIT cache
and cache-CCD placement align. It also shows that affinity alone is not a
product fix. The remaining architecture target is to move command replay off
the core worker so the emulator and hundreds of thousands of small WebGPU
queue writes no longer contend on one JavaScript execution thread.

## What the measurements establish

1. Disabling the JIT run counter produced no reproducible benefit. The final
   controlled off/on pair differed by only `-0.635` percentage points amid a
   bimodal campaign, so the experimental patch was removed rather than
   promoted.
2. JIT cache warmth affects startup and compile pressure but does not determine
   the fast regime. A second warm pass reached `91.716%`; the next, with more
   cached modules and the same 49 new compiles, fell to `70.203%`.
3. The single placement probes favored CPUs 0–15 over CPUs 16–31 or all 32 on
   this dual-CCD machine. This is an observation, not a causal affinity result;
   order-balanced repeats are still required.
4. Validation telemetry is not the missing 20%. Disabling metrics and input
   readback did not materially improve direct-queue throughput.
5. Upload call volume is the largest measured removable host overhead. Direct
   queue uploads improved one measured slow-regime run from about 70% to about
   78%. Geometry packing reduced queue-write calls and CPU time substantially,
   but the adjacent off/on pair changed speed by only `+0.383` percentage
   points. That proves removable overhead, not an isolated game-speed win.
6. Submission/replay scheduling remains bimodal. Comparable fixed-work runs
   alternate between roughly 70–85% and 92–100% even with zero WGPU errors,
   drops, aborts, or upload timeouts.

## Decision and next architecture

Do not change renderer or JIT defaults from this evidence. Retain direct queue
and geometry packing as an experimental combination for further order-balanced
validation:

```text
video=wgpu&presenter=webgpu&wgpuuploadtransport=queue&wgpugeompack=1
```

The next implementation should isolate command replay from the disc/audio/control
worker and reduce per-draw upload calls without one giant synchronous
`queue.writeBuffer`. Scope it as a dedicated renderer worker plus bounded draw
upload packages, with these gates:

- byte/order parity for UBO, vertex, and index payloads;
- no resource-generation, pass-order, or upload-watermark regressions;
- zero WGPU errors, drops, aborts, timeouts, and audio underruns;
- fixed-work A/B blocks with post-run GPU-complete screenshots;
- rollback to the existing queue/mapped transports and unpacked command stream.

The committed [evidence index](melee-wgpu-realtime-followup-2026-07-14.json)
records every table row's exact URL, core/cache identity, fixed-work result,
validity reason, correctness counters, local artifact path, and source
summary/manifest hashes. Full raw local artifacts remain under the ignored
`.omx/wgpu-realtime-100/` tree. No generated core or tracked `.wasm` artifact
is part of this follow-up.
