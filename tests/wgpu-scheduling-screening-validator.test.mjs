// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { validateWgpuSchedulingScreening } from
  "../tools/validate-wgpu-scheduling-screening.mjs";

const HISTORICAL_PACKAGES = [
  ".omx/wgpu-no-lag/item-6-replay-4ms-clean",
  ".omx/wgpu-no-lag/item-6-replay-6ms-screen",
];

test("scheduling validator accepts a complete audible ABBA+BAAB campaign", async (t) => {
  const fixture = await makeFixture(t);
  const result = await validateWgpuSchedulingScreening({
    outDir: fixture.root,
    requireHardwareVisual: true,
  });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.equal(result.runCount, 8);
  assert.deepEqual(result.expectedOrder, ["ABBA", "BAAB"]);
});

test("scheduling validator rejects non-audible, headless, or wrong-work campaigns", async (t) => {
  for (const [name, mutate, code] of [
    ["muted", (report) => { report.audioMode = "muted"; }, "AUDIO_NOT_AUDIBLE"],
    ["headless", (report) => { report.headed = false; }, "RUN_NOT_HEADED"],
    ["short", (report) => { report.targetCoreSeconds = 7; }, "FIXED_WORK_TARGET"],
  ]) {
    await t.test(name, async (t) => {
      const fixture = await makeFixture(t);
      await editJson(path.join(fixture.root, "report.json"), mutate);
      const result = await validateWgpuSchedulingScreening({ outDir: fixture.root });
      assert.equal(result.ok, false);
      assert.ok(result.issues.some((issue) => issue.code === code));
    });
  }
});

test("scheduling validator rejects replacements, pending work, and an unbalanced order", async (t) => {
  for (const [name, mutate, code] of [
    ["replacement", (tasklist) => {
      tasklist.blocks[1].replaces = "block-01";
    }, "TASKLIST_REPLACEMENT"],
    ["wrong retry ceiling", (tasklist) => {
      tasklist.maximumAttemptedBlocks = 2;
    }, "TASKLIST_BOUNDS"],
    ["pending", (tasklist) => {
      tasklist.blocks[1].status = "pending";
      tasklist.blocks[1].runs[0].status = "pending";
    }, "TASKLIST_PENDING"],
    ["order", (tasklist) => { tasklist.blocks[1].order = ["A", "B", "B", "A"]; },
      "TASKLIST_ORDER"],
  ]) {
    await t.test(name, async (t) => {
      const fixture = await makeFixture(t);
      await editJson(path.join(fixture.root, "tasklist.json"), mutate);
      const result = await validateWgpuSchedulingScreening({ outDir: fixture.root });
      assert.equal(result.ok, false);
      assert.ok(result.issues.some((issue) => issue.code === code));
    });
  }
});

test("scheduling validator rejects every causal fairness failure class", async (t) => {
  for (const [name, mutate, code] of [
    ["underrun", (summary) => {
      summary.metrics.causalFairness.audio.deltas.underrunCount = 1;
    }, "AUDIO_UNDERRUN"],
    ["input-stage", (summary) => {
      summary.metrics.causalFairness.inputMarker.stageDeltas.completed = 11;
      summary.metrics.causalFairness.inputMarker.parityPassed = false;
    }, "INPUT_STAGE_COUNT"],
    ["input-error", (summary) => {
      summary.metrics.causalFairness.inputMarker.errorDeltas.supersededCount = 1;
    }, "INPUT_MARKER_ERROR"],
    ["gpu-error", (summary) => {
      summary.metrics.causalFairness.gpuErrors.gpuCompletionFailedCount = 1;
    }, "CAUSAL_GPU_ERROR"],
  ]) {
    await t.test(name, async (t) => {
      const fixture = await makeFixture(t);
      await editJson(path.join(fixture.firstRunDir, "summary.json"), mutate);
      const result = await validateWgpuSchedulingScreening({ outDir: fixture.root });
      assert.equal(result.ok, false);
      assert.ok(result.issues.some((issue) => issue.code === code));
    });
  }
});

test("scheduling validator rejects renderer, pass, upload, replay, and completion errors", async (t) => {
  for (const [name, file, mutate, code] of [
    ["renderer", "manifest.json", (manifest) => {
      manifest.renderer.errors.push({ scope: "validation", message: "synthetic" });
    }, "RENDERER_ERRORS"],
    ["pass", "manifest.json", (manifest) => {
      manifest.renderer.wgpuReplayClassifier.stages.passAtomicity.splitAtDrainCount = 1;
    }, "PASS_ATOMICITY"],
    ["upload", "summary.json", (summary) => {
      summary.final.causalTelemetry.webgpu.uploadTimeoutCount = 1;
    }, "WEBGPU_COUNTER"],
    ["replay", "summary.json", (summary) => {
      summary.final.causalTelemetry.webgpu.commandDroppedCount = 1;
    }, "WEBGPU_COUNTER"],
    ["completion", "summary.json", (summary) => {
      summary.final.causalTelemetry.presentation.gpuCompletion.failedCount = 1;
    }, "GPU_COMPLETION_ERROR"],
  ]) {
    await t.test(name, async (t) => {
      const fixture = await makeFixture(t);
      await editJson(path.join(fixture.firstRunDir, file), mutate);
      const result = await validateWgpuSchedulingScreening({ outDir: fixture.root });
      assert.equal(result.ok, false);
      assert.ok(result.issues.some((issue) => issue.code === code));
    });
  }
});

test("hardware visual evidence is enforced only when requested", async (t) => {
  const fixture = await makeFixture(t);
  await editJson(path.join(fixture.firstRunDir, "summary.json"), (summary) => {
    summary.final.visualSampleSource = "xfb-hash";
    summary.final.visualCadenceTelemetry.enabled = false;
  });
  await editJson(path.join(fixture.root, "tasklist.json"), (tasklist) => {
    tasklist.blocks[0].runs[0].params.wgpuvisual = "0";
  });

  const optional = await validateWgpuSchedulingScreening({ outDir: fixture.root });
  assert.equal(optional.ok, true, JSON.stringify(optional.issues));
  const required = await validateWgpuSchedulingScreening({
    outDir: fixture.root,
    requireHardwareVisual: true,
  });
  assert.equal(required.ok, false);
  assert.ok(required.issues.some((issue) => issue.code === "HARDWARE_VISUAL_NOT_REQUESTED"));
  assert.ok(required.issues.some((issue) => issue.code === "HARDWARE_VISUAL_SOURCE"));
});

test("scheduling validator verifies raw artifacts and provenance bytes", async (t) => {
  const fixture = await makeFixture(t);
  await writeFile(path.join(fixture.firstRunDir, "build-provenance", "source.lock.json"), "changed");
  await rm(path.join(fixture.firstRunDir, "events.jsonl"));
  const result = await validateWgpuSchedulingScreening({ outDir: fixture.root });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "ARTIFACT_MISSING"));
  assert.ok(result.issues.some((issue) => issue.code === "PROVENANCE_SIZE"));
  assert.ok(result.issues.some((issue) => issue.code === "PROVENANCE_HASH"));
});

test("historical item-6 4ms and 6ms packages fail closed", async (t) => {
  for (const relative of HISTORICAL_PACKAGES) {
    const outDir = path.resolve(relative);
    try {
      await access(path.join(outDir, "report.json"));
    } catch {
      t.diagnostic(`historical local package unavailable: ${relative}`);
      continue;
    }
    const result = await validateWgpuSchedulingScreening({
      outDir,
      requireHardwareVisual: true,
    });
    assert.equal(result.ok, false, `${relative} must not qualify`);
    assert.ok(result.issues.some((issue) =>
      issue.code === "AUDIO_NOT_AUDIBLE" || issue.code === "AUDIO_UNDERRUN"));
    assert.ok(result.issues.some((issue) =>
      issue.code === "TASKLIST_BOUNDS" || issue.code === "TASKLIST_PENDING"));
    assert.ok(result.issues.some((issue) =>
      issue.code === "INPUT_PARITY" || issue.code === "INPUT_STAGE_COUNT"));
  }
});

async function makeFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wgpu-scheduling-validator-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const orders = [["A", "B", "B", "A"], ["B", "A", "A", "B"]];
  const blocks = orders.map((order, blockIndex) => {
    const blockId = `block-0${blockIndex + 1}`;
    return {
      blockId,
      blockNumber: blockIndex + 1,
      order,
      status: "complete",
      runs: order.map((arm, runIndex) => ({
        runId: `${blockId}-run-${runIndex + 1}`,
        blockId,
        blockNumber: blockIndex + 1,
        orderIndex: runIndex + 1,
        arm,
        armName: arm === "A" ? "fixed16k" : "budget6ms",
        params: {
          video: "wgpu",
          presenter: "webgpu",
          gpucomplete: "1",
          inputlatency: "1",
          wgpuvisual: "1",
        },
        status: "complete",
      })),
    };
  });
  const tasklist = {
    schemaVersion: 1,
    mode: "screening",
    initialValidBlocks: 2,
    maximumValidBlocks: 2,
    maximumAttemptedBlocks: 3,
    blocks,
    status: "PASS",
  };
  const tasks = blocks.flatMap((block) => block.runs);
  const results = [];
  for (const task of tasks) {
    const runDir = path.join(root, task.runId);
    const provenanceDir = path.join(runDir, "build-provenance");
    await mkdir(provenanceDir, { recursive: true });
    const provenanceBytes = Buffer.from(`locked provenance for ${task.runId}`);
    const provenanceRelative = "build-provenance/source.lock.json";
    await writeFile(path.join(runDir, provenanceRelative), provenanceBytes);

    const fixedEmulatedWork = makeFixedWork();
    const fairness = makeFairness();
    const final = makeFinal();
    const samples = [
      { elapsedSeconds: 0, frame: 100, coreTicks: 1_000_000 },
      { elapsedSeconds: 8, frame: 580, coreTicks: 3_889_000_000, ...final },
    ];
    const url = new URL("https://example.invalid/");
    for (const [key, value] of Object.entries(task.params)) url.searchParams.set(key, value);
    const audioModeApplication = {
      requestedMode: "audible",
      applied: true,
      muted: false,
    };
    const audioClaimQualification = {
      mode: "audible",
      audibleRequested: true,
      eligible: true,
      reason: "eligible",
    };
    const summary = {
      runId: task.runId,
      arm: task.arm,
      armName: task.armName,
      valid: true,
      invalidReasons: [],
      failures: [],
      url: url.href,
      audioMode: "audible",
      audioModeApplication,
      audioClaimQualification,
      sampleCount: samples.length,
      postLoadInput: {
        mode: "post-load-only",
        scheduledEventCount: 12,
        deliveredEventCount: 12,
        markerReadiness: { required: true, ready: true, waitedMs: 1 },
        events: makeInputEvents(),
      },
      metrics: { fixedEmulatedWork, causalFairness: fairness },
      fixedEmulatedWork,
      final,
    };
    const manifest = {
      benchmark: {
        audioMode: "audible",
        audioModeApplication,
        timingStartsAfterVerifiedLoad: true,
        inputScriptMode: "post-load-only",
        inputScriptEventCount: 12,
        inputScriptDeliveredEventCount: 12,
        inputMarkerReadiness: { required: true, ready: true, waitedMs: 1 },
        fixedEmulatedWork,
      },
      fixture: {
        isoVerified: true,
        saveStateVerified: true,
        saveStateLoaded: true,
        battleCheckpoint: { verified: true },
      },
      qualification: { eligible: true },
      buildProvenance: {
        verification: { verified: true, failures: [] },
        evidenceBundle: [{
          path: provenanceRelative,
          bytes: provenanceBytes.length,
          sha256: sha256(provenanceBytes),
        }],
      },
      renderer: makeRenderer(),
      result: {
        valid: true,
        screenshotFile: "final.png",
        inputEventsFile: "input-events.json",
        fixedEmulatedWork,
      },
    };
    await Promise.all([
      writeFile(path.join(runDir, "manifest.json"), JSON.stringify(manifest)),
      writeFile(path.join(runDir, "summary.json"), JSON.stringify(summary)),
      writeFile(path.join(runDir, "samples.json"), JSON.stringify(samples)),
      writeFile(path.join(runDir, "samples.csv"), "elapsed,frame\n0,100\n8,580\n"),
      writeFile(path.join(runDir, "input-events.json"), JSON.stringify({
        markerReadiness: { required: true, ready: true, waitedMs: 1 },
        events: makeInputEvents(),
      })),
      writeFile(path.join(runDir, "events.jsonl"), "{\"type\":\"sample\"}\n"),
      writeFile(path.join(runDir, "console.log"), "[log] fixed battle running\n"),
      writeFile(path.join(runDir, "final.png"), Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        Buffer.from("synthetic-png"),
      ])),
    ]);
    results.push({
      runId: task.runId,
      arm: task.arm,
      armName: task.armName,
      valid: true,
      invalidReasons: [],
      audioMode: "audible",
      audioClaimsEligible: true,
      qualification: { eligible: true },
      metrics: { fixedEmulatedWork },
      fixedEmulatedWork,
    });
  }
  await Promise.all([
    writeFile(path.join(root, "report.json"), JSON.stringify({
      headed: true,
      audioMode: "audible",
      qualificationEligible: true,
      failures: [],
      durationSeconds: 25,
      sampleMs: 1000,
      targetCoreSeconds: 8,
      results,
    })),
    writeFile(path.join(root, "tasklist.json"), JSON.stringify(tasklist)),
    writeFile(path.join(root, "comparison.json"), JSON.stringify({
      attemptedBlocks: 2,
      validBlockCount: 2,
      invalidBlockCount: 0,
    })),
    writeFile(path.join(root, "comparison.csv"), "arm,value\nA,100\nB,100\n"),
    writeFile(path.join(root, "runs.csv"), "run,value\nblock-01-run-1,100\n"),
  ]);
  return { root, firstRunDir: path.join(root, tasks[0].runId) };
}

function makeFixedWork() {
  return {
    enabled: true,
    targetCoreSeconds: 8,
    targetCoreTicks: 3_888_000_000,
    actualCoreTickDelta: 3_888_000_000,
    actualFrameDelta: 480,
    elapsedWallSeconds: 8,
    reachedTarget: true,
    deltasValid: true,
    throughputGameSpeedPercent: 100,
    throughputCoreFps: 60,
  };
}

function makeFairness() {
  return {
    audio: { deltas: { underrunCount: 0 } },
    inputMarker: {
      enabled: true,
      expectedCount: 12,
      stageDeltas: {
        applied: 12,
        polled: 12,
        armed: 12,
        submitted: 12,
        completed: 12,
      },
      errorDeltas: {
        supersededCount: 0,
        supersededArmedCount: 0,
        droppedInFlightCount: 0,
        generationMismatchCount: 0,
        generationUnavailableCount: 0,
        expiredCount: 0,
        expiredInFlightCount: 0,
      },
      final: { pendingGeneration: 0, activeGeneration: 0, inFlightCount: 0 },
      parityPassed: true,
    },
    gpuErrors: { wgpuErrorCount: 0, gpuCompletionFailedCount: 0 },
    failures: [],
  };
}

function makeInputEvents() {
  return Array.from({ length: 12 }, (_, index) => ({
    index,
    atMs: index * 100,
    delivered: true,
  }));
}

function makeFinal() {
  return {
    visualSampleSource: "wgpu-downsample-readback",
    visualCadenceTelemetry: {
      schema: "wasm-dolphin.wgpu-visual-cadence.v1",
      enabled: true,
      source: "wgpu-downsample-readback",
      completedSampleCount: 120,
      changedSampleCount: 100,
      latestHash: 0x1234abcd,
      encodeErrorCount: 0,
      mapErrorCount: 0,
      inFlightCount: 0,
    },
    causalTelemetry: {
      presentation: {
        backend: "webgpu",
        gpuCompletion: {
          enabled: true,
          completedCount: 4,
          failedCount: 0,
          unsupportedCount: 0,
          inFlight: 0,
        },
      },
      webgpu: {
        errorCount: 0,
        commandDroppedCount: 0,
        batchAbortCount: 0,
        batchOversizeCount: 0,
        uploadTimeoutCount: 0,
        uploadTimeoutCountAfterVerifiedLoad: 0,
        heldUploadStageLimitCount: 0,
        uploadAttribution: {
          passAssociation: {
            abortedPassCount: 0,
            incompletePassCount: 0,
            currentPassOpen: false,
          },
        },
        replayOps: { enabled: true, histogram: [0, 1, 2] },
      },
    },
  };
}

function makeRenderer() {
  return {
    requestedVideoBackend: "WebGPU-Real",
    configuredVideoBackend: "WebGPU-Real",
    activeVideoBackend: "WebGPU-Real",
    requestedPresenterBackend: "webgpu",
    activePresenterBackend: "webgpu",
    fallback: null,
    coreSelection: { fallbackReason: null },
    errors: [],
    emscriptenPrintErr: [],
    fatalStatusHistory: [],
    workerTransport: { requestErrorRepliesSent: 0, oneWayErrorRepliesSent: 0 },
    wgpuReplayClassifier: {
      stages: {
        missingResources: { total: 0 },
        passAtomicity: {
          splitAtDrainCount: 0,
          recordsOutsidePass: 0,
          heldIncompletePassCount: 0,
        },
        presentSubmission: { errorCount: 0 },
      },
    },
  };
}

async function editJson(filePath, mutate) {
  const value = JSON.parse(await readFile(filePath, "utf8"));
  mutate(value);
  await writeFile(filePath, JSON.stringify(value));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
