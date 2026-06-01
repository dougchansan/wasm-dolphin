// Comp-play match-length realism check — run 2 (repeatability).
process.env.ROM = process.env.ROM ||
  "F:/Emulation/super-smash-bros.-melee-usa-en-ja-rev-2.nkit_202203/Super Smash Bros. Melee (USA) (En,Ja) (Rev 2).nkit.iso";
process.env.SAVE_STATE_URL = "/__battle.sav";
process.env.SAVE_STATE_AT = "35";
process.env.VIDEO = "software";
process.env.PRESENTER = "webgpu";
process.env.FORCEJIT = "1";
process.env.JITWARMUP = "700";
process.env.DURATION = "660";
process.env.BASE_URL = "http://127.0.0.1:8081/";
delete process.env.DISABLE;
delete process.env.BLOCKMERGE;

process.argv = [
  process.argv[0],
  new URL("./menu-progress-validate.mjs", import.meta.url).pathname,
  "--out-dir",
  ".omx/menu-progress/longdur-shipped-02",
];
await import("./menu-progress-validate.mjs");
