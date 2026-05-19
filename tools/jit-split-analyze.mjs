// Day-33 §28br no-rebuild JIT dispatch-vs-block-body split analyzer.
//
// Reads a menu-progress-validate samples.json and derives, from EXISTING
// core counters only (no rebuild):
//   - WASM block dispatch rate (Δ s_wasm_block_run_count / Δ wallclock)
//   - dispatches per core frame
//   - avg static compiled-block length ("pre:" avg) + length histogram
//   - implied PPC instrs/frame  =  dispatches/frame x avg_block_len
//   - fixed per-dispatch overhead as a fraction of block-body work
//
// The point: decide whether JIT block-linking (kill per-block return-to-
// JS-dispatcher) or WASM-local register allocation is the bigger prize
// before committing a risky core rebuild.

import { readFileSync } from "node:fs";

const file = process.argv[2] || ".omx/menu-progress/jitsplit/samples.json";
const samples = JSON.parse(readFileSync(file, "utf8"));

const num = (re, s) => {
  const m = re.exec(s || "");
  return m ? Number(m[1]) : null;
};

// Annotate each sample with parsed JIT facts.
const rows = samples.map((s) => {
  const h = s.helper || "";
  return {
    t: Number(s.elapsedSeconds) || 0,
    run: Number(s.jitBlockRunCount) || 0,
    compiled: Number(s.jitBlockCompileCount) || 0,
    jitOn: /(?:^|\s)jit:on\b/i.test(h),
    tier: (/(?:^|\s)tier:(\w+)/.exec(h) || [, "?"])[1],
    preAvg: num(/\bpre:(\d+)\/\d+/, h),
    preMax: num(/\bpre:\d+\/(\d+)/, h),
    hist: (() => {
      const m = /\bhist:(\d+),(\d+),(\d+),(\d+),(\d+)/.exec(h);
      return m ? m.slice(1, 6).map(Number) : null;
    })(),
    attempts: num(/\bjit attempts:(\d+)/, h),
    rawFps: num(/\braw:(\d+)/, h) || Number(s.presentationRawFps) || 0,
  };
});

// Steady state = JIT engaged AND block-run-rate has plateaued. Take the
// last 50% of samples that have jitOn and a growing run count.
const engaged = rows.filter((r) => r.jitOn && r.run > 0);
if (engaged.length < 4) {
  console.log("INSUFFICIENT engaged samples:", engaged.length, "of", rows.length);
  console.log("last sample:", JSON.stringify(rows.at(-1), null, 2));
  process.exit(0);
}
const tail = engaged.slice(Math.floor(engaged.length / 2));
const a = tail[0];
const b = tail.at(-1);

const dt = b.t - a.t;
const dRun = b.run - a.run;
const dCompiled = b.compiled - a.compiled;
const dispatchRate = dRun / dt; // dispatches / sec
const fps =
  tail.reduce((acc, r) => acc + (r.rawFps || 0), 0) / tail.length || 60;
const dispatchesPerFrame = dispatchRate / fps;

// Static avg block length (instructions admitted per compiled block). Use
// the last reading; it is cumulative-average so it is the steady-state mix.
const preAvg = b.preAvg ?? a.preAvg ?? 0;
const preMax = b.preMax ?? 0;
const hist = b.hist;

const impliedInstrPerFrame = dispatchesPerFrame * preAvg;
const impliedInstrPerSec = dispatchRate * preAvg;

// Gekko GC CPU ~486 MHz. Full-speed 60fps budget ~8.1M cycles/frame, but
// the guest does not retire 1 instr/cycle and we are not at native speed;
// this is only a sanity scale, not the verdict.
const GEKKO_HZ = 486_000_000;
const fullSpeedInstrPerFrame = GEKKO_HZ / 60;

// Per-dispatch fixed overhead model. Each dispatch = 1 indirect call thru
// fn-ptr + ppc_state arg + cached-interp dispatch-loop iter + (on
// end_block) pc/npc/downcount/perfmon update. Conservative host-op band.
const OVERHEAD_LO = 12;
const OVERHEAD_HI = 30;
// Approx WASM ops emitted per PPC instr in the block body (state-struct
// round-trips dominate w/o regalloc): conservative band.
const WASM_OPS_PER_PPC_LO = 4;
const WASM_OPS_PER_PPC_HI = 8;

const bodyOpsLo = preAvg * WASM_OPS_PER_PPC_LO;
const bodyOpsHi = preAvg * WASM_OPS_PER_PPC_HI;
const dispatchFracLo = OVERHEAD_LO / (OVERHEAD_LO + bodyOpsHi);
const dispatchFracHi = OVERHEAD_HI / (OVERHEAD_HI + bodyOpsLo);

const pct = (x) => (100 * x).toFixed(1) + "%";
const fmt = (x) => Number(x).toLocaleString("en-US", { maximumFractionDigits: 1 });

console.log("=== JIT dispatch-vs-block-body split (no rebuild) ===");
console.log("samples total/engaged/tail:", rows.length, engaged.length, tail.length);
console.log("window:", fmt(a.t), "->", fmt(b.t), "s  (dt=" + fmt(dt) + "s)");
console.log("tier:", b.tier, " jitOn:", b.jitOn);
console.log("rawFps (tail avg):", fmt(fps));
console.log("");
console.log("block_run delta:", fmt(dRun), " compiled delta:", fmt(dCompiled));
console.log("DISPATCH RATE:", fmt(dispatchRate), "WASM-block dispatches/sec");
console.log("DISPATCHES / FRAME:", fmt(dispatchesPerFrame));
console.log("");
console.log("avg compiled-block length (pre: avg):", preAvg, "PPC instr  (max", preMax + ")");
console.log("block-length histogram [<= buckets]:", hist ? hist.join(", ") : "n/a");
console.log("implied PPC instr/frame  =", fmt(impliedInstrPerFrame),
  " (" + pct(impliedInstrPerFrame / fullSpeedInstrPerFrame) + " of 486MHz/60 full-speed budget)");
console.log("implied PPC instr/sec    =", fmt(impliedInstrPerSec));
console.log("");
console.log("--- leverage estimate ---");
console.log("per-dispatch fixed overhead band:", OVERHEAD_LO + "-" + OVERHEAD_HI, "host ops");
console.log("block-body band:", fmt(bodyOpsLo) + "-" + fmt(bodyOpsHi),
  "WASM ops (" + preAvg + " PPC instr x " + WASM_OPS_PER_PPC_LO + "-" + WASM_OPS_PER_PPC_HI + ")");
console.log("=> dispatch overhead fraction:", pct(dispatchFracLo), "-", pct(dispatchFracHi),
  "of per-block work");
console.log("");
let verdict;
if (preAvg > 0 && preAvg <= 12 && dispatchFracHi > 0.20) {
  verdict =
    "BLOCK-LINKING is the bigger prize: short blocks (" + preAvg +
    " instr) re-enter the JS dispatcher ~" + fmt(dispatchesPerFrame) +
    "x/frame; dispatch overhead is " + pct(dispatchFracLo) + "-" +
    pct(dispatchFracHi) + " of per-block work. Direct block->block jumps " +
    "amortize that across the hot loop.";
} else if (preAvg >= 25) {
  verdict =
    "REGISTER ALLOCATION is the bigger prize: blocks are long (" + preAvg +
    " instr), so per-instruction state-struct round-trips inside the body " +
    "dominate; dispatch is only " + pct(dispatchFracLo) + "-" + pct(dispatchFracHi) + ".";
} else {
  verdict =
    "MIXED: blocks ~" + preAvg + " instr, dispatch " + pct(dispatchFracLo) +
    "-" + pct(dispatchFracHi) + ". Both levers help; prefer the lower-risk " +
    "(regalloc) first unless dispatches/frame is extreme.";
}
console.log("VERDICT:", verdict);
