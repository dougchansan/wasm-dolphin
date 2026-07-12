# Hardware-WGPU draw-resource profile — 2026-07-12

This package records the default-off safety repair, overhead validation, phase
attribution, and visible smoke for the sampled hardware-WGPU draw-resource
profiler. It does **not** claim full speed. The authoritative stability-gated
screen averaged about 69% fixed-work game speed, and the visible run averaged
69.36% game speed.

## Identity and method

- Scene: direct verified Kirby-versus-Link battle save-state load
- Machine: AMD Ryzen 9 9950X3D, 32 logical CPUs; AMD `rdna-4` WebGPU adapter
- Authoritative browser: headed Chrome `150.0.7871.114`
- Work: 12 emulated core seconds per run, two four-run ABBA/BAAB blocks
- Primary metric: fixed-emulated-work game-speed throughput; higher is better
- Profiler arm: `wgpudrawprofile=0` versus `wgpudrawprofile=1`
- Render probe: `wgpurenderprobe=null-drain` for the overhead/attribution
  screens; no render probe for the visible smoke
- Authoritative harness commit: `771168b09f5f06f2074956380bd7e767061823cc`
- TLS candidate source commit: `31059c8b2ad50ee15ee691d60ce433f4832d7622`
- TLS candidate WASM SHA-256:
  `595e2f345b182ab187c0dca6c7660d297483f476aaa07004370ad7ebb8268caa`
  (12,913,493 bytes)
- Patch-series SHA-256:
  `17ba7df45aff733d9e191aeb607e363a3c80604d321eba2b021ac4963bcb1b03`
- Patched vendor tree: `623c2943d508493a7858516bb959d969ea01eab3`

The null-drain screens intentionally produce no visible output. They isolate
producer/core work and cannot validate presentation throughput or visible
correctness. The separate no-probe run supplies the visible evidence below.

## Default-off regression and remediation

The first implementation used shared atomic counters even while
`wgpudrawprofile=0`. A direct default-off comparison of the prior candidate
`8797d56029dcc540c5cae88b7d219712f76c63a00f884ec9aa25f64c90f90ff2`
against atomic candidate
`c9e3498688eb8c43eda630a19f925675bfd628e93ce1a3cfbaee8718ac4cef0a`
measured means of 49.5788% and 48.2478%, respectively: a **-2.6846%**
regression. That violated the default-off contract.

The remediation kept the shared sampled counters unchanged when profiling is
active, but cached the global enable state per thread so the disabled branch
avoids repeated atomic loads. Candidate `595e2f3…` measured 71.1177% versus
50.5049% for the prior candidate in the follow-up ABBA comparison, a +40.8134%
cross-build difference. That unexpectedly large recovery is not treated as an
optimization result: it may include WASM code-layout, tiering, or build-state
sensitivity and needs independent reproduction. The narrower proven result is
that the measured -2.6846% default-off regression was removed before phase
attribution. Separately, the parent `draw_resources` estimate shifted -3.444%
between profiler arms, so absolute phase estimates remain observer-sensitive.

## Discarded cold/warm screens

Two early on/off screens are retained for auditability but are not the
authoritative profiler-overhead result:

| Attempt | Block effects | Harness result | Evidence decision |
| --- | ---: | --- | --- |
| Cold TLS | +2.8770%, +0.8177% | Valid / overhead gate passed | Attribution-invalidated |
| Warm TLS | +19.8402%, -0.8918% | Valid / overhead gate passed | Attribution-invalidated |

The harness JSON marked these blocks valid, but the large order/control
movement—especially the sign reversal in the warm attempt—made them unsuitable
for attribution. The stable rerun added an explicit within-arm spread gate and
is the result used below.

## Authoritative overhead result

| Block/order | Profiler-off mean | Profiler-on mean | Relative effect | Off spread | On spread |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 / ABBA | 69.2752% | 69.5938% | +0.4599% | 2.2323% | 0.2360% |
| 2 / BAAB | 68.8010% | 69.2748% | +0.6887% | 3.3109% | 0.1365% |

Both blocks were valid and qualification-eligible. The measured profiler-on
arm was slightly faster in both orders, so overhead regression was 0% and the
predeclared maximum 2% overhead gate passed. Core-tick divergence was at most
0.0142% and frame divergence was 0.1388%. The median effect was +0.5743%, with
a block-bootstrap interval of [+0.4599%, +0.6887%]. This validates the profiler
as a low-overhead diagnostic; it is not evidence that enabling instrumentation
improves emulator performance.

## Draw-resource phase attribution

The following values are medians across the four profiler-enabled runs,
normalized to one emulated core second:

| Phase | Estimated milliseconds per emulated second |
| --- | ---: |
| `uniform_prepare` | 70.3447 |
| `command_stage` | 44.7988 |
| `bind_resource_record` | 25.1177 |
| `pipeline_uid_build` | 13.0266 |
| `texture_sampler_resolve` | 7.5603 |
| `draw_resource_init` | 7.3479 |
| `pipeline_cache_lookup` | 4.4156 |

These are independently sampled attribution estimates, not a conserved
wall-time decomposition. **Do not sum the phases.** The supported conclusion
is only their observed ranking: uniform preparation is the largest measured
draw-resource subphase, followed by command staging and bind-resource record
generation. Each candidate optimization still requires its own default-off,
order-balanced A/B.

## Visible confirmation

A separate headed, no-probe 15-second run loaded the same save and rendered
the Kirby-versus-Link battle correctly. It recorded:

| Game speed | Core FPS | Presentation FPS | Distinct canvas hashes | Audio-active samples |
| ---: | ---: | ---: | ---: | ---: |
| 69.36% | 41.76 | 31.24 | 31/31 | 98.63% |

The normal hardware-WGPU visual-FPS field remained zero because that legacy
metric uses the software/XFB hash rather than a hardware-WGPU readback. The 31
distinct browser-canvas hashes and screenshots provide the visible-motion
evidence. This smoke proves visible operation and active audio; it does not
prove real-time or lag-free play.

## Raw artifacts

Authoritative stability-gated screen:

- `.omx/wgpu-no-lag/draw-profile-overhead-stable-595e2f3/report.json`:
  `b0f76674ad45af3269b132b00205be7e061937619f92b186e740760d17c95429`
- `comparison.json`:
  `170effa2b55fc5626479883f6037fe6eee23fe6e7f529bc43f618520944a22eb`
- `runs.csv`:
  `7f6df8cd8184cf19c5e0291e7b46fd078a6ce37dadf5c8f24db6003ce37808bc`
- `comparison.csv`:
  `a982f8f95d1b81a2060f2ca1dead23491e9ef769df6e5d01399357bf027d90e0`

Discarded cold/warm attempts:

- Cold `report.json`: `ec441beef267ae2a088d0e11f3c59666639cd7a4254ed1ba3ee20cab695acba3`
- Cold `comparison.json`: `c05334f338a9287a5c8c75db451132b200f79c2d04eb0dbad7630cf0f64320cb`
- Warm `report.json`: `3522c0d07ba832fa9968d0cd967cf97d856303f59ee570647a4a946a27b4a657`
- Warm `comparison.json`: `9ba08f2ea5c9c2534da27c3af1c8dc8daa22b358e3019e98e64d4f44acfab5c5`

Visible confirmation:

- `.omx/wgpu-no-lag/visible-draw-profile-tls-595e2f3/summary.json`:
  `52368334b10d0e60455ae333e6edf3c7fc7e5e52a4e8e4297d2c5d590bd43fe3`
- `run-metadata.json`:
  `c4e55e8793c53ccc6b9faeb02fe581f384f53f8e760d3e80e576c096369695d8`
- `distinct-hashes.json`:
  `39feabefbcfb3276330eaea4d806b82e11d96b10e719067d5018d8650af2df78`
- `audio-samples.json`:
  `de8aa92c11b26bbdba7c36719ee7a121237f0656add379d93fcfe250820b7051`
- `zz-final.png`:
  `fc820035a84d9ed36f63467a2cd6198c799318857033411eaf75bcef8e2d057c`

The complete machine-readable record, including all default-off report and
manifest hashes, is
[`melee-wgpu-draw-profile-2026-07-12.json`](melee-wgpu-draw-profile-2026-07-12.json).
