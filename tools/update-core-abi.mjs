import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  fileRecord,
  inspectMemoryContract,
  loadSourceLock,
  publicModuleExports,
  verifyCoreAbiManifest,
} from "./dolphin-provenance.mjs";

const root = process.cwd();
const manifestPath = resolve(root, "provenance/dolphin-core-abi-v1.json");
const write = process.argv.includes("--write");
const previous = JSON.parse(readFileSync(manifestPath, "utf8"));
const lock = loadSourceLock(root);
const artifacts = previous.artifacts.map((artifact) => ({
  ...fileRecord(artifact.path, root, artifact.hashMode ?? "raw"),
  ...(artifact.hashMode ? { hashMode: artifact.hashMode } : {}),
}));
const wasm = artifacts.find((artifact) => artifact.path.endsWith(".wasm"));
if (!wasm) throw new Error("Core ABI manifest has no WASM artifact");
const contractSources = previous.contractSources.map((source) => ({
  ...fileRecord(source.path, root, source.hashMode ?? "raw"),
  ...(source.hashMode ? { hashMode: source.hashMode } : {}),
}));
const glue = readFileSync(resolve(root, "cores/dolphin/dolphin-core-upstream.js"), "utf8");
const moduleExports = publicModuleExports(glue);
const memoryContract = inspectMemoryContract(root);
const runtimeMethods = inspectRuntimeMethods(lock, glue);
const manifest = {
  ...previous,
  coreId: `sha256:${wasm.sha256}`,
  upstreamCommit: lock.upstream.commit,
  artifacts,
  contractSources,
  memoryContract,
  memoryContractStatus: memoryContractStatus(memoryContract),
  sourceOnlyExportsPendingRebuild: (previous.sourceOnlyExportsPendingRebuild ?? [])
    .filter((name) => !moduleExports.includes(name)),
  moduleExports,
  runtimeMethods,
};

if (write) {
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  verifyCoreAbiManifest(root);
}

console.log(JSON.stringify({
  wroteFile: write,
  coreId: manifest.coreId,
  artifactSizes: Object.fromEntries(artifacts.map((artifact) => [artifact.path, artifact.size])),
  contractSourceCount: contractSources.length,
  moduleExportCount: manifest.moduleExports.length,
  runtimeMethods,
  memoryContractStatus: manifest.memoryContractStatus,
}, null, 2));

function inspectRuntimeMethods(sourceLock, glueSource) {
  const activePatchText = sourceLock.patches
    .filter((entry) => entry.cwd === ".")
    .map((entry) => readFileSync(resolve(root, entry.path), "utf8"))
    .join("\n");
  const methods = new Set();
  for (const list of activePatchText.matchAll(/-sEXPORTED_RUNTIME_METHODS=\[([^\]]+)\]/g)) {
    for (const method of list[1].matchAll(/'([^']+)'/g)) methods.add(method[1]);
  }
  if (methods.size === 0) throw new Error("Active patch series declares no runtime methods");
  const result = [...methods].sort();
  for (const method of result) {
    if (!glueSource.includes(`Module["${method}"]=${method}`)) {
      throw new Error(`Generated core does not expose runtime method ${method}`);
    }
  }
  return result;
}

function memoryContractStatus(contract) {
  const pages = [
    contract.jsGlue.initialPages,
    ...contract.wasmImports.flatMap((memory) => [memory.minimum, memory.maximum]),
    ...contract.wrapperDynamicJitPages,
    contract.activePatchSeries.initialPages,
  ];
  const consistentPages = pages.every((value) => value === pages[0]);
  const validSharedImports = contract.wasmImports.length > 0 &&
    contract.wasmImports.every(
      (memory) => memory.shared && !memory.memory64 && memory.maximum !== null
    );
  return consistentPages && validSharedImports ? "consistent" : "mismatch";
}
