import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const vendorRoot = new URL("../vendor/dolphin/Source/Core/", import.meta.url);

test("correlated timing is metrics-gated and commits one coherent worst slice", async () => {
  const [profile, cachedInterpreter, coreTiming, dvdThread, videoInterface, snapshotPatch] =
    await Promise.all([
      readFile(new URL("Core/WasmTimingProfile.h", vendorRoot), "utf8"),
      readFile(new URL("Core/PowerPC/CachedInterpreter/CachedInterpreter.cpp", vendorRoot), "utf8"),
      readFile(new URL("Core/CoreTiming.cpp", vendorRoot), "utf8"),
      readFile(new URL("Core/HW/DVD/DVDThread.cpp", vendorRoot), "utf8"),
      readFile(new URL("Core/HW/VideoInterface.cpp", vendorRoot), "utf8"),
      readFile(
        new URL(
          "../patches/dolphin-wasm/snapshot/0014-correlated-core-timing-profile.patch",
          import.meta.url
        ),
        "utf8"
      )
    ]);

  assert.match(profile, /inline thread_local CurrentSlice s_current_slice/);
  assert.match(profile, /inline std::atomic<bool> s_enabled/);
  assert.match(profile, /RecordCoreTimingEvent[\s\S]*?EventKind::VICallback/);
  assert.match(profile, /nested_wait_us[\s\S]*?elapsed_us - nested_wait_us/);
  assert.match(profile, /sequence\.fetch_add\(1, std::memory_order_acq_rel\)/);
  assert.match(profile, /WorstSlice CaptureWorstSlice\(\)/);

  assert.match(cachedInterpreter, /SetPpcProfileEnabled[\s\S]*?WasmTimingProfile::SetEnabled/);
  assert.match(cachedInterpreter, /const bool _profile_slice = .*BeginSlice\(\)/);
  assert.match(cachedInterpreter, /if \(_profile_slice\)[\s\S]*?FinishSlice/);
  assert.match(
    cachedInterpreter,
    /sliceprof:total=[\s\S]*?,advance=[\s\S]*?,execute=[\s\S]*?,compile=[\s\S]*?,throttle=[\s\S]*?,dvd=[\s\S]*?,video=[\s\S]*?,event=/
  );

  assert.match(coreTiming, /profile_event = .*IsSliceActive\(\)/);
  assert.match(coreTiming, /RecordCoreTimingEvent\(name, callback_us, wait_us_at_start\)/);
  assert.match(coreTiming, /RecordThrottleWaitUs/);
  assert.match(dvdThread, /WaitForData\(\);[\s\S]*?RecordDvdWaitUs/);
  assert.match(videoInterface, /const bool _vi_profile = .*IsSliceActive\(\)/);

  for (const path of [
    "Source/Core/Core/WasmTimingProfile.h",
    "Source/Core/Core/CoreTiming.cpp",
    "Source/Core/Core/HW/DVD/DVDThread.cpp",
    "Source/Core/Core/HW/VideoInterface.cpp",
    "Source/Core/Core/PowerPC/CachedInterpreter/CachedInterpreter.cpp"
  ]) {
    assert.match(snapshotPatch, new RegExp(`diff --git a/${path.replaceAll("/", "\\/")}`));
  }
});
