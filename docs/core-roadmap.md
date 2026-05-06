# Dolphin WebAssembly Core Roadmap

The browser host and native ABI are in place. Completing a true Dolphin-compatible WebAssembly core means porting emulator subsystems, not just compiling one file.

## Current Slice

- Emscripten module boundary.
- Disc mounting through browser file input and Emscripten FS.
- GameCube header metadata parsing.
- Deterministic software framebuffer.
- Input mask, frame stepping, reset, and state slot calls.

## Porting Milestones

1. Memory and boot ROM model: MEM1/MEM2 layout, exception vectors, MMIO map, reset state.
2. Disc interface: ISO/GCM partition reads, RVZ/WBFS support, async read scheduling.
3. PowerPC core: interpreter first, then browser-safe recompilation strategy if feasible.
4. Scheduler and timing: CPU/GPU/audio event queues and deterministic frame pacing.
5. Video: GX command processor, texture formats, embedded framebuffer, WebGL2/WebGPU backend.
6. Audio: DSP HLE first, AudioWorklet output path.
7. Input and devices: GameCube controller, memory cards, SRAM, EXI/SI.
8. Wii lane: IOS, NAND, Bluetooth/Wiimote, WAD/title launching.
9. Save states and persistence: browser storage, import/export, compatibility versioning.
10. Upstream Dolphin integration: map upstream Core/VideoCommon/Common libraries onto this ABI.

## Upstream Dependency Lane

Use `npm run fetch:dolphin` to clone upstream Dolphin into `vendor/dolphin`. Upstream Dolphin currently targets desktop/mobile platforms and uses CMake with C++20; browser support needs dedicated Emscripten flags, platform shims, thread policy, graphics backend work, and filesystem integration.
