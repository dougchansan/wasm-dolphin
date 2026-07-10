import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = resolve(root, "provenance/wasm-toolchain.lock.json");

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256NormalizedTextFile(path) {
  return createHash("sha256")
    .update(readFileSync(path, "utf8").replaceAll("\r\n", "\n"))
    .digest("hex");
}

function normalizedTextBytes(path) {
  return Buffer.from(readFileSync(path, "utf8").replaceAll("\r\n", "\n"));
}

function expandCandidate(candidate) {
  return resolve(
    String(candidate).replace(/%([^%]+)%/g, (_, name) => {
      const value = Object.entries(process.env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
      invariant(value, `Environment variable ${name} is required to resolve ${candidate}`);
      return value;
    })
  );
}

function pathCandidate(command) {
  const where = spawnSync("where.exe", [command], { encoding: "utf8", windowsHide: true });
  if (where.status !== 0) return null;
  return where.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
}

function resolveTool(label, envName, candidates, expectedSha256, pathCommand = null) {
  const attempted = [];
  const values = [process.env[envName], ...candidates.map(expandCandidate), pathCommand && pathCandidate(pathCommand)]
    .filter(Boolean);

  for (const value of values) {
    const path = resolve(value);
    attempted.push(path);
    if (!existsSync(path)) continue;
    const actual = sha256File(path);
    invariant(
      actual === expectedSha256,
      `${label} hash mismatch at ${path}: expected ${expectedSha256}, got ${actual}`
    );
    return path;
  }

  throw new Error(`${label} was not found. Checked: ${attempted.join(", ")}`);
}

function runVersion(command, args) {
  const isBatch = process.platform === "win32" && /\.(bat|cmd)$/i.test(command);
  const executable = isBatch ? (process.env.ComSpec ?? "cmd.exe") : command;
  const executableArgs = isBatch ? ["/d", "/s", "/c", command, ...args] : args;
  const result = spawnSync(executable, executableArgs, {
    encoding: "utf8",
    windowsHide: true
  });
  invariant(!result.error && result.status === 0, `Could not run ${command} ${args.join(" ")}`);
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
}

function requireText(label, output, expected) {
  invariant(output.includes(expected), `${label} version mismatch: expected output containing ${expected}, got ${output}`);
}

export function loadWasmToolchainLock() {
  return JSON.parse(readFileSync(lockPath, "utf8"));
}

export function verifyWasmToolchain() {
  const lock = loadWasmToolchainLock();
  invariant(lock.schemaVersion === 1, `Unsupported toolchain lock schema ${lock.schemaVersion}`);
  invariant(`${process.platform}-${process.arch}` === lock.platform, `Toolchain lock requires ${lock.platform}`);

  const node = resolveTool("Node", "DOLPHIN_NODE", lock.node.candidates, lock.node.sha256, "node.exe");
  const emcc = resolveTool("emcc", "EMCC", lock.emscripten.emccCandidates, lock.emscripten.emccSha256, "emcc.bat");
  const emcmake = resolveTool("emcmake", "EMCMAKE", lock.emscripten.emcmakeCandidates, lock.emscripten.emcmakeSha256, "emcmake.bat");
  const cmake = resolveTool("CMake", "CMAKE", lock.cmake.candidates, lock.cmake.sha256, "cmake.exe");
  const ninja = resolveTool("Ninja", "NINJA", lock.ninja.candidates, lock.ninja.sha256, "ninja.exe");
  const rustc = resolveTool("rustc", "RUSTC", lock.rust.rustcCandidates, lock.rust.rustcSha256);
  const cargo = resolveTool("cargo", "CARGO", lock.rust.cargoCandidates, lock.rust.cargoSha256);
  const rustup = resolveTool("rustup", "RUSTUP", lock.rust.rustupCandidates, lock.rust.rustupSha256);

  requireText("Node", runVersion(node, ["--version"]), `v${lock.node.version}`);
  const emccVersion = runVersion(emcc, ["--version"]);
  requireText("Emscripten", emccVersion, lock.emscripten.version);
  requireText("Emscripten compiler", emccVersion, lock.emscripten.compilerCommit);
  requireText("CMake", runVersion(cmake, ["--version"]), lock.cmake.version);
  requireText("Ninja", runVersion(ninja, ["--version"]), lock.ninja.version);
  const rustcVersion = runVersion(rustc, ["--version", "--verbose"]);
  requireText("rustc", rustcVersion, lock.rust.rustcVersion);
  requireText("rustc", rustcVersion, lock.rust.rustcCommit);
  const cargoVersion = runVersion(cargo, ["--version", "--verbose"]);
  requireText("cargo", cargoVersion, lock.rust.cargoVersion);
  requireText("cargo", cargoVersion, lock.rust.cargoCommit);

  const emsdkRoot = resolve(dirname(emcc), "../..");
  const emsdkHead = runVersion("git", ["-C", emsdkRoot, "rev-parse", "HEAD"]);
  invariant(emsdkHead === lock.emscripten.emsdkCommit, `emsdk commit mismatch: expected ${lock.emscripten.emsdkCommit}, got ${emsdkHead}`);
  const clangxx = resolve(emsdkRoot, "upstream/bin/clang++.exe");
  invariant(existsSync(clangxx), `Emscripten clang++ is missing at ${clangxx}`);
  invariant(sha256File(clangxx) === lock.emscripten.clangxxSha256, "Emscripten clang++ hash mismatch");

  if (lock.rust.rustSrcRequired) {
    const installed = runVersion(rustup, ["component", "list", "--toolchain", lock.rust.toolchain, "--installed"]);
    invariant(installed.split(/\r?\n/).some((line) => line.startsWith("rust-src")), `${lock.rust.toolchain} is missing rust-src`);
  }

  const cargoLock = resolve(root, "tools/naga-spirv-wgsl/Cargo.lock");
  invariant(lock.naga.cargoLockHashMode === "lf-normalized", "Unsupported Naga Cargo.lock hash mode");
  invariant(sha256NormalizedTextFile(cargoLock) === lock.naga.cargoLockSha256, "Naga Cargo.lock hash mismatch");
  const cargoToml = readFileSync(resolve(root, "tools/naga-spirv-wgsl/Cargo.toml"), "utf8");
  invariant(cargoToml.includes(`version = "${lock.naga.crateVersion}"`), "Naga crate version does not match the lock");
  invariant(cargoToml.includes(`naga = { version = "${lock.naga.dependencyVersion.split(".")[0]}"`), "Naga dependency version does not match the lock");
  invariant(Array.isArray(lock.naga.sourceRecords) && lock.naga.sourceRecords.length > 0,
    "Naga source records are missing from the toolchain lock");
  for (const record of lock.naga.sourceRecords) {
    invariant(record.hashMode === "lf-normalized", `Unsupported Naga source hash mode for ${record.path}`);
    const path = resolve(root, record.path);
    invariant(existsSync(path), `Missing Naga source ${record.path}`);
    const bytes = normalizedTextBytes(path);
    invariant(bytes.length === record.size, `Naga source size mismatch for ${record.path}`);
    invariant(createHash("sha256").update(bytes).digest("hex") === record.sha256,
      `Naga source hash mismatch for ${record.path}`);
  }

  return {
    lock,
    paths: { node, emcc, emcmake, cmake, ninja, rustc, cargo, rustup, clangxx },
    hashes: {
      lock: sha256File(lockPath),
      cargoLock: sha256NormalizedTextFile(cargoLock)
    }
  };
}

export { lockPath, sha256File, sha256NormalizedTextFile };
