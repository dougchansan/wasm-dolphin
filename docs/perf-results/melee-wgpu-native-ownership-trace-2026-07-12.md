# Melee hardware-WGPU native ownership trace (2026-07-12)

This campaign determines whether immediate WebGPU resource and upload records
can be assigned to native producer transactions before any package replay is
implemented. The trace is explicit, default-off, and separate from the command
ring; it does not widen `CmdRecord` or `CmdRingHeader`.

## Identity

- Branch: `perf/wgpu-native-ownership-trace`
- Instrumentation commits: `a31f44c`, `bd9b9d8`, and `cbc5e6f`
- Candidate core SHA-256: `3d19574ffe595472a69661172cffc67d51ad7f8f81439bef2a483f211dc316fc`
- Candidate core size: 12,915,020 bytes
- Machine: AMD Ryzen 9 9950X3D, 32 logical CPUs, 128 GiB RAM
- Browser: headed Google Chrome 150.0.7871.114
- GPU: AMD RDNA 4 WebGPU adapter
- Scene: direct Kirby-versus-Link battle save loaded at time zero
- Work: eight emulated core-seconds, JIT off, visible hardware WGPU

## Trace validation

The first 65,536-record activation registered correctly but dropped 79,779
records and allocated per command in JS. It was rejected. The revision uses a
131,072-record sideband and allocation-free aggregate draining.

| Integrity metric | Revised activation |
| --- | ---: |
| Observed records | 1,871,637 |
| Command events | 1,857,212 |
| Native drops | 0 |
| Final backlog | 0 |
| Epoch mismatches | 0 |
| Ordering violations | 0 |
| Malformed header/descriptor | 0 |
| Pass commits / begins | 4,807 / 4,808 |
| Pending reservations | 4,808 |
| Load-request epochs | 1 |

`LoadRequested` intentionally records the request boundary, not asynchronous
load completion.

## Ownership result

| Attribution | Command count | Share | Upload bytes |
| --- | ---: | ---: | ---: |
| Outside | 104 | 0.0056% | 2,762,000 |
| Pending pre-pass | 470 | 0.0253% | 43,976 |
| Active transaction | 1,856,638 | 99.9691% | 1,106,835,656 |
| Unknown | 0 | 0% | 0 |

Publication classification conserved every command: 1,323,722 staged pass
records, 531,839 immediate records emitted while a transaction was active, and
1,651 immediate/outside publications.

This clears the native ownership classification gate. It does not prove that a
package implementation is semantically equivalent.

## Performance and visual limits

The aggregate trace-on run reported 68.6392% fixed-work game speed and 41.1670
core FPS, but added 838 audio underruns and had one 124 ms late input event.
Earlier same-core single runs varied from 48.30% trace-on to 50.31% trace-off,
and both had more than 1,000 audio underruns. No balanced overhead claim exists.

The headed capture reached Fountain of Dreams with an active timer and both HUD
slots at 0%, confirming direct battle load. The known large black center
rectangle remains, so renderer correctness is still incomplete.

## Decision

Proceed to independent legacy/package semantic digest instrumentation. Require
matching committed-pass event chains, resource generations, upload payload
hashes, and draw-visible buffer/texture shadows. Keep runtime package replay
disabled until digest parity, zero-drop trace, under-2% observer overhead,
fixed-work fairness, and visual correctness all pass.

Raw local artifacts:

- `.omx/wgpu-no-lag/native-ownership-trace-on-ae28e395`
- `.omx/wgpu-no-lag/native-ownership-trace-on-3d19574f`
- `.omx/wgpu-no-lag/native-ownership-trace-off-3d19574f`
- `.omx/wgpu-no-lag/native-ownership-trace-aggregate-on-3d19574f`

