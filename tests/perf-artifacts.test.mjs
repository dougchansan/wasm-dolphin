import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FIXED_MELEE_BATTLE_FIXTURE,
  assertRunProvenance,
  buildComparisonTasklist,
  buildReplacementBlock,
  parseProfileMetrics,
  recordsToCsv,
  summarizeComparison,
  summarizeNumeric,
  verifyFileFixture,
} from "../tools/perf-artifacts.mjs";

test("profile parser separates core, XFB, publish, and JS presentation costs", () => {
  const helper =
    "video xfb:10 coreprof xfb_dt:16.7 avg:17.1 max:41.2 decode:1.3 avg:1.4 max:2.8 " +
    "vo_sync:0.1/max4.2 vo_pub:1.5/max3.1 vo_total:1.6/max5.0 " +
    "swxfb:0.9 conv:0.8 copy:0.1 sz:640x480->480 | jit:on";
  const frame =
    "loop:0.35 pump:0.02 run:0.10 api:0.03 cap:0.50 copy:0.40 " +
    "present:1.90 draw:1.20 hash:0.08 paced:0.04 copy:73.2MB/s cap:30 shown:29";

  assert.deepEqual(parseProfileMetrics(helper, frame), {
    coreXfbIntervalMs: 16.7,
    coreXfbAverageIntervalMs: 17.1,
    coreXfbMaxIntervalMs: 41.2,
    coreXfbDecodeMs: 1.3,
    coreXfbAverageDecodeMs: 1.4,
    coreXfbMaxDecodeMs: 2.8,
    videoOutputSyncMs: 0.1,
    videoOutputMaxSyncMs: 4.2,
    videoOutputPublishMs: 1.5,
    videoOutputMaxPublishMs: 3.1,
    videoOutputTotalMs: 1.6,
    videoOutputMaxTotalMs: 5,
    softwareXfbTotalMs: 0.9,
    softwareXfbConvertMs: 0.8,
    softwareXfbCopyMs: 0.1,
    jsLoopMs: 0.35,
    jsPumpMs: 0.02,
    jsRunMs: 0.1,
    jsApiMs: 0.03,
    jsCaptureMs: 0.5,
    jsCopyMs: 0.4,
    jsPresentMs: 1.9,
    jsDrawMs: 1.2,
    jsHashMs: 0.08,
    jsPacedMs: 0.04,
    jsCopyMegabytesPerSecond: 73.2,
    jsCaptureCount: 30,
    jsPresentCount: 29,
  });
});

test("profile parser uses nulls when a backend does not emit a profile", () => {
  const parsed = parseProfileMetrics("jit:warmup", "-");
  assert.equal(parsed.coreXfbIntervalMs, null);
  assert.equal(parsed.softwareXfbTotalMs, null);
  assert.equal(parsed.jsPresentMs, null);
});

test("CSV output preserves arrays, commas, quotes, and newlines", () => {
  const csv = recordsToCsv([
    { run: 1, note: 'hello, "GPU"', histogram: [1, 2] },
    { run: 2, note: "line1\nline2", histogram: null },
  ]);
  assert.equal(
    csv,
    'run,note,histogram\n1,"hello, ""GPU""","[1,2]"\n2,"line1\nline2",\n'
  );
});

test("fixture verification rejects missing and hash-mismatched files", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wasm-dolphin-fixture-"));
  const fixturePath = path.join(directory, "fixture.sav");
  try {
    await assert.rejects(
      verifyFileFixture(fixturePath, { label: "battle save", expectedSha256: "0".repeat(64) }),
      /Missing battle save/
    );
    await writeFile(fixturePath, "Kirby versus Link");
    await assert.rejects(
      verifyFileFixture(fixturePath, { label: "battle save", expectedSha256: "0".repeat(64) }),
      /SHA-256 mismatch/
    );
    const expectedSha256 = createHash("sha256").update("Kirby versus Link").digest("hex");
    const verified = await verifyFileFixture(fixturePath, { label: "battle save", expectedSha256 });
    assert.equal(verified.verified, true);
    assert.equal(verified.sha256, expectedSha256);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fixed-battle provenance rejects missing fields and premature timing", () => {
  const manifest = validManifest();
  delete manifest.artifacts.core.sha256;
  assert.throws(() => assertRunProvenance(manifest), /artifacts\.core\.sha256/);

  const premature = validManifest();
  premature.benchmark.saveStateAt = 1;
  assert.throws(() => assertRunProvenance(premature), /saveStateAt=0/);

  const menuDriven = validManifest();
  menuDriven.benchmark.inputScriptMode = "scripted";
  assert.throws(() => assertRunProvenance(menuDriven), /inputScriptMode=none/);

  const wrongScene = validManifest();
  wrongScene.benchmark.sceneLabel = "character select";
  assert.throws(() => assertRunProvenance(wrongScene), /Unexpected benchmark scene/);

  assert.equal(assertRunProvenance(validManifest()).fixture.saveStateLoaded, true);
});

test("comparison tasklist alternates complete four-run blocks and is bounded", () => {
  const config = comparisonConfig({ mode: "screening", blockCount: 2 });
  const tasklist = buildComparisonTasklist(config);
  assert.deepEqual(tasklist.blocks.map((block) => block.order), [
    ["A", "B", "B", "A"],
    ["B", "A", "A", "B"],
  ]);
  assert.equal(tasklist.blocks.flatMap((block) => block.runs).length, 8);
  assert.equal(tasklist.maxInvalidBlocks, 0);
  assert.throws(
    () => buildComparisonTasklist(comparisonConfig({ mode: "screening", blockCount: 3 })),
    /exactly 2/
  );
  assert.throws(
    () => buildComparisonTasklist(comparisonConfig({ mode: "confirmation", blockCount: 11 })),
    /5 to 10/
  );
});

test("replacement blocks preserve the complete invalid block order", () => {
  const config = comparisonConfig({ mode: "confirmation", blockCount: 5 });
  const invalid = buildComparisonTasklist(config).blocks[0];
  const replacement = buildReplacementBlock(config, invalid);
  assert.deepEqual(replacement.order, invalid.order);
  assert.equal(replacement.replaces, invalid.blockId);
  assert.equal(replacement.runs.length, 4);
  assert.ok(replacement.runs.every((run) => run.blockId === replacement.blockId));
});

test("screening block effects are sign-normalized but never promotable", () => {
  const config = comparisonConfig({ mode: "screening", blockCount: 2 });
  const runs = makeRuns(config, [
    { a: [100, 102], b: [110, 112] },
    { a: [101, 103], b: [111, 113] },
  ]);
  const report = summarizeComparison(config, runs);
  assert.equal(report.validBlockCount, 2);
  assert.equal(report.outcome, "SCREENING_SIGNAL");
  assert.equal(report.promotable, false);
  assert.ok(report.medianEffectPercent > 8);

  const lowerIsBetter = { ...config, direction: "lower" };
  const lowerReport = summarizeComparison(lowerIsBetter, makeRuns(lowerIsBetter, [
    { a: [20, 20], b: [10, 10] },
    { a: [22, 22], b: [11, 11] },
  ]));
  assert.ok(lowerReport.medianEffectPercent > 0);
});

test("confirmation uses block effects for pass and ten-block INCONCLUSIVE outcomes", () => {
  const passing = comparisonConfig({ mode: "confirmation", blockCount: 5 });
  const passReport = summarizeComparison(
    passing,
    makeRuns(passing, Array.from({ length: 5 }, (_, index) => ({
      a: [100 + index, 100 + index],
      b: [108 + index, 108 + index],
    })))
  );
  assert.equal(passReport.outcome, "STATISTICAL_GATE_PASS");
  assert.equal(passReport.promotable, true);
  assert.ok(passReport.interval95.low > 0);

  const unresolved = comparisonConfig({ mode: "confirmation", blockCount: 10 });
  const unresolvedReport = summarizeComparison(
    unresolved,
    makeRuns(unresolved, Array.from({ length: 10 }, (_, index) => ({
      a: [100, 100],
      b: index % 2 === 0 ? [102, 102] : [98, 98],
    })))
  );
  assert.equal(unresolvedReport.outcome, "INCONCLUSIVE");
  assert.equal(unresolvedReport.promotable, false);
  assert.ok(unresolvedReport.interval95.low <= 0);
  assert.ok(unresolvedReport.interval95.high >= 0);
});

test("one invalid run invalidates its whole block and trips the screening stop", () => {
  const config = comparisonConfig({ mode: "screening", blockCount: 2 });
  const runs = makeRuns(config, [
    { a: [100, 100], b: [104, 104] },
    { a: [100, 100], b: [104, 104] },
  ]);
  runs[1].valid = false;
  runs[1].invalidReasons = ["browser crashed"];
  const report = summarizeComparison(config, runs);
  assert.equal(report.invalidBlockCount, 1);
  assert.equal(report.validBlockCount, 1);
  assert.equal(report.outcome, "INFRASTRUCTURE_INCONCLUSIVE");
});

test("numeric summaries retain the full run distribution", () => {
  assert.deepEqual(summarizeNumeric([1, 2, 3, 4, "bad"]), {
    count: 4,
    min: 1,
    mean: 2.5,
    p50: 2.5,
    p95: 3.8499999999999996,
    p99: 3.9699999999999998,
    max: 4,
  });
});

function validManifest() {
  return {
    git: { commit: "abc123" },
    browser: { version: "143.0" },
    benchmark: {
      url: "http://127.0.0.1:8082/?video=software",
      sceneLabel: FIXED_MELEE_BATTLE_FIXTURE.sceneLabel,
      saveStateAt: 0,
      inputScriptMode: "none",
    },
    artifacts: {
      rom: { sha256: FIXED_MELEE_BATTLE_FIXTURE.isoSha256 },
      core: { sha256: "1".repeat(64) },
      saveState: { sha256: FIXED_MELEE_BATTLE_FIXTURE.saveStateSha256 },
    },
    fixture: { isoVerified: true, saveStateVerified: true, saveStateLoaded: true },
  };
}

function comparisonConfig(overrides = {}) {
  return {
    mode: "screening",
    blockCount: 2,
    primaryMetric: "metrics.gameSpeed.mean",
    direction: "higher",
    minimumEffectPercent: 3,
    hypothesis: "Candidate improves game speed.",
    armA: { name: "baseline", params: { fastsw: 1 } },
    armB: { name: "candidate", params: { fastsw: 2 } },
    ...overrides,
  };
}

function makeRuns(config, valuesByBlock) {
  const tasklist = buildComparisonTasklist(config);
  return tasklist.blocks.flatMap((block, blockIndex) => {
    const values = valuesByBlock[blockIndex];
    const next = { A: [...values.a], B: [...values.b] };
    return block.runs.map((task) => ({
      ...task,
      valid: true,
      invalidReasons: [],
      metrics: { gameSpeed: { mean: next[task.arm].shift() } },
    }));
  });
}
