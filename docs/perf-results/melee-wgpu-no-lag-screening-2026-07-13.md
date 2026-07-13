# Hardware-WGPU no-lag screening — 2026-07-13

This report closes roadmap items 1–9 by recording the implementation proofs,
balanced screens, and release decision. It does **not** claim realtime or
no-lag play. On the validation machine, `video=wgpu` now produces a correct,
changing Kirby-versus-Link battle, but the diagnostic, JIT-off campaigns remain
well below full game speed.

## Test identity

| Field | Value |
| --- | --- |
| Machine | AMD Ryzen 9 9950X3D, 32 logical CPUs, 128 GiB RAM, Windows 10.0.26200 |
| GPU | AMD RDNA 4 / Radeon RX 9070 XT class adapter |
| Browser | Headed Chrome 150.0.7871.114 |
| Branch | `perf/wgpu-semantic-digest` |
| Candidate source commit | `2b73f11d504f40c1d64a5cbeed815abd189f1bc7` |
| Upstream Dolphin commit | `e22551eae1c84a7e4d0b6a5c519ef4ed4ef69df1` |
| Patch series | `19d4e4b70c9d0aff2496880ed47a0d790b9ebdc96fa451c8e08547789310d31e` |
| Vendor result tree | `426546bcb2ef286f66df33c498ecc39954e3aaa7` |
| Candidate WASM | `4f886a64093472d8c86e3341877b55a7de6a2ca000c2e71cc5d448bc984ad0d2`, 12,918,860 bytes |
| ISO | Melee Rev 2, SHA-256 `1018b65a58ca654056be1611a43e753de5dd5f842ce5266581b29c6a12ce7c67` |
| Save state | Direct Kirby-versus-Link battle, SHA-256 `620879e2ed3c35248deba9fb2f7b2a39f91f5374d2f6a98d2a2455cb55e156d1` |
| Work unit | Eight emulated seconds per run, fixed-work throughput |

The harness loaded the battle save directly. It did not pause at character
select. Geometry, arena, and UBO campaigns were muted. The replay campaigns
explicitly requested audible AudioWorklet output and are the only campaigns in
this report eligible to support audio claims.

## Roadmap closure

| Item | Result | Decision |
| ---: | --- | --- |
| 1. Upload attribution | Role/opcode accounting and publication ownership are causally attributed. | Proven; use as the measurement authority. |
| 2. Geometry packet | Native command-stream and vertex-manager parity, lifecycle, range, and rollback smokes pass on the rebuilt candidate. | Mechanism retained behind its flag. |
| 3. Lifetime/rollback | Tiny-ring, failed-publication, abort, device-reset, range, and rollback paths are covered by native and JS tests. | Proven for the tested mechanism; no default change. |
| 4. Geometry A/B | Two valid balanced blocks: median `+0.292%`, 95% block-bootstrap interval `[-12.571%, +13.155%]`. | `SCREENING_REJECT`; keep `wgpugeompack` default-off. |
| 5. Arena capacity | Two valid balanced blocks: 64 MiB versus 32 MiB median `-7.876%`, interval `[-10.562%, -5.191%]`. | Reject 64 MiB; retain 32 MiB. |
| 6. Replay budget | Audible 4 ms and 6 ms campaigns were infrastructure-inconclusive because of input dispatch lateness and, in the 4 ms campaign, performance-threshold failures. Descriptively, both budget arms were slower than fixed replay. | No-go for 4/6 ms; retain fixed replay. |
| 7. Audio/input fairness | All 24 audible replay runs had zero recorded audio underruns and completed their input marker stages. Dispatch lateness invalidated all balanced blocks; some GPU-completion tails exceeded 200 ms. | The unmuted Worklet transport remained active, but scheduling fairness is not promotion-ready. |
| 8. Dense UBO | Native parity/rollback smokes and the strict validator pass. Two valid balanced blocks: median `-0.981%`, interval `[-1.510%, -0.452%]`. | `SCREENING_REJECT`; keep dense UBO packing default-off. |
| 9. Release/coverage | Every performance candidate failed its screen. Hardware output was validated on one AMD GPU; forced low-power/second-GPU selection was unavailable. | No confirmation promotion and no default changes. |

## Campaign results

| Campaign | Audio | Valid blocks | Fixed arm mean | Candidate arm mean | Outcome |
| --- | --- | ---: | ---: | ---: | --- |
| Geometry legacy vs packed | Muted | 2/2 | 64.683% | 64.259% | `SCREENING_REJECT` |
| 32 MiB vs 64 MiB arena | Muted | 2/2 | 69.147% | 63.657% | `SCREENING_REJECT` |
| Fixed replay vs 4 ms | Audible Worklet | 0/3 | 67.141% | 55.311% | Infrastructure-inconclusive; candidate slower descriptively |
| Fixed replay vs 6 ms | Audible Worklet | 0/3 | 64.811% | 57.105% | Infrastructure-inconclusive; candidate slower descriptively |
| Dense UBO off vs on | Muted | 2/2 | 70.245% | 69.559% | `SCREENING_REJECT` |

The replay means are descriptive only because the input-lateness gate rejected
all attempted blocks. They must not be treated as promotable estimates.

## Visible-output and latency evidence

The candidate runs identify the requested, configured, and active backend as
`WebGPU-Real`. A representative candidate run completed 431 GPU-downsample
samples, 402 of which changed, with two nonblocking busy drops and zero encode
or map errors. Its screenshot shows the Kirby-versus-Link battle rather than a
green, black, menu-only, or frozen frame.

An additional hardware visual-cadence smoke measured 49.768% fixed-work game
speed, 29.828 core FPS, and about 27 changing visual samples per second. That
smoke used JIT off and several diagnostics, so it is a diagnostic lower-bound,
not a clean playback benchmark. It proves visible mutation and cadence, not
realtime performance.

Across the audible replay campaigns, the unmuted AudioWorklet transport
remained active, recorded zero underruns, and every run completed the causal
input marker stages. This is transport telemetry, not external acoustic proof.
However, post-load input events were often dispatched more than 100 ms late,
and poll-to-GPU-completion p95 reached as high as 293 ms. These failures are
scheduling evidence, not permission to relax the gate.

## Artifacts and hashes

Raw artifacts remain local under `.omx/wgpu-no-lag/` and include JSON/CSV
samples, events, console logs, screenshots, manifests, comparisons, tasklists,
and build provenance.

| Artifact root | `report.json` SHA-256 |
| --- | --- |
| `item-4-geometry-rerun-muted-v2` | `ca091a4f96a6a89e8473ad0111e1a97b0abed683a2405934117c6dde2d46891a` |
| `item-5-arena-rerun-muted-v2` | `d69a950819fe3db83c0dce4fea15d8388a358eadd281e3346eb5105a427c9793` |
| `item-6-replay-4ms-rerun-audible-v3` | `5c28c698dedee76fb99a5c0ac92020872e81e3a63829c59a6bca0a65b15d427a` |
| `item-6-replay-6ms-rerun-audible-v2` | `e811d92bb0304206973fbefa411779d43a3e13e87ad1e29a0ef5fad6ef11a863` |
| `item-8-dense-ubo-rerun-muted-v2` | `056671a0af2d4288cda2ff2be9f302cbe70e0aa1508b901615553a99a3b356af` |

One dense-UBO-on screenshot had anomalous page framing, while the other packed
screenshots showed the correct battle. Semantic/resource validators did not
report a renderer error, but the anomaly reinforces the no-promotion decision.

## Release decision

Do not promote geometry packing, a 64 MiB upload arena, time-budgeted replay,
or dense UBO packing. Do not describe hardware WGPU as realtime, full-speed, or
no-lag on this evidence. Keep the experimental flags and rollback paths, retain
the 32 MiB arena and fixed replay behavior, and make the next performance work
target measured producer/replay cost rather than enlarging queues or weakening
correctness and latency gates.

No tracked `.wasm` or generated core artifact was changed by this evidence
package.
