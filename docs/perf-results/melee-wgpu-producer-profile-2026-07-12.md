# Melee hardware-WGPU producer profile (2026-07-12)

## Decision

The sampled producer profiler is cheap enough to use for attribution. A headed,
two-block ABBA/BAAB overhead screen measured a worst block regression of
**0.22%**, below the strict **2%** limit. Both blocks were valid and semantic
core-tick/frame work differed by at most **0.14%**.

The repeatable hot pattern is the dual-core FIFO idle tail: it entered the
`Flush`/`RefreshPeekCache` scope about **22.2 million times per emulated
second**. This is more than 76 times the `fifo_decode` call rate. It justifies a
default-off experiment that removes only state-proven no-op calls; it does not
justify changing the default or skipping required flush/peek work.

## Identity

- Scene: fixed Kirby-versus-Link battle save, loaded directly with no menu or
  character-select pause.
- Host: Windows 10.0.26200, AMD Ryzen 9 9950X3D, 32 logical CPUs, 128 GB RAM.
- Browser: headed Chrome 150.0.7871.114.
- GPU: AMD RDNA 4 WebGPU adapter.
- Host commit: `db8cb448be84bf304a1dd54ec3124aa577028f1b`.
- Core WASM: 12,908,800 bytes, SHA-256
  `9a52203461bf43b5f1f56ae4858ad5e8872ae32196f431e94ec51ae2d0c96138`.
- ISO SHA-256:
  `1018b65a58ca654056be1611a43e753de5dd5f842ce5266581b29c6a12ce7c67`.
- Save SHA-256:
  `620879e2ed3c35248deba9fb2f7b2a39f91f5374d2f6a98d2a2455cb55e156d1`.

## Profiler overhead

Each run used 12 fixed emulated seconds, JIT off, metrics on, mapped staging,
geometry packing, and the intentional `null-drain` probe. Null drain isolates
producer cost and intentionally does not validate visible rendering.

| Block | Profile-off mean speed % | Profile-on mean speed % | Effect | Profiler regression | Valid |
| --- | ---: | ---: | ---: | ---: | --- |
| ABBA | 74.379 | 74.216 | -0.220% | 0.220% | Yes |
| BAAB | 74.474 | 75.139 | +0.893% | 0% | Yes |

The median effect was +0.337%. This is a non-promotable instrumentation screen,
not a performance improvement claim.

An earlier 8-second campaign was infrastructure-inconclusive because one run
ended at 481 rather than 480 frames and the command-records-per-frame spread
crossed the strict 0.5% workload-shape limit. No values from that invalid block
are used in the result above.

## Phase attribution

Values below are medians across the four profile-on runs. Calls are exact
counter deltas. Estimated time is the sampled duration multiplied by the phase
period; phases are inclusive and non-additive.

| Phase | Calls / emulated second | Estimated ms / emulated second | Range |
| --- | ---: | ---: | ---: |
| `fifo_tail_flush` | 22,229,083 | 5,150.3 | 5,038.4–5,350.8 |
| `draw_resources` | 26,355 | 204.2 | 198.7–221.1 |
| `fifo_decode` | 290,125 | 158.5 | 148.8–177.0 |
| `upload_copy` | 66,868 | 25.3 | 24.6–27.4 |
| `ring_publish` | 70,424 | 18.7 | 16.9–23.1 |
| `geometry_commit` | 26,044 | 11.2 | 10.6–11.2 |
| `shader_translate_emit` | 1.7 | 5.9 | 5.9–6.1 |
| `bind_group_prepare` | 2,848 | 2.5 | 2.1–3.0 |

The 5.15-second absolute tail estimate is not physically interpretable as wall
time on one GPU thread. The measured scope is only a few hundred nanoseconds,
so clock overhead and deterministic sample aliasing dominate after multiplying
by the period. The reliable finding is the exact, repeated call frequency—not
the absolute duration estimate.

## Visible renderer confirmation

A separate no-probe headed run rendered the Kirby-versus-Link scene correctly.
It reached 8 fixed emulated seconds at **74.77%** game speed and **44.81** core
FPS, processed 2,036,444 replay commands, made 2,256 queue submissions, completed
75/75 sampled GPU waits, and recorded zero audio underruns. This confirms
renderer correctness on the validation GPU, but it remains below the realtime
target.

## Next experiment

Screen a default-off true-WGPU tail gate that uses the exact existing early-out
states: call `VertexManagerBase::Flush()` only when the vertex manager is not
already flushed, and call `RefreshPeekCache()` only when either peek cache needs
refresh. Preserve the current unconditional pair when the flag is off. Require
balanced fixed-work evidence, counter invariants, EFB-access stress coverage,
and a separate visible battle confirmation before considering any default.

## Raw evidence

- Valid overhead screen:
  `.omx/wgpu-no-lag/producer-profile-overhead-rerun-9a5220/`
- Valid report SHA-256:
  `6219107fd45023a96824e2470780ea39d1ca54a638fd9ec6f36d92cfe235c759`
- Valid comparison SHA-256:
  `c4a55efbd31e1319a778cd094883de1ade1499a068af22d4ec307a25f40af50a`
- Visible confirmation:
  `.omx/wgpu-no-lag/visible-wgpu-warning-confirmation-9a5220/`
- Visible summary SHA-256:
  `8912724544484ed56b18248f8cc8d0c7919bda673eb8bb8ad3e225f4f89bf92e`

The raw `.omx` directories are local and uncommitted. The compact JSON record
contains the machine-readable decision and summary values.
