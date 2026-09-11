# Cached-interpreter static exit links: local promotion

The WebAssembly core now reuses linked targets for known block exits, reducing repeated cache lookups while retaining the original execution, timing, input-policy and invalidation checks. Patch `0066-cached-interpreter-static-exit-links.patch` enables the lean implementation by default under Emscripten. An explicit `DOLPHIN_WEB_STATIC_EXIT_LINKS=0` still disables it, and diagnostic counters default off.

The first broad-link implementation had mixed Melee results and was not promoted. The lean version installs the thread-local context once per `ExecuteOneBlock` call and refreshes its completion, epoch and feature state at each actual block. It keeps the same link descriptors and base cache unlink behavior. No shared JIT-cache layout or new package dependency was introduced.

Paired tests of this exact core showed Melee gains of **9.52% and 11.09%**, and Mario Kart Wii gains of **8.52% and 12.97%**. Candidate results were **46.19–47.27 core FPS** for the tested Melee battle and **34.27–35.36 core FPS** for the settled, idle-kart Wii fixture. These remain below full speed. See the [Melee measurements](melee-static-exit-links-lean-2026-09-07.json) and [Mario Kart Wii measurements](mkw-static-exit-links-lean-2026-09-07.json) for each arm's identity, timing, input, audio and GPU-completion evidence. The separate diagnostic build bypassed 82.233% of post-block lookups; that percentage is not an FPS gain.

## Reproduction and installation

Production Ninja rebuilt all four dependent objects: `CachedInterpreter.cpp`, `CachedInterpreter_Disassembler.cpp`, `CachedInterpreterBlockCache.cpp`, and the factory consumer `JitInterface.cpp`. Every object matched the measured candidate exactly. The final in-place Windows link failed when `wasm-metadce` could not reopen its output WASM, so the working baseline runtime was restored while the link was recovered.

A private optimized link used the current production `libcore.a`, the same flags and toolchain, and separate output/temporary paths. All 890 pinned inputs remained unchanged. Both resulting files matched the measured candidate byte for byte before installation:

| Artifact | SHA-256 |
| --- | --- |
| WASM | `e8a1c1bb9aec817bdf96f88f41c9681caa1b8001620a35e658deff7c7a9630a2` |
| JS, raw bytes | `a589ee9e0f9ff3feb0a466f46a54b0151b058d6d3307ba7356db1a8a88d6cdd6` |
| Renderer worker | `f2ff1fda27fde40b7d018303dfa1a9454e39b0619901663634aed3514ab68677` |

The installed files were packaged using the standard build-info and candidate helpers. The ABI manifest and default worker core identity were refreshed. The source snapshot has 66 patches, series hash `467b031ca41d8e82da59f0657d606f47561ffb7b3688fb5648f89bf13a6ae955`, and result tree `f7486fd3c967e88fe89a00d5ad44a0bf95cdfb76`. The installed patch uses LF-normalized patch text so both working-tree application and cached provenance replay succeed; applied source bytes match the prepared promotion files. Historical experimental bindings in the measurement reports describe the inputs at measurement time and were not relabelled.

## Verification and limits

`npm test` passed **975 tests, zero failed and zero skipped**. The installed native regression package includes 52 groups plus its parent test, reads actual vendor source, and derives its differential reference from explicit macro zero. Coverage includes real base cache linking/unlinking, epoch invalidation, feature variants, early halts, nested contexts, failed emission, specialized helpers, policy gates, and coherent diagnostic publication. The native host harness documents the small adapters required for WebAssembly's 32-bit callable ABI; its POSIX protected-memory adapter was not exercised on this Windows host.

`npm run check` and `npm run verify:provenance` passed after installation. The source lock also replayed and verified before the build. No native builds or tests overlapped the timed browser measurements.

Melee battle and Wii fixture screenshots, input isolation, JIT policy, audio counters and GPU fences passed their bounded checks. Wii's course outline is visible using the separately repaired checkpoint, with no displaced left-side overlay apparent in the inspected boundaries. Sunshine passed only an animated file-select menu smoke check: 59.94 core FPS, approximately 29.89 submitted presentations per second. This is not Sunshine gameplay coverage or proof that all games run at full speed.

General GPU save-state readback remains unresolved, as do wider gameplay coverage and sustained native cadence across all games. The Wii fixture restores one previously blank map image; it does not repair the other lost cached images. See [the viewport and minimap investigation](../webgpu-viewport-fix.md). The Windows in-place link failure was recovered for this build; the build wrapper itself was not changed.

Private build logs, input pins, installation evidence, source contracts and game captures remain under `.omx/full-speed/static-exit-links-lean/` and the associated benchmark directories. Game data and raw captures are excluded from source deliverables.
