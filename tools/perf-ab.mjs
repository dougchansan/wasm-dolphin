// Paired A/B performance comparison.
//
// Why this exists: single-run comparisons on this project are worthless. The
// same title measured 32-35% early in a session and 26-28% later on
// byte-identical builds, and within-config spread on one binary was 26-35%.
// A 1-2% optimisation cannot be seen through that, which made micro-
// optimisation unfalsifiable rather than merely hard.
//
// What fixes it is not more runs -- it is PAIRING. Run A and B back-to-back as
// a pair, compute the difference WITHIN each pair, then take the median of the
// differences. Machine drift moves both halves of a pair together and cancels;
// only the treatment effect survives. Group means do not have this property,
// which is why the earlier A/B tables were misleading.
//
// Usage:
//   node tools/perf-ab.mjs --filter "Metroid Prime (USA)" \
//     --a "" --b "DISABLE=0x800000" --pairs 5 [--duration 40]
//
// --a and --b are space-separated ENV assignments applied to boot-matrix. The
// only difference between the two arms should be the thing under test.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function parseArgs(argv) {
  const out = { pairs: 5, duration: 40, a: "", b: "", library: "F:/Games/Library/GameCube" };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--filter") out.filter = argv[++i];
    else if (k === "--a") out.a = argv[++i];
    else if (k === "--b") out.b = argv[++i];
    else if (k === "--pairs") out.pairs = Number(argv[++i]);
    else if (k === "--duration") out.duration = Number(argv[++i]);
    else if (k === "--library") out.library = argv[++i];
    else if (k === "--video") out.video = argv[++i];
    else if (k === "--rom") out.rom = argv[++i];
    else if (k === "--save-state") out.saveState = argv[++i];
    else if (k === "--state-at") out.stateAt = argv[++i];
    else if (k === "--base-url") out.baseUrl = argv[++i];
    else if (k === "--retries") out.retries = Number(argv[++i]);
    else throw new Error(`Unknown arg: ${k}`);
  }
  if (!out.filter) throw new Error("--filter is required");
  return out;
}

const args = parseArgs(process.argv.slice(2));

function envFrom(spec) {
  const env = { ...process.env, VIDEO: args.video || "wgpu" };
  if (args.baseUrl) env.BASE_URL = args.baseUrl;
  for (const tok of spec.split(/\s+/).filter(Boolean)) {
    const eq = tok.indexOf("=");
    if (eq < 0) throw new Error(`Bad env token: ${tok}`);
    env[tok.slice(0, eq)] = tok.slice(eq + 1);
  }
  return env;
}

// Fixed-scene measurement. NOT WORKING YET -- see the note below; prefer the
// default (boot-matrix) backend until it is fixed.
//
// STATUS 2026-08-31: passing --save-state fails with
//   Save-state load failed: Failed to fetch
// from window.__loadStateFile inside the page, even though the dev server
// returns 200 for the same path (verified with curl for /__mkdd-race.sav and
// /__battle.sav). So the server is fine and the failure is in the page's own
// fetch. Worth checking next: the COOP/COEP headers the server sets for
// SharedArrayBuffer, and whether a 44MB response is being cut off.
//
// A save state pins the workload: every run measures
// the SAME frames, which removes the dominant variance source. Without it each
// run samples whatever the attract mode happened to be showing, which is why
// within-config spread was 26-35% even on one binary. Input is disabled so the
// scene cannot drift after the state loads.
function measureFixedScene(spec) {
  const dir = mkdtempSync(path.join(tmpdir(), "perfab-"));
  try {
    const env = envFrom(spec);
    env.ROM = args.rom;
    env.SAVE_STATE_URL = args.saveState;
    env.SAVE_STATE_AT = args.stateAt || "35";
    env.INPUT_SCRIPT = "none";
    env.DURATION = String(args.duration);
    env.CAPTURE_SCREENSHOTS = "0";
    const out = execFileSync(process.execPath,
      ["tools/menu-progress-validate.mjs", "--out-dir", dir],
      { env, stdio: "pipe", maxBuffer: 64 * 1024 * 1024 }).toString();
    // Score only the post-load tail, so the pre-state boot is excluded.
    const samples = JSON.parse(readFileSync(path.join(dir, "samples.json"), "utf8"));
    const rows = (samples.samples || samples)
      .filter((x) => Number(x.elapsedSeconds) > Number(env.SAVE_STATE_AT) + 5)
      // gameSpeed is a STRING with a percent sign ("99%"), so Number() gives
      // NaN and every row silently drops. That produced "fail" for a run that
      // had 46 good samples.
      .map((x) => Number.parseFloat(String(x.gameSpeed)))
      .filter((n) => Number.isFinite(n));
    if (rows.length < 5) return null;
    return median(rows);
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// One measurement. Returns median game speed for the run, or null if the run
// did not produce a usable sample -- a failed mount must not be scored as 0.
function measure(spec) {
  if (args.saveState) return measureFixedScene(spec);
  const dir = mkdtempSync(path.join(tmpdir(), "perfab-"));
  try {
    execFileSync(process.execPath,
      ["tools/boot-matrix.mjs", "--library", args.library, "--filter", args.filter,
       "--duration", String(args.duration), "--out-dir", dir],
      { env: envFrom(spec), stdio: "pipe", maxBuffer: 64 * 1024 * 1024 });
    const results = JSON.parse(readFileSync(path.join(dir, "results.json"), "utf8"));
    const rows = results.results || results;
    const row = rows[0];
    if (!row || row.verdict === "mount-fail" || !Number.isFinite(Number(row.medianGameSpeed)))
      return null;
    return Number(row.medianGameSpeed);
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function median(xs) {
  const s = [...xs].sort((p, q) => p - q);
  const n = s.length;
  if (!n) return null;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

console.log(`[perf-ab] ${args.filter}  pairs=${args.pairs} duration=${args.duration}s`);
console.log(`[perf-ab] A: ${args.a || "(baseline)"}`);
console.log(`[perf-ab] B: ${args.b || "(baseline)"}`);

const diffs = [];
const aVals = [];
const bVals = [];
let discarded = 0;

for (let i = 1; i <= args.pairs; i++) {
  // Alternate which arm runs first, so any within-pair ordering effect
  // (cache warmth, thermal ramp) does not bias one arm systematically.
  const aFirst = i % 2 === 1;
  // Disc mounts are intermittently flaky on large images. Retry rather than
  // discard, so a transient mount failure does not quietly shrink the sample.
  const attempt = (spec) => {
    const tries = Number.isFinite(args.retries) ? args.retries : 2;
    for (let t = 0; t <= tries; t++) {
      const v = measure(spec);
      if (v != null) return v;
    }
    return null;
  };
  const first = aFirst ? attempt(args.a) : attempt(args.b);
  const second = aFirst ? attempt(args.b) : attempt(args.a);
  const a = aFirst ? first : second;
  const b = aFirst ? second : first;
  if (a == null || b == null) {
    discarded++;
    console.log(`  pair ${i}: DISCARDED (a=${a ?? "fail"} b=${b ?? "fail"})`);
    continue;
  }
  aVals.push(a); bVals.push(b); diffs.push(b - a);
  console.log(`  pair ${i}: a=${a}%  b=${b}%  b-a=${(b - a).toFixed(1)}`);
}

if (!diffs.length) {
  console.log("[perf-ab] no usable pairs");
  process.exit(1);
}

const md = median(diffs);
const lo = Math.min(...diffs);
const hi = Math.max(...diffs);
const sameSign = diffs.every((d) => d > 0) || diffs.every((d) => d < 0);

console.log("");
console.log(`[perf-ab] A median ${median(aVals)}%  (spread ${Math.min(...aVals)}-${Math.max(...aVals)})`);
console.log(`[perf-ab] B median ${median(bVals)}%  (spread ${Math.min(...bVals)}-${Math.max(...bVals)})`);
console.log(`[perf-ab] paired difference (B-A): median ${md.toFixed(1)}, range ${lo.toFixed(1)}..${hi.toFixed(1)}`);
if (discarded) console.log(`[perf-ab] ${discarded} pair(s) discarded`);
console.log(
  sameSign
    ? `[perf-ab] VERDICT: consistent ${md > 0 ? "gain" : "loss"} — every pair agreed in sign.`
    : `[perf-ab] VERDICT: NOT RESOLVED — pairs disagree in sign, effect is below this rig's resolution.`
);
