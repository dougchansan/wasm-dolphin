// §28bx blockmerge A/B scorer. Usage:
//   node tools/score-blockmerge-ab.mjs [match-prefix]
// Default prefix "blockmerge-" matches both ON and OFF dirs under
// .omx/menu-progress/. Computes per-trial stats and the §28bt-style
// non-overlapping-range verdict between ON and OFF subsets.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const prefix = process.argv[2] || "blockmerge-";
const base = ".omx/menu-progress";

function score(dir) {
  const samples = JSON.parse(readFileSync(join(base, dir, "samples.json"), "utf8"));
  const errs = samples.filter((s) => s.visibleError && s.visibleError !== "").length;
  const last = samples[samples.length - 1];
  const h = last.helper || "";
  const num = (re) => { const m = re.exec(h); return m ? Number(m[1]) : null; };
  const parsePct = (v) => { const m = /^(\d+)/.exec(v || ""); return m ? Number(m[1]) : null; };
  const steady = samples.filter((s) => s.elapsedSeconds >= 90);
  const gs = steady.map((s) => parsePct(s.gameSpeed)).filter((n) => n != null && n > 0);
  const fps = steady.map((s) => Number(s.presentationRawFps)).filter((n) => n > 0);
  const drop = +((last.presentationLifetimeDropCount / last.presentationLifetimeFrameCount) * 100).toFixed(1);
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  return {
    dir, errs,
    attempts: num(/jit attempts:(\d+)/),
    compiled: num(/compiled:(\d+)/),
    short: num(/short:(\d+)/),
    merge: num(/merge:(\d+)/), // §28bx counter (null if not exposed in HUD)
    preAvg: num(/pre:(\d+)/),
    preMax: num(/pre:\d+\/(\d+)/),
    gsAvg: +avg(gs).toFixed(1),
    gsMin: Math.min(...gs),
    gsMax: Math.max(...gs),
    fpsAvg: +avg(fps).toFixed(1),
    drop,
    distinct: samples[samples.length - 1].canvasHash ? "?" : "n/a",
  };
}

const dirs = readdirSync(base)
  .filter((d) => d.startsWith(prefix))
  .sort();

const rows = dirs.map((d) => {
  try { return score(d); } catch (e) { return { dir: d, error: e.message }; }
});

const numFmt = (v, w) => String(v ?? "-").padStart(w);
console.log(
  "dir".padEnd(28) + "errs attempts compiled short  merge preAvg preMax gsAvg gsMin gsMax fpsAvg drop"
);
for (const r of rows) {
  if (r.error) { console.log(`${r.dir.padEnd(28)} ERROR: ${r.error}`); continue; }
  console.log(
    r.dir.padEnd(28) +
      numFmt(r.errs, 4) + " " +
      numFmt(r.attempts, 7) + "  " +
      numFmt(r.compiled, 7) + "  " +
      numFmt(r.short, 5) + "  " +
      numFmt(r.merge, 5) + "  " +
      numFmt(r.preAvg, 5) + "  " +
      numFmt(r.preMax, 5) + " " +
      numFmt(r.gsAvg, 5) + " " +
      numFmt(r.gsMin, 5) + " " +
      numFmt(r.gsMax, 5) + "  " +
      numFmt(r.fpsAvg, 5) + " " +
      numFmt(r.drop, 4),
  );
}

const off = rows.filter((r) => /off/.test(r.dir) && !r.error);
const on = rows.filter((r) => !/off/.test(r.dir) && !r.error);
if (off.length && on.length) {
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const offGs = off.map((r) => r.gsAvg), onGs = on.map((r) => r.gsAvg);
  const offFps = off.map((r) => r.fpsAvg), onFps = on.map((r) => r.fpsAvg);
  const nonOverlap = (a, b) => Math.min(...a) > Math.max(...b) || Math.max(...a) < Math.min(...b);
  console.log(`\n=== A/B SUMMARY (n_off=${off.length} n_on=${on.length}) ===`);
  console.log(`OFF gsAvg:  [${Math.min(...offGs)}, ${Math.max(...offGs)}] mean=${avg(offGs).toFixed(1)}`);
  console.log(`ON  gsAvg:  [${Math.min(...onGs)}, ${Math.max(...onGs)}] mean=${avg(onGs).toFixed(1)}`);
  console.log(`OFF fpsAvg: [${Math.min(...offFps)}, ${Math.max(...offFps)}] mean=${avg(offFps).toFixed(1)}`);
  console.log(`ON  fpsAvg: [${Math.min(...onFps)}, ${Math.max(...onFps)}] mean=${avg(onFps).toFixed(1)}`);
  console.log(`\nNon-overlapping gsAvg?  ${nonOverlap(onGs, offGs) ? "YES (winner)" : "NO (wash)"}`);
  console.log(`Non-overlapping fpsAvg? ${nonOverlap(onFps, offFps) ? "YES (winner)" : "NO (wash)"}`);

  const offMerge = off.map((r) => r.merge).filter((n) => n != null);
  const onMerge = on.map((r) => r.merge).filter((n) => n != null);
  if (onMerge.length) {
    console.log(`\nON merge counts: [${Math.min(...onMerge)}, ${Math.max(...onMerge)}] mean=${avg(onMerge).toFixed(0)}`);
    if (offMerge.length)
      console.log(`OFF merge counts: [${Math.min(...offMerge)}, ${Math.max(...offMerge)}] mean=${avg(offMerge).toFixed(0)} (expected ~0)`);
  } else {
    console.log("\nmerge counter not in HUD — rebuild required to confirm fire rate");
  }
  const errs = rows.reduce((a, r) => a + (r.errs || 0), 0);
  console.log(`\nCorrectness: ${errs === 0 ? "CLEAN (0 visibleErrors across all trials)" : `${errs} errors!`}`);
}
