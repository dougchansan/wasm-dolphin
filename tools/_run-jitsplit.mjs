// Robust env launcher for the JIT-split measurement run. The Bash tool's
// inline `VAR=val cmd` env prefix does NOT propagate in this environment
// (proved: `PORT=8082 node serve.mjs` still bound 8081). Set env + argv
// in-process, then dynamically import the validator so it reads them.
process.env.SAVE_STATE_URL = "/__battle.sav";
process.env.SAVE_STATE_AT = "35";
process.env.VIDEO = "software";
process.env.PRESENTER = "webgpu";
process.env.FORCEJIT = "1";
process.env.JITWARMUP = "700";
process.env.DURATION = "170";
process.env.BASE_URL = "http://127.0.0.1:8081/";

process.argv = [
  process.argv[0],
  new URL("./menu-progress-validate.mjs", import.meta.url).pathname,
  "--out-dir",
  ".omx/menu-progress/jitsplit",
];

await import("./menu-progress-validate.mjs");
