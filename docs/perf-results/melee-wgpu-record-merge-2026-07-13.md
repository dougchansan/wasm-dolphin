# Hardware-WGPU staging record-merge screen — 2026-07-13

## Decision

**Reject as a throughput optimization.** The candidate replaced each staging
seal's `flatMap`/wrapper allocation/sort with a direct single-slot encoder and a
reusable cursor merge for multi-slot seals. It preserved strict upload order
and visible output, but the removed CPU work was too small to improve fixed-work
game speed.

## Fixed-work screen

- Scene: direct-loaded Kirby-versus-Link battle; 12 emulated seconds per run.
- Machine/browser: AMD Ryzen 9 9950X3D, AMD `rdna-4`, headed Chrome
  `150.0.7871.114`; automated audio muted.
- Core SHA-256:
  `fe4448a07a726b67c9b7bd73f2515118b353414a66ac48cc4b1cdd92fb42f2c8`.
- Common mode: `video=wgpu`, dual CPU, JIT off, mapped staging, `0xFFFF`
  affinity, visible output.
- Order: legacy A1, ordered merge B1, ordered merge B2, legacy A2.

| Run | Mode | Game speed | Seal encode time | Batches | Merge records | Visible changes |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| A1 | Legacy sort | 71.520% | 92.435 ms | 2,903 | 0 | 17/18 |
| B1 | Ordered merge | 57.677% | 68.385 ms | 3,913 | 1,188,366 | 21/22 |
| B2 | Ordered merge | 57.480% | 65.660 ms | 3,859 | 1,184,635 | 21/22 |
| A2 | Legacy sort | 58.249% | 117.735 ms | 3,885 | 0 | 21/22 |

Every seal in all four runs used one staging slot; the multi-slot merge was not
needed in this scene. Relative to the comparable closing control, the candidate
runs were 0.98% and 1.32% slower. The 71.52% opening control is an obvious
run-order outlier and makes the first paired comparison unusable. Even taking
the mechanism at face value, roughly 50 ms of saved seal encoding across a
21-second run is only about 0.24% of wall time and cannot close the realtime gap.

All runs were valid, visibly changing, and recorded zero WebGPU errors. This is
a screening rejection, not qualification evidence; GPU completion, input
markers, and hardware visual cadence were not enabled. The candidate remains
isolated on `perf/wgpu-record-merge` and is not carried into later optimization
branches.

Raw ignored artifacts and report SHA-256 values:

- `.omx/wgpu-realtime-100/record-merge-a1` — `5fe7c928b80f9a5b5b5e6a674c90c5e7013221d3a82b771fad62b899aced72d0`
- `.omx/wgpu-realtime-100/record-merge-b1` — `79e5b4ca1792d631f58aa951430eeb9d9960fe7eb4687e0ba8172c63566c84c9`
- `.omx/wgpu-realtime-100/record-merge-b2` — `9cee1697321e4698baadb3f40338b8d2de496bb0233f7caa41bcc321859dc18e`
- `.omx/wgpu-realtime-100/record-merge-a2` — `7b2e56d2c1073c3e2df21309075d8c3f8ef1640587994654a0347c9262e4e2e6`
