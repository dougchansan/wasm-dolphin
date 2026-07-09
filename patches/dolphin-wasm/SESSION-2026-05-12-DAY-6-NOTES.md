# Session 2026-05-12 (Day 6) — pthread → worker JIT compile RPC bridge (DEAD END)

This session attempted to build the pthread → worker compile-RPC bridge
that Day-5's persistent-JIT-cache investigation called for. The bridge
itself worked mechanically — the C++ side proxies the compile request
to the discio worker via `MAIN_THREAD_EM_ASM_INT`, and the worker body
executes in the Emscripten bundle's scope where `wasmTable` and
`wasmMemory` are directly accessible. But the resulting wasmTable
entries produced "table index is out of bounds" the moment the pthread
tried to call them.

**Root cause: in current WebAssembly implementations, function tables
are NOT shared across pthreads.** Each pthread's WebAssembly Instance
gets its own Table view at instantiation time. Growing and writing
entries on the worker thread does not update what the pthread's
`call_indirect` sees, so the index returned by the proxy is invalid in
the pthread's table.

Verified empirically:

1. Built a minimal proxy whose body did *exactly* what the original
   direct EM_JS did (compile, grow, set, return index) — just on the
   worker thread instead of the calling pthread. Probe result:
   `compileCount=1` then `Uncaught RuntimeError: table index is out of
   bounds`. The single compile that "succeeded" appears to be a block
   that wasn't actually invoked yet; as soon as something called
   `call_indirect` at the proxy-returned index, it OOB'd.
2. The same body, executed inline on the pthread via plain `EM_JS`, has
   worked since Day 2 and continues to. So the compile + grow + set
   logic is fine — the problem is the *target* table when those calls
   happen on a different thread than the pthread that will use the entry.

## Other rabbit holes traversed (so they don't get re-tried)

- **`Module.*` propagation**: stashing wasmTable/wasmMemory on Module
  from a runtime EM_ASM helper (`DolphinWeb_ExposeJitRuntime`) and
  reading them in a discio-side `_dolphinJitProxyCompile` function
  produced the same OOB error. Module additions DO propagate when set
  on the worker thread that runs the EM_ASM body, but the underlying
  Table is still per-pthread.
- **Macro-argument quirks**: `MAIN_THREAD_EM_ASM_INT`'s body must be
  wrapped in extra parens — `MAIN_THREAD_EM_ASM_INT(({ ... }), args)` —
  because the C preprocessor splits on top-level commas inside `{}`
  (braces don't protect like parens do). Object literals with multiple
  keys would otherwise tear into separate macro arguments. Documented
  in the Emscripten docs but easy to miss.
- **Single-quoted JS strings**: in the EM_ASM body, single-quoted
  strings like `'memory'` parse as C multi-char constants and cause
  spurious "expected ')'" errors on some bodies. Use bare identifier
  keys (as the existing EM_JS does) — they're fine in object literal
  position even though the preprocessor sees them as identifiers.

## What would actually work

For a real persistent JIT cache, two paths remain (both significant):

1. **Wait for shared WebAssembly tables.** The WebAssembly threads
   proposal can be extended to make Tables shareable; some browsers
   have implementation flags but none ship it by default. When that
   lands, today's proxy design works.
2. **Push cached `WebAssembly.Module` objects to each pthread at
   spawn time.** Hook Emscripten's pthread bootstrap (`Module.PThread`
   setup, `pthread_create` interception) to postMessage the cache map
   to the new pthread before it begins executing. The pthread
   instantiates the cached Module locally — its OWN table gets the new
   entry, which is the only table its call_indirect will touch. This
   bypasses the cross-thread table problem entirely.

Both are multi-session refactors. Neither was in scope for tonight.

## What this session left in the tree

The C++ change reverts back to the direct `EM_JS` path — same as Day 2.
The cached interpreter calls `DolphinWeb_CachedInterpreterCompileWasmBlock`
(now restored as the original EM_JS, no proxy wrapper). The discio
worker has no new helper. WASM output is byte-stable vs the pre-Day-6
build.

A comment in `CachedInterpreter.cpp` near the EM_JS body now points
future-me here so the same dead end isn't re-explored without rereading
the Day-5 + Day-6 notes.

## Concrete next moves (when this comes back up)

If approach (2) above is what we want to chase:

- Probe `Module.PThread` in the generated bundle — find where pthread
  Workers are constructed (`pthreadCreateMainWorker` or similar).
- Patch the postMessage that sets up the pthread to include a
  `Module._dolphinJitCache` payload (Map of hash → WebAssembly.Module,
  pre-loaded from IndexedDB).
- On the pthread side, install an `onmessage` shim that captures the
  payload before Emscripten's handler runs, stashes it on Module.
- In `DolphinWeb_CachedInterpreterCompileWasmBlock`, before `new
  WebAssembly.Module(bytes)`, check `Module._dolphinJitCache.get(hash)`
  and use the cached Module if present.
- Async-write new compiles back to IndexedDB from the worker (which
  the pthread can postMessage to via its own bridge).

That's the design. Implementation is non-trivial and best done in a
dedicated session with the Emscripten pthread source tab open.
