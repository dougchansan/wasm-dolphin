import { verifyDolphinProvenance } from "./dolphin-provenance.mjs";

try {
  const result = verifyDolphinProvenance();
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
