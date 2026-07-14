// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildComparisonTasklist, validateComparisonConfig } from "../tools/perf-artifacts.mjs";
import { validateWgpuUboScreening } from "../tools/validate-wgpu-ubo-screening.mjs";

const configPath = path.resolve("docs/perf-results/wgpu-ubo-screening.json");

test("WGPU UBO validator accepts two complete balanced blocks", async (t) => {
  const fixture = await makeFixture(t);
  const result = await validateWgpuUboScreening({ outDir: fixture.root, configPath });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.equal(result.runCount, 8);
  assert.deepEqual(result.expectedOrder.map((block) => block.order), ["ABBA", "BAAB"]);
  assert.equal(result.manualChecks.length, 8);
});

test("WGPU UBO validator rejects cache-off hits", async (t) => {
  const fixture = await makeFixture(t);
  const run = fixture.tasks.find((task) => task.params.wgpuubocache === "0");
  const summaryPath = path.join(fixture.root, run.runId, "summary.json");
  const summary = JSON.parse(await readFile(summaryPath, "utf8"));
  summary.final.causalTelemetry.webgpu.producerUboCacheHits = [1, 0, 0];
  summary.final.causalTelemetry.webgpu.producerUboUploadCallsSuppressed = [1, 0, 0];
  summary.final.helper = helperStats(false, [0, 0, 0], [1, 0, 0]);
  await writeFile(summaryPath, JSON.stringify(summary));
  const samplesPath = path.join(fixture.root, run.runId, "samples.json");
  const samples = JSON.parse(await readFile(samplesPath, "utf8"));
  samples.at(-1).causalTelemetry = summary.final.causalTelemetry;
  samples.at(-1).helper = summary.final.helper;
  await writeFile(samplesPath, JSON.stringify(samples));

  const result = await validateWgpuUboScreening({ outDir: fixture.root, configPath });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.runId === run.runId && issue.code === "UBO_CACHE_OFF_HIT"));
});

test("WGPU UBO validator accepts a fresh helper snapshot ahead of causal telemetry", async (t) => {
  const fixture = await makeFixture(t);
  const run = fixture.tasks.find((task) => task.params.wgpuubocache === "1");
  const summaryPath = path.join(fixture.root, run.runId, "summary.json");
  const summary = JSON.parse(await readFile(summaryPath, "utf8"));
  summary.final.helper = helperStats(true, [12, 22, 32], [6, 11, 16]);
  await writeFile(summaryPath, JSON.stringify(summary));

  const result = await validateWgpuUboScreening({ outDir: fixture.root, configPath });
  assert.equal(result.ok, true);
});

test("WGPU UBO validator rejects a helper snapshot behind causal telemetry", async (t) => {
  const fixture = await makeFixture(t);
  const run = fixture.tasks.find((task) => task.params.wgpuubocache === "1");
  const summaryPath = path.join(fixture.root, run.runId, "summary.json");
  const summary = JSON.parse(await readFile(summaryPath, "utf8"));
  summary.final.helper = helperStats(true, [9, 20, 30], [5, 10, 15]);
  await writeFile(summaryPath, JSON.stringify(summary));

  const result = await validateWgpuUboScreening({ outDir: fixture.root, configPath });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some(
    (issue) => issue.runId === run.runId && issue.code === "UBO_COUNTER_REGRESSION"
  ));
});

test("WGPU UBO validator rejects zero-color presentation readback", async (t) => {
  const fixture = await makeFixture(t);
  const run = fixture.tasks[0];
  const manifestPath = path.join(fixture.root, run.runId, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const backbuffer = manifest.renderer.wgpuReplayClassifier.stages.presentationChain.backbuffer;
  backbuffer.nonzeroColorReadbackCount = 0;
  backbuffer.lastNonzeroColorBytes = 0;
  await writeFile(manifestPath, JSON.stringify(manifest));

  const result = await validateWgpuUboScreening({ outDir: fixture.root, configPath });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.runId === run.runId && issue.code === "RGB_READBACK_ZERO"));
});

test("WGPU UBO validator accepts causal hardware cadence without the legacy classifier", async (t) => {
  const fixture = await makeFixture(t);
  for (const run of fixture.tasks) {
    await editJson(path.join(fixture.root, run.runId, "manifest.json"), (manifest) => {
      delete manifest.renderer.wgpuReplayClassifier;
    });
    await editJson(path.join(fixture.root, run.runId, "summary.json"), (summary) => {
      summary.final.causalTelemetry.webgpu.visualCadence = {
        schema: "wasm-dolphin.wgpu-visual-cadence.v1",
        enabled: true,
        source: "wgpu-downsample-readback",
        completedSampleCount: 120,
        changedSampleCount: 100,
        latestHash: 0x1234abcd,
        encodeErrorCount: 0,
        mapErrorCount: 0,
      };
      summary.final.causalTelemetry.webgpu.uploadAttribution = {
        passAssociation: {
          abortedPassCount: 0,
          incompletePassCount: 0,
          currentPassOpen: false,
        },
      };
    });
  }
  const result = await validateWgpuUboScreening({ outDir: fixture.root, configPath });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
});

test("WGPU UBO validator rejects incomplete timed samples", async (t) => {
  const fixture = await makeFixture(t);
  const run = fixture.tasks[0];
  const samplesPath = path.join(fixture.root, run.runId, "samples.json");
  const samples = JSON.parse(await readFile(samplesPath, "utf8"));
  samples.splice(1);
  await writeFile(samplesPath, JSON.stringify(samples));

  const result = await validateWgpuUboScreening({ outDir: fixture.root, configPath });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.runId === run.runId && issue.code === "SAMPLE_COUNT"));
});

test("WGPU UBO validator rejects a fixed-work target that was not reached", async (t) => {
  const fixture = await makeFixture(t);
  const run = fixture.tasks[0];
  const summaryPath = path.join(fixture.root, run.runId, "summary.json");
  const manifestPath = path.join(fixture.root, run.runId, "manifest.json");
  const summary = JSON.parse(await readFile(summaryPath, "utf8"));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  summary.metrics.fixedEmulatedWork.reachedTarget = false;
  summary.fixedEmulatedWork.reachedTarget = false;
  manifest.benchmark.fixedEmulatedWork.reachedTarget = false;
  await Promise.all([
    writeFile(summaryPath, JSON.stringify(summary)),
    writeFile(manifestPath, JSON.stringify(manifest)),
  ]);

  const result = await validateWgpuUboScreening({ outDir: fixture.root, configPath });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some(
    (issue) => issue.runId === run.runId && issue.code === "FIXED_WORK_NOT_REACHED"
  ));
});

async function makeFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wgpu-ubo-validator-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = validateComparisonConfig(JSON.parse(await readFile(configPath, "utf8")));
  const tasklist = buildComparisonTasklist(config);
  const tasks = tasklist.blocks.flatMap((block) => block.runs);
  for (const block of tasklist.blocks) {
    block.status = "complete";
    for (const run of block.runs) run.status = "complete";
  }
  const results = [];
  for (const task of tasks) {
    const runDir = path.join(root, task.runId);
    await mkdir(runDir, { recursive: true });
    const enabled = task.params.wgpuubocache === "1";
    const lookups = enabled ? [10, 20, 30] : [0, 0, 0];
    const hits = enabled ? [5, 10, 15] : [0, 0, 0];
    const causalTelemetry = makeCausalTelemetry(enabled, lookups, hits);
    const fixedEmulatedWork = {
      enabled: true,
      targetCoreSeconds: 2,
      targetCoreTicks: 972_000_000,
      coreTicksPerSecond: 486_000_000,
      wallTimeCapSeconds: 2,
      pollIntervalMs: 100,
      baselineCoreTicks: 1_000_000,
      baselineFrame: 100,
      actualCoreTickDelta: 972_000_000,
      actualFrameDelta: 2,
      elapsedWallSeconds: 2,
      reachedTarget: true,
      throughputGameSpeedPercent: 100,
      throughputCoreFps: 1,
      deltasValid: true,
    };
    const samples = [0, 1, 2].map((elapsedSeconds, index) => ({
      elapsedSeconds,
      frame: 100 + index,
      coreTicks: 1_000_000 + index * 486_000_000,
      coreFps: index === 0 ? null : 60,
      gameSpeed: index === 0 ? null : 100,
      presentFps: 60,
      visualFps: 60,
      visibleHash: 100 + index,
      visibleError: "",
      visibleChanged: index > 0,
      helper: helperStats(enabled, lookups, hits),
      causalTelemetry,
    }));
    const url = new URL("https://example.invalid/");
    for (const [key, value] of Object.entries(task.params)) url.searchParams.set(key, value);
    url.searchParams.set("nojitcache", "1");
    const summary = {
      name: task.runId,
      runId: task.runId,
      blockId: task.blockId,
      arm: task.arm,
      armName: task.armName,
      valid: true,
      invalidReasons: [],
      failures: [],
      url: url.href,
      sampleCount: samples.length,
      timedWindow: { sampleCount: samples.length },
      metrics: {
        fullTimedWindow: {
          gameSpeed: { count: 2, mean: 100 },
          coreFps: { count: 2, mean: 60 },
          presentationFps: { count: 3, mean: 60 },
          visualFps: { count: 3, mean: 60 },
        },
        fixedEmulatedWork,
      },
      fixedEmulatedWork,
      final: samples.at(-1),
    };
    const manifest = {
      experiment: task,
      fixture: {
        isoVerified: true,
        saveStateVerified: true,
        saveStateLoaded: true,
        battleCheckpoint: { verified: true },
      },
      benchmark: {
        timingStartsAfterVerifiedLoad: true,
        inputScriptMode: "none",
        fixedEmulatedWork,
      },
      renderer: makeRenderer(),
      qualification: { eligible: true },
      result: { valid: true, screenshotFile: "final.png" },
    };
    await Promise.all([
      writeFile(path.join(runDir, "manifest.json"), JSON.stringify(manifest)),
      writeFile(path.join(runDir, "summary.json"), JSON.stringify(summary)),
      writeFile(path.join(runDir, "samples.json"), JSON.stringify(samples)),
      writeFile(path.join(runDir, "console.log"), "[log] fixed battle running"),
      writeFile(path.join(runDir, "final.png"), Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        Buffer.from("synthetic-png-fixture"),
      ])),
    ]);
    results.push({
      runId: task.runId,
      arm: task.arm,
      armName: task.armName,
      valid: true,
      invalidReasons: [],
      qualification: { eligible: true },
    });
  }
  await Promise.all([
    writeFile(path.join(root, "report.json"), JSON.stringify({
      headed: true,
      qualificationEligible: true,
      failures: [],
      durationSeconds: 2,
      targetCoreSeconds: 2,
      sampleMs: 1000,
      results,
    })),
    writeFile(path.join(root, "tasklist.json"), JSON.stringify(tasklist)),
    writeFile(path.join(root, "comparison.json"), JSON.stringify({
      attemptedBlocks: 2,
      validBlockCount: 2,
      invalidBlockCount: 0,
    })),
  ]);
  return { root, tasks };
}

function makeRenderer() {
  return {
    requestedVideoBackend: "WebGPU-Real",
    configuredVideoBackend: "WebGPU-Real",
    activeVideoBackend: "WebGPU-Real",
    expectedVideoBackend: "WebGPU-Real",
    requestedPresenterBackend: "webgpu",
    activePresenterBackend: "webgpu",
    expectedRequestedPresenterBackend: "webgpu",
    expectedActivePresenterBackend: "webgpu",
    fallback: null,
    coreSelection: { fallbackReason: null },
    errors: [],
    emscriptenPrintErr: [],
    fatalStatusHistory: [],
    workerTransport: { requestErrorRepliesSent: 0, oneWayErrorRepliesSent: 0 },
    wgpuReplayClassifier: {
      stages: {
        missingResources: { total: 0 },
        passAtomicity: { splitAtDrainCount: 0, recordsOutsidePass: 0 },
        presentSubmission: { errorCount: 0 },
        presentationChain: {
          xfb: readback(),
          backbuffer: readback(),
        },
      },
    },
  };
}

function readback() {
  return {
    readbackCount: 2,
    nonzeroColorReadbackCount: 1,
    lastNonzeroColorBytes: 1024,
    lastMaxByte: 255,
  };
}

function makeCausalTelemetry(enabled, lookups, hits) {
  return {
    presentation: { backend: "webgpu" },
    webgpu: {
      errorCount: 0,
      commandDroppedCount: 0,
      batchAbortCount: 0,
      batchOversizeCount: 0,
      uploadTimeoutCount: 0,
      heldUploadStageLimitCount: 0,
      uploadAttribution: {
        passAssociation: {
          abortedPassCount: 0,
          incompletePassCount: 0,
          currentPassOpen: false,
        },
      },
      producerUboCacheAvailable: true,
      producerUboCacheEnabled: enabled,
      producerUboCacheMetricsEnabled: true,
      producerUboCacheClassOrder: ["vs", "ps", "gs"],
      producerUboCacheLookups: lookups,
      producerUboCacheHits: hits,
      producerUboCacheExpired: [0, 0, 0],
      producerUboUploadCallsSuppressed: hits,
      producerUboUploadBytesSuppressed: enabled ? [100, 200, 300] : [0, 0, 0],
    },
  };
}

function helperStats(enabled, lookups, hits) {
  return `wgstate:0 pipe:0 bg:0,0,0 vb:0 ib:0 wgdrop:0 ` +
    `wgbabort:0 wgboversize:0 wguploadto:0 wgubo:${enabled ? 1 : 0} wgubometrics:1 ` +
    `ulook:${lookups.join(",")} uhit:${hits.join(",")} uexp:0,0,0 ` +
    `usupcall:${hits.join(",")} usupbyte:${enabled ? "100,200,300" : "0,0,0"}`;
}

async function editJson(filePath, mutate) {
  const value = JSON.parse(await readFile(filePath, "utf8"));
  mutate(value);
  await writeFile(filePath, JSON.stringify(value));
}
