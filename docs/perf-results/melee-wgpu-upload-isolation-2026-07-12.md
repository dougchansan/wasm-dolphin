# Melee hardware-WGPU upload-isolation screen (2026-07-12)

## Decision

**NO-GO for a renderer-worker split based on upload isolation alone.** Two valid
ABBA/BAAB blocks rejected the hypothesis that moving upload-only command
consumption to a nested worker improves fixed-work game speed by at least 5%.
The measured median effect was **-1.83%**: the worker arm was slightly slower.

The stronger result is the null-drain ceiling. With all GPU upload and submission
work removed, game speed remained **74.27-75.62%**. Forced PPC-to-WASM JIT raised
that only to **75.69%**. On this host and fixed fixture, the current hardware-path
limit is therefore primarily core/video/FIFO command production, not WebGPU
upload placement or GPU completion.

These probes intentionally produce a black canvas. They validate command-stream
ownership, work conservation, and timing pressure; they do **not** validate visible
hardware rendering. A visible full-renderer change must separately prove changing,
non-black battle output.

## Environment and fixture

- Scene: direct reload of the fixed Kirby-versus-Link battle save; no character-select pause.
- Host: Windows 10.0.26200, AMD Ryzen 9 9950X3D, 32 logical CPUs, 128 GB RAM.
- Browser: headed Chrome 150.0.7871.114.
- GPU: AMD RDNA 4 WebGPU adapter.
- Host branch/commit: `perf/wgpu-renderer-worker-probe` at `583ea8eb4f58aded62325783bcb0fbb46c11b456`.
- Core build commit: `5f12f37d7ec43e7cde3211293fb2c50ad60e9cfd` (the unchanged candidate identified by the core hash below).
- Core: 12,903,025-byte WASM, SHA-256 `2d7f376d808fae0735fbebb8ee03af123d4a4fdd8f1a53972074ffbe9d808134`.
- ISO SHA-256: `1018b65a58ca654056be1611a43e753de5dd5f842ce5266581b29c6a12ce7c67`.
- Save SHA-256: `620879e2ed3c35248deba9fb2f7b2a39f91f5374d2f6a98d2a2455cb55e156d1`.
- Work: 8 emulated core seconds per run, JIT off for the ABBA screen, fixed save reloaded after warmup.

## Results

| Mode | Runs | Fixed-work game speed % | Interpretation |
| --- | ---: | ---: | --- |
| Inline upload | 4 | 75.01, 74.84, 74.82, 74.18 (mean 74.71) | Reference |
| Worker upload | 4 | 74.25, 73.25, 72.51, 73.38 (mean 73.35) | No improvement |
| Null drain, JIT off | 2 | 75.62, 74.27 (mean 74.95) | GPU upload removal does not reach 90% |
| Null drain, forced JIT | 2 | 75.692, 75.691 (mean 75.692) | PPC JIT is not the dominant limiter |

The two valid comparison-block effects were **-1.57%** and **-2.09%**.
The screening outcome was `SCREENING_REJECT`; it is non-promotable and is not a
qualification claim.

The forced-JIT runs compiled about 5.2k blocks and executed about 9.5 million
block runs, for roughly 1,825 runs per compile. Both reported zero emit failures
and zero module compile failures. JIT module compilation cost about 0.30 seconds
per run, but steady reuse still did not materially raise the null-drain ceiling.

## Validity boundary

The successful screen used exclusive protocol-v3 ring ownership, a paused and
reloaded measurement checkpoint, a 50 ms stable-empty producer barrier, quiescent
GPU completion, and per-frame semantic-work comparison. Both blocks had matching
core/save identity, initial submit structure, bounded tick/frame/submit differences,
and conserved records/uploads.

Later per-submit ordering and cache-creation counts are retained as diagnostics,
not correctness gates, because same-arm dual-core runs proved them nondeterministic.
The payload-sampled stream digest remains recorded per run; for each upload it
hashes normalized record structure plus the first and last 16 payload bytes,
not every payload byte.

## Next action

Do not move the full renderer to a nested worker for performance yet. Instrument
fixed-submit-prefix video/FIFO work and reduce command-production cost first.
In parallel, fix visible `video=wgpu` rendering and require non-black, changing
Kirby-versus-Link output before evaluating presentation latency or visual cadence.

## Raw evidence

- Comparison: `.omx/wgpu-no-lag/renderer-worker-screening-583ea8e/`
- Null ceiling: `.omx/wgpu-no-lag/null-drain-ceiling-583ea8e-run{1,2}/`
- Forced-JIT ceiling: `.omx/wgpu-no-lag/null-drain-jit-ceiling-583ea8e-run{1,2}/`

The raw `.omx` directories are local and uncommitted. Their pinned hashes are in
[the compact JSON record](melee-wgpu-upload-isolation-2026-07-12.json).
