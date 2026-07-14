# Melee hardware-WGPU UBO change attribution — 2026-07-13

## Decision

Proceed to a separately guarded sparse-UBO publication prototype. The measured
physical UBO payload is highly sparse: across the fixed battle window, exact
changed bytes were 3.03% of comparable full payload bytes and 16-byte dirty
coverage was 5.18%. This is evidence for a prototype, not evidence that sparse
publication is already faster or correct.

The current renderer allocates a fresh UBO ring slice for each physical
publication. It therefore cannot simply omit unchanged bytes: a new slice does
not contain the previous payload. The next behavior branch must first establish
safe destination ownership, such as alternating source/destination GPU buffers
with a full GPU-side copy plus bounded dirty-range overwrites. It must retain a
full-upload fallback and byte-identical smoke tests.

## Run identity

- Scene: direct-loaded Melee save-state, Kirby versus Link battle
- Audio: muted for automated validation
- Browser: headed Chrome from the repository Playwright configuration
- CPU affinity: `0xFFFF`, inherited by Chrome on the 96 MiB L3 CCD
- Video: `video=wgpu`, visible hardware-WGPU replay, WebGPU presenter
- Upload transport: mapped, three 16 MiB slots
- Fixed work: 12 emulated seconds
- Diagnostic core SHA-256:
  `6b2cf8f20564060d99da497fd5fa64598a362af2b5898230f48c3ba06806e163`
- Diagnostic core size: 12,921,193 bytes
- Accepted production core remains:
  `fe4448a07a726b67c9b7bd73f2515118b353414a66ac48cc4b1cdd92fb42f2c8`
- Raw output:
  `.omx/wgpu-realtime-100/ubo-change-visible-diagnostic-1`

The run was valid and reached 5,843,478,431 core ticks and 721 frames in
20.992 seconds. Its 57.277% game speed is diagnostic-only: exact byte scanning
and additional counters were enabled with `wgpuubometrics=1`, so this number is
not compared with normal throughput runs. The run produced 21 readable visual
changes; its unique-visual-FPS aggregate was not usable and is not reported as
a visual-performance result.

## Fixed-window UBO deltas

Baseline-only observations were zero for every class inside the fixed window,
so every byte ratio below uses comparable observations. “16-byte” and
“256-byte” values are payload bytes covered by dirty aligned regions, with the
final partial region clamped to the actual structure size.

| Class | Physical publications | Full bytes | Exact changed bytes | Changed % | Dirty 16-byte coverage | 16-byte % | Dirty 256-byte coverage | 256-byte % |
| ----- | --------------------: | ---------: | ------------------: | --------: | ---------------------: | --------: | ----------------------: | ---------: |
| VS | 232,173 | 954,695,376 | 34,319,826 | 3.595% | 53,151,264 | 5.567% | 133,582,848 | 13.992% |
| PS | 144,234 | 221,543,424 | 1,490,105 | 0.673% | 8,197,104 | 3.700% | 78,721,792 | 35.533% |
| GS | 117,152 | 7,497,728 | 4,827 | 0.064% | 25,744 | 0.343% | 102,976 | 1.373% |
| Total | 493,559 | 1,183,736,528 | 35,814,758 | 3.026% | 61,374,112 | 5.185% | 212,407,616 | 17.944% |

The same window contained 980,509 contiguous 16-byte dirty ranges, or 1.987
ranges per physical publication. At 256-byte granularity it contained 677,240
ranges, or 1.372 per publication. These are weighted aggregates; they do not
establish a median or typical per-draw value.

## Mapped-staging attribution

The fixed window staged 1,820,633,080 bytes across 1,156,071 records. Full UBO
payload represented about 65.0% of those bytes. There were 64 new capacity-wait
episodes plus one episode already active at the boundary that completed inside
the window. Critical-path capacity wait totaled 1,325.46 ms.

| Role at held record | New episodes | Completions in window | Wait ms |
| ------------------- | -----------: | --------------------: | ------: |
| UBO | 1 | 1 | 104.695 |
| Utility uniform | 2 | 2 | 231.150 |
| Vertex | 61 | 62 | 989.615 |
| Other roles | 0 | 0 | 0 |

The held record is usually a vertex upload, but this does not prove vertex data
created the pressure. UBO records account for most staged bytes and commonly
fill the pool before the following vertex record encounters the exhausted
capacity. Role-at-trigger and byte contribution must remain separate metrics.

## Instrumentation guarantees

- The byte scan is default-off and runs only with explicit
  `wgpuubometrics=1`.
- Counters include only successful physical publications. UBO-cache hits are
  excluded by checking the publication serial.
- First/invalid shadows are recorded separately as unknown baseline bytes, not
  as changed bytes.
- The parser requires `ubodiff` schema/version/epoch/class-count attestation;
  missing or malformed vectors are unavailable rather than interpreted as
  zero churn.
- Native compile-time fixtures cover equal data, 15/16/17 and 255/256
  boundaries, disjoint regions, and the 4,112-byte VS tail.
- Mapped wait completion is generation-guarded so a remap from an old core load
  cannot mutate a newer run's attribution.

## Next A/B

Build a default-off sparse-publication prototype on a separate behavior branch.
First prove byte-identical output and rollback under failed publication, cache
reuse, ring wrap, reset, and save-state load. Then compare repeated ABBA blocks
against the accepted core using the same save-state, fixed work, visible and
null-drain modes, CCD affinity, and metrics-off throughput configuration.
