# Reproducible upstream-core build

The repository fetches upstream Dolphin into the gitignored `vendor/dolphin/`
tree, verifies and applies the browser patch snapshot, configures an
Emscripten/Ninja build, and writes the browser core into `cores/dolphin/`.

## Toolchain record

The committed `provenance/wasm-toolchain.lock.json` pins the exact local
toolchain used for the research core. `npm run verify:toolchain` rejects a
version or executable hash mismatch before configuration.

| Component | Version/revision |
| --- | --- |
| Node.js | `24.12.0` |
| Emscripten SDK | `5.0.7`; compiler `263db4cffa6f9fc2ec514a70abac81362ea41849`; emsdk `bafd64c26bdaf10bd829163d1575b50b759a72d8` |
| CMake | `4.3.2` |
| Ninja | `1.13.0.git.kitware.jobserver-pipe-1` |
| Rust nightly | `1.97.0-nightly`; rustc `7c3c88f42ad444f4688b865591d84660be4ece2f` |
| Rust target | `wasm32-unknown-emscripten` |
| Naga | `26.0.0`, with the full Cargo graph locked |
| Chrome | `149.0.7827.201` for headed diagnostics; record each performance run separately |
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
npm run verify:toolchain
npm run fetch:dolphin
npm run patch:upstream
npm run configure:upstream
npm run build:upstream:full-core
```

The final target produces:

- `cores/dolphin/dolphin-core-upstream.js`
- `cores/dolphin/dolphin-core-upstream.wasm`
- `cores/dolphin/dolphin-core-upstream.build.json`

The build script also packages an ignored, content-addressed candidate under
`build/core-candidates/<wasm-sha256>/`. It contains the JS, WASM, build record,
source/ABI/vendor/toolchain locks, Cargo lock, and a manifest of file hashes.
Use `?coreid=sha256:<wasm-sha256>` to test it. The browser checks the full WASM
SHA-256 before execution and rolls a rejected candidate back to the pinned
baseline before transferring the canvas.

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
verified result tree 894201c58d67cd65ce67892776f5ccf5c143663c
```

The active lock contains eight root snapshot patches and two patches applied in
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

Build success alone does not establish gameplay parity. Compare two independent
build records with `npm run compare:core-builds -- <left> <right>`, then run the
fixed Kirby-versus-Link save smoke on the candidate and on the default baseline.

## Known local assumptions

The current lock is deliberately Windows x64-specific. Scripts resolve common
Windows locations and accept `EMCC`, `EMCMAKE`, `CMAKE`, `NINJA`, `RUSTC`,
`CARGO`, and `RUSTUP` overrides only when the selected file still matches the
locked hash. `DOLPHIN_WASM_BUILD_DIR`, `DOLPHIN_WASM_OUTPUT_DIR`, and
`BUILD_PARALLELISM` select isolated build/output locations without weakening
the toolchain check.

The Rust bridge archive is generated beneath
`tools/naga-spirv-wgsl/target/` and is intentionally ignored. The patched
upstream source tree is also ignored; commit the patch inputs and the intended
build record, not `vendor/dolphin/`.

## Release/reproduction checklist

- [x] Record the upstream Dolphin commit.
- [x] Confirm the complete upstream patch snapshot is committed and replayable.
- [x] Record the Emscripten version and compiler/emsdk commits.
- [x] Record the Rust toolchain, Naga version, and Cargo lock.
- [x] Record the existing `.wasm` byte size and SHA-256 hash.
- [x] Record the Chrome version used for the current headed diagnostics.
- [ ] Rebuild twice in separate clean directories and establish parity.
- [ ] Run `npm test` and `npm run check` from the recorded checkout.
- [ ] Store measured gameplay evidence separately from build success.

Useful artifact commands:

```powershell
npm run verify:provenance
(Get-Item cores/dolphin/dolphin-core-upstream.wasm).Length
Get-FileHash cores/dolphin/dolphin-core-upstream.wasm -Algorithm SHA256
```
