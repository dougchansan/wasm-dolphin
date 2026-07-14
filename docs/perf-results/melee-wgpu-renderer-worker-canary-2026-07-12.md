# Hardware-WGPU renderer-worker canary — 2026-07-12

This is a feasibility result, not a performance benchmark. It proves that the
disc worker can create a nested module worker which shares a
`SharedArrayBuffer`, obtains its own WebGPU device, submits a buffer copy,
waits for GPU completion, and maps the result before the visible renderer is
created.

## Validation identity

- Branch: `perf/wgpu-renderer-worker-probe`
- Source commit at capture: `5f12f37d7ec43e7cde3211293fb2c50ad60e9cfd`
  plus the uncommitted canary change under validation
- Core: `sha256:2d7f376d808fae0735fbebb8ee03af123d4a4fdd8f1a53972074ffbe9d808134`
- Core size: 12,903,025 bytes
- Browser: headed Chrome 150.0.7871.114
- Machine: AMD Ryzen 9 9950X3D, AMD RDNA 4 adapter, Windows x64
- Scene: verified Kirby-vs-Link battle save
- Raw output: `.omx/wgpu-no-lag/renderer-worker-canary-2d7f37/`

The selected core SHA matched the local candidate, served candidate, runtime
requested and active identities, build record, candidate ABI, and candidate
manifest. The baseline core remained separately identified as `2576faf6…`;
there was no fallback and no WASM content mismatch.

## Canary result

| Check | Result |
| --- | ---: |
| Nested worker active | Pass |
| Shared-memory atomic round trip | Pass |
| WebGPU adapter request | 9.83 ms |
| WebGPU device request | 8.63 ms |
| GPU copy completion | 4.02 ms |
| Readback map | 1.09 ms |
| Total canary time | 23.87 ms |
| Renderer/WGPU errors | 0 |

The fixed-work smoke reached one emulated second, but the run is intentionally
`NON_QUALIFYING`: it was captured from a dirty worktree and its one-second
window is too short for the normal presentation-FPS threshold. Its throughput
number must not be used as a performance result.

## Decision

The browser feasibility gate passed. The next step is the planned upload-only
executor A/B (`inline-upload-only`, `dedicated-upload-only`, and `null-drain`).
Do not infer that a full renderer-worker split improves game speed until those
arms are run repeatedly against the same fixed save and core SHA.
