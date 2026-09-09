# Mario Kart Wii on hardware WebGPU: where the missing performance is

Measured on `perf/wgpu-mkwii-throughput`, from main `5105474` (PR #19 merged).

    core sha256   650308c2c52fbf7fa9818cbe1fa27c2794ae31c5d0d56344533858a179f229e3
    vendor tree   37ed892e5367e448634807deef5f74fe66c1012f
    browser       Chrome 152.0.7977.83
    GPU           AMD Radeon RX 9070 XT
    CPU           Ryzen 9 9950X3D (16C/32T)
    fixture       __mkw-race.sav, SAVE_STATE_AT=0, INPUT_SCRIPT=none, 60 s
    query         video=wgpu&presenter=webgpu, no diagnostic flags

## Baseline

| | median speed | frames / 60 s | present fps | core fps |
| --- | ---: | ---: | ---: | ---: |
| hardware WebGPU | 46.0% | 1790 | 19.7 | 33.8 |
| software | 99% | 3597 | 54.0 | 59.8 |

Reproduced in two separate idle sessions (1825 and 1790 frames), so the
baseline is stable to about 2%. Frames advanced is quoted in preference to the
game-speed mean, which is skewed by start-up spikes.

## It is not CPU emulation

The software path reaches 59.8 core fps on the *same* cached interpreter and
the same WASM JIT. The hardware path drags the same emulation down to 33.8.
That is roughly 13 ms per frame of extra work on the emulation thread, and it
rules out "the CPU core is not fast enough" as the explanation.

## Stage costs

From the native phase timers (`?wgpuprodprofile=1&wgpudrawprofile=1`, which
themselves cost about four points, so this is a separate run from any
throughput number):

| stage | ms/frame | calls/frame | mean |
| --- | ---: | ---: | ---: |
| UniformPrepare | 5.42 | 514 | 10.55 us |
| CommandStage | 1.57 | 3423 | 0.46 us |
| DrawResources | 1.13 | 514 | 2.20 us |
| UploadCopy | 1.09 | 1846 | 0.59 us |
| RingPublish | 0.82 | 1924 | 0.43 us |
| BindResourceRecord | 0.82 | 1542 | 0.53 us |

Two phases are excluded from that ranking on purpose. `FifoDecode` (8.9
ms/frame) wraps the draw callbacks, so it double-counts every row above.
`FifoTailFlush` reports 526,054 calls per frame -- it is the dual-core idle
poll, and reading its estimated total as work gives 339 seconds inside a
60-second run.

## Root cause: the uniform blocks are ~24x larger than their changes

`?wgpuubometrics=1`, per class, over a 1611-frame window:

| class | uploads/frame | bytes uploaded each | bytes actually changed | waste | dirty ranges |
| --- | ---: | ---: | ---: | ---: | ---: |
| VS | 361 | 4112 | 172 | **23.9x** | 4.0 |
| PS | 233 | 1024 | 95 | 10.7x | 3.9 |
| GS | 2 | 256 | 15 | 17.3x | 0.9 |

`VertexShaderConstants` is 4112 bytes, and its three largest members --
`transformmatrices` (1 KiB), `posttransformmatrices` (1 KiB) and
`normalmatrices` (512 B), 2560 of the 4112 -- are exactly the parts that do not
change between draws within a frame. Over the run the VS class alone moves
**2.39 GB to convey 0.100 GB of change**.

That is what saturates the upload arena: 242 wraps, ~800 waits, 2.1 s blocked,
125 ms worst single stall, 32 MiB high-water on a 32 MiB arena. The command
ring, by contrast, never waits once.

The UBO slice cache cannot fix it: the VS hit rate is 8.3%. Mario Kart Wii
really does change its constants nearly every draw. It just changes very
little of them.

## What the existing knobs do

Clean interleaved runs, machine idle, two reps each against an adjacent
control (60 s each):

| knob | frames | delta |
| --- | ---: | ---: |
| control | 1790 | -- |
| `wgpuubocache=1` | 1869 | +4.4% |
| `wgpuuploadmb=128` | 1799 | +0.5% |
| `wgpuuniformfast=1` | 1765 | -1.4% |
| `wgpustatecache=1` | 1767 | -1.3% |

None of them is the fix, and two of them cannot be by construction:

- `WebGpuUniformFastPath::Plan` only skips the whole-block *comparison* when
  the draw is going to publish a slice anyway. It never reduces upload volume.
- `wgpuubocache` deduplicates whole slices, and at an 8.3% VS hit rate there
  are few duplicates to find.

The `wgpuubocache` result of +4.4% overlaps the control spread at n=2 and
should not be read as a win without more repetitions.

## Sparse UBO copy-forward acts one layer too late

`src/wgpu-sparse-ubo-copy-forward.js` uploads only the dirty 16-byte ranges of
a constant block, and its class spec even names the right number (`vs: 4112`).
It looked like the answer. It is not, and the reason is structural rather than
a tuning problem.

    ensureWgpuSparseUbo(dev)?.stage({ pool, data, destination: buf, ... })

`data` there is the payload **after** it has already crossed from the WASM heap
into the upload arena. The module reduces the device-side staging write; the
2.39 GB that saturates the arena is produced upstream of it, by
`WebGPUGfx::AllocUboSlice` calling `UploadAlloc(data, size, 16)` with the full
4112 bytes.

Measured, interleaved (this batch ran under external CPU load, so read only the
within-batch deltas):

| configuration | frames | delta | upload wait |
| --- | ---: | ---: | ---: |
| control | 1643 | -- | 2.77 s |
| `wgpuuploadtransport=mapped` | 1406 | -14.5% | 7.19 s |
| `+ wgpuubosparse=1` | 1399 | -14.9% | 7.67 s |
| `+ wgpuubocache=1` | 1377 | -16.2% | 6.57 s |

Sparse adds nothing over the mapped transport it requires, and the arena wait
does not fall -- which is the signature of a change that never touched the
arena. The mapped transport is itself a 14.5% regression on this workload.

## Recommended next step

Make the *producer* upload only dirty ranges. The shadow copies that
`PrepareDrawResources` already maintains (`m_vs_shadow`, `m_ps_shadow`,
`m_gs_shadow`) contain everything needed to compute them; the block is already
compared against them with `memcmp` on every draw, so the comparison is paid
for already and only the range bookkeeping is new.

Because slices are bump-allocated fresh, a partial write needs the previous
slice contents carried into the new one first, so this is a copy-forward on the
device plus small dirty-range uploads -- the same shape as the JS module, moved
to the layer where the traffic actually is. That is a native change and a core
rebuild.

Expected upside: VS traffic 4112 -> ~172 bytes plus range overhead on 361
draws/frame, which should remove most of the 2.1 s of arena stalls and a large
part of the 5.42 ms/frame in UniformPrepare. It does not obviously reach parity
with software on its own, and no estimate here should be treated as a promise
until it is built and measured.

## Measurement notes

Two batches were discarded during this work. The first eight-knob sweep ran
while an unrelated 16-core job shared the machine; an identical control re-run
afterwards fell from 46% to 39% with arena stalls rising 2.1 s -> 3.5 s, which
is larger than every effect being measured. A second batch overlapped two
emulator instances.

Every number kept here comes from runs that were interleaved with an adjacent
control, so shared load biases both arms equally. On a machine that other work
shares, only within-batch deltas mean anything, and absolute numbers between
batches do not compare.
