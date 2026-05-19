// §28bt verification — block re-dispatch OFF via kill-switch bit 15
// (?disable=32768). Same binary, same warm-battle config. Proves the gate
// isolates the change and gives the baseline-on-same-binary perf reference.
// Out: .omx/menu-progress/jitsplit-off2
process.env.SAVE_STATE_URL = "/__battle.sav";
process.env.SAVE_STATE_AT = "35";
process.env.VIDEO = "software";
process.env.PRESENTER = "webgpu";
process.env.FORCEJIT = "1";
process.env.JITWARMUP = "700";
process.env.DURATION = "170";
process.env.BASE_URL = "http://127.0.0.1:8081/";
process.env.DISABLE = "32768"; // DOLPHIN_WEB_DISABLE_BLOCK_REDISPATCH (1<<15)

process.argv = [
  process.argv[0],
  new URL("./menu-progress-validate.mjs", import.meta.url).pathname,
  "--out-dir",
  ".omx/menu-progress/jitsplit-off2",
];

await import("./menu-progress-validate.mjs");
