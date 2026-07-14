# Hardware-WGPU second-GPU availability check (2026-07-12)

## Result

**Second-GPU validation is unavailable on this host.** Windows reports both an
AMD Radeon RX 9070 XT and integrated AMD Radeon Graphics, but a headed Chrome
run forced to the low-power WebGPU adapter returned no adapter. The true
hardware renderer and WebGPU presenter therefore did not initialize, and the
run produced no changing visible output.

This is an availability result, not a performance result. The run's 101.071%
core speed measured emulation with no active hardware renderer and must not be
cited as second-GPU performance.

## Reproduction

- Commit: `21eed04` on `perf/wgpu-bounded-renderer-staging`.
- Core: 12,893,772 bytes, SHA-256
  `2576faf651de4dd6cd9677e2770c6285271e63ceb30e39489b978f9b43bab245`.
- Browser: headed Chrome 150.0.7871.114.
- Browser launch override:
  `--use-webgpu-power-preference=force-low-power`.
- URL also requested `wgpupower=low`.
- Scene: direct Kirby-versus-Link `__battle.sav` load.

The manifest recorded:

- `webgpuAdapter.available=true`;
- `webgpuAdapter.selected=false`;
- no active WebGPU presenter;
- no created WebGPU device;
- zero visible canvas changes.

The harness now records browser launch arguments so future reviewers can
distinguish an actually forced adapter attempt from the ordinary WebGPU
`powerPreference` hint. A previous low-power URL-only run selected the same
AMD `rdna-4` adapter as the high-performance run and was not second-GPU
coverage.

## Evidence

Raw ignored artifacts are under `.omx/wgpu-no-lag/second-gpu-force-low/`.

| Artifact | SHA-256 |
| --- | --- |
| `report.json` | `3ea240b8e0af7d67719ea4d924f43d518ba13e1b1cd4b358bb770ca9b0fb55db` |
| `manifest.json` | `1333c95790412a0f2803240fe9a883e0787072f55a231bb9f41d28df595d1715` |
| `final.png` | `8fea57ca71ca576bd6d520c52d8da52b87aee00801c74aeccedf40f443ce7fb2` |

The GPU-coverage limitation remains explicit: correctness and performance are
validated only on the RX 9070 XT until a second Chrome-compatible WebGPU
adapter or another physical machine is available.

