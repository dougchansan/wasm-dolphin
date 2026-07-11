# Melee final optimization evidence - 2026-07-10

This report closes the five-priority profiling pass on the direct-loaded
Kirby-versus-Link battle. It separates a positive but non-promotable software
TEV result from a rejected hardware-WGPU UBO experiment, and records the
hardware upload bottleneck exposed by the latter.

## Decision summary

| Candidate | Measured outcome | Decision |
| --- | --- | --- |
| Exact software TEV cases, `swtevfast=1` | Ten-block confirmation: median fixed-work throughput effect `+4.9546%`, 95% block-bootstrap interval `[+1.5631%, +9.4837%]`, permutation `p=0.0390625` | Primary statistical gate passed, but the overall gate was non-qualifying; keep default-off |
| Producer UBO cache, `wgpuubocache=1` | Two-block screen: `+3.6393%`, then `-2.2201%`; median `+0.7096%`, interval `[-2.2201%, +3.6393%]` | `SCREENING_REJECT`; keep default-off |
| WGPU replay liveness | Three of eight UBO-screen runs recorded one upload timeout and one aborted pass | Correctness/liveness blocker; do not promote timing from those runs |
| WGPU upload architecture | `593,660-819,806` `UPLOAD_BUFFER` calls and `833-1,161 MiB` per eight emulated seconds; upload replay consumed `4.47-5.28 s` | Per-call upload replay is the primary measured hardware-WGPU bottleneck |

No default renderer, JIT, pacing, audio, or image-quality setting changed from
these experiments.

## Run identity

| Field | Value |
| --- | --- |
| Machine | AMD Ryzen 9 9950X3D, 32 logical CPUs, Windows `10.0.26200` x64 |
| Browser | Headed installed Chrome `150.0.7871.114` |
| Recorded commit | `db4da0743dc856955ed6b59a4f59618837b5f3f5`, clean |
| Core | 12,875,582 bytes; SHA-256 `a239ee47209605f20f7c078f61567cd90d4adb9a718fc3dc71060a178d006995` |
| Upstream Dolphin | `e22551eae1c84a7e4d0b6a5c519ef4ed4ef69df1` |
| ROM | Melee Rev 2 NKit; SHA-256 `1018b65a58ca654056be1611a43e753de5dd5f842ce5266581b29c6a12ce7c67` |
| Save state | `__battle.sav`; SHA-256 `620879e2ed3c35248deba9fb2f7b2a39f91f5374d2f6a98d2a2455cb55e156d1` |
| Scene/input | Save loaded directly at time zero; Kirby versus Link; no menu driving or gameplay input |
| Work unit | Eight emulated core seconds, `3,888,000,000` ticks, with a wall-time safety cap |

The clean TEV screen immediately preceding confirmation was recorded at
`fa2618794d20c6b5bf523f3e1c9990c8ca51be9b`. The core artifact is identical
across both clean commits. The earlier shadow-parity diagnostics described
below are not covered by this clean-run identity.

## Software TEV confirmation

The candidate specializes three complete nine-word TEV tuples selected from
two independent profiles. The specialization and its same-pixel shadow check
remain opt-in.

The shadow counts below are earlier mechanism diagnostics, not part of the
clean confirmation campaign. Both were recorded from a dirty tree at commit
`d851b336ca1c9de7da036b73145d3116aef6ec59` in headed Chrome `143.0.7499.4`;
they used the same core artifact SHA-256 recorded above:

- shadow-only: `55,009,382` compared pixels, zero mismatches;
- execute plus shadow: `47,336,624` specialized and compared pixels, zero
  mismatches.

Raw shadow evidence:

- `.omx/final-opt/tev-shadow-only`: `summary.json`
  `c18856b16b6624b73f0019ca5e92d30c7c9c7cf403ff316d05394ae83c9016b8`,
  `run-metadata.json`
  `1f5027efba1a93940d2ee31e618cb0382eec71594885f356fb795af0507297fa`;
- `.omx/final-opt/tev-execute-shadow`: `summary.json`
  `4109c6efa8dedda2844881fb7663444397af8d2fa5089b11de971d88fb75e59d`,
  `run-metadata.json`
  `d13215eb29b97400c1be9ae868e33fe17ec8d47595fa9dbd8ab3198a201f19ad`.

The clean two-block screen produced a `+6.7479%` median signal, so a separate
confirmation configuration preregistered five initial blocks and at most ten.
All 40 runs were provenance-eligible, valid, and reached the fixed-work target.

| Block | Generic mean % | Exact-case mean % | Effect |
| --- | ---: | ---: | ---: |
| 1 | 146.0400 | 155.0576 | +6.1748% |
| 2 | 151.4257 | 155.4606 | +2.6646% |
| 3 | 138.7371 | 154.9711 | +11.7012% |
| 4 | 150.9080 | 156.5436 | +3.7344% |
| 5 | 145.8427 | 156.4399 | +7.2661% |
| 6 | 156.6001 | 145.2203 | -7.2668% |
| 7 | 151.7703 | 154.9255 | +2.0789% |
| 8 | 153.4653 | 152.5319 | -0.6082% |
| 9 | 148.5983 | 168.0879 | +13.1156% |
| 10 | 154.6167 | 167.6869 | +8.4533% |

The primary comparison outcome was `STATISTICAL_GATE_PASS`: median
`+4.9546%`, interval `[+1.5631%, +9.4837%]`, and exact permutation
`p=0.0390625`. This is a machine- and scene-specific throughput result at
`speed=unlimited`; it is not a unique-visual-FPS result.

The overall gate remained `NON_QUALIFYING` and `promotable=false`. Four runs
missed the preregistered 50-FPS minimum presentation target, with minima 49,
46, 43, and 40. Manual review of all 40 final 1280x900 PNGs found the expected
battle with no black, green, missing-texture, or obvious TEV/color failure, but
dynamic screenshots from different emulated frames are not byte-for-byte
EFB/XFB parity. Therefore `swtevfast` stays default-off even though its primary
throughput hypothesis passed on this fixture.

Raw directory:

```text
.omx/final-opt/tev-confirmation-clean
```

Integrity:

- `comparison.json`: `e24dd6bc9997b98a06db31fbacce8e55dc93463102fb9c830ced733490585621`
- `comparison.csv`: `ed50d94ca4103226cb1bc3dce408569b7094f38426dfdf29bacf84254d29082e`
- `report.json`: `08f872a5975f720fcb884f7f33c1d63bf1f644e2f952ac080054113ee7f5a020`
- `runs.csv`: `9c0bf486677116884561f27dd0c7b0299d61f6a1e918dcd264976a30ca783934`
- `tasklist.json`: `6662e63029c7e15c776a135164cf8673d8cc89ace70eee82305febd1c0f81c76`
- preregistered config: `e08a8838a74f7ad553d1acf20f7db1c5acc65180ea1679359fb0464eea08c6f6`

## Hardware-WGPU UBO screen

The true hardware path used `video=wgpu`, the WebGPU presenter, `wasmjit=0`,
`wgpupump=1`, and the exact hardware checkpoint hash `6fd97dc5`. All eight
runs reached the fixed-work target and produced nonzero XFB and backbuffer
readbacks. Manual screenshots showed the Kirby-versus-Link battle rather than
the previous green, black, or menu-only output.

| Block | Cache-off mean % | Cache-on mean % | Effect |
| --- | ---: | ---: | ---: |
| 1 | 49.3065 | 51.1010 | +3.6393% |
| 2 | 52.2267 | 51.0672 | -2.2201% |

The result is `SCREENING_REJECT`: median `+0.7096%`, interval
`[-2.2201%, +3.6393%]`, permutation `p=1`. Cache-on runs did demonstrate a
43.93-44.24% UBO lookup hit rate and suppressed 219-269 MiB each, but that
mechanism signal did not become a repeatable throughput gain.

The independent strict validator rejected three runs. Each recorded one
producer upload-watermark timeout and one poisoned/aborted pass. Their maximum
single-drain times were 1,838.375, 2,170.915, and 2,352.390 ms, with replay
backlog high-water marks of 62,028, 75,140, and 62,822 records. Later frames
recovered and were visibly correct, but an omitted pass is still a correctness
failure; those timings cannot qualify an optimization.

The validator originally reported four additional helper/causal counter
disagreements. Those were snapshot-age artifacts: helper text refreshes every
frame while causal telemetry may be retained for 200 ms. The validator now
accepts only monotonic helper-ahead skew and continues to reject every real
drop, abort, oversize event, timeout, or counter regression. Revalidation
retains nine validator findings across three affected runs: six counter
failures (one timeout and one abort per run) plus three helper summaries of
those same failures.

Raw directory:

```text
.omx/final-opt/wgpu-ubo-screening-clean-2
```

Integrity:

- `comparison.json`: `e783dd288105c6f362e67d991fb7bc7fba5eda028316f29b56aee4433a21069b`
- `report.json`: `6754c175eccaee5cf0588dc2cd37ef08e69635e1b8099f0e9e5c432f5987f671`

## What is actually slow in hardware WGPU

Across the eight fixed-work runs:

- `UPLOAD_BUFFER` executed 593,660-819,806 times;
- those calls moved 833-1,161 MiB;
- upload replay consumed 4.47-5.28 seconds of each 15-16 second wall run;
- only 0.89-1.23 seconds was measured SAB-to-local payload copying;
- backlog high-water was 53,849-75,140 records against a 16,384-record replay
  window.

On cache-on runs, vertex plus index uploads accounted for about 70-72% of all
buffer-upload calls. UBO misses explained nearly all remaining calls. The
measured hardware bottleneck is therefore per-call command replay and
`GPUQueue.writeBuffer` pressure, not shader translation, first-draw absence,
or raw payload copying alone.

The next behavior branch should combine vertex and index payloads into one
correctly lifetime-tracked streaming upload. The scoped design, invariants,
tests, and rollback are in [the WGPU upload coalescing plan](../wgpu-upload-coalescing-plan.md).
A larger upload arena can add timeout headroom, but it does not reduce calls or
bytes and is not a substitute for coalescing.

## Interpretation limits

- TEV confirmation measures fixed emulated-work throughput at unlimited speed,
  not realtime presentation or physical display smoothness.
- Shadow equality covers the selected TEV tuples in this Melee scene, not every
  game or TEV program.
- WGPU evidence is from one AMD RDNA 4 adapter and has real replay failures.
- The first one-draw EFB pass is the correct restoration of an all-zero saved
  EFB, not a missing gameplay draw.
- No physical input-to-photon claim is made; the causal marker stops at the
  browser canvas.
