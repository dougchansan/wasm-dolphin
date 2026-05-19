// §28bt verification — block re-dispatch ON (default path). Warm battle,
// locked product config. In-process env/argv (Bash inline VAR= doesn't
// propagate here). Out: .omx/menu-progress/jitsplit-on2
process.env.SAVE_STATE_URL = "/__battle.sav";
process.env.SAVE_STATE_AT = "35";
process.env.VIDEO = "software";
process.env.PRESENTER = "webgpu";
process.env.FORCEJIT = "1";
process.env.JITWARMUP = "700";
process.env.DURATION = "170";
process.env.BASE_URL = "http://127.0.0.1:8081/";
delete process.env.DISABLE; // redispatch ENABLED (default)

process.argv = [
  process.argv[0],
  new URL("./menu-progress-validate.mjs", import.meta.url).pathname,
  "--out-dir",
  ".omx/menu-progress/jitsplit-on2",
];

await import("./menu-progress-validate.mjs");
