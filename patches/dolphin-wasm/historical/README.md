# Historical patch series (not applied)

These are the original hand-curated `0001`–`0009` browser-porting patches. Each
one isolates a single decision and is worth reading for that reason:

| Patch | Decision |
| --- | --- |
| `0001` | Browser platform build gates |
| `0002` | Skip large dcbx warmup invalidations |
| `0003` | Disable WebGL base vertex |
| `0004` | Fix `OGLTexture` `MapBufferRange` invalidate |
| `0005` | WebGL depth range and XFB duplicate |
| `0006` | Skip `SleepUntil` and immediate XFB |
| `0007` | Skip dcbx when the JIT is inactive |
| `0008` | Fix character rendering on WebGL2 |
| `0009` | OGL worker-mode proxy fallback |

**They are not the build input and are not applied by `npm run patch:upstream`.**

The working tree diverged well beyond this series — notably the entire
`Source/Core/VideoBackends/WebGPU` backend and `AudioCommon/WebAudioStream`,
which existed only as untracked local files and were captured in no patch at
all. The authoritative build input is now
[`../wasm-dolphin-full.patch`](../wasm-dolphin-full.patch): the complete,
verified delta from the pinned upstream revision to the tree that produced the
committed core `.wasm`.

Every file touched by `0001`–`0009` is covered by the full patch. Re-adding
these to the apply pipeline would conflict.

If you want to restore a readable decomposition, the right move is to rebase
the full delta into a fresh themed series against the pinned revision and
re-verify it against a pristine worktree — not to resurrect this one.
