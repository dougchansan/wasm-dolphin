# Melee hardware-WGPU pass-package projection (2026-07-12)

This is a passive architecture screen, not a benchmark win. The projection
observes records only after the existing WebGPU replay path accepts them and
does not change publication, replay, payload storage, or rendering.

## Identity

- Commit: `f52f703` on `perf/wgpu-tail-flush-gate`
- Candidate core SHA-256: `2796011f6616f6b280e2d7ffdebbee209517f362529e4500c9a5bd7f1cd98038`
- Candidate core size: 12,914,126 bytes
- Machine: AMD Ryzen 9 9950X3D, 32 logical CPUs, 128 GiB RAM
- Browser: headed Google Chrome 150.0.7871.114
- GPU: AMD RDNA 4 WebGPU adapter
- Scene: verified direct Kirby-versus-Link battle save, loaded at time zero
- Work: eight emulated core-seconds, JIT off, visible hardware WGPU

The fixed fixture hashes remained unchanged: ISO
`1018b65a58ca654056be1611a43e753de5dd5f842ce5266581b29c6a12ce7c67`
and save state
`620879e2ed3c35248deba9fb2f7b2a39f91f5374d2f6a98d2a2455cb55e156d1`.

## Structural result

| Metric | Projection-on capture |
| --- | ---: |
| Consumed legacy records | 2,340,750 |
| Existing legacy publications | 677,734 |
| Complete pass batches | 5,889 |
| Outside segments | 6,001 |
| Upload records / bytes | 644,459 / 1,384,467,068 |
| Resource records | 26,710 |
| Unsupported / malformed / nested / state-outside / incomplete | 0 / 0 / 0 / 0 / 0 |
| Safe publication reduction | 0 |
| Unsafe speculative publications | 11,890 |
| Unsafe speculative reduction estimate | 665,844 (98.25%) |
| Unresolved upload ownership | 644,459 |
| Unresolved resource ownership | 26,710 |
| Largest legacy record-only segment | 92,960 bytes |
| Runtime eligible | No |

The apparent 98.25% publication reduction is not implementable from the JS
consumer evidence. Every observed upload and resource record still lacks a
native producer-transaction ownership proof. The 92,960-byte figure is only a
legacy record-byte lower bound; it excludes payloads and must not be compared
with the 4 MiB package-cap kill gate.

## Observer overhead control

One projection-on run and one matching projection-off run were captured. Both
failed fairness and candidate-provenance qualification, so no paired effect or
speed claim exists.

| Arm | Fixed-work game speed | Core FPS | New audio underruns | Max input lateness | Valid |
| --- | ---: | ---: | ---: | ---: | --- |
| Projection on | 47.7522% | 28.6770 | 101 | 96 ms | No |
| Projection off | 47.4505% | 28.4318 | 71 | 132 ms | No |

The similar descriptive throughput does not prove zero observer cost. A
balanced repeated screen is still required before projection-captured QoS
numbers may be used for optimization claims.

## Visual result and decision

The headed capture reached Fountain of Dreams with an active timer and both
fighters at 0%, confirming direct battle load rather than character select.
It matches the prior hardware-WGPU capture, including the unresolved large
black center rectangle. Visual parity therefore passes for this instrumentation
screen, but renderer correctness is not complete.

Next, add default-off native producer ownership tracing for uploads and
resources plus an independent legacy/package semantic digest. Do not implement
runtime package replay until ownership, payload, lifecycle, draw-observable,
overhead, and fixed-work gates all pass.

Raw local artifacts:

- `.omx/wgpu-no-lag/pass-package-projection-f52f703`
- `.omx/wgpu-no-lag/pass-package-projection-off-f52f703`

