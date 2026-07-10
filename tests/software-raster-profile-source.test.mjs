import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("software raster profiling is metrics-gated and explicitly sampled", async () => {
  const header = await readFile(
    new URL("../core/upstream/dolphin_web_raster_profile.h", import.meta.url),
    "utf8"
  );
  assert.match(header, /inline void SetEnabled\(bool enabled\)/);
  assert.match(header, /s_profile_state/);
  assert.match(header, /EnsureLocalEpoch/);
  assert.match(header, /phase == Phase::RasterTraversal \? 63 : 4095/);
  assert.match(header, /duration_cast<std::chrono::nanoseconds>/);
  assert.match(header, /timed_samples/);
  assert.match(header, /sampled_total_us/);
  assert.match(header, /RecordFifoBurst/);
  assert.match(header, /RecordFifoConsume/);
  assert.match(header, /fifo_consume_count & 1023/);
  assert.match(header, /RecordFifoDistanceUnderflow/);
  assert.match(header, /PublishGeneratedFrame/);
});

test("the locked Dolphin patch reaches each measured phase without changing render output", async () => {
  const patch = await readFile(
    new URL(
      "../patches/dolphin-wasm/snapshot/0009-software-raster-phase-profile.patch",
      import.meta.url
    ),
    "utf8"
  );
  for (const marker of [
    "Phase::RasterTraversal",
    "RecordRasterCandidatePixel",
    "Phase::TevPixel",
    "RecordTevStages",
    "Phase::TextureSample",
    "RecordFifoBurst",
    "RecordFifoConsume",
    "RecordFifoDistanceUnderflow",
  ]) {
    assert.match(patch, new RegExp(marker.replaceAll("::", "::")));
  }
  assert.doesNotMatch(patch, /fast_software_raster\s*[=+\-]/);
});

test("the parity-built core exports the software raster profiler", async () => {
  const [bridge, manifest] = await Promise.all([
    readFile(new URL("../core/upstream/dolphin_web_discio.cpp", import.meta.url), "utf8"),
    readFile(new URL("../provenance/dolphin-core-abi-v1.json", import.meta.url), "utf8").then(JSON.parse),
  ]);
  assert.match(bridge, /EMSCRIPTEN_KEEPALIVE\s*\n#endif\s*\nint SetSoftwareRasterProfileEnabled/);
  assert.match(bridge, /RasterProfileStats\(\)/);
  assert.match(
    bridge,
    /void DolphinWeb_RecordVideoOutputProfile[\s\S]*?RasterProfile::PublishGeneratedFrame\(\)/,
  );
  assert.deepEqual(manifest.sourceOnlyExportsPendingRebuild, []);
  assert.ok(manifest.moduleExports.includes("_SetSoftwareRasterProfileEnabled"));
});
