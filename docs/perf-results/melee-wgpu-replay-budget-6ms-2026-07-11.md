# Melee hardware-WGPU 6 ms replay-budget screen (2026-07-11)

## Decision

**NO-GO. Do not promote `wgpureplayms=6`.** The candidate improved mean fixed-work game speed by only 0.096 percentage points (0.145% relative), below the 1% screening threshold and within the observed run scatter. Both ABBA blocks were invalid, every run failed the audio and input gates, and the recurrent roughly 1.7-second `GPUQueue.writeBuffer` stall remained. The comparison is therefore infrastructure-inconclusive, not evidence of a performance win.

The default/fixed 16 KiB replay policy remains the reference. A new screen should wait until the audio/input validity failures are resolved or the upload-staging architecture changes.

## Fixed fixture and environment

- Scene: direct `__battle.sav` load into the Kirby-versus-Link battle; no character-select stop.
- ISO: Melee USA Rev 2, SHA-256 `1018b65a58ca654056be1611a43e753de5dd5f842ce5266581b29c6a12ce7c67`.
- Save state: SHA-256 `620879e2ed3c35248deba9fb2f7b2a39f91f5374d2f6a98d2a2455cb55e156d1`.
- Checkpoint: XFB hash `6fd97dc5`, expected core ticks `15166162443`, permitted delta `[-20000, 0]`; verified in all eight runs.
- Core: 12,877,445-byte WASM, SHA-256 `03acd0d3f5b6b82fdd4644b03b26addeef8487307211e6eba70a3ee8b66e133b`.
- Source: clean commit `5d0cccc3f45eeb2385d3638efad7fd972d96ef4e` on `perf/wgpu-bounded-renderer-staging`.
- Machine: Windows 10.0.26200, AMD Ryzen 9 9950X3D, 32 logical CPUs, AMD `rdna-4` WebGPU adapter.
- Browser: headed Chrome 150.0.7871.114.
- Fixed work: 8 emulated core seconds, 25-second wall cap, four runs per arm, ABBA ordering with one replacement block.
- Common mode: true hardware WebGPU (`video=wgpu`), WebGPU presenter, geometry packing enabled, 32 MiB upload arena, JIT disabled.

The harness manifests report `isoVerified`, `saveStateVerified`, `saveStateLoaded`, and `battleCheckpoint.verified` for every run. A representative final screenshot was also visually inspected and shows Kirby and Link already in battle. This verifies fixture identity; it does not make the invalid performance comparison statistically usable.

## Aggregate results

All values below are descriptive because there were zero valid blocks.

| Metric | Fixed 16 KiB (n=4) | 6 ms (n=4) | 6 ms minus reference |
| --- | ---: | ---: | ---: |
| Fixed-work game speed, mean | 66.422094% | 66.518270% | +0.096175 pp (+0.144794%) |
| Fixed-work game speed, median | 66.726096% | 66.608028% | -0.118068 pp |
| Fixed-work game speed, sample SD | 0.941749 | 0.904185 | -0.037564 |
| Fixed-work core FPS, mean | 39.844017 | 39.903587 | +0.059571 (+0.149510%) |
| Fixed-work wall time, mean | 12.218028 s | 12.193726 s | -0.024301 s (-0.198897%) |
| Steady-state game speed, mean | 76.021693% | 73.135120% | -2.886573 pp |
| Steady-state core FPS, mean | 45.707128 | 43.857026 | -1.850102 |
| Steady-state presentation FPS, mean | 33.083333 | 32.750000 | -0.333333 |
| Reported visual FPS | 0 in every run | 0 in every run | Not usable on this hardware path |

The per-block fixed-work effects were +0.014510% and +0.273759%. Neither block qualified for inference. The visual metric sampled the software XFB hash and therefore cannot measure distinct hardware-WGPU frames; the final screenshots are visibly rendered but do not establish visual cadence.

### Per-run fixed-work results

| Run | Arm | Game speed % | Core FPS | Wall seconds | Frames | Valid |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| `block-01-run-1` | fixed16k | 65.103021 | 39.015741 | 12.430880 | 485 | No |
| `block-01-run-2` | 6ms | 66.835432 | 40.091617 | 12.122235 | 486 | No |
| `block-01-run-3` | 6ms | 65.352175 | 39.187255 | 12.427510 | 487 | No |
| `block-01-run-4` | fixed16k | 67.065408 | 40.222404 | 12.107680 | 487 | No |
| `block-01-replacement-1-run-1` | fixed16k | 66.386784 | 39.865554 | 12.216060 | 487 | No |
| `block-01-replacement-1-run-2` | 6ms | 67.504848 | 40.488157 | 12.003510 | 486 | No |
| `block-01-replacement-1-run-3` | 6ms | 66.380624 | 39.847320 | 12.221650 | 487 | No |
| `block-01-replacement-1-run-4` | fixed16k | 67.133164 | 40.272367 | 12.117490 | 488 | No |

## Hard-gate outcomes

- Comparison: `INFRASTRUCTURE_INCONCLUSIVE`; 0/2 valid blocks, 2/2 invalid, 100% invalid-block rate, statistical gate false, promotable false.
- Fixed work: reached in 8/8 runs with valid tick/frame deltas.
- Renderer integrity: 8/8 requested, configured, and ran `WebGPU-Real`; WebGPU presenter active; no fallback.
- GPU integrity: zero renderer/WebGPU errors, GPU-completion failures, command drops, batch aborts, oversized batches, or upload timeouts in either arm.
- Audio: fixed16k produced four underruns total; 6ms produced five. Every run failed the no-new-underrun gate.
- Input: 0/8 runs passed marker parity. Most delivered 12 events but polled/armed/submitted/completed only 11; the arms recorded three and four superseded markers respectively. One fixed16k run applied only 11 events, and one 6ms run recorded four generation-unavailable events.
- Qualification: 0/8 runs eligible. Each manifest lacked `buildProvenance.verification.verified=true` and `buildProvenance.buildInfo.js.size`.
- Queue stall: per-run maximum queue-write time remained 1,678.5–1,765.7 ms; the 6 ms budget did not remove the staging/backpressure stall.

## Evidence boundary

The compact machine-readable record is [melee-wgpu-replay-budget-6ms-2026-07-11.json](melee-wgpu-replay-budget-6ms-2026-07-11.json). Its artifact manifest pins the raw files without committing their multi-megabyte contents.

The raw capture directory was `.omx/wgpu-no-lag/item-6-replay-6ms-screen/` in the validating worktree. `.omx` is local, uncommitted, and ephemeral; reviewers should use the recorded SHA-256 values to verify any retained copy rather than expect the raw directory in Git.
