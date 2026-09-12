# Broader cached-block links: first screening

The first implementation avoids most block-cache lookups in the checked Melee scene, but its FPS results are mixed. It has not been promoted.

| Pair | Production | Linking candidate | Change |
| --- | ---: | ---: | ---: |
| A1 / B1 | 57.76 FPS | 49.94 FPS | −13.53% |
| A2 / B2 | 47.17 FPS | 51.57 FPS | +9.32% |

The ratio of mean frame rates is −3.26%. Four fresh-browser runs used ABBA order, the same worker/checkpoint, explicit `0x5555` process affinity, audible worklet audio, 20 emulated seconds of warm-up and 30 emulated seconds of measurement. Every before/final scene was reviewed: the same battle advances with coherent stage/fighters/HUD and matching damage. Subsecond animation/camera phase differences remain. All runs kept JIT enabled, recorded zero native input changes, completed GPU fences and reported zero audio underruns/overruns or renderer errors.

A separate diagnostic build recorded **713,113,836 executed linked transitions**, avoiding **82.23% of post-block lookups** in the observed interval. This proves activation, not a performance gain. Diagnostic counters were disabled in the performance candidate.

The implementation reuses the existing base linker for direct branches/calls, conditional continuations, explicit fallthroughs and known specialized-helper completions. Terminal descriptors live in emitted callback storage. Normal completion publishes a descriptor; the original timing/CPU-state predicate, source epoch and feature checks guard consumption. Base unlinking and deferred reclamation preserve source/target lifetimes. Early halts, HLE replacements and dynamic taken returns retain ordinary lookup.

Forty-five native test groups pass, including actual base link/unlink/clear/erase algorithms, emitter and disassembler boundaries, source/target reuse, nested execution, branch state/accounting, helper success/fallback, failure guards, and diagnostic publication. Native x64 tests adapt only the WASM handle/state-call ABI where required; actual browser runs provide separate WASM execution evidence. Independent source review found no blocking issue.

Both reference and disabled controls reproduce all four affected original objects and production core `7479b6c803ff1d19e4c03b3654c69e4fe95a6a4367b411ba11769c65730b112c`. The performance core is `16f110a9929887d5a48faed4725b510473123b269d1430576418da581b1bcacd`; the diagnostic core is `d67c8efc95959100d71c3e69b1549fc0da93348fc088d6c412612a90bb1e1d2a`. Worker `f2ff1fda27fde40b7d018303dfa1a9454e39b0619901663634aed3514ab68677` is unchanged. Source/layout changes require CachedInterpreter, its disassembler and block cache, plus JitInterface's factory object.

A separate lean-context variant is being evaluated to reduce repeated setup and TLS operations. It retains the link-cell/lifetime rules and resets completion, epoch and features at every actual block. This is an overhead hypothesis; the first screening does not establish that context setup caused the mixed results.

Exact evidence is in [the machine-readable report](melee-static-exit-links-2026-09-07.json). Private source/build/tests and captures remain under `.omx/full-speed/static-exit-links` and `current-bench`. No native implementation was installed in production, and no all-games or sustained full-speed claim is supported yet.
