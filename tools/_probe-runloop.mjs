// §28cn runloop probe — automated capture of the per-slice CPU pthread
// profiler readings. Wraps _run-audit-shipped to load the battle save state,
// run for DURATION seconds, then extracts and prints the runloop counter
// from the final sample so we can iterate quickly without user-side testing.
//
// Usage:
//   node tools/_probe-runloop.mjs              # 60s default, pacing=tick
//   DURATION=90 PACING=direct node tools/_probe-runloop.mjs
//   DISABLE_TICK=1 node tools/_probe-runloop.mjs   # baseline (no tick)
//
// Output (one-line):
//   [runloop-probe] tag=<tag> avg=Xus max=Yus runOnlyMax=Zus
//   compile=Aus/maxBus cache=H/M speed=N% core=Mfps drop=K underrun=K
//
// Compare two configs by setting different OUT_TAG values.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const tag = process.env.OUT_TAG || `runloop-${Date.now()}`;
const duration = process.env.DURATION || "60";
const pacing = process.env.PACING || "tick";
const queue = process.env.QUEUE || "2";
const present = process.env.PRESENT || "0.5";
const smearcompile = process.env.SMEARCOMPILE || "";
const audiolead = process.env.AUDIOLEAD || "";
const speed = process.env.SPEED || "";
const oc = process.env.OC || "";

const env = {
  ...process.env,
  DURATION: duration,
  PACING: pacing,
  OUT_TAG: tag,
  QUEUE: queue,
  PRESENT: present
};
if (smearcompile) env.SMEARCOMPILE = smearcompile;
if (audiolead) env.AUDIOLEAD = audiolead;
if (speed) env.SPEED = speed;
if (oc) env.OC = oc;

console.log(`[runloop-probe] tag=${tag} duration=${duration}s pacing=${pacing} queue=${queue} present=${present}` +
  (smearcompile ? ` smearcompile=${smearcompile}` : "") +
  (audiolead ? ` audiolead=${audiolead}` : "") +
  (speed ? ` speed=${speed}` : "") +
  (oc ? ` oc=${oc}` : ""));

await new Promise((resolve, reject) => {
  const p = spawn("node", ["tools/_run-audit-shipped.mjs"], {
    stdio: "inherit",
    env,
    shell: process.platform === "win32"
  });
  p.on("error", reject);
  p.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`audit exited ${code}`)));
});

const samplesPath = path.resolve(".omx/menu-progress/audit-shipped/samples.json");
const samples = JSON.parse(await readFile(samplesPath, "utf8"));
if (!samples.length) {
  console.error("[runloop-probe] no samples produced — abort");
  process.exit(1);
}

// Use the LAST 5 samples averaged for stability (warm-battle, post-warmup).
const tail = samples.slice(-5);
const lastHelper = tail[tail.length - 1].helper || "";
const m = /runloop:(\d+)slices\/avg(\d+)us\/max(\d+)us\/runOnlyMax(\d+)us\/advMax(\d+)us\/execMax(\d+)us/.exec(lastHelper);
const cm = /modcompile:(\d+)us\/max(\d+)us/.exec(lastHelper);
const ci = /modcache:(\d+)hit\/(\d+)miss/.exec(lastHelper);
const drop = /\bdrop:(\d+)/.exec(lastHelper)?.[1] ?? "?";
const under = /\bunderrun:(\d+)/.exec(lastHelper)?.[1] ?? "?";

// Pull avg core+speed across the last 5 samples (warm window).
const avgCore = tail.reduce((a, s) => a + (Number(s.coreFps) || 0), 0) / tail.length;
const avgSpeedPct = tail.reduce((a, s) => {
  const n = Number(String(s.gameSpeed || "").replace(/[^0-9.]/g, ""));
  return a + (Number.isFinite(n) ? n : 0);
}, 0) / tail.length;

console.log("");
console.log(`[runloop-probe] === ${tag} ===`);
if (m) {
  console.log(`  slices=${m[1]} avg=${m[2]}us max=${m[3]}us runOnlyMax=${m[4]}us advMax=${m[5]}us execMax=${m[6]}us`);
} else {
  console.log(`  runloop: NOT FOUND in helper string — is the build current?`);
  console.log(`  helper tail: ${lastHelper.slice(-300)}`);
}
if (cm) console.log(`  modcompile: total=${cm[1]}us max=${cm[2]}us`);
if (ci) console.log(`  cache: ${ci[1]}hit / ${ci[2]}miss`);
console.log(`  warm-tail (last 5 samples): avgCore=${avgCore.toFixed(1)}fps avgSpeed=${avgSpeedPct.toFixed(1)}%`);
console.log(`  audio: ${under}u/${drop}d`);
