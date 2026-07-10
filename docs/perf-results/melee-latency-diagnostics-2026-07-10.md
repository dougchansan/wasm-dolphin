# Melee GPU-completion and input-propagation diagnostics — 2026-07-10

These are headed, direct-save diagnostics from the exact Kirby-versus-Link
battle. They validate the new opt-in measurement paths; they are not release
qualification or proof that full-speed play was achieved. The checkout was
dirty because the instrumentation had not yet been committed.

Test machine: Windows 10.0.26200, AMD Ryzen 9 9950X3D (32 logical CPUs),
128 GiB RAM, AMD WebGPU adapter reported as RDNA 4. Both runs used commit
`44e5553d8c749b4986807e8600ff69f295036c7c` before the instrumentation commit.

## GPU completion

With `video=software&presenter=webgpu&gpucomplete=1`, the tracker sampled
`GPUQueue.onSubmittedWorkDone()` once per 30 successful submits. It never
awaited completion in the presentation loop.

| Submits | Samples completed | Average | p95 | Max | In-flight high-water |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 3,499 | 116 | 3.211 ms | 4.780 ms | 5.510 ms | 1 |

The 30-second run used installed Chrome `149.0.7827.201`. Presentation stayed
at a 59.54 FPS steady-state mean, core FPS averaged 59.84, game speed averaged
99.80%, and distinct visual FPS averaged 13.69. The normal gate verdict was
`FAIL`: it observed four guarded-JIT emit failures and a minimum game-speed
sample of 92.11%, below the 95% target. Queue completion therefore does not
explain the low distinct visual cadence on this run.

## Input propagation bound

The second headed run used Chromium `143.0.7499.4`, disabled the JIT, loaded the
same save directly, and injected four key transitions after load. Each
generation travelled through both SAB and postMessage; duplicate delivery was
deduplicated. The tracker then observed the core pad-poll mask/count and the
next distinct presented frame.

| Boundary | Average | p95 | Max |
| --- | ---: | ---: | ---: |
| Host send → worker apply | 5.5 ms | — | 21 ms |
| Host send → confirmed core pad poll | 29 ms | 48 ms | — |
| Host send → next distinct frame after poll | 34.5 ms | 59 ms | 59 ms |
| Confirmed core poll → next distinct frame | 5.5 ms | 11 ms | — |

All four transitions reached all three boundaries. This is not causal visual
attribution: the battle is animated, so the next distinct frame may have
changed without the input. The schema records
`causalVisualAttribution: false` and names the measurement
`host-to-next-distinct-frame-after-core-poll`.

Machine-readable values and raw-file hashes are in
[the diagnostic JSON](melee-latency-diagnostics-2026-07-10.json). Local raw
artifacts are under `.omx/next/gpu-completion-software/` and
`.omx/next/input-visible-latency-v2/`.

The GPU run used `npm run perf:gate -- --base-url http://127.0.0.1:8120/
--duration 30 --out-dir .omx/next/gpu-completion-software --target-mode warn`
with `GPUCOMPLETE=1`, the exact ROM/save-state environment variables, and the
software-stable scenario. The input run used `node
tools/menu-progress-validate.mjs --base-url http://127.0.0.1:8120/ --duration
12 --sample-ms 100 --out-dir .omx/next/input-visible-latency-v2 --headed` with
`INPUTLATENCY=1`, `GPUCOMPLETE=1`, `WASMJIT=0`, direct save load at time zero,
and a four-transition input script. The generated metadata files retain the
complete URLs and artifact identities.

The later real-WGPU measurement uses a mapped hardware backbuffer rather than
the software XFB hash. Its six input transitions, queue-completion samples, and
validation caveats are recorded separately in
[WGPU replay and hardware-latency diagnostics](wgpu-replay-and-latency-2026-07-10.md).
