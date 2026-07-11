# Melee hardware-WGPU UBO attribution (2026-07-11)

This measurement determines whether UBO packetization is the next safe
hardware-WGPU optimization. It is not. UBO changes co-occur often enough to
remove many API calls, but the safe fixed-stride packet design fails the
padding and measured CPU-ownership gates. The dominant 1.7-second stall is
global `GPUQueue.writeBuffer` staging pressure and can occur on either a UBO or
packed-geometry write.

## Environment

| Field | Value |
| --- | --- |
| Clean-build commit | `b809698` |
| Core | 12,877,445 bytes; SHA-256 `03acd0d3f5b6b82fdd4644b03b26addeef8487307211e6eba70a3ee8b66e133b` |
| Browser | Headed Chrome 150.0.7871.114 |
| CPU/GPU | AMD Ryzen 9 9950X3D; AMD `rdna-4` WebGPU adapter |
| Scene | Direct verified `__battle.sav` Kirby-versus-Link load |
| Work | Eight emulated seconds per run |
| Raw cache-off | `.omx/wgpu-no-lag/item-8-ubo-cache-off-clean/` |
| Raw cache-on | `.omx/wgpu-no-lag/item-8-ubo-cache-on-run1/` |

These are diagnostic counterpart runs, not a new statistical promotion
campaign. The earlier repeated UBO-cache screen also found no repeatable speed
gain; this pass adds direct queue-write ownership and packet-opportunity data.

## Packet opportunity

With UBO caching off:

| Measure | Value | Gate |
| --- | ---: | ---: |
| Queue buffer-write calls | 507,416 | — |
| Theoretical UBO calls removed | 158,211 (31.18%) | At least 15%: pass |
| UBO packet payload bytes | 732,525,984 | — |
| Safe fixed-stride aligned bytes | 780,749,568 | — |
| Padding overhead | 6.58% | At most 2%: **fail** |
| UBO queue-write CPU share | 90.42% in this run | At least 25%: pass, but unstable |

The CPU role share is not stable enough to identify the root cause. In the
preceding cache-off run the one 1.705-second stall occurred on a 12,456-byte
packed-geometry write; in the clean cache-off counterpart it occurred on a
1,536-byte UBO write. With caching on it occurred on a 4,112-byte UBO write.
The next small write blocks when the browser/Dawn upload staging pipeline is
already saturated; the semantic producer role is incidental.

## Cache diagnostic

| Measure | Cache off | Cache on | Interpretation |
| --- | ---: | ---: | --- |
| Game speed | 66.23% | 65.25% | No diagnostic gain |
| Queue-write calls | 507,416 | 384,647 | 24.20% fewer |
| Queue-write CPU total | 2,269.03 ms | 2,355.42 ms | Stall cost unchanged/worse |
| Maximum queue write | 1,711.58 ms | 1,711.77 ms | No improvement |
| Queue submissions | 1,417 | 1,466 | No reduction |
| GPU-completion p95 | 242.20 ms | 224.88 ms | Better in one run, not qualifying |
| Battle-window audio underruns | 1 | 0 | No repeated causal conclusion |

The cache-on run was qualification-eligible and passed its single-run harness
checks. The cache-off run was qualification-eligible but failed because of one
battle-window audio underrun. Neither single run promotes a default. Combined
with the earlier repeated cache screen, they support keeping the cache
default-off.

## Decision

Do not implement the safe fixed-8-KiB-stride UBO packet prototype now. It would
meet the call-removal threshold but violates the padding limit and does not
address the global staging stall. Dense 256-byte UBO packing remains a possible
larger liveness refactor, not an immediate optimization.

Do not promote `wgpuubocache=1`; it reduced calls but did not remove the long
queue stall or improve speed repeatably.

The next architecture should move replay to a dedicated renderer worker with
bounded, non-dropping producer backpressure, or use a bounded mapped staging
pool with per-submission completion tracking. The attempted asynchronous
same-worker relief path was rejected after timeout, abort/drop, audio, and
input failures.
