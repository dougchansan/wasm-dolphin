import { fetchPinnedDolphin } from "./dolphin-provenance.mjs";

try {
  const result = fetchPinnedDolphin();
  console.log(`Dolphin source pinned at ${result.commit}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
