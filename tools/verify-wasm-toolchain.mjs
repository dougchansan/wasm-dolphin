import { verifyWasmToolchain } from "./wasm-toolchain.mjs";

try {
  const result = verifyWasmToolchain();
  console.log(`Pinned WASM toolchain verified (${result.lock.emscripten.version}, ${result.lock.rust.rustcVersion})`);
} catch (error) {
  console.error(`WASM toolchain verification failed: ${error.message}`);
  process.exitCode = 1;
}
