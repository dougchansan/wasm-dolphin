import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workerUrl = new URL("../src/upstream-discio-worker.js", import.meta.url);

test("worker honors metrics=0 without disabling correctness and liveness signals", async () => {
  const source = await readFile(workerUrl, "utf8");

  assert.match(source, /collectMetrics = Boolean\(payload\.collectMetrics\)/);
  assert.match(source, /readDetailedCoreStat\("helperStats", api\?\.getPpcWasmHelperStats\)/);
  assert.match(source, /readDetailedCoreStat\("profileStats", api\?\.getPpcProfileStats\)/);
  assert.match(source, /if \(collectMetrics\) \{\s*frameProfileStats = formatProfileWindow/s);
  assert.match(source, /metricsDiagnosticsPayload\(\)/);
  assert.match(
    source,
    /api\.setSoftwareRasterProfileEnabled\?\.\(\s*collectMetrics && videoBackend === "Software Renderer" \? 1 : 0\s*\)/,
  );
  assert.match(source, /frameReuseTelemetryPayload\(frameReuseTelemetry, tickRepaintCount\)/);

  // These measurements remain active because presentation/JIT safety and
  // fixed-scene validation depend on them even when detailed metrics are off.
  assert.match(source, /const videoStats = api\.getVideoStats\?\.\(\)/);
  assert.match(source, /recordVisualFrameHash\(hashFrameBytes\(sourceFrameView\), true\)/);
  assert.match(source, /const loopStartedAt = performance\.now\(\)/);
});

test("headed fixed-save harness can run metrics-off overhead controls", async () => {
  const source = await readFile(
    new URL("../tools/menu-progress-validate.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /url\.searchParams\.set\("metrics", process\.env\.METRICS \?\? "1"\)/);
});

