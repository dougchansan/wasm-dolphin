# Native WebAssembly Core

This directory is the from-scratch browser core lane. It establishes the ABI the Chrome host uses before the full upstream Dolphin subsystems are ported in.

The current implementation:

- Mounts a GameCube/Wii-style disc file from Emscripten FS.
- Parses GameCube header metadata when available.
- Maintains input, frame counter, reset, and save/load state.
- Renders a deterministic software framebuffer into WASM memory for the browser.

The missing full-emulator work is tracked in `docs/core-roadmap.md`.

Build:

```powershell
npm run build:core
```
