# Melee hardware-WGPU queue-relief experiments (2026-07-11)

These direct-save smokes tested whether asynchronous GPU queue fences could
replace the recurring 1.7-second synchronous `GPUQueue.writeBuffer` stall. The
experiment substantially improved measured game speed and queue latency, but
none of the variants preserved every correctness, audio, and input gate. The
runtime and URL flag were removed before release; this document retains the
negative result.

## Environment

| Field | Value |
| --- | --- |
| Core | 12,877,445 bytes; SHA-256 `03acd0d3f5b6b82fdd4644b03b26addeef8487307211e6eba70a3ee8b66e133b` |
| Browser | Headed Chrome 150.0.7871.114 |
| CPU/GPU | AMD Ryzen 9 9950X3D; AMD `rdna-4` WebGPU adapter |
| Scene | Direct verified `__battle.sav` Kirby-versus-Link load |
| Work | Eight emulated seconds; same 12 input transitions |
| Historical flag | `wgpuqueuewait=1` (removed) |

A separate smoke requested `wgpupower=low`, but Chrome still reported the same
`rdna-4` adapter. This does not count as second-GPU coverage; a distinct adapter
or machine remains required for that validation.

## Results

| Variant | Game speed | Max queue write | Max drain | Queue wait max | Timeout/abort/drop | Audio/input |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| Baseline, no relief | ~66% | ~1,712 ms | ~1,717 ms | — | 0/0/0 in clean item-6 screen | 1 underrun; no 12/12 parity |
| 8,192 calls / 16 MiB | 80.33% | 5.79 ms | 57.52 ms | 1,888.21 ms | 1/1/0 | 1 underrun; 10/12 polled |
| 8,192/16 with captured-suffix staging | 81.41% | 7.72 ms | 57.10 ms | 1,880.71 ms | 1/1/0 | 2 underruns; 10/12 polled |
| 1,024 calls / 2 MiB | 78.02% | 10.29 ms | 38.51 ms | 1,938.46 ms | 1/1/0 | 1 underrun; 11/12 polled |
| 1,024/2 with continuous staging | 75.93% | 2.25 ms | 11.96 ms | 1,966.88 ms | 0/2,409/2,437 | 1 underrun; 11/12 polled |

Raw output:

- `.omx/wgpu-no-lag/item-9-queue-relief-on-smoke/`
- `.omx/wgpu-no-lag/item-9-queue-relief-staged-smoke/`
- `.omx/wgpu-no-lag/item-9-queue-relief-2mb-smoke/`
- `.omx/wgpu-no-lag/item-9-queue-relief-continuous-stage/`

Those machine-local raw directories are gitignored and are not part of the
repository. The committed companion JSON preserves the aggregate measurements
and decision; it is not a substitute for the raw event streams.

Every run reached the fixed emulated-work target and retained nonzero rendering
evidence. The measurements are diagnostic, not a balanced promotion campaign.

## Interpretation

These diagnostic smokes strongly implicate browser upload backpressure as the
main observed hardware-WGPU throughput limiter: removing synchronous `writeBuffer` stalls
raised measured speed from roughly 66% to 76–81% and reduced drain maxima to
12–58 ms. GPU-completion p95 also fell as low as 7–136 ms depending on the
variant.

The long startup queue fence still lasts about 1.9 seconds. If the consumer
stops advancing the upload watermark, the 32 MiB producer arena times out. If
upload payloads are retained continuously so that watermark can advance, the
producer fills the 262,144-record command ring and begins dropping whole
batches. Increasing staging memory therefore moves the bounded-resource failure
rather than fixing it.

The worker event loop did service some audio and input activity during fences,
but one WebAudio underrun and at least one superseded input generation remained.
The first input pair was repeatedly delivered late and nearly together during
the startup GPU event.

## Decision

Do not ship `wgpuqueuewait=1`, and do not describe the 76–81% figures as a
successful optimization because the strict correctness and latency gates fail.
The experimental runtime was removed; only its evidence and design record are
retained.

The next architectural step must provide one of:

1. a bounded shadow command queue that copies command records and upload
   payloads together before advancing native ownership;
2. a dedicated renderer worker plus an explicit non-aborting producer
   backpressure protocol; or
3. a mapped GPU staging pool that avoids Dawn `writeBuffer` allocation pressure
   without pausing command consumption for ~1.9 seconds.

Simply enlarging timeouts, upload staging, or the command ring would hide or
move the stall and is not an acceptable promotion path.
