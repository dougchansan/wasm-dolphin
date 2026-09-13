# CPU attribution and full-speed coverage — 2026-09-07

Fresh active-battle profiling identifies substantial interpreter, memory-access, and block-lookup work. It does not establish full-speed gameplay or a speedup. The all-games goal remains active; the currently available library is test coverage, not a narrower definition of that goal.

## Build identity

The shipping core at profile time was `1b99a62abb8c74b9f3cd215b1feca69bac1901b5045ac69e8837238d85d35a13`, with worker `9eba675ef3c9765bb26b30dda4ed7ef9941bc506d1103403144b44ae60f881e3`. A fresh Melee profile captured 18 page/worker targets and correct changing battle frames. Its native functions are anonymous.

An isolated relink using the same objects and optimized flags plus `--emit-symbol-map` produced `6e207b7152b6f7e2a4704a5cd8c621a917605162aef1f90822b92ac518852262`. Function/type ordering changed, so its symbol map was rejected for the shipping profile. A separate profile then ran that isolated candidate through the normal local server; its selected core hash matched before and after measurement. Only that candidate's own samples were symbolized.

This boundary matters: candidate index 1017 is `_do_futex_wait`, while candidate index 1025 is `File::Rename`. An index from another build cannot be assigned these names. The initial synthetic-route attempt also failed because its worker responses lacked isolation headers; that failed run contains no usable profile and was excluded.

## Candidate CPU attribution

The CPU worker sampled 19.299 seconds in core WASM, 0.938 seconds in other WASM modules, and 0.083 seconds in JavaScript during a 20.321-second interval. The following percentages use **this worker's core-WASM self-time**, not total application CPU usage or elapsed game time.

| Function | Share |
| --- | ---: |
| `CachedInterpreter::ExecuteOneBlock` | 24.74% |
| `CachedInterpreter::FastInteger` | 22.75% |
| `JitBaseBlockCache::Dispatch` | 11.43% |
| `TryFastRamWordLoadStore` | 9.20% |
| `CachedInterpreter::FastFloat` | 5.02% |
| `DolphinWeb_OnXfb` | 4.56% |
| `TryFastRamFloatLoadStore` | 3.48% |
| `TryFastRamByteHalfLoadStore` | 2.82% |
| `MMU::WriteToHardware` | 2.67% |
| `GPFifo::UpdateGatherPipe` | 2.23% |
| `CachedInterpreter::RunWasmBlock` | 1.63% |

The other native worker sampled 31.97% in futex waits, 27.56% in `SetCPStatusFromGPU`, and 23.58% in the video-thread entry. Wait residence is not busy CPU time. Source inspection identifies repeated FIFO/status polling as a hypothesis, but shortening the polling window needs careful wakeup analysis: not every relevant MMIO write currently wakes the GPU thread.

The capture is not steady state: 260 new blocks compiled during it. Small-module self-time also does not include all possible JIT wrapper/import costs and is not a ceiling on JIT-related optimizations. Existing block redispatch and GPR local caching are already enabled. `ppcprof=1` changes the dispatch path, so it was not used here.

## Rejected map-size experiment

The block-cache lookup share justifies a visible comparison of the existing 16-bit and 18-bit fallback maps. Both experimental cores were built from the same source and flags except map size, with separate content-addressed outputs. The baseline exactly reproduces `6e207b…`; the candidate is `bec759c081418e434759c78c0b41f52aa25e3ce13d6c6597c86f818421d47914`.

The map is an inline class member, so changing its size affects class layout. All eight translation units in the recorded header dependency closure were recompiled in each arm before replacing their members in a copied archive. Recompiling only `JitCache.cpp` would be unsafe. All original inputs and shipping artifacts remained unchanged.

Visible ABBA comparisons rejected the larger map as a global default. Melee's paired speed changes were -2.70% and -5.80%; Mario Kart Wii's were +2.64% and -21.15%. The Wii captures showed unpaused racing. The existing 16-bit default remains.

## Deferred compilation and policy changes

A separate diagnostic build sampled callbacks inside normal block redispatch. Hot memory loops repeatedly used native callbacks because the per-slice compilation cap rejected them once and their fallback blocks stayed cached. Turning off compile smearing made those same loops use compiled callbacks, identifying a missing retry path. The diagnostic samples are attribution evidence, not performance measurements.

The isolated retry candidate retains the compilation cap and queues rejected blocks for bounded invalidation at CPU slice boundaries. It also applies requested JIT policy changes on the CPU thread and clears code generated under the previous policy. The original build continued executing compiled callbacks after JIT was disabled; the candidate stopped them and resumed them after re-enabling.

Input-isolated Melee ABBA results and their limits are recorded in [the deferred-JIT report](melee-deferred-jit-2026-09-07.md). After correcting pause/load guard timing, the rebuilt production core reached 29.73–30.51 FPS versus 23.40–26.17 FPS for the previous core, with paired gains of 16.61% and 27.08%. Both used normal Windows scheduling and the same corrected worker, and JIT stayed on throughout each measurement. This remains about half speed and does not establish performance across the library. Compilation still occurs after the 20-emulated-second warmup.

## Coverage

The inventory contains 42 title families across currently available GameCube and Wii files. Historical boot results are recorded separately from gameplay evidence. Melee's recent fixed battle runs remain around 43% game speed even where older boot/menu runs reported near 100%.

Current saved fixtures support Melee, Mario Kart Double Dash, Mario Kart Wii, and Sunshine scenes. No ready gameplay checkpoint was found for Metroid Prime, Paper Mario, Star Fox Adventures, or Pokémon Colosseum. Several old files labelled Metroid profiles actually captured the demo and are excluded from game evidence. Additional gameplay coverage is still required.

## Local evidence

Raw profiles, screenshots, exact build identities, symbol maps, source comparisons, and build recipes remain under `.omx/full-speed/`:

- `melee-profile-default/`: shipping-core profile and process CPU-time snapshots.
- `melee-profile-symbols-server/`: successful isolated-core profile and GPU-complete final image.
- `symbol-map/candidate-profile-summary.json`: named attribution bound to the candidate hash.
- `cache-map-experiment/`: both isolated builds, commands, dependency closure, and input hashes.
- `library-inventory.json` and `library-inventory-checkpoints.json`: available coverage and its limitations.
