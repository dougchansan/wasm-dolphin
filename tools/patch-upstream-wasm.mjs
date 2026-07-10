import { applyPinnedPatches } from "./dolphin-provenance.mjs";

try {
  const result = applyPinnedPatches();
  console.log(
    `${result.status} ${result.count} locked patches (${result.sha256}); ` +
    `verified result tree ${result.resultTree}`
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
