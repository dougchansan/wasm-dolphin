# Hardware-WGPU mapped-drain coalescing — 2026-07-13

## Decision

**Reject as a performance optimization; keep default-off.** The candidate
deferred one upload-only mapped drain for at most 4 ms, 1 MiB, or 640 records.
It preserved upload order and visible battle output, but did not produce a
repeatable speed gain or materially reduce mapped-buffer retirement pressure.

## Fixed-work screen

- Scene: direct-loaded Kirby-versus-Link Melee save; no menu automation.
- Browser: headed Chrome; automated audio muted.
- Core: 12,916,037 bytes; SHA-256
  `fe4448a07a726b67c9b7bd73f2515118b353414a66ac48cc4b1cdd92fb42f2c8`.
- CPU affinity: `0xFFFF`.
- Work: 12 emulated seconds per run.
- Order: immediate A, coalesced B, coalesced B, immediate A.

| Run | Mode | Game speed | Batches | Capacity wait | Max submit age | Visible changes |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| A1 | Immediate | 58.021% | 3,932 | 3,873.010 ms | 15.535 ms | 21/22 |
| B1 | Coalesced | 58.794% | 3,598 | 3,738.810 ms | 10.360 ms | 21/22 |
| B2 | Coalesced | 67.379% | 3,069 | 3,949.515 ms | 16.510 ms | 18/19 |
| A2 | Immediate | 69.552% | 3,069 | 3,901.245 ms | 16.435 ms | 18/19 |

The paired effects conflict: `+1.332%` for B1/A1 and `-3.124%` for B2/A2.
The control improved 19.87% from A1 to A2, so run-order drift was much larger
than the treatment. Across arm means, the candidate was about 1.10% slower.
It reduced batches/remaps about 4.8% and cumulative capacity wait about 1.1%,
well below the preregistered 25% and 20% mechanism thresholds.

In the candidate runs, 84.9–87.1% of deferrals expired on the deadline timer;
only 6.0–7.5% reached a useful second-boundary merge. Actual oldest-upload age
at `queue.submit` exceeded the 8 ms safety limit in both runs. The feature is
therefore rejected without a longer campaign.

## Evidence boundary

The actual browser URLs and telemetry prove that the candidate executed, but
the first screen inherited its toggle from `BASE_URL`. The harness previously
validated only scenario-owned parameters, so it did not run the new quiescent
finalizer or reject the age overrun automatically. That harness gap is fixed
alongside this result. These runs are diagnostic rejection evidence, not a
promotion or qualification result.

Raw ignored artifacts:

- `.omx/wgpu-realtime-100/drain-coalesce-a1-clean`
- `.omx/wgpu-realtime-100/drain-coalesce-b1-clean`
- `.omx/wgpu-realtime-100/drain-coalesce-b2-clean`
- `.omx/wgpu-realtime-100/drain-coalesce-a2-clean`
