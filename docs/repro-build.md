# Reproducible upstream-core build

The repository fetches upstream Dolphin into the gitignored `vendor/dolphin/`
tree, applies the browser patch set, configures an Emscripten/Ninja build, and
writes the browser core into `cores/dolphin/`.

## Toolchain record

Use Node.js **20.x through 24.x**. Before calling a build reproducible, replace
every `TODO` below with the exact value used for that build:

| Component | Version/revision |
| --- | --- |
| Node.js | `TODO: record exact version within 20.x-24.x` |
| Emscripten SDK | `TODO: record emsdk/Emscripten version` |
| CMake | `TODO: record CMake version` |
| Ninja | `TODO: record Ninja version` |
| Rust nightly | `TODO: record rustc version/date` |
| Rust target | `wasm32-unknown-emscripten` |
| Naga | `26` (confirm from `tools/naga-spirv-wgsl/Cargo.toml`) |
| Chrome | `TODO: record validation Chrome version` |
| Upstream Dolphin commit | `TODO: record vendor/dolphin commit SHA` |

The Naga static library uses nightly Rust because its Emscripten pthread build
rebuilds `std` with atomics and bulk-memory support. Install nightly plus
`rust-src`, add the `wasm32-unknown-emscripten` target, and build the crate as
documented in [the bridge guide](webgpu-naga-bridge.md) when the hardware
WebGPU shader path is required.

## Commands

From a clean repository checkout in PowerShell:

```powershell
npm install
npm test
npm run check
npm run fetch:dolphin
npm run patch:upstream
npm run configure:upstream
npm run build:upstream:full-core
```

The final target produces:

- `cores/dolphin/dolphin-core-upstream.js`
- `cores/dolphin/dolphin-core-upstream.wasm`

`fetch:dolphin` currently checks out the fetched upstream `master` head rather
than a repository-pinned SHA. Recording the resolved `vendor/dolphin` commit is
therefore part of the reproducibility record:

```powershell
git -C vendor/dolphin rev-parse HEAD
```

The true hardware-WebGPU work also exists in the working research tree beyond
the currently enumerated `0001`-`0009` patch manifest. Before treating the
sequence above as a release reproduction, verify that the complete Dolphin
patch set—including the Naga call site—is committed and applied by
`patch:upstream`. See [the bridge guide](webgpu-naga-bridge.md).

## Known local assumptions

The scripts are Windows-friendly and search common Windows locations for
Emscripten and CMake. They should also work when `emcmake`, `cmake`, and
`ninja` are on `PATH`. Environment overrides such as `CMAKE`, `EMCMAKE`,
`DOLPHIN_WASM_BUILD_DIR`, and `BUILD_PARALLELISM` are supported where the
corresponding scripts read them.

The Rust bridge archive is generated beneath
`tools/naga-spirv-wgsl/target/` and is intentionally ignored. The patched
upstream source tree is also ignored; commit the patch inputs and the intended
build record, not `vendor/dolphin/`.

## Release/reproduction checklist

- [ ] Record the upstream Dolphin commit.
- [ ] Confirm the complete upstream patch set is committed and replayable.
- [ ] Record the Emscripten version.
- [ ] Record the Rust toolchain and Naga version.
- [ ] Record the `.wasm` byte size and a SHA-256 hash.
- [ ] Record the Chrome version used for validation.
- [ ] Run `npm test` and `npm run check` from the recorded checkout.
- [ ] Store measured gameplay evidence separately from build success.

Useful artifact commands:

```powershell
(Get-Item cores/dolphin/dolphin-core-upstream.wasm).Length
Get-FileHash cores/dolphin/dolphin-core-upstream.wasm -Algorithm SHA256
```
