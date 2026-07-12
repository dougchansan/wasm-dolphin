import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPerfScenarioUrl,
  buildVisibleHarnessUrl,
} from "../tools/benchmark-url.mjs";

test("visible harness removes an inherited intentional-blank probe", () => {
  const { url, removedProbe } = buildVisibleHarnessUrl(
    "http://localhost:8130/?coreid=sha256%3Aabc&wgpurenderprobe=null-drain"
  );

  assert.equal(removedProbe, "null-drain");
  assert.equal(url.searchParams.get("wgpurenderprobe"), null);
  assert.equal(url.searchParams.get("coreid"), "sha256:abc");
});

test("perf scenarios reject blank probes inherited from BASE_URL", () => {
  assert.throws(
    () => buildPerfScenarioUrl(
      "http://localhost:8130/?wgpurenderprobe=null-drain",
      { video: "wgpu" }
    ),
    /BASE_URL.*wgpurenderprobe=null-drain/
  );
});

test("perf scenarios retain explicitly configured intentional-blank probes", () => {
  const { url, uploadProbeMode } = buildPerfScenarioUrl(
    "http://localhost:8130/?coreid=sha256%3Aabc",
    { video: "wgpu", wgpurenderprobe: "null-drain" }
  );

  assert.equal(url.searchParams.get("wgpurenderprobe"), "null-drain");
  assert.equal(uploadProbeMode, true);
});

test("ordinary perf scenarios remain visible", () => {
  const { url, uploadProbeMode } = buildPerfScenarioUrl(
    "http://localhost:8130/?coreid=sha256%3Aabc",
    { video: "wgpu" }
  );

  assert.equal(url.searchParams.get("wgpurenderprobe"), null);
  assert.equal(uploadProbeMode, false);
});
