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
  assert.match(header, /TEXTURE_CASE_CAPACITY = 256/);
  assert.match(header, /TEV_CASE_CAPACITY = 256/);
  assert.match(header, /struct SharedCaseTable/);
  assert.match(header, /inline void RecordCase/);
  assert.match(header, /other_samples/);
  assert.match(header, /collision_count/);
  assert.match(header, /ShouldRecordCase/);
  assert.match(header, /s_case_sample_seed/);
  assert.match(header, /AdvanceCaseSampleRng/);
  assert.match(header, /AvoidTimedSampleCall/);
  assert.match(header, /0x54455631u : 0x54455831u/);
  assert.match(header, /snapshot\.case_sample_seed/);
  assert.match(header, /PackTextureCaseKey/);
  assert.match(header, /PackTevStructuralKey/);
  assert.match(header, /AppendTevProgramWord/);
  assert.match(header, /RecordFifoBurst/);
  assert.match(header, /RecordFifoConsume/);
  assert.match(header, /fifo_consume_count & 1023/);
  assert.match(header, /RecordFifoDistanceUnderflow/);
  assert.match(header, /PublishGeneratedFrame/);
});

test("applied software sources keep the measured CMPR specialization exact", async () => {
  const [texture, hotCase, tev, bridge, hotPatch, parityHarness] = await Promise.all([
    readFile(
      new URL(
        "../vendor/dolphin/Source/Core/VideoBackends/Software/TextureSampler.cpp",
        import.meta.url
      ),
      "utf8"
    ),
    readFile(
      new URL(
        "../vendor/dolphin/Source/Core/VideoBackends/Software/TextureSamplerHotCase.h",
        import.meta.url
      ),
      "utf8"
    ),
    readFile(
      new URL("../vendor/dolphin/Source/Core/VideoBackends/Software/Tev.cpp", import.meta.url),
      "utf8"
    ),
    readFile(new URL("../core/upstream/dolphin_web_discio.cpp", import.meta.url), "utf8"),
    readFile(
      new URL(
        "../patches/dolphin-wasm/snapshot/0016-software-texture-hot-case.patch",
        import.meta.url
      ),
      "utf8"
    ),
    readFile(new URL("../tools/software-texture-hot-case-parity.cpp", import.meta.url), "utf8"),
  ]);
  assert.match(texture, /profile_scope\.ShouldRecordCase\(\)/);
  assert.match(texture, /PackTextureCaseKey/);
  assert.match(texture, /RecordTextureCase/);
  assert.match(texture, /decode_work = \(linear \? 4u : 1u\) \* \(mipLinear \? 2u : 1u\)/);
  assert.match(tev, /profile_scope\.ShouldRecordCase\(\)/);
  assert.match(tev, /TEV_PROGRAM_FINGERPRINT_SEED/);
  assert.match(tev, /PackTevStructuralKey/);
  assert.match(tev, /RecordTevCase/);
  assert.match(bridge, /texcase:/);
  assert.match(bridge, /tevcase:/);
  assert.match(bridge, /caseseed:/);
  for (const exactPredicate of [
    /mip == 0 && linear && texfmt == TextureFormat::CMPR/,
    /tm0\.mipmap_filter == MipMode::None/,
    /tm0\.min_filter == FilterMode::Linear/,
    /tm0\.mag_filter == FilterMode::Linear/,
    /tm0\.wrap_s == WrapMode::Repeat/,
    /tm0\.wrap_t == WrapMode::Repeat/,
    /!texUnit\.texImage1\.cache_manually_managed/,
    /tlutfmt == TLUTFormat::RGB565 \|\| tlutfmt == TLUTFormat::RGB5A3/,
    /IsPowerOfTwo\(static_cast<u32>\(image_width_minus_1 \+ 1\)\)/,
    /IsPowerOfTwo\(static_cast<u32>\(image_height_minus_1 \+ 1\)\)/,
  ]) {
    assert.match(texture, exactPredicate);
  }
  assert.match(hotCase, /SampleCmprLinearRepeatPow2/);
  assert.match(hotCase, /Common::SafeSpanRead<DXTBlock>/);
  assert.match(hotCase, /std::array<DecodedCmprBlock, 4>/);
  assert.match(hotPatch, /keys 0xd38a01e and 0xd34a01e/);
  assert.match(parityHarness, /TexDecoder_DecodeTexel/);
  assert.match(parityHarness, /TLUTFormat::RGB565/);
  assert.match(parityHarness, /TLUTFormat::RGB5A3/);
  assert.doesNotMatch(tev, /swtevfast|SampleNearestBaseMip/);
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
