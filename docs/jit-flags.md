# PPC-to-WASM JIT flags

These URL parameters control the experimental PowerPC-to-WebAssembly JIT and
its diagnostic/bisection features. Defaults favor the known-good Melee
software-hybrid configuration. Several optimizations stay off until their
correctness is established.

| Flag | Meaning |
| --- | --- |
| `wasmjit=0` | Disable the PPC-to-WASM JIT. |
| `wasmjit=1` | Enable the guarded JIT tier. This is the normal software-path setting. |
| `wasmjit=2` | Enable the mixed tier; equivalent to selecting `jittier=mixed` while enabling the JIT. |
| `jittier=guarded` | Use conservative guarded compilation. This is the default tier. |
| `jittier=mixed` | Use the broader experimental mixed tier. Treat it as a bisection setting. |
| `forcejit=1` | Keep/force JIT use past normal safety decisions. It can bypass protective behavior and is opt-in. |
| `jitwarmup=N` | Wait for `N` stable video frames before engaging the JIT (`0`-`60000`; the recommended URL uses `700`). |
| `unsafejitwarmup=1` | Bypass staged-warmup and OGL warmup protections. Diagnostic only. |
| `regalloc=0` | Disable the default-on GPR register cache/register allocation and return to the baseline path. |
| `smearcompile=0` | Disable default-on compile smearing and compile eagerly. |
| `blockmerge=1` | Opt into adjacent-block merging. Default-off because it is correctness-sensitive. |
| `shortprefix=1` | Compile shorter PPC prefixes. Default-off pending stronger correctness evidence. |
| `fastmemhoist=1` | Hoist per-block fastmem bounds checks. Default-off because a bad proof could permit an out-of-bounds access. |
| `disable=...` | Disable named JIT helper/optimization categories, or pass a decimal/hex mask, for bisection. |
| `nojitcache=1` | Skip the browser-side compiled JIT cache/prewarm path for a cold-cache comparison. |
| `metrics=1` | Enable on-screen and validation metrics used to judge behavior and performance. |

## Defaults and safety

- Block merge is default-off; enable it only with `blockmerge=1`.
- Short-prefix compilation is default-off; enable it only with
  `shortprefix=1`.
- Fastmem bounds-check hoisting is default-off; enable it only with
  `fastmemhoist=1`.
- Register allocation/GPR caching is default-on. `regalloc=0` is the immediate
  escape hatch.
- Compile smearing is default-on. `smearcompile=0` restores eager compilation.
- `forcejit`, mixed-tier selection, and unsafe warmup are experimental
  diagnostics, not implied by the recommended URL.

The OGL path has stricter defaults. If neither `wasmjit` nor `forcejit=1` is
specified, JIT use defaults off for OGL. When JIT is explicitly enabled, a
5000-frame safety floor applies to warmup unless `forcejit=1` or
`unsafejitwarmup=1` overrides it.

## Bisection with `disable`

`disable` accepts comma-, plus-, or whitespace-separated category names, a
decimal bitmask, or a `0x` hexadecimal bitmask. Unknown names are logged and
ignored. Current named categories include:

```text
meleeloop meleecall osinterrupt dcbxloop fastbranch fastfp fastinteger
fastsystem wasmblock wasmcarry wasmaddc wasmsubfc wasmadde wasmsubfe
wasmaddze blockredispatch blockmerge regalloc shortprefix smearcompile
fastmemhoist all
```

Aliases include `fastinputpoll` for `meleecall` and `fastmem` for
`fastsystem`. Because this surface is for controlled experiments, always save
the complete URL alongside results.

## Interpreting JIT metrics

- **Block compile count** is how many PPC blocks were translated/compiled. A
  rising count proves compilation activity, not that the compiled blocks are
  useful or amortized.
- **Block run count** is how often compiled blocks actually executed. Compare
  it with compile count to distinguish productive reuse from compile churn.
- **Helper stats** show which fallback or specialized helpers are being used.
  They are useful for finding hot unsupported operations and for validating a
  `disable` bisection.
- **Profile stats** attribute time and work across capture, copying,
  presentation, hashing, pacing, and related windows. Read them together with
  game speed, core FPS, presentation FPS, and unique/visual FPS.

“JIT enabled” does not automatically mean “faster” for every backend. Compile
bursts, low block reuse, helper overhead, renderer bottlenecks, browser codegen,
and backend-specific synchronization can hide or reverse a CPU-side gain. Use
same-machine A/B runs and distinguish emulation progress from presentation and
unique-frame cadence.
