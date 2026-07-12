# Melee hardware-WGPU deep-diagnostic gate — 2026-07-12

This screen asks whether default-off legacy C++ diagnostics remove measurable renderer overhead. It is a screening result, not evidence that hardware WGPU is realtime.

## Environment

- Commit: `2bda1b097eee576e1d68ebb767dd8ad62bc31411`
- Machine: AMD Ryzen 9 9950X3D, 32 logical CPUs, 128 GiB RAM, AMD RDNA 4 GPU, Windows 10.0.26200
- Fixed-work browser: headed Google Chrome 150.0.7871.114 with cold ephemeral profiles
- Scene: verified Kirby-vs-Link save loaded at time zero; no menu driving or gameplay input
- Work per pass: 12 emulated seconds
- Order: ABBA followed by BAAB
- Renderer settings: `video=wgpu`, `presenter=webgpu`, JIT off, mapped uploads, geometry packing on, null-drain presentation probe

The old core is the independently packaged `595e2f3…` profiler candidate. The new core is `14d458c…`, built from the locked 39-patch replay. The old bundle predates the current contract manifest, so the cross-build comparison is explicitly non-qualifying against current HEAD even though its own build evidence is retained.

## Result

| Block | Old diagnostics | Default-off gate | Relative effect |
| --- | ---: | ---: | ---: |
| ABBA | 71.9094% | 72.3333% | +0.5895% |
| BAAB | 72.1957% | 72.0552% | −0.1945% |
| All four runs per arm | 72.0525% | 72.1943% | +0.1967% |

The opposed block effects and +0.20% aggregate shift do not establish a speed improvement. Treat throughput as neutral within noise. Within-arm spread was 1.90% for the old core and 0.82% for the gated core.

The hygiene effect is unambiguous:

- targeted legacy diagnostic lines fell from roughly 5,100 per old-core run to zero by default;
- mean console capture fell from 793,250 bytes to 19,214 bytes, a 97.58% reduction;
- `wgpudeepdiag=1` restored 1,570 targeted lines in a three-emulated-second rollback smoke;
- startup and failure diagnostics remain unconditional in source-level tests.

## Visible validation

The rebuilt core loaded the fixed battle directly and rendered Kirby versus Link correctly. All 31 sampled canvases were distinct. Over the short visible smoke it averaged 53.2% game speed, 32.04 core FPS, and 21.32 presentation FPS, so hardware WGPU is still far from realtime.

Audio was active in 89.74% of samples with zero reported underruns. GPU-completion sampling recorded 61/61 completions and zero failures across 1,847 submissions; completion latency averaged 20.72 ms, with p95 146.48 ms and max 331.81 ms. Those long GPU completion tails are a remaining smoothness signal, not proof that the GPU itself is the sole bottleneck.

Raw data and the per-run measurements are in [the companion JSON](./melee-wgpu-deep-diagnostic-gate-2026-07-12.json). Local raw artifacts are under `.omx/wgpu-no-lag/deep-diag-gate-abba-14d458c` and `.omx/wgpu-no-lag/visible-deep-diag-gate-14d458c`.
