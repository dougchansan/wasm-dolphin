// Attribute warm-state CPU samples to dispatch vs JIT'd block bodies.
//
//   node tools/cpu-profile-analyze.mjs .omx/cpu-profile/<stamp>
//
// Reads the .cpuprofile files written by cpu-profile-capture.mjs and reports
// where emulation CPU time actually goes. The decision this feeds: JIT block
// linking removes per-dispatch overhead, so the measured dispatch share is the
// hard ceiling on what that (HIGH-risk, per §28br) rewrite could win.
//
// How the split is derived — module identity, no naming convention needed:
//
//   block body : a JIT'd PPC block. Each is its own `new WebAssembly.Module`
//                built in DolphinWeb_CachedInterpreterCompileWasmBlock, so it
//                lands in its own tiny script with a distinct scriptId. Many
//                distinct scripts, each with few functions.
//   dispatch   : the cached-interpreter run loop, RunWasmBlock, and the JIT
//                helper callbacks. All inside the single large core module.
//   host       : JS/browser work — rendering, audio, GC, compile.
//
// Self time is what matters here, not total time: a block body called from the
// dispatch loop would otherwise be double-counted into dispatch.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node tools/cpu-profile-analyze.mjs <profile-dir>");
  process.exit(1);
}

const files = (await readdir(dir)).filter((f) => f.endsWith(".cpuprofile"));
if (files.length === 0) {
  console.error(`No .cpuprofile files in ${dir}`);
  process.exit(1);
}

let run = null;
try {
  run = JSON.parse(await readFile(path.join(dir, "run.json"), "utf8"));
} catch {}

const pct = (n, d) => (d === 0 ? "0.0" : ((n / d) * 100).toFixed(1));
const ms = (n) => (n / 1000).toFixed(1);

// A frame is WASM if V8 tagged it so. V8 reports wasm frames with a url of the
// owning script and function names like "wasm-function[N]" or, when a name
// section exists, the real symbol.
const isWasmFrame = (cf) =>
  /wasm/i.test(cf.url || "") ||
  /^wasm-function\[/.test(cf.functionName || "") ||
  (cf.codeType === "wasm");

for (const file of files) {
  const profile = JSON.parse(await readFile(path.join(dir, file), "utf8"));
  const { nodes, samples, timeDeltas } = profile;
  if (!samples?.length) continue;

  const byId = new Map(nodes.map((n) => [n.id, n]));

  // Self time per node from the sample stream.
  const selfTime = new Map();
  let total = 0;
  for (let i = 0; i < samples.length; i++) {
    const dt = timeDeltas[i] ?? 0;
    if (dt < 0) continue;
    total += dt;
    selfTime.set(samples[i], (selfTime.get(samples[i]) ?? 0) + dt);
  }
  if (total === 0) continue;

  // Group wasm self-time by script. The core module is simply the wasm script
  // with the most distinct functions and the most self time; JIT blocks are the
  // long tail of one-or-two-function scripts.
  const scripts = new Map();
  let hostTime = 0;
  let idleTime = 0;

  for (const [nodeId, time] of selfTime) {
    const node = byId.get(nodeId);
    if (!node) continue;
    const cf = node.callFrame || {};
    const name = cf.functionName || "";

    if (name === "(idle)" || name === "(program)") { idleTime += time; continue; }

    if (isWasmFrame(cf)) {
      const key = String(cf.scriptId ?? cf.url ?? "?");
      if (!scripts.has(key)) scripts.set(key, { time: 0, fns: new Set(), url: cf.url || "" });
      const s = scripts.get(key);
      s.time += time;
      s.fns.add(name);
    } else {
      hostTime += time;
    }
  }

  const wasmScripts = [...scripts.values()].sort((a, b) => b.time - a.time);
  const wasmTotal = wasmScripts.reduce((a, s) => a + s.time, 0);

  // The core module: highest self-time script that also holds many functions.
  // JIT block modules contain a single compiled block each.
  const core = wasmScripts.find((s) => s.fns.size > 4) ?? wasmScripts[0];
  const blockScripts = wasmScripts.filter((s) => s !== core);
  const dispatchTime = core?.time ?? 0;
  const blockTime = blockScripts.reduce((a, s) => a + s.time, 0);

  const active = total - idleTime;

  console.log(`\n${"=".repeat(72)}`);
  console.log(file);
  console.log("=".repeat(72));
  console.log(`samples ${samples.length}  wall ${ms(total)}ms  active ${ms(active)}ms  idle ${pct(idleTime, total)}%`);

  // A pthread parked in a futex wait shows as ~100% "active" in one function.
  // That is blocked time, not work — counting it as emulation would inflate
  // every ratio below it.
  const topShare = Math.max(0, ...[...selfTime.values()]) / (active || 1);
  const distinctFns = new Set(
    [...selfTime.keys()].map((id) => byId.get(id)?.callFrame?.functionName).filter(Boolean)
  ).size;
  if (topShare > 0.95 && distinctFns <= 3) {
    console.log(`\n  parked worker — ~${(topShare * 100).toFixed(0)}% in a single function (futex wait), not emulation work`);
    continue;
  }

  if (wasmTotal === 0) {
    console.log("\n  no wasm frames — not the emulation thread");
    continue;
  }

  console.log(`\n  WASM total          ${ms(wasmTotal).padStart(9)}ms  ${pct(wasmTotal, active).padStart(5)}% of active`);
  console.log(`    core module       ${ms(dispatchTime).padStart(9)}ms  ${pct(dispatchTime, wasmTotal).padStart(5)}% of wasm`);
  console.log(`    JIT block bodies  ${ms(blockTime).padStart(9)}ms  ${pct(blockTime, wasmTotal).padStart(5)}% of wasm   (${blockScripts.length} block modules)`);
  console.log(`  host / JS / GC      ${ms(hostTime).padStart(9)}ms  ${pct(hostTime, active).padStart(5)}% of active`);

  if (blockScripts.length === 0) {
    console.log(
      "\n  NOTE: no separate block modules seen. Either the JIT never engaged,\n" +
      "  or V8 merged them. Check `compiled:` in run.json preStats."
    );
  } else {
    console.log(`\n  >>> JIT'd block bodies are ${pct(blockTime, wasmTotal)}% of emulation WASM time.`);
    console.log(`      The other ${pct(dispatchTime, wasmTotal)}% is the core module, which is NOT`);
    console.log(`      the same thing as dispatch overhead. That bucket also contains the`);
    console.log(`      JIT helper callbacks (load/store/FP/system) that compiled blocks call`);
    console.log(`      out to, the cached-interpreter fallback for uncompiled blocks, the`);
    console.log(`      software rasterizer, audio and DVD. Separating those needs function`);
    console.log(`      names — the core .wasm currently ships without a name section, so V8`);
    console.log(`      reports bare wasm-function[N]. Do NOT read this as a block-linking`);
    console.log(`      ceiling until that breakdown exists.`);
  }

  // Top self-time frames, so the bucketing above stays auditable rather than
  // being taken on faith.
  const top = [...selfTime.entries()]
    .map(([id, t]) => ({ node: byId.get(id), t }))
    .filter((e) => e.node)
    .sort((a, b) => b.t - a.t)
    .slice(0, 15);

  console.log("\n  top self-time frames:");
  for (const { node, t } of top) {
    const cf = node.callFrame || {};
    const name = (cf.functionName || "(anon)").slice(0, 44);
    const where = isWasmFrame(cf) ? (cf.scriptId === core?.scriptId ? "wasm/core" : "wasm") : "js";
    console.log(`    ${pct(t, active).padStart(5)}%  ${where.padEnd(9)}  ${name}`);
  }
}

if (run) {
  console.log(`\n${"=".repeat(72)}`);
  console.log(`rom       ${run.rom}`);
  console.log(`warm      ${run.warm ? "yes — compile plateau reached" : "NO — treat as indicative only"}`);
  console.log(`helper    ${(run.preStats?.helper || "").slice(0, 160)}`);
  console.log(`speed     ${run.preStats?.speed} -> ${run.postStats?.speed}`);
}
