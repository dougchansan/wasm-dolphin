# Reproducible upstream-core build

The distributed core `.wasm` is a derived work of GPLv2+ Dolphin. Reproducing
it from pinned inputs is therefore a **licensing obligation**, not just a
convenience: GPLv2 §3 requires the complete corresponding source for the exact
binary that is distributed.

Three things together constitute that corresponding source:

1. `vendor/dolphin` — a git submodule pinned to the revision below.
2. `patches/dolphin-wasm/wasm-dolphin-full.patch` — the complete delta from
   that revision to the tree that produced the committed `.wasm`.
3. `patches/dolphin-wasm/nested/*.patch` — changes inside two of Dolphin's own
   submodules, which a superproject patch cannot express.

## Pinned inputs

| Component | Version/revision |
| --- | --- |
| Upstream Dolphin | `e22551eae1c84a7e4d0b6a5c519ef4ed4ef69df1` |
| SPIRV-Tools (vendored into glslang) | `7f2d9ee926f98fc77a3ed1e1e0f113b8c9c49458` |
| SPIRV-Headers | `01e0577914a75a2569c846778c2f93aa8e6feddd` |
| Naga | `26` (`tools/naga-spirv-wgsl/Cargo.toml`) |
| Rust target | `wasm32-unknown-emscripten` |

SPIRV-Tools and SPIRV-Headers are **not** reachable through submodules —
glslang gitignores `External/spirv-tools` — but the build needs them, because
`Externals/glslang/CMakeLists.txt` sets `ENABLE_OPT=ON` so glslang compiles its
SPIRV-Tools optimizer bridge. That bridge canonicalises glslang's raw SPIR-V
into the subset Naga's `spv` frontend accepts. `npm run fetch:dolphin` vendors
both at the pins above.

## Toolchain record

Recorded from the machine that produced the committed core on **2026-08-12**:

| Component | Version |
| --- | --- |
| Node.js (repo tooling) | `v24.12.0` (supported range: 20.x–24.x) |
| Emscripten SDK | `5.0.7` |
| CMake | `4.3.2` |
| Ninja | `1.13.0.git.kitware.jobserver-pipe-1` |
| Rust nightly | `1.97.0-nightly (7c3c88f42 2026-05-14)` |
| Chrome (validation) | `151.0.7922.109` |

The Naga static library uses nightly Rust because its Emscripten pthread build
rebuilds `std` with atomics and bulk-memory support. Install nightly plus
`rust-src`, add the `wasm32-unknown-emscripten` target, and build the crate as
documented in [the bridge guide](webgpu-naga-bridge.md).

### Line endings

The patch set is generated against an **LF** tree. `fetch:dolphin` sets
`core.autocrlf=false` inside `vendor/dolphin` for this reason. A CRLF checkout
still applies the patch cleanly but yields a source tree that differs byte-wise
from the one that built the committed `.wasm`.

## Artifact record

| Property | Value |
| --- | --- |
| `cores/dolphin/dolphin-core-upstream.wasm` size | `14977143` bytes |
| SHA-256 | `af7048b163d08b1ef35823cb1ed3c767713003daa248afde7e557c28d84de89c` |

## Commands

From a clean repository checkout in PowerShell:

```powershell
git submodule update --init --depth 1 vendor/dolphin
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

## Verifying the patch set

The full patch is verified to apply cleanly to a pristine checkout of the
pinned revision. To re-verify without disturbing a working tree:

```powershell
git -C vendor/dolphin worktree add --detach ../../.verify e22551eae1c84a7e4d0b6a5c519ef4ed4ef69df1
git -C .verify apply --unidiff-zero --check ../patches/dolphin-wasm/wasm-dolphin-full.patch
git -C vendor/dolphin worktree remove --force ../../.verify
```

## Patch layout

| Path | Role |
| --- | --- |
| `wasm-dolphin-full.patch` | **Authoritative build input.** Complete delta, 87 files, including the `VideoBackends/WebGPU` backend and `AudioCommon/WebAudioStream`. |
| `nested/sfml-emscripten-platform.patch` | Applied inside `Externals/SFML/SFML`. |
| `nested/xxhash.patch` | Applied inside `Externals/xxhash/xxHash`. |
| `historical/0001-0009-*.patch` | Earlier hand-curated series, each documenting one browser-porting decision. A **subset** of the full patch; kept for readability, **not applied** by `patch:upstream`. |

## Release/reproduction checklist

- [x] Record the upstream Dolphin commit.
- [x] Pin the upstream tree as a submodule rather than tracking `master`.
- [x] Confirm the complete upstream patch set is committed and replayable.
- [x] Record the Emscripten version.
- [x] Record the Rust toolchain and Naga version.
- [x] Record the `.wasm` byte size and a SHA-256 hash.
- [x] Record the Chrome version used for validation.
- [ ] Re-run the full build from a clean clone and confirm the `.wasm` hash
      matches the artifact record above. **Not yet done** — the pins and patch
      set are verified to reconstruct the *source tree*, but an end-to-end
      rebuild has not been performed against the recorded hash.
- [ ] Run `npm test` and `npm run check` from the recorded checkout.
- [ ] Store measured gameplay evidence separately from build success.

Useful artifact commands:

```powershell
(Get-Item cores/dolphin/dolphin-core-upstream.wasm).Length
Get-FileHash cores/dolphin/dolphin-core-upstream.wasm -Algorithm SHA256
```

## Known local assumptions

The scripts are Windows-friendly and search common Windows locations for
Emscripten and CMake. They should also work when `emcmake`, `cmake`, and
`ninja` are on `PATH`. Environment overrides such as `CMAKE`, `EMCMAKE`,
`DOLPHIN_WASM_BUILD_DIR`, and `BUILD_PARALLELISM` are supported where the
corresponding scripts read them.

The Rust bridge archive is generated beneath `tools/naga-spirv-wgsl/target/`
and is intentionally ignored. Commit the patch inputs and the build record, not
the patched `vendor/dolphin/` tree.
