# Melee hardware-WGPU AudioWorklet screen (2026-07-12)

## Decision

**INFRASTRUCTURE INCONCLUSIVE. Keep `audiotransport=worklet` experimental and
default-off.** No single harness campaign produced the required two valid
balanced blocks. A descriptive set of two complete valid blocks selected
across isolated retries showed the worklet within 0.94% of legacy game speed
and below the 5% regression guard, but retry and order conditioning prevent a
promotion claim.

The worklet mechanism itself remained clean in the selected observations:
zero underrun frames or events, zero empty worker mixes, zero WebGPU errors,
zero GPU-completion failures, correct input parity, visible output, and valid
qualification evidence. Six excluded legacy runs each recorded one audio
underrun. One excluded worklet run missed the 100 ms input-dispatch gate at
113 ms.

## Integrity incident and resolution

The first rerun was stopped when a WASM SHA mismatch was reported. The active
staging worktree was not corrupt: its runtime pin, build record, ABI manifest,
candidate directory, local artifact, HTTP-served artifact, and completed-run
manifests all identified the same 12,893,772-byte core:

`2576faf651de4dd6cd9677e2770c6285271e63ceb30e39489b978f9b43bab245`

A separate dirty checkout contained a generated core with SHA-256
`0db4f08abed065679b38373045aa03efbe2247931887ecbe6cecd323f4d6f3dc`.
The incident was classified as cross-worktree or stale-tab selection. The old
artifact was not overwritten. The rerun used only `http://127.0.0.1:8130/`,
whose live response used `Cache-Control: no-store`, and provenance verification
passed before measurement. The aborted partial campaign is not included here.

## Fixed campaign

- Scene: direct `__battle.sav` load into Kirby versus Link; no character-select
  navigation or pause.
- Commit: `462cd292de36b8cebec5fec55441e76cbb3ebed1` on
  `perf/wgpu-bounded-renderer-staging`.
- Core: 12,893,772 bytes, SHA-256
  `2576faf651de4dd6cd9677e2770c6285271e63ceb30e39489b978f9b43bab245`.
- Browser/GPU: headed Chrome 150.0.7871.114 on the same AMD hardware-WGPU
  adapter used by the preceding renderer campaigns.
- Common mode: `video=wgpu`, mapped upload transport, geometry packing on,
  dense UBO packing and UBO cache off, JIT off, metrics, GPU-completion, and
  input telemetry on.
- Work: eight emulated core seconds with six spaced input events.
- Arms: A is legacy audio; B is AudioWorklet/SAB audio.
- Required design: two valid whole balanced blocks in physical ABBA/BAAB order.
- Correctness, provenance, activation, audio, input, visibility, and GPU-error
  gates remained active. Performance thresholds were neutral for screening.

## Official result

The official attempts are infrastructure-inconclusive. Cold/first legacy runs
repeatedly recorded a single underrun, causing whole-block rejection. One
attempt produced a valid ABBA replacement block, but no individual campaign
reached the required two valid blocks. Gates were not loosened.

## Descriptive selected-valid result

The following aggregates combine one complete valid ABBA replacement block
with one complete valid BAAB replacement block from a later isolated attempt.
The physical order is `ABBABAAB`, with four observations per arm.

| Metric | Legacy | Worklet | Worklet relative change |
| --- | ---: | ---: | ---: |
| Game speed | 71.214% | 70.547% | -0.937% |
| Core FPS | 42.709 | 42.278 | -1.010% |
| Wall time | 11.350 s | 11.435 s | +0.755% |
| Audio underruns | 0 | 0 frames / 0 events | tied |

Across those eight observations, GPU-completion p95 was 6.305–7.630 ms,
input-dispatch lateness max was 12–41 ms, and input poll-to-GPU p95 was
15–200 ms. The worklet ring finished at 5,248–5,760 frames, reached a
5,760-frame high-water mark, and recorded 16.53–20.02 ms maximum producer
timer gaps. These are descriptive ranges, not an input-to-photon measurement.

## Evidence boundary

Raw ignored artifacts are under
`.omx/wgpu-no-lag/audio-worklet-ab-2576faf-rerun/`. The machine-readable
descriptive selection is retained as the adjacent JSON file.

- Selected-valid descriptive JSON SHA-256:
  `fa8286fc09ff99b7981ad766f5c4340f5989aff2219335ae0b5dc27e6f1d345a`
- Attempt 2 official report SHA-256:
  `e0da64da58c8210ac9b2971c1da31ace4edd4721b68c2ca82787839a25d2e586`
- Reversed attempt official report SHA-256:
  `118db75afb2b40656e021e2eab5e6c7f86ab2eaced84846391df827d06328b08`

Do not cite the selected-valid difference as a measured performance win or use
it to change the default. A future promotion run must produce two valid blocks
within one preregistered campaign without cross-attempt selection.

