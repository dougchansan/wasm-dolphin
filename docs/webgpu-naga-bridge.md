# WebGPU Naga bridge

The browser WebGPU API consumes WGSL shaders. Dolphin's existing shader
generation path produces GLSL and can use glslang to compile that GLSL to
SPIR-V, but browsers do not accept SPIR-V directly. The bridge supplies the
missing synchronous SPIR-V-to-WGSL step:

```text
GLSL -> glslang -> SPIR-V -> Naga -> WGSL -> browser WebGPU
```

This bridge supports the experimental true hardware renderer (`video=wgpu`).
It is unrelated to the WebGPU blit used by the recommended software-hybrid
presenter.

## Rust crate and ABI

The crate lives at `tools/naga-spirv-wgsl` and builds as a Rust `staticlib` for
`wasm32-unknown-emscripten`. Emscripten links the resulting archive into the
same WebAssembly module as Dolphin, allowing a synchronous C ABI call.

| Function | Contract |
| --- | --- |
| `naga_spirv_to_wgsl(const uint32_t* words, size_t count)` | Parses, validates, and translates SPIR-V words. Returns a NUL-terminated UTF-8 WGSL allocation, or null on failure. |
| `naga_free_wgsl(char* ptr)` | Releases a non-null string returned by `naga_spirv_to_wgsl`; null-safe. |
| `naga_last_error()` | Returns the thread-local last error string, or null when there is no error. |

### Memory ownership

The caller owns a successful `naga_spirv_to_wgsl` result and must release it
exactly once with `naga_free_wgsl` after copying or consuming it. Do not free
the pointer from `naga_last_error`: the Rust crate owns that thread-local
string, and it remains valid only until the next translation call on the same
thread. Input SPIR-V memory remains caller-owned and only needs to stay valid
for the duration of the synchronous call.

### Failure behavior

Invalid pointers, zero-length input, SPIR-V parse errors, validation failures,
WGSL backend failures, or a WGSL string containing an interior NUL return null.
The bridge records a stage-tagged diagnostic for `naga_last_error`. Release
builds use `panic = "abort"`; Rust unwinding never crosses the C ABI boundary,
but an unexpected Rust panic would terminate the module rather than return an
error. Normal translation failures are handled as return values.

## Function-name sanitization

SPIR-V debug names may survive into Naga and may be invalid or reserved in
WGSL. Before WGSL emission, the bridge replaces non-entry-point function names
with deterministic identifiers such as `dolphin_fn_0`. Entry-point names are
preserved because they come from `OpEntryPoint`. This sanitizer avoids WGSL
reserved-word/name collisions, including the observed `function` collision,
and is load-bearing for real Dolphin shaders.

## C++ integration after patching

Conceptually, Dolphin's `WebGPUShaderTranslator::SpirvToWgsl` passes the SPIR-V
word buffer to `naga_spirv_to_wgsl`, copies the returned WGSL into C++ storage,
reports `naga_last_error()` when conversion fails, and frees successful output
with `naga_free_wgsl`. The integration belongs in Dolphin's WebGPU shader
translator implementation (under the patched upstream
`Source/Core/VideoBackends/WebGPU` shader-translation code), with build wiring
in the patched upstream CMake files.

The repository does **not** commit that patched vendored C++ tree:
`vendor/dolphin/` is gitignored.

**The call site is introduced by the Dolphin patch set and is visible after running `npm run patch:upstream`.**

Do not infer from the committed Rust crate alone that a fresh, unpatched
upstream checkout contains the C++ integration.

The active source lock includes the translator call site in snapshot patch
`0006-webgpu-backend.patch`. Provenance verification checks its file hash and
the complete patched Git result tree, so a fresh `patch:upstream` replay cannot
silently omit the bridge.

## Building the bridge

The crate's `.cargo/config.toml` rebuilds the standard library with atomics,
bulk memory, and mutable globals so it can link into Dolphin's pthread/shared
memory WebAssembly module.

`npm run configure:upstream` verifies the pinned toolchain and then runs the
equivalent of:

```powershell
cargo build --locked --release --target wasm32-unknown-emscripten
```

The selected Cargo binary is the locked nightly toolchain, and `rust-src` is
required because `.cargo/config.toml` uses nightly `build-std`. The precompiled
target library is not used.

The generated archive and Cargo build directory are ignored build products.
`Cargo.lock` is tracked and LF-normalized; the build record includes its hash,
the Naga archive hash, and the exact Rust/Naga versions.
