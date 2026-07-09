// §28bt cold-boot BUG-REPRO: ?redispatch=1 opt-in re-enables block
// re-dispatch on a cold launch (NO savestate). Tests whether re-dispatch ON
// stalls at the intro cutscene (the user-reported regression) while the
// safe default (cold-off) progresses. Out: .omx/menu-progress/cold-on
process.env.VIDEO = "software";
process.env.PRESENTER = "webgpu";
process.env.FORCEJIT = "1";
process.env.JITWARMUP = "700";
process.env.DURATION = "200";
process.env.BASE_URL = "http://127.0.0.1:8081/";
process.env.REDISPATCH = "1"; // opt-in: re-dispatch ON (reproduce the bug)
delete process.env.SAVE_STATE_URL;
delete process.env.DISABLE;

process.argv = [
  process.argv[0],
  new URL("./menu-progress-validate.mjs", import.meta.url).pathname,
  "--out-dir",
  ".omx/menu-progress/cold-on",
];

await import("./menu-progress-validate.mjs");
