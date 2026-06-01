// §28cg export tool — dumps the IndexedDB JIT cache populated by a prior
// validator run into a static binary blob (`public/prebuilt-jit-cache.bin`)
// that ships with the app and pre-warms first-session boots.
//
// Workflow (orchestrated by `npm run build:prebuilt-cache`):
//   1. Pre-step (separate command): run the validator with
//      `PROBE_PERSIST_DIR=<dir>` for ~120s on the menu+battle path so the
//      IDB store fills with all the blocks Melee touches during boot,
//      menu, and warm battle.
//   2. This script: launch playwright with the same persistent profile dir,
//      open the wasm-dolphin homepage (just needs the same origin for IDB
//      access), page.evaluate to cursor every `modules` row + read the
//      `buildFingerprint` metadata key, return both to Node.
//   3. Encode via the shared format module and write next to the core
//      (default `cores/dolphin/prebuilt-jit-cache.bin`).
//
// Run:
//   PROBE_PERSIST_DIR=./build/jit-cache-profile \
//     node tools/export-prebuilt-jit-cache.mjs
//
// If the profile dir is empty or the IDB store has no `buildFingerprint`,
// the tool exits 2 with a helpful message — caller must run the validator
// step first.

import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { encodePrebuiltCache } from "../src/prebuilt-jit-cache-format.js";

// Match the validator's playwright resolution: prefer the validator-local
// install at .omx/browser-probe/node_modules/playwright, fall back to top-level.
async function importPlaywright() {
  const local = path.join(
    process.cwd(),
    ".omx",
    "browser-probe",
    "node_modules",
    "playwright",
    "index.mjs"
  );
  if (existsSync(local)) return import(pathToFileURL(local).href);
  return import("playwright");
}
const { chromium } = await importPlaywright();

const persistDir = process.env.PROBE_PERSIST_DIR
  ? path.resolve(process.env.PROBE_PERSIST_DIR)
  : null;
if (!persistDir) {
  console.error("PROBE_PERSIST_DIR is required — point it at the profile that ran the validator.");
  process.exit(2);
}
const baseUrl = process.env.BASE_URL || "http://127.0.0.1:8081/";
const outPath = process.env.OUT_PATH
  ? path.resolve(process.env.OUT_PATH)
  : path.resolve("cores/dolphin/prebuilt-jit-cache.bin");
// §28ch / §28cw: reverted to 8192 after PTHREAD_POOL_SIZE=8 + 16k cache
// broke audio in real Chrome (probe was clean, real-browser dropped 18u/16d).
// Original safe config: 16 pthreads × 8k modules = 128k Module instances.
const maxEntries = Number(process.env.MAX_ENTRIES || 8192);

console.log(`[export] persistDir=${persistDir}`);
console.log(`[export] baseUrl=${baseUrl}`);
console.log(`[export] outPath=${outPath}`);
console.log(`[export] maxEntries=${maxEntries}`);

const ctx = await chromium.launchPersistentContext(persistDir, {
  channel: process.env.BROWSER_CHANNEL || "chrome",
  headless: process.env.HEADED !== "1",
  args: [
    "--autoplay-policy=no-user-gesture-required",
    "--enable-unsafe-webgpu"
  ]
});
const page = await ctx.newPage();

// Just navigate to the same origin — we don't need to run the emulator.
// IDB is origin-scoped so simply opening the page gives us access. Use a
// `?nojitcache=0&export=1` URL to make it obvious we're in export mode
// (the app ignores unknown params).
await page.goto(`${baseUrl}?export=1`, { waitUntil: "domcontentloaded", timeout: 30000 });

const dump = await page.evaluate(async (cap) => {
  function openDb() {
    return new Promise((resolve) => {
      const req = indexedDB.open("dolphin-jit-cache", 2);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
  }
  function readMeta(db, key) {
    return new Promise((resolve) => {
      try {
        const tx = db.transaction("metadata", "readonly");
        const req = tx.objectStore("metadata").get(key);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => resolve(null);
      } catch { resolve(null); }
    });
  }
  function readAllModules(db, cap) {
    return new Promise((resolve) => {
      const out = [];
      try {
        const tx = db.transaction("modules", "readonly");
        const cur = tx.objectStore("modules").openCursor();
        cur.onsuccess = (event) => {
          const cursor = event.target.result;
          if (!cursor || out.length >= cap) {
            resolve(out);
            return;
          }
          const value = cursor.value;
          if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
            const bytes = value instanceof ArrayBuffer
              ? new Uint8Array(value)
              : value;
            // Transfer-safe: clone to a plain ArrayBuffer the page.evaluate
            // bridge can structured-clone back to Node.
            out.push({
              hash: String(cursor.key),
              bytes: Array.from(bytes)
            });
          }
          cursor.continue();
        };
        cur.onerror = () => resolve(out);
      } catch { resolve(out); }
    });
  }
  const db = await openDb();
  if (!db) return { fingerprint: null, entries: [] };
  const fingerprint = await readMeta(db, "buildFingerprint");
  const entries = await readAllModules(db, cap);
  return { fingerprint, entries };
}, maxEntries);

await ctx.close();

if (!dump.fingerprint) {
  console.error("[export] no buildFingerprint in IDB — did you run the validator with PROBE_PERSIST_DIR first?");
  process.exit(2);
}
if (!dump.entries.length) {
  console.error("[export] IDB modules store is empty — validator run produced no JIT cache.");
  process.exit(2);
}

// Re-pack the Array<number> back into Uint8Array for the encoder.
const entriesMap = new Map();
let totalBytes = 0;
for (const { hash, bytes } of dump.entries) {
  const u8 = Uint8Array.from(bytes);
  entriesMap.set(hash, u8);
  totalBytes += u8.byteLength;
}

const blob = encodePrebuiltCache({
  fingerprint: dump.fingerprint,
  entries: entriesMap
});

await mkdir(path.dirname(outPath), { recursive: true });
await writeFile(outPath, blob);

console.log(
  `[export] wrote ${outPath} — ${entriesMap.size} modules, ${(blob.byteLength / 1048576).toFixed(2)} MiB ` +
    `(${(totalBytes / 1048576).toFixed(2)} MiB raw WASM, fingerprint ${dump.fingerprint.slice(0, 16)}...)`
);
