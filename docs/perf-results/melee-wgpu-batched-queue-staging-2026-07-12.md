# Melee hardware-WGPU batched queue-staging smoke (2026-07-12)

## Decision

**REJECT. Do not run a balanced A/B or merge
`wgpuuploadtransport=batched`.** The transport was mechanically correct but
reintroduced the original synchronous `GPUQueue.writeBuffer` stall at a larger
granularity. One queue write blocked the renderer/control worker for 1.728
seconds, GPU-completion tails exceeded two seconds, and AudioWorklet recorded
98 underrun events after a 1.812-second producer-timer gap.

The fixed-work speed of this single invalid smoke is not promotion evidence.
The run failed the audio gate and omitted explicit WGPU classifier activation.

## Design and review

The default-off experiment used one 16 MiB CPU arena, one reusable GPU
`COPY_DST | COPY_SRC` staging buffer, exactly one `queue.writeBuffer` per
nonempty transaction, and an upload command buffer submitted before dependent
render command buffers. Reuse relied only on same-queue ordering, consistent
with the WebGPU queue timeline; it used no completion-promise ordering.

Review caught and fixed two presentation bugs before the smoke:

- completed-pass submission cleared the encoder before `SUBMIT_PRESENT`, so a
  persistent render-submission latch now carries valid work to presentation
  accounting while excluding upload-only flushes;
- latch-only presentation now starts the generation-fenced one-shot queue
  completion probe without duplicating a current-present probe.

The full source suite passed after those repairs.

## Fixed smoke

- Scene: direct `__battle.sav` load into Kirby versus Link.
- Commit: `1ebeb105d0714006c5ed279a777251500103f712` on
  `perf/wgpu-batched-queue-staging`.
- Core: 12,893,772 bytes, SHA-256
  `2576faf651de4dd6cd9677e2770c6285271e63ceb30e39489b978f9b43bab245`.
- Browser/GPU: headed Chrome 150.0.7871.114, AMD `rdna-4` adapter.
- Mode: hardware WGPU, batched queue uploads, geometry packing on, dense UBO
  and state/UBO caches off, JIT off, AudioWorklet audio, metrics,
  GPU-completion, and input telemetry on.
- Work: eight emulated core seconds with six spaced input events.
- Result: qualification-eligible but failed due to 98 timed audio underrun
  events. No rerun or A/B was allowed after the failed activation smoke.

The run reached eight emulated seconds in 10.752 seconds: 74.616% game speed
and 44.643 core FPS. Presentation averaged 34.33 FPS with 551 submitted frames;
11 of 12 readable visual samples changed. The screenshot and EFB draw counters
showed the Kirby-versus-Link battle. The visible black/white rectangle is the
intentional optical input marker, not a black-frame failure.

## Mechanism evidence

| Metric | Value |
| --- | ---: |
| Logical uploads | 541,810 |
| Scatter copies | 528,755 |
| Transactions / queue writes | 5,786 |
| Logical bytes | 1,172,778,440 |
| Queue-write bytes | 1,173,536,736 |
| Queue-write CPU total | 1,907.275 ms |
| Queue-write CPU max | 1,728.255 ms |
| Command encoding total / max | 39.530 / 0.390 ms |
| Queue submit total / max | 270.830 / 114.655 ms |
| Drain-boundary / completed-pass flushes | 1,324 / 4,462 |
| GPU completion p95 / max | 12.99 / 2,085.285 ms |
| Batched-staging GPU p95 / max | 416.19 / 2,085.285 ms |

The transport ended open with zero pending bytes/uploads and exact equality
between sealed transactions, submitted transactions, and queue-write calls.
It recorded zero capacity misses, oversized uploads, invalidations, transport
fatals, WebGPU errors, GPU-completion failures, command drops, batch aborts,
upload timeouts, or ring-handoff mismatches.

The worker produced all 485,760 requested audio frames with zero empty mixes
and a 2.11 ms maximum mix time. Nevertheless, the synchronous queue-write
stall prevented timely producer scheduling, causing 98 underrun events. This
is direct evidence that the call blocks the shared disc/control worker even
when emulation-side audio production is fast enough.

Inputs were 6/6 with 32 ms maximum dispatch lateness and exact marker parity.
Reported marker completion is browser/GPU completion, not physical photon
latency.

## Evidence boundary

Raw ignored artifacts are under
`.omx/wgpu-no-lag/batched-queue-smoke-2576faf/`.

- `report.json`: `c459c5a51b28ae3ced967c115d1d2ba1802d77b6332dc902ce433293943bb22b`
- `summary.json`: `391737d0316d396169e1c5f8965de5db2aea5abf921a5f3d6b70b75369acca21`
- `manifest.json`: `cd2a8cf8ea10989835985533b1244e1bdf339e15b2a4a7213b812f479fddb33e`
- `runs.csv`: `fba79e61241e61a3a1cac0f68b70d4816e967d10489f5c762491fbcf1077fa34`
- `final.png`: `cb1ba9be7ad4a90bc284f03dc9bae4a80790d044f8eb6f6adf6bb14af39d34b1`

The manifest's WGPU replay classifier is null because the smoke did not set
`WGPUCLASSIFY=1`. Do not claim explicit classifier completion from this run.
The visual/EFB and ordinary completion evidence is sufficient to diagnose the
transport stall, but not to qualify a renderer promotion.

The next architecture should isolate replay from audio/input/control rather
than adding another upload transport on the same worker. A dedicated renderer
worker may improve responsiveness, but it will not by itself remove the
renderer throughput limit and must be scoped accordingly.

