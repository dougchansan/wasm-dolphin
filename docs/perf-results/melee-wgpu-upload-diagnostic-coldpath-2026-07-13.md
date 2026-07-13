# Hardware-WGPU upload-diagnostic cold-path screen — 2026-07-13

## Decision

**Reject and fully roll back.** Moving legacy upload diagnostic work behind a
default-off gate did not improve the direct-save hardware-WGPU path. Both
paired comparisons regressed, so the behavior change was removed rather than
kept as an unmeasured cleanup.

## Fixed-work screen

The headed, muted-audio ABBA block used the verified core, Kirby-versus-Link
save, `0xFFFF` affinity, mapped staging, dual CPU mode, JIT off, visible output,
and 12 emulated seconds per run.

| Run | Legacy diagnostics | Game speed | Presentation FPS | Visible changes |
| --- | --- | ---: | ---: | ---: |
| A1 | On/reference | 58.151% | 25.227 | 21/22 |
| B1 | Off/cold | 55.760% | 21.696 | 22/23 |
| B2 | Off/cold | 56.656% | 23.435 | 22/23 |
| A2 | On/reference | 58.077% | 24.091 | 21/22 |

The paired candidate effects were approximately -4.11% and -2.45%. All runs
were valid and visibly changing. The candidate sometimes reduced batch count
and cumulative remap latency, but that did not improve fixed-work throughput.
The most plausible explanations are incidental producer pacing or browser/JIT
code-layout effects; this short screen does not distinguish them.

Raw ignored artifacts and report SHA-256 values:

- `.omx/wgpu-realtime-100/upload-log-a1` — `fb34f2195fe411fb1ad38d90e9db31d7682ab22b05e4c561a05fd8a2e6d58720`
- `.omx/wgpu-realtime-100/upload-log-b1` — `1a7e6a28522e7975178c3095bc8bf25096e4b0950134352dd1c84d45b2e66ec3`
- `.omx/wgpu-realtime-100/upload-log-b2` — `23c63725ca5863b0a5c1a1eb9dfa0f6f724386182f98834a1746e93ee561615c`
- `.omx/wgpu-realtime-100/upload-log-a2` — `4d103c278439882c5f13bc07fab8c51aeec09b9eb006b0ee5b23dab9a241c472`
