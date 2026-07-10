# Reproducible upstream-core build

The repository fetches upstream Dolphin into the gitignored `vendor/dolphin/`
tree, verifies and applies the browser patch snapshot, configures an
Emscripten/Ninja build, and writes the browser core into `cores/dolphin/`.

## Toolchain record

Use Node.js **20.x through 24.x**. Before calling a new build reproducible,
replace every remaining `TODO` with the exact value used for that build:

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
| Upstream Dolphin commit | `e22551eae1c84a7e4d0b6a5c519ef4ed4ef69df1` |

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
npm run verify:provenance
npm run fetch:dolphin
npm run patch:upstream
npm run configure:upstream
npm run build:upstream:full-core
```

The final target produces:

- `cores/dolphin/dolphin-core-upstream.js`
- `cores/dolphin/dolphin-core-upstream.wasm`

`fetch:dolphin` reads `provenance/dolphin-source.lock.json`, fetches the exact
commit above, verifies the fetched object, and checks it out detached. It never
uses a moving branch head. `patch:upstream` verifies every active patch's
canonical SHA-256, byte size, order, target repository, and base commit before
applying it. The root `HEAD` remains the pristine upstream base after patches
are applied, so this command proves only the base commit:

```powershell
git -C vendor/dolphin rev-parse HEAD
```

The durable patched identity is the virtual result tree. Re-running the patch
command classifies the complete root and submodule status, rejects extra dirty
or untracked paths, rejects index flags that can hide changes (including
assume-unchanged and skip-worktree), recomputes every result blob and tree, and
reports:

```text
verified result tree 021ca35004bcb8bd1c4a7bf745c798e2874135e1
```

The active lock contains six root snapshot patches and two patches applied in
the pinned SFML and xxHash submodules. It captures the complete forensic delta,
including the hardware-WebGPU/Naga call site. The older top-level
`0001`-`0009` files remain research history and are not applied by the locked
build. See [the bridge guide](webgpu-naga-bridge.md).

## Existing artifact and ABI identity

`provenance/dolphin-core-abi-v1.json` independently identifies the current
baked core:

| Artifact | Canonical size | SHA-256 |
| --- | ---: | --- |
| `dolphin-core-upstream.js` | 260,703 bytes | `2465f3c0d43864eb7ce0aa2f8bde33ee082e8a835b88b7d4813199f0cdfde3c8` |
| `dolphin-core-upstream.wasm` | 12,800,707 bytes | `03df79d2eb4be6c1e05d58d79ad4ab9590a9407c19fa5ae70e088401f424af3f` |

The JS digest is calculated after CRLF-to-LF normalization, and
`.gitattributes` requires LF for core JS files. This prevents checkout line
ending policy from changing the identity of semantically identical glue. The
WASM digest is always over raw bytes. ABI verification also checks the public
Module exports and the 24,576-page (1.5 GiB) shared-memory contract in the JS
glue, WASM import, C++ dynamic-JIT wrapper, and active patch series.

This source freeze does not establish that a newly built core is byte-identical
or behaviorally equivalent to the baked core. That requires the pinned
toolchain and two-clean-build parity work described by the performance plan.

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

- [x] Record the upstream Dolphin commit.
- [x] Confirm the complete upstream patch snapshot is committed and replayable.
- [ ] Record the Emscripten version.
- [ ] Record the Rust toolchain and Naga version.
- [x] Record the existing `.wasm` byte size and SHA-256 hash.
- [ ] Record the Chrome version used for validation.
- [ ] Rebuild twice in separate clean directories and establish parity.
- [ ] Run `npm test` and `npm run check` from the recorded checkout.
- [ ] Store measured gameplay evidence separately from build success.

Useful artifact commands:

```powershell
npm run verify:provenance
(Get-Item cores/dolphin/dolphin-core-upstream.wasm).Length
Get-FileHash cores/dolphin/dolphin-core-upstream.wasm -Algorithm SHA256
```
