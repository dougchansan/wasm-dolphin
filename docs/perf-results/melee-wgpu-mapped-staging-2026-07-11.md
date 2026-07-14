# Melee hardware-WGPU mapped-staging smoke (2026-07-11)

## Decision

**NO-GO. Do not promote `wgpuuploadtransport=mapped`.** The corrected single-arm
smoke proves that the mapped transport executed and eliminated direct
`GPUQueue.writeBuffer` calls, but it reached only 71.601957% fixed-work game
speed and recorded an 878.845 ms maximum staging-capacity wait. This is useful
mechanism evidence, not a qualifying performance result.

The earlier balanced screen is **invalid as an A/B comparison**. Its URLs
requested different transports, but all eight manifests reported
`uploadTransport=queue`; both arms executed the queue implementation because of
the subsequently fixed handoff bug. None of its between-arm differences can be
attributed to mapped staging.

## Corrected mapped-transport smoke

- Scene: direct `__battle.sav` load into the Kirby-versus-Link battle; no
  character-select stop.
- Mode: true hardware WebGPU, WebGPU presenter, geometry packing enabled,
  32 MiB upload arena, `wgpuuploadtransport=mapped`, and JIT disabled.
- Work: 8 emulated core seconds with a 25-second wall cap.
- Source checkout: clean commit
  `e3a60518b384638f917cbd81e0e8b0622e678c15` on
  `perf/wgpu-bounded-renderer-staging`.
- Browser/GPU: headed Chrome 150.0.7871.114 on AMD `rdna-4`.
- Core artifact: 12,881,747 bytes, SHA-256
  `60070a57adba29003c81ee86956026ad4c1dee31a3d6ea3c802f1266e1292262`.

| Metric | Corrected mapped smoke |
| --- | ---: |
| Fixed-work game speed | 71.60195660035636% |
| Fixed-work core FPS | 43.00055582855915 |
| Fixed-work wall time | 11.325434999994934 s |
| Direct queue-write calls / max | 0 / 0 ms |
| Logical staged uploads | 553,821 |
| Logical staged bytes | 1,212,941,464 |
| GPU copy commands encoded | 540,621 |
| Coalesced buffer uploads | 13,200 |
| Staging batches submitted | 2,121 |
| Capacity misses | 86 |
| Maximum capacity wait | 878.8450000062585 ms |
| Remap failures / unsafe-capacity events | 0 / 0 |

The final snapshot had 2,121 remaps started and 2,119 completed, with two slots
still in the normal `remapping` state at the measurement boundary. It reported
no remap failures, unsafe-capacity events, WebGPU errors, GPU-completion
failures, audio underruns/overruns, or input-marker parity errors. All six
scripted input events reached applied, polled, armed, submitted, and completed
stages.

The run still failed the realtime thresholds: minimum presentation FPS was 1,
minimum core FPS was 30.969031, and minimum game speed was 51.453174%. The
hardware path's reported visual FPS is based on the software XFB hash and is
not a valid unique-frame measure here. The run was also qualification-ineligible
because its locked build record described generated artifacts as dirty rather
than a clean, provenance-verified build.

## Rolled-back tuning smokes

Two subsequent single-run changes tried to reduce mapped-staging pressure.
Neither improved the original smoke, neither was a qualifying benchmark, and
both were rolled back.

| Configuration | Commit tested | Game speed % | Core FPS | Wall s | Copy commands | Batches | Capacity waits | Max wait ms | Audio underruns | Input parity | Remap / unsafe errors | Decision |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |
| 3×16 MiB, immediate flush | `e3a60518` | 71.60195660035636 | 43.00055582855915 | 11.325434999994934 | 540,621 | 2,121 | 86 | 878.8450000062585 | 0 | Pass | 0 / 0 | Reference smoke; NO-GO |
| 2×32 MiB, immediate flush | `c78ef805` | 68.96289904744087 | 41.40137697914956 | 11.738739999994635 | 382,841 | 2,105 | 49 | 263.47999999672174 | 2 | Pass | 0 / 0 | Rolled back; NO-GO |
| 3×16 MiB, retained partial-drain uploads | `66ae27bb` | 69.26502517740828 | 41.56419644944262 | 11.861169999994338 | 352,846 | 1,029 | 69 | 2561.015000000596 | 2 | Pass | 0 / 0 | Rolled back; NO-GO |

The 2×32 MiB layout reduced the number and worst duration of capacity waits but
also reduced fixed-work throughput. Retaining uploads across partial producer
drains cut copy-command and batch counts further, yet produced the worst maximum
wait and again reduced throughput. Both tuning runs added two audio underruns;
their six-event input-marker sequences still passed parity.

These are descriptive single smokes across different commits, not a paired
effect estimate. The current code is restored to three 16 MiB staging slots
with immediate upload flushing; the rejected retention behavior is absent.

## Invalid prior comparison, retained descriptively

The prior report labelled four runs as queue (A) and four as mapped (B), but
every captured runtime state said `uploadTransport=queue`. These values only
describe eight queue-transport runs under their requested labels:

| Requested label | n | Mean game speed % | Mean core FPS | Mean wall time s | Actual transport |
| --- | ---: | ---: | ---: | ---: | --- |
| Queue (A) | 4 | 73.33131886760303 | 43.97219591896048 | 10.992480000000446 | queue |
| Mapped (B) | 4 | 72.22598574194822 | 43.26396054844931 | 11.240830000000075 | queue |

Do not calculate or cite an effect between these rows. The corrected mapped
result is a single smoke on a different built artifact, not a replacement arm
for that invalid comparison.

## Evidence boundary

The compact record is
[melee-wgpu-mapped-staging-2026-07-11.json](melee-wgpu-mapped-staging-2026-07-11.json).
Raw captures lived under `.omx/wgpu-no-lag/` in the validating worktree; `.omx`
is uncommitted and ephemeral. The JSON records sizes and SHA-256 hashes for the
single-smoke report, its per-run artifacts, and the invalid comparison report
so a retained copy can be verified.
