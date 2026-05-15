# Session 2026-05-15 (Day 23) — Naga SPIR-V→WGSL linked into the wasm

Day 22 proved GLSL→SPIR-V (glslang, already in-build). Day 23 closes
the loop: SPIR-V→WGSL via Naga, linked straight into the game wasm so
`WebGPUShaderTranslator::SpirvToWgsl` is a synchronous C call — no
async worker round-trip, no change to Dolphin's pipeline path.

## The crate

`tools/naga-spirv-wgsl/` — Rust, `crate-type = ["staticlib"]`,
`naga = "26"` with only `spv-in` + `wgsl-out`. C ABI:

- `char* naga_spirv_to_wgsl(const u32* words, size_t count)` — returns
  a malloc'd NUL-terminated WGSL string or null.
- `void naga_free_wgsl(char*)`.

`panic = "abort"` in release, so the FFI surface is panic-free (every
Result handled, no unwrap/expect/indexing — a panic would abort the
whole game wasm). Pipeline inside: `spv::Frontend::parse` →
`valid::Validator (all flags/caps)` → `back::wgsl::write_string`.

## Toolchain friction (the real work of Day 23)

1. Rust was installed but only `x86_64-pc-windows-msvc`. Added
   `wasm32-unknown-emscripten`.
2. First link failed:
   `wasm-ld: error: --shared-memory is disallowed by
   naga_spirv_wgsl…rcgu.o because it was not compiled with 'atomics'
   or 'bulk-memory'`. dolphin_web_core is an Emscripten pthread /
   shared-memory module; *every* object including Rust's std must
   carry the atomics + bulk-memory wasm features. The precompiled
   `wasm32-unknown-emscripten` std has neither.
3. Fix: rebuild std from source with those features. Needs
   `-Z build-std` → nightly. Installed `nightly` + `rust-src`.
   Pinned the recipe in `tools/naga-spirv-wgsl/.cargo/config.toml`:
   `build-std = ["std","panic_abort"]` +
   `target-feature=+atomics,+bulk-memory,+mutable-globals`.
   (The "unstable feature `atomics`" rustc warning is expected and
   harmless — it's exactly what we want.)
4. Built with `cargo +nightly build --release --target
   wasm32-unknown-emscripten` → `libnaga_spirv_wgsl.a` (~4 MB).

## Wiring

- `Source/Core/Core/CMakeLists.txt` — links the staticlib into
  dolphin_web_core (absolute path, same hardcode style as the
  jit-cache pre-js; warns + degrades gracefully if the .a is absent).
- `WebGPUShaderTranslator.cpp` — `extern "C"` decls;
  `SpirvToWgsl` now calls `naga_spirv_to_wgsl`, copies the result,
  `naga_free_wgsl`.
- Smoke in `WebGPU::VideoBackend::Initialize` extended to run the full
  `GlslToWgsl` and report both stages.

## Verified

18s `VIDEO=wgpu` probe console.log:

    [webgpu-shader-xlat] GLSL->SPIR-V words=87 SPIR-V->WGSL bytes=205

The full `Dolphin GLSL → glslang → SPIR-V → Naga → WGSL` chain runs
synchronously inside the browser wasm. Game still renders via the
Day-18 Software path (15 distinct hashes, clean character-select) —
the translator is proven but not yet on the render path.

## Build dependency note (for ONBOARDING / fresh checkouts)

The wasm build now expects `libnaga_spirv_wgsl.a` at
`tools/naga-spirv-wgsl/target/wasm32-unknown-emscripten/release/`.
To (re)build it:

    rustup toolchain install nightly --component rust-src
    rustup target add wasm32-unknown-emscripten
    cd tools/naga-spirv-wgsl
    cargo +nightly build --release --target wasm32-unknown-emscripten

CMake warns and falls back to the Software path if it's missing, so
the main build never hard-fails on a fresh checkout.

## Next (the actual hardware-render arc)

Infrastructure is done; now the renderer itself:

1. `WebGPUGfx::CreateShaderFromSource` → `GlslToWgsl` →
   `wgpuDeviceCreateShaderModule` (real `WGPUShaderModule`).
2. Real `WGPURenderPipeline` from `AbstractPipelineConfig`; real
   `WGPUBuffer` vertex/uniform; bind groups.
3. EFB/XFB as real `WGPUTexture`s; `Draw`/`DrawIndexed` →
   `wgpuRenderPassEncoderDraw`.
4. Flip `SupportsUtilityDrawing` / InitBackendInfo to real WebGPU
   caps; retire the Software-rasteriser delegation.

## Files touched (project-tracked)

- `tools/naga-spirv-wgsl/{Cargo.toml,src/lib.rs,.cargo/config.toml}`
  — new crate (the built `.a` + `target/` are gitignored).
- `cores/dolphin/dolphin-core-upstream.{js,wasm}` — rebuilt.
- `patches/dolphin-wasm/SESSION-2026-05-15-DAY-23-NOTES.md` — this.

Vendor (gitignored): `WebGPUShaderTranslator.cpp`,
`VideoBackend.cpp`, `Core/CMakeLists.txt`.
