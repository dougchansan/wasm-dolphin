// §28bt cold-boot SAFE-DEFAULT verification: no params => block re-dispatch
// defaults OFF (the new core-host.js mitigation). Confirms a cold launch
// boot -> save-prompt -> intro cutscene -> menu progresses cleanly (baseline
// behavior). Out: .omx/menu-progress/cold-off
process.env.VIDEO = "software";
process.env.PRESENTER = "webgpu";
process.env.FORCEJIT = "1";
process.env.JITWARMUP = "700";
process.env.DURATION = "200";
process.env.BASE_URL = "http://127.0.0.1:8081/";
delete process.env.SAVE_STATE_URL;
delete process.env.DISABLE;
delete process.env.REDISPATCH; // default => redispatch OFF (safe)

process.argv = [
  process.argv[0],
  new URL("./menu-progress-validate.mjs", import.meta.url).pathname,
  "--out-dir",
  ".omx/menu-progress/cold-off",
];

await import("./menu-progress-validate.mjs");
