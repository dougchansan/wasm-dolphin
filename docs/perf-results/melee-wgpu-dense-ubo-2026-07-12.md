# Melee hardware-WGPU dense UBO screen (2026-07-12)

## Decision

**INCONCLUSIVE. Keep `wgpuubopack=1` experimental and default-off.** Dense
packets substantially reduced upload records, but this campaign did not produce
a valid balanced performance block: six of eight otherwise-correct runs had
WebAudio underruns. The one valid run per arm was effectively tied, so the
descriptive all-run speed difference is not evidence of a win.

The implementation remains useful as a default-off experiment. Native and
full-core smokes cover all dirty masks, byte parity, 256-byte dynamic-offset
alignment, zero padding, wrap, rollback, cache fallback, and the real
`VertexManager::CommitBuffer` boundary. A headed screenshot showed the correct
Kirby-versus-Link battle, and the final campaign recorded no WebGPU validation
errors.

## Fixed campaign

- Scene: direct `__battle.sav` load into Kirby versus Link; no character-select
  navigation or pause.
- Commit: `99cf5ce578db36472271b23d4d5ada0f3ed2a108` on
  `perf/wgpu-bounded-renderer-staging`.
- Core: 12,893,772 bytes, SHA-256
  `2576faf651de4dd6cd9677e2770c6285271e63ceb30e39489b978f9b43bab245`.
- Browser/GPU: headed Chrome 150.0.7871.114, AMD `rdna-4` adapter.
- Common mode: `video=wgpu`, WebGPU presenter, JIT off, geometry packing on,
  32 MiB arena, mapped upload transport, GPU-completion and input telemetry on.
- Work: eight emulated core seconds with a 25-second wall cap.
- Order: ABBA followed by ABBA replacement block; A is dense UBO off and B is
  dense UBO on.
- Performance thresholds were neutralized for screening. Correctness,
  visibility, activation, provenance, GPU-error, and audio-integrity gates
  remained active.

| Run | Arm | Valid | Game speed % | Core FPS | Wall s | Audio underruns | Uploads | UBO uploads | GPU copies | Batches | Capacity waits / max ms |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| block-01-run-1 | Off | No | 49.312 | 29.523 | 16.224 | 1 | 553,081 | 332,920 | 539,926 | 2,833 | 77 / 1009.600 |
| block-01-run-2 | On | Yes | 65.110 | 39.046 | 12.319 | 0 | 258,868 | 108,876 | 248,006 | 2,036 | 65 / 757.205 |
| block-01-run-3 | On | No | 65.497 | 39.275 | 12.298 | 2 | 259,664 | 109,009 | 248,738 | 2,075 | 62 / 1418.805 |
| block-01-run-4 | Off | Yes | 65.588 | 39.376 | 12.317 | 0 | 375,330 | 225,383 | 366,255 | 2,029 | 68 / 812.770 |
| replacement-run-1 | Off | No | 61.768 | 37.025 | 13.099 | 1 | 409,865 | 245,838 | 400,102 | 2,175 | 80 / 758.725 |
| replacement-run-2 | On | No | 46.379 | 27.825 | 17.430 | 1 | 377,728 | 159,698 | 362,204 | 3,059 | 71 / 731.280 |
| replacement-run-3 | On | No | 63.949 | 38.390 | 12.842 | 2 | 260,258 | 109,411 | 249,267 | 2,049 | 68 / 1617.370 |
| replacement-run-4 | Off | No | 56.384 | 33.847 | 14.211 | 3 | 432,223 | 259,829 | 421,869 | 2,300 | 75 / 1000.245 |

Every run was headed, qualification-eligible, reached the fixed-work target,
changed visible pixels, used the requested mapped transport, and reported the
correct dense-packet activation state. All eight recorded zero WebGPU errors
and zero GPU-completion failures. Six runs were invalid solely because they
added one to three WebAudio underruns.

## Descriptive mechanism result

These means include invalid runs and therefore describe mechanism only; they
are not a performance effect estimate.

| Metric | Off mean | On mean | Descriptive change |
| --- | ---: | ---: | ---: |
| Game speed | 58.263% | 60.234% | +3.383% |
| Core FPS | 34.943 | 36.134 | +3.409% |
| Wall time | 13.963 s | 13.722 s | -1.724% |
| Logical uploads | 442,624.75 | 289,129.50 | -34.678% |
| UBO uploads | 265,992.50 | 121,748.50 | -54.229% |
| GPU copy commands | 432,038.00 | 277,053.75 | -35.873% |
| Staging batches | 2,334.25 | 2,304.75 | -1.264% |

The only valid observations were 65.110% with packets on and 65.588% with
packets off. They do not form a valid balanced block and are effectively tied.
Packetization removes records but does not remove the large mapped-staging
capacity waits or the roughly two-second replay-backlog age.

## Correctness findings during screening

The fail-closed activation gate caught two dropped handoffs before measurement:
the perf scenario initially omitted `WGPUUBOPACK`, and the disc worker initially
omitted `payload.wgpuUboPack` when calling `loadCore`. The first truly active
smoke then exposed unaligned successor utility UBOs because a 5,904-byte dense
interval ended on a 4-byte boundary. Packet ownership now extends to 6,144
bytes, leaving 240 verified zero tail bytes and keeping every successor offset
256-byte aligned.

## Evidence boundary

Raw ignored artifacts are under `.omx/wgpu-no-lag/dense-ubo-ab-2576faf/` in
the validating worktree. Their retained hashes are recorded in the adjacent
JSON file. Because only one run per arm passed the audio gate, do not promote
the flag or cite the descriptive +3.383% as a measured speed improvement.

## Muted direct-save rescreen — 2026-07-13

The audio gate was made explicit and muted for automated validation, allowing a
complete visible ABBA+BAAB block on the accepted core
`fe4448a07a726b67c9b7bd73f2515118b353414a66ac48cc4b1cdd92fb42f2c8`.
All eight runs reached 12 emulated core seconds, changed the canvas in 19
samples, reported the requested packet mode, and remained valid. The machine
was in a lower absolute-throughput regime than earlier campaigns, so only the
balanced within-block comparison is used.

| Metric | Off mean | On mean | Change |
| --- | ---: | ---: | ---: |
| Game speed | 65.683% | 64.852% | -1.266% |
| Logical uploads | 675,020 | 462,108 | -31.542% |
| Encoded GPU copies | 658,567 | 442,855 | -32.755% |
| Upload bytes | 1,462,094,728 | 1,520,601,055 | +4.002% |
| Capacity waits | 81.25 | 82.75 | +1.846% |
| Capacity-wait time | 4,591.99 ms | 4,717.41 ms | +2.731% |

Both ordering blocks favored packets off. This resolves the earlier
inconclusive performance decision: keep `wgpuubopack=1` default-off and do not
promote it as a speed optimization. It materially reduces command volume, but
the wider aligned transfers and persistent mapped-staging capacity waits leave
end-to-end throughput slightly worse.

Raw ignored artifacts are under
`.omx/wgpu-realtime-100/dense-ubo-current-visible/`.
