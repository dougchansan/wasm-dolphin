import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CAUSAL_TELEMETRY_SCHEMA_VERSION,
  countTransferBytes,
  createCausalTelemetry,
  deepMerge,
  flattenCausalTelemetry,
  parseCoreProfileTelemetry,
  stageWindowFromProfile,
} from "../src/causal-telemetry.js";
import {
  WGPU_UPLOAD_ROLE,
  createWgpuUploadAttribution,
} from "../src/wgpu-upload-attribution.js";

test("causal telemetry has a stable versioned shape", () => {
  const value = createCausalTelemetry({
    enabled: true,
    core: { ticks: 123 },
    presentation: { queueDepth: 2 },
  });
  assert.equal(value.schemaVersion, CAUSAL_TELEMETRY_SCHEMA_VERSION);
  assert.equal(value.enabled, true);
  assert.equal(value.core.ticks, 123);
  assert.equal(value.core.loadedCheckpointTicks, null);
  assert.equal(value.presentation.queueDepth, 2);
  assert.equal(value.presentation.freshFrameDelivery, "unknown");
  assert.equal(value.presentation.legacyTickQueue, false);
  assert.equal(value.presentation.immediateFreshFrameCount, 0);
  assert.equal(value.presentation.queuedFreshFrameCount, 0);
  assert.equal(value.presentation.tickRepaintCount, 0);
  assert.equal(value.presentation.queueDepthHighWater, 0);
  assert.equal(value.presentation.queueAgeAverageMs, 0);
  assert.equal(value.presentation.queueAgeMaxMs, 0);
  assert.equal(value.presentation.js.capture.count, 0);
  assert.equal(value.presentation.gpuCompletion.enabled, false);
  assert.equal(value.presentation.gpuCompletion.completedCount, 0);
  assert.equal(value.webgpu.producerStateCacheEnabled, false);
  assert.deepEqual(value.webgpu.producerBindGroupRecordsSuppressed, [0, 0, 0]);
  assert.equal(value.webgpu.commandDroppedCount, 0);
  assert.equal(value.webgpu.producerUploadArenaConfiguredBytes, 0);
  assert.equal(value.webgpu.producerRingWaitCount, 0);
  assert.equal(value.webgpu.producerRingWaitTotalUs, 0);
  assert.equal(value.webgpu.producerRingWaitMaxUs, 0);
  assert.equal(value.webgpu.producerUploadWaitCount, 0);
  assert.equal(value.webgpu.producerUploadWaitTotalUs, 0);
  assert.equal(value.webgpu.producerUploadWaitMaxUs, 0);
  assert.equal(value.webgpu.producerProfile.requested, false);
  assert.equal(value.webgpu.producerProfile.available, false);
  assert.equal(value.webgpu.producerProfile.enabled, false);
  assert.equal(value.webgpu.producerProfile.phaseCount, 12);
  assert.equal(value.webgpu.producerProfile.phaseOrder[0], "ring_publish");
  assert.deepEqual(value.webgpu.producerProfile.estimatedTotalNs, new Array(12).fill(0));
  assert.equal(value.webgpu.uploadArenaRingHandoffMismatch, false);
  assert.equal(value.webgpu.uploadTimeoutBoundaryVerified, false);
  assert.equal(
    value.webgpu.uploadAttribution.schema,
    "wasm-dolphin.wgpu-upload-attribution.v2"
  );
  assert.deepEqual(value.webgpu.uploadAttribution.callsByRole, [0, 0, 0, 0, 0, 0, 0]);
  assert.equal(value.softwareRaster.profileEnabled, false);
  assert.equal(value.softwareRaster.caseSampleSeed, 0);
  assert.equal(value.softwareRaster.rasterTraversalCount, 0);
  assert.equal(value.softwareRaster.tevPixelCount, 0);
  assert.equal(value.softwareRaster.textureSampleCount, 0);
  assert.deepEqual(value.softwareRaster.textureCases, {
    sampledCount: 0,
    workCount: 0,
    otherSampleCount: 0,
    otherWorkCount: 0,
    collisionCount: 0,
    topCases: [],
  });
  assert.deepEqual(value.softwareRaster.tevCases, value.softwareRaster.textureCases);
  assert.equal(value.softwareRaster.fifoConsumerObservedBacklogAgeLastMs, null);
  assert.equal(value.softwareRaster.fifoOldestPendingAgeLastMs, null);
  assert.equal(value.softwareRaster.sampledStaleFrameRatio, 0);
  assert.equal(value.audio.underrunCount, 0);
  assert.equal(value.input.ageLastMs, 0);
  assert.equal(value.input.mainGeneration, 0);
  assert.equal(value.input.visible.enabled, false);
  assert.equal(value.input.visible.causalVisualAttribution, false);
  assert.equal(value.input.marker.enabled, false);
  assert.equal(value.input.marker.exactCorePollCount, 0);
  assert.equal(value.input.marker.markerCompletedCount, 0);
  assert.equal(value.input.marker.lastCompletionKind, "");
  assert.equal(value.input.marker.overhead.enabled, false);
  assert.equal(value.input.marker.overhead.softwareFrameCopyPaint.calls, 0);
  assert.equal(value.input.marker.overhead.padStatsPollParse.calls, 0);
});

test("core profile text is promoted without changing the compatibility string", () => {
  const source =
    "video xfb:77 640x480 stride:1280 present:320x240 hash:4b2d0a3b nz:2048 " +
    "coreprof xfb_dt:16.7 avg:17.1 max:41.2 decode:1.3 avg:1.4 max:2.8 " +
    "vo_sync:0.2/max0.6 vo_pub:0.3/max0.7 vo_total:0.5/max1.1 " +
    "swxfb:0.9 conv:0.8 copy:0.1 " +
    "swphase:1 caseseed:305419896 rast:120/4/840/4096 tev:1024/8192/2/410 tex:4096/2/260 " +
    "texcase:10/80/2/16/3:61b31d6=8/64 " +
    "tevcase:10/20/2/4/5:21002a112322.deadbeef@1.10.20.43.0.123456.abcdef.3412.e4.1b=8/16 " +
    "fifo:128/127/64/512/900/2400/127 fifouf:0 xfbgen:77/900/69300/1800 " +
    "framegen:77/16600/1278200/41000/76";
  assert.deepEqual(parseCoreProfileTelemetry(source), {
    sourceXfbCount: 77,
    sourceWidth: 640,
    sourceHeight: 480,
    sourceStrideBytes: 1280,
    sourceHash: "4b2d0a3b",
    sourceNonZeroPixels: 2048,
    xfbIntervalLastMs: 16.7,
    xfbIntervalAverageMs: 17.1,
    xfbIntervalMaxMs: 41.2,
    xfbDecodeLastMs: 1.3,
    xfbDecodeAverageMs: 1.4,
    xfbDecodeMaxMs: 2.8,
    outputSyncLastMs: 0.2,
    outputSyncMaxMs: 0.6,
    outputPublishLastMs: 0.3,
    outputPublishMaxMs: 0.7,
    outputTotalLastMs: 0.5,
    outputTotalMaxMs: 1.1,
    encodeTotalMs: 0.9,
    encodeConvertMs: 0.8,
    encodeCopyMs: 0.1,
    profileEnabled: true,
    caseSampleSeed: 305419896,
    rasterTraversalCount: 120,
    rasterTraversalTimedSampleCount: 4,
    rasterTraversalSampledTotalMs: 0.84,
    rasterTraversalSampledAverageMs: 0.21,
    rasterCandidatePixelCount: 4096,
    tevPixelCount: 1024,
    tevStageCount: 8192,
    tevTimedSampleCount: 2,
    tevSampledTotalMs: 0.41,
    tevSampledAverageMs: 0.205,
    textureSampleCount: 4096,
    textureTimedSampleCount: 2,
    textureSampledTotalMs: 0.26,
    textureSampledAverageMs: 0.13,
    textureCases: {
      sampledCount: 10,
      workCount: 80,
      otherSampleCount: 2,
      otherWorkCount: 16,
      collisionCount: 3,
      topCases: [{
        key: "0x61b31d6",
        sampleCount: 8,
        decodeWorkCount: 64,
        textureFormat: 6,
        linear: true,
        mipmapFilter: 2,
        baseMip: 3,
        mipLinear: true,
        wrapS: 1,
        wrapT: 2,
        manuallyManaged: true,
        tlutFormat: 2,
        widthPowerOfTwo: true,
        heightPowerOfTwo: false,
        decodeWorkPerSample: 8,
        minFilter: 1,
        magFilter: 0,
      }],
    },
    tevCases: {
      sampledCount: 10,
      workCount: 20,
      otherSampleCount: 2,
      otherWorkCount: 4,
      collisionCount: 5,
      topCases: [{
        structuralKey: "0x21002a112322",
        programFingerprint: "0xdeadbeef",
        canonicalProgramSchema: 1,
        canonicalProgramWords: [
          "0x10",
          "0x20",
          "0x43",
          "0x0",
          "0x123456",
          "0xabcdef",
          "0x3412",
          "0xe4",
          "0x1b",
        ],
        genModeHex: "0x10",
        tevIndirectReferenceHex: "0x20",
        orderWord: "0x43",
        indirectWord: "0x0",
        colorCombinerHex: "0x123456",
        alphaCombinerHex: "0xabcdef",
        konstWord: "0x3412",
        rasterSwapWord: "0xe4",
        textureSwapWord: "0x1b",
        sampleCount: 8,
        stageWorkCount: 16,
        tevStageCount: 2,
        indirectStageCount: 1,
        textureGenerationCount: 3,
        colorChannelCount: 2,
        textureEnabledStageCount: 2,
        activeIndirectStageCount: 1,
        usedIndirectTextureMask: 5,
        colorCompareStageCount: 1,
        alphaCompareStageCount: 0,
        colorClampStageCount: 2,
        alphaClampStageCount: 2,
      }],
    },
    fifoBurstCount: 128,
    fifoConsumeCount: 127,
    fifoBytesLast: 64,
    fifoBytesMax: 512,
    fifoConsumerObservedBacklogAgeLastMs: 0.9,
    fifoConsumerObservedBacklogAgeMaxMs: 2.4,
    fifoOldestPendingAgeLastMs: 0.9,
    fifoOldestPendingAgeMaxMs: 2.4,
    fifoAgeSampleCount: 127,
    fifoDistanceUnderflowCount: 0,
    xfbGenerationCount: 77,
    xfbGenerationLastMs: 0.9,
    xfbGenerationTotalMs: 69.3,
    xfbGenerationMaxMs: 1.8,
    frameGenerationCount: 77,
    frameGenerationIntervalLastMs: 16.6,
    frameGenerationIntervalAverageMs: 16.818421052631578,
    frameGenerationIntervalMaxMs: 41,
  });
});

test("TEV case parsing keeps legacy records and rejects incomplete schema-1 tuples", () => {
  const legacy = parseCoreProfileTelemetry(
    "tevcase:1/1/0/0/0:1.deadbeef=1/1"
  ).tevCases.topCases[0];
  assert.equal(legacy.programFingerprint, "0xdeadbeef");
  assert.equal("canonicalProgramSchema" in legacy, false);

  const incomplete = parseCoreProfileTelemetry(
    "tevcase:1/1/0/0/0:1.deadbeef@1.1.2=1/1"
  ).tevCases.topCases;
  assert.deepEqual(incomplete, []);
});

test("profile windows retain counts, totals, averages, and copy throughput", () => {
  const value = stageWindowFromProfile({
    captureCount: 4,
    captureMs: 8,
    drawCount: 2,
    drawMs: 3,
    copyBytes: 1048576,
  }, 1000);
  assert.deepEqual(value.capture, { count: 4, totalMs: 8, averageMs: 2 });
  assert.deepEqual(value.draw, { count: 2, totalMs: 3, averageMs: 1.5 });
  assert.equal(value.copyMegabytesPerSecond, 1);
});

test("traffic byte accounting deduplicates views of the same transferred buffer", () => {
  const buffer = new ArrayBuffer(64);
  assert.equal(countTransferBytes([buffer, new Uint8Array(buffer)]), 64);
});

test("CSV flattening carries the exact causal schema and decision fields", () => {
  const value = createCausalTelemetry({
    core: { ticks: 55 },
    softwareRaster: {
      encodeTotalMs: 1.25,
      profileEnabled: true,
      caseSampleSeed: 305419896,
      rasterTraversalCount: 120,
      tevPixelCount: 1024,
      textureSampleCount: 4096,
      textureCases: {
        sampledCount: 10,
        workCount: 80,
        otherSampleCount: 2,
        collisionCount: 3,
        topCases: [{ key: "0x61b31d6", sampleCount: 8, decodeWorkCount: 64 }],
      },
      tevCases: {
        sampledCount: 10,
        workCount: 20,
        otherSampleCount: 2,
        collisionCount: 5,
        topCases: [{
          structuralKey: "0x21002a112322",
          programFingerprint: "0xdeadbeef",
          canonicalProgramSchema: 1,
          genModeHex: "0x10",
          tevIndirectReferenceHex: "0x20",
          orderWord: "0x43",
          indirectWord: "0x0",
          colorCombinerHex: "0x123456",
          alphaCombinerHex: "0xabcdef",
          konstWord: "0x3412",
          rasterSwapWord: "0xe4",
          textureSwapWord: "0x1b",
          sampleCount: 8,
        }],
      },
      fifoOldestPendingAgeMaxMs: 2.4,
      sampledSourceFrameCount: 10,
      sampledUniqueFrameCount: 4,
      sampledStaleFrameCount: 6,
      sampledStaleFrameRatio: 0.6,
      sampledStaleFrameRunMax: 3,
      staleRepaintCount: 2,
    },
    presentation: {
      underrunCount: 6,
      freshFrameDelivery: "immediate",
      legacyTickQueue: false,
      immediateFreshFrameCount: 9,
      queuedFreshFrameCount: 0,
      tickRepaintCount: 4,
      queueDepth: 0,
      queueDepthHighWater: 0,
      queueAgeMs: 0,
      queueAgeAverageMs: 0,
      queueAgeMaxMs: 0,
      gpuCompletion: {
        enabled: true,
        lastMs: 3.5,
        p95Ms: 4.5,
        inFlight: 1,
      },
    },
    webgpu: {
      producerProfile: {
        schema: "wasm-dolphin.wgpu-producer-profile.v1",
        requested: true,
        available: true,
        version: 1,
        enabled: true,
        epoch: 9,
        phaseCount: 12,
        phaseOrder: [
          "ring_publish", "upload_copy", "geometry_commit", "draw_resources",
          "shader_translate_emit", "pipeline_serialize_emit", "bind_group_prepare",
          "xfb_show_image", "backbuffer_present", "fifo_decode", "fifo_tail_flush",
          "reserved",
        ],
        periods: new Array(12).fill(2),
        calls: Array.from({ length: 12 }, (_, index) => index + 10),
        samples: Array.from({ length: 12 }, (_, index) => index + 1),
        sampleTotalNs: Array.from({ length: 12 }, (_, index) => (index + 1) * 100),
        sampleMaxNs: Array.from({ length: 12 }, (_, index) => (index + 1) * 10),
        estimatedTotalNs: Array.from({ length: 12 }, (_, index) => (index + 1) * 200),
      },
      producerRingWaitCount: 11,
      producerRingWaitTotalUs: 12_000,
      producerRingWaitMaxUs: 1_300,
      producerUploadWaitCount: 14,
      producerUploadWaitTotalUs: 15_000,
      producerUploadWaitMaxUs: 1_600,
      rendererWorkerProbe: {
        requested: "worker-upload",
        active: true,
        passed: true,
        schema: "wasm-dolphin.wgpu-renderer-worker-upload-probe.v1",
        totalMs: 12.5,
        executorLocation: "worker",
        blankOutput: true,
        protocolVersion: 3,
        claimedOwner: 2,
        claimCount: 1,
        conflictCount: 0,
        observedRecordCount: 100,
        consumedRecordCount: 100,
        uploadRecordCount: 20,
        releasedUploadCount: 20,
        totalUploadBytes: 4096,
        submissionCount: 4,
        gpuCompletionCount: 4,
        backlog: 0,
        quiesced: true,
        fatalCount: 0,
        streamDigest: "deadbeef",
        error: "",
      },
      backlogLast: 3,
      backlogSampleP95: 12,
      backlogSampleAverage: 6.5,
      backlogAfterLast: 2,
      backlogNonzeroAgeMaxMs: 44,
      replayBudgetMs: 4,
      replayBudgetYieldCount: 7,
      replayBudgetAtomicOverrunMaxMs: 1.5,
      replayBudgetStopReasons: { "time-budget": 7 },
      drainDurationHistogram: [1, 2, 3, 4, 0, 0, 0, 0],
      drainCommandHistogram: [0, 1, 2, 3, 4, 0, 0, 0],
      replayPumpWakeDelayAverageMs: 0.75,
      replayPumpWakeDelayMaxMs: 2.5,
      stageBudgetYieldCount: 5,
      stageCopyDeadlineOverrunMaxMs: 0.4,
      mappedStaging: {
        slotCount: 6,
        slotSize: 8 * 1024 * 1024,
        capacityMissesNoMappedSlots: 9,
        capacityMissesMappedSlotsFull: 2,
        sealedSlotCountTotal: 123,
        sealedBytesTotal: 456,
        sealedBytesMax: 78,
        sealedRecordsTotal: 90,
        sealedRecordsMax: 12,
        remapLatencyTotalMs: 34.5,
        remapLatencyMaxMs: 8.5,
        remapLatencyBucketBoundsMs: [1, 2, 4, 8, 16],
        remapLatencyHistogram: [0, 1, 2, 3, 4, 0],
      },
    },
    audio: {
      workerMixCount: 11,
      workerRequestedFrames: 22,
      workerReturnedFrames: 20,
      workerEmptyMixCount: 2,
      workerMixLastMs: 1.1,
      workerMixTotalMs: 5.5,
      workerMixMaxMs: 1.5,
      pumpCount: 12,
      pumpPendingSkipCount: 1,
      pumpMissCount: 2,
      pumpGapLastMs: 3,
      pumpGapAverageMs: 4,
      pumpGapMaxMs: 5,
      mixRoundTripAverageMs: 6,
      mixRoundTripMaxMs: 7,
      underrunCount: 3,
      overrunCount: 4,
      scheduleLeadSeconds: 0.08,
      scheduleDriftSeconds: -0.02,
    },
    input: {
      ageLastMs: 4,
      mainGeneration: 7,
      visible: {
        enabled: true,
        pollAgeLastMs: 5,
        visibleAgeLastMs: 18,
        pollToVisibleLastMs: 13,
      },
      marker: {
        enabled: true,
        appliedCount: 4,
        duplicateApplyCount: 1,
        supersededCount: 2,
        supersededArmedCount: 3,
        droppedInFlightCount: 4,
        exactCorePollCount: 4,
        generationMismatchCount: 5,
        generationUnavailableCount: 6,
        markerArmedCount: 4,
        markerSubmittedCount: 4,
        markerCompletedCount: 3,
        duplicateSubmitCount: 7,
        duplicateCompleteCount: 8,
        retiredCompletedMarkerCount: 9,
        expiredMarkerCount: 10,
        expiredInFlightCount: 11,
        pendingGeneration: 12,
        activeGeneration: 13,
        inFlightCount: 1,
        completionAgeLastMs: 22,
        completionAgeP95Ms: 30,
        pollToCompletionLastMs: 12,
        pollToCompletionP95Ms: 18,
        lastCompletedGeneration: 9,
        lastCompletionKind: "gpu-complete",
        overhead: {
          enabled: true,
          softwareFrameCopyPaint: {
            calls: 12,
            sourceBytes: 14_745_600,
            paintedBytes: 1_277_952,
            totalMs: 6.5,
            maxMs: 0.9,
          },
          padStatsPollParse: {
            calls: 5,
            sourceUtf16Bytes: 8_192,
            totalMs: 1.25,
            maxMs: 0.4,
            failureCount: 1,
          },
        },
      },
    },
  });
  const flat = flattenCausalTelemetry(value);
  assert.equal(flat.causalTelemetrySchemaVersion, CAUSAL_TELEMETRY_SCHEMA_VERSION);
  assert.equal(flat.causalCoreTicks, 55);
  assert.equal(flat.causalSoftwareEncodeMs, 1.25);
  assert.equal(flat.causalSoftwareRasterProfileEnabled, true);
  assert.equal(flat.causalRasterCaseSampleSeed, 305419896);
  assert.equal(flat.causalRasterTraversalCount, 120);
  assert.equal(flat.causalTevPixelCount, 1024);
  assert.equal(flat.causalTextureSampleCount, 4096);
  assert.equal(flat.causalTextureCaseSampleCount, 10);
  assert.equal(flat.causalTextureCaseWorkCount, 80);
  assert.equal(flat.causalTextureCaseOtherSampleCount, 2);
  assert.equal(flat.causalTextureCaseCollisionCount, 3);
  assert.equal(flat.causalTextureTopCaseKey, "0x61b31d6");
  assert.equal(flat.causalTextureTopCaseSamples, 8);
  assert.equal(flat.causalTextureTopCaseDecodeWork, 64);
  assert.equal(flat.causalTevCaseSampleCount, 10);
  assert.equal(flat.causalTevCaseWorkCount, 20);
  assert.equal(flat.causalTevCaseOtherSampleCount, 2);
  assert.equal(flat.causalTevCaseCollisionCount, 5);
  assert.equal(flat.causalTevTopStructuralKey, "0x21002a112322");
  assert.equal(flat.causalTevTopProgramFingerprint, "0xdeadbeef");
  assert.equal(flat.causalTevTopCanonicalProgramSchema, 1);
  assert.equal(flat.causalTevTopGenModeHex, "0x10");
  assert.equal(flat.causalTevTopIndirectReferenceHex, "0x20");
  assert.equal(flat.causalTevTopOrderWord, "0x43");
  assert.equal(flat.causalTevTopIndirectWord, "0x0");
  assert.equal(flat.causalTevTopColorCombinerHex, "0x123456");
  assert.equal(flat.causalTevTopAlphaCombinerHex, "0xabcdef");
  assert.equal(flat.causalTevTopKonstWord, "0x3412");
  assert.equal(flat.causalTevTopRasterSwapWord, "0xe4");
  assert.equal(flat.causalTevTopTextureSwapWord, "0x1b");
  assert.equal(flat.causalTevTopCaseSamples, 8);
  assert.equal(flat.causalFifoOldestPendingAgeMaxMs, 2.4);
  assert.equal(flat.causalFifoConsumerObservedBacklogAgeMaxMs, 2.4);
  assert.equal(flat.causalSampledStaleFrameRatio, 0.6);
  assert.equal(flat.causalSampledStaleFrameRunMax, 3);
  assert.equal(flat.causalStaleRepaintCount, 2);
  assert.equal(flat.causalFreshFrameDelivery, "immediate");
  assert.equal(flat.causalLegacyTickQueue, false);
  assert.equal(flat.causalImmediateFreshFrameCount, 9);
  assert.equal(flat.causalQueuedFreshFrameCount, 0);
  assert.equal(flat.causalTickRepaintCount, 4);
  assert.equal(flat.causalPresentationQueueDepthHighWater, 0);
  assert.equal(flat.causalPresentationQueueAgeAverageMs, 0);
  assert.equal(flat.causalPresentationQueueAgeMaxMs, 0);
  assert.equal(flat.causalGpuCompletionEnabled, true);
  assert.equal(flat.causalGpuCompletionMs, 3.5);
  assert.equal(flat.causalGpuCompletionP95Ms, 4.5);
  assert.equal(flat.causalGpuCompletionInFlight, 1);
  assert.equal(flat.causalGpuCompletionFailedCount, 0);
  assert.equal(flat.causalPresentationUnderruns, 6);
  assert.equal(flat.causalWgpuBacklog, 3);
  assert.equal(flat.causalWgpuBacklogSampleP95, 12);
  assert.equal(flat.causalWgpuBacklogSampleAverage, 6.5);
  assert.equal(flat.causalWgpuBacklogAfter, 2);
  assert.equal(flat.causalWgpuBacklogNonzeroAgeMaxMs, 44);
  assert.equal(flat.causalWgpuProducerRingWaitCount, 11);
  assert.equal(flat.causalWgpuProducerRingWaitTotalUs, 12_000);
  assert.equal(flat.causalWgpuProducerRingWaitMaxUs, 1_300);
  assert.equal(flat.causalWgpuProducerUploadWaitCount, 14);
  assert.equal(flat.causalWgpuProducerUploadWaitTotalUs, 15_000);
  assert.equal(flat.causalWgpuProducerUploadWaitMaxUs, 1_600);
  assert.equal(flat.causalWgpuProducerProfileSchema, "wasm-dolphin.wgpu-producer-profile.v1");
  assert.equal(flat.causalWgpuProducerProfileRequested, true);
  assert.equal(flat.causalWgpuProducerProfileAvailable, true);
  assert.equal(flat.causalWgpuProducerProfileEnabled, true);
  assert.equal(flat.causalWgpuProducerProfileEpoch, 9);
  assert.equal(flat.causalWgpuProducerProfilePhaseCount, 12);
  assert.equal(flat.causalWgpuProducerProfilePhaseOrder[0], "ring_publish");
  assert.deepEqual(flat.causalWgpuProducerProfilePeriods, new Array(12).fill(2));
  assert.deepEqual(flat.causalWgpuProducerProfileCalls,
    Array.from({ length: 12 }, (_, index) => index + 10));
  assert.deepEqual(flat.causalWgpuProducerProfileSamples,
    Array.from({ length: 12 }, (_, index) => index + 1));
  assert.equal(flat.causalWgpuProducerProfileSampleTotalNs[11], 1200);
  assert.equal(flat.causalWgpuProducerProfileSampleMaxNs[11], 120);
  assert.equal(flat.causalWgpuProducerProfileEstimatedTotalNs[11], 2400);
  assert.equal(flat.causalWgpuRendererWorkerProbeRequested, "worker-upload");
  assert.equal(flat.causalWgpuRendererWorkerProbeActive, true);
  assert.equal(flat.causalWgpuRendererWorkerProbePassed, true);
  assert.equal(flat.causalWgpuRendererWorkerProbeSchema, "wasm-dolphin.wgpu-renderer-worker-upload-probe.v1");
  assert.equal(flat.causalWgpuRendererWorkerProbeTotalMs, 12.5);
  assert.equal(flat.causalWgpuRendererWorkerProbeExecutor, "worker");
  assert.equal(flat.causalWgpuRendererWorkerProbeBlankOutput, true);
  assert.equal(flat.causalWgpuRendererWorkerProbeProtocolVersion, 3);
  assert.equal(flat.causalWgpuRendererWorkerProbeClaimedOwner, 2);
  assert.equal(flat.causalWgpuRendererWorkerProbeObservedRecords, 100);
  assert.equal(flat.causalWgpuRendererWorkerProbeConsumedRecords, 100);
  assert.equal(flat.causalWgpuRendererWorkerProbeUploadRecords, 20);
  assert.equal(flat.causalWgpuRendererWorkerProbeReleasedUploads, 20);
  assert.equal(flat.causalWgpuRendererWorkerProbeUploadBytes, 4096);
  assert.equal(flat.causalWgpuRendererWorkerProbeSubmissions, 4);
  assert.equal(flat.causalWgpuRendererWorkerProbeGpuCompletions, 4);
  assert.equal(flat.causalWgpuRendererWorkerProbeBacklog, 0);
  assert.equal(flat.causalWgpuRendererWorkerProbeQuiesced, true);
  assert.equal(flat.causalWgpuRendererWorkerProbeFatalCount, 0);
  assert.equal(flat.causalWgpuRendererWorkerProbeStreamDigest, "deadbeef");
  assert.equal(flat.causalWgpuMappedStagingSlotCount, 6);
  assert.equal(flat.causalWgpuMappedStagingSlotSize, 8 * 1024 * 1024);
  assert.equal(flat.causalWgpuMappedStagingCapacityMissesNoMappedSlots, 9);
  assert.equal(flat.causalWgpuMappedStagingCapacityMissesMappedSlotsFull, 2);
  assert.equal(flat.causalWgpuMappedStagingSealedSlotCountTotal, 123);
  assert.equal(flat.causalWgpuMappedStagingSealedBytesTotal, 456);
  assert.equal(flat.causalWgpuMappedStagingSealedBytesMax, 78);
  assert.equal(flat.causalWgpuMappedStagingSealedRecordsTotal, 90);
  assert.equal(flat.causalWgpuMappedStagingSealedRecordsMax, 12);
  assert.equal(flat.causalWgpuMappedStagingRemapLatencyTotalMs, 34.5);
  assert.equal(flat.causalWgpuMappedStagingRemapLatencyMaxMs, 8.5);
  assert.deepEqual(flat.causalWgpuMappedStagingRemapLatencyBucketBoundsMs, [1, 2, 4, 8, 16]);
  assert.deepEqual(flat.causalWgpuMappedStagingRemapLatencyHistogram, [0, 1, 2, 3, 4, 0]);
  assert.equal(flat.causalWgpuReplayBudgetMs, 4);
  assert.equal(flat.causalWgpuReplayBudgetYieldCount, 7);
  assert.equal(flat.causalWgpuReplayBudgetAtomicOverrunMaxMs, 1.5);
  assert.equal(flat.causalWgpuReplayBudgetStopReasons["time-budget"], 7);
  assert.deepEqual(flat.causalWgpuDrainDurationHistogram, [1, 2, 3, 4, 0, 0, 0, 0]);
  assert.deepEqual(flat.causalWgpuDrainCommandHistogram, [0, 1, 2, 3, 4, 0, 0, 0]);
  assert.equal(flat.causalWgpuReplayPumpWakeDelayAverageMs, 0.75);
  assert.equal(flat.causalWgpuReplayPumpWakeDelayMaxMs, 2.5);
  assert.equal(flat.causalWgpuStageBudgetYieldCount, 5);
  assert.equal(flat.causalWgpuStageCopyDeadlineOverrunMaxMs, 0.4);
  assert.equal(flat.causalInputAgeMs, 4);
  assert.equal(flat.causalInputGeneration, 7);
  assert.equal(flat.causalInputVisibleEnabled, true);
  assert.equal(flat.causalInputCorePollAgeMs, 5);
  assert.equal(flat.causalInputVisibleAgeMs, 18);
  assert.equal(flat.causalInputPollToVisibleMs, 13);
  assert.equal(flat.causalInputMarkerEnabled, true);
  assert.equal(flat.causalInputMarkerExactCorePollCount, 4);
  assert.equal(flat.causalInputMarkerCompletedCount, 3);
  assert.equal(flat.causalInputMarkerCompletionAgeMs, 22);
  assert.equal(flat.causalInputMarkerCompletionAgeP95Ms, 30);
  assert.equal(flat.causalInputMarkerPollToCompletionMs, 12);
  assert.equal(flat.causalInputMarkerPollToCompletionP95Ms, 18);
  assert.equal(flat.causalInputMarkerLastCompletedGeneration, 9);
  assert.equal(flat.causalInputMarkerCompletionKind, "gpu-complete");
  assert.equal(flat.causalInputPhotonOverheadEnabled, true);
  assert.equal(flat.causalInputPhotonFrameCopyPaintCalls, 12);
  assert.equal(flat.causalInputPhotonFrameCopyBytes, 14_745_600);
  assert.equal(flat.causalInputPhotonMarkerPaintBytes, 1_277_952);
  assert.equal(flat.causalInputPhotonFrameCopyPaintTotalMs, 6.5);
  assert.equal(flat.causalInputPhotonFrameCopyPaintMaxMs, 0.9);
  assert.equal(flat.causalInputPhotonPadStatsPollParseCalls, 5);
  assert.equal(flat.causalInputPhotonPadStatsSourceUtf16Bytes, 8_192);
  assert.equal(flat.causalInputPhotonPadStatsPollParseTotalMs, 1.25);
  assert.equal(flat.causalInputPhotonPadStatsPollParseMaxMs, 0.4);
  assert.equal(flat.causalInputPhotonPadStatsPollParseFailureCount, 1);
  assert.equal(flat.causalWgpuProducerStateCacheEnabled, false);
  assert.deepEqual(flat.causalWgpuProducerBindGroupRecordsSuppressed, [0, 0, 0]);
  assert.equal(flat.causalWgpuCommandDroppedCount, 0);
  assert.equal(flat.causalWgpuErrorCount, 0);
  assert.equal(flat.causalAudioWorkerMixCount, 11);
  assert.equal(flat.causalAudioWorkerRequestedFrames, 22);
  assert.equal(flat.causalAudioWorkerReturnedFrames, 20);
  assert.equal(flat.causalAudioWorkerEmptyMixCount, 2);
  assert.equal(flat.causalAudioWorkerMixLastMs, 1.1);
  assert.equal(flat.causalAudioWorkerMixTotalMs, 5.5);
  assert.equal(flat.causalAudioWorkerMixMaxMs, 1.5);
  assert.equal(flat.causalAudioPumpCount, 12);
  assert.equal(flat.causalAudioPumpPendingSkipCount, 1);
  assert.equal(flat.causalAudioPumpMissCount, 2);
  assert.equal(flat.causalAudioPumpGapLastMs, 3);
  assert.equal(flat.causalAudioPumpGapAverageMs, 4);
  assert.equal(flat.causalAudioPumpGapMaxMs, 5);
  assert.equal(flat.causalAudioMixRoundTripAverageMs, 6);
  assert.equal(flat.causalAudioMixRoundTripMaxMs, 7);
  assert.equal(flat.causalAudioUnderruns, 3);
  assert.equal(flat.causalAudioOverruns, 4);
  assert.equal(flat.causalAudioScheduleLeadSeconds, 0.08);
  assert.equal(flat.causalAudioScheduleDriftSeconds, -0.02);
  assert.equal(flat.causalInputMarkerAppliedCount, 4);
  assert.equal(flat.causalInputMarkerDuplicateApplyCount, 1);
  assert.equal(flat.causalInputMarkerSupersededCount, 2);
  assert.equal(flat.causalInputMarkerSupersededArmedCount, 3);
  assert.equal(flat.causalInputMarkerDroppedInFlightCount, 4);
  assert.equal(flat.causalInputMarkerGenerationMismatchCount, 5);
  assert.equal(flat.causalInputMarkerGenerationUnavailableCount, 6);
  assert.equal(flat.causalInputMarkerArmedCount, 4);
  assert.equal(flat.causalInputMarkerSubmittedCount, 4);
  assert.equal(flat.causalInputMarkerDuplicateSubmitCount, 7);
  assert.equal(flat.causalInputMarkerDuplicateCompleteCount, 8);
  assert.equal(flat.causalInputMarkerRetiredCompletedCount, 9);
  assert.equal(flat.causalInputMarkerExpiredCount, 10);
  assert.equal(flat.causalInputMarkerExpiredInFlightCount, 11);
  assert.equal(flat.causalInputMarkerPendingGeneration, 12);
  assert.equal(flat.causalInputMarkerActiveGeneration, 13);
  assert.equal(flat.causalInputMarkerInFlightCount, 1);
  assert.equal(flattenCausalTelemetry(null).causalTelemetrySchemaVersion, null);
});

test("upload attribution and verified-load timeout deltas flatten into CSV-safe fields", () => {
  const uploads = createWgpuUploadAttribution();
  uploads.recordUpload(WGPU_UPLOAD_ROLE.VERTEX, 1024, 256);
  uploads.recordUpload(WGPU_UPLOAD_ROLE.INDEX, 64, 64);
  uploads.recordPassBegin();
  uploads.recordPassEnd();

  const telemetry = createCausalTelemetry({
    webgpu: {
      uploadTimeoutCount: 5,
      uploadTimeoutBoundaryVerified: true,
      uploadTimeoutCountAtVerifiedLoad: 2,
      uploadTimeoutCountBeforeVerifiedLoad: 2,
      uploadTimeoutCountAfterVerifiedLoad: 3,
      uploadAttribution: uploads.snapshot(),
    },
  });
  const flat = flattenCausalTelemetry(telemetry);

  assert.equal(flat.causalWgpuUploadTimeoutBoundaryVerified, true);
  assert.equal(flat.causalWgpuUploadTimeoutCountAtVerifiedLoad, 2);
  assert.equal(flat.causalWgpuUploadTimeoutCountAfterVerifiedLoad, 3);
  assert.equal(flat.causalWgpuUploadTotalCalls, 2);
  assert.equal(flat.causalWgpuUploadTotalBytes, 1088);
  assert.deepEqual(flat.causalWgpuUploadCallsByRole, [0, 0, 0, 1, 1, 0, 0]);
  assert.equal(flat.causalWgpuUploadMaxPassCalls, 2);
  assert.equal(flat.causalWgpuUploadMaxPassBytes, 1088);
  assert.equal(flat.causalWgpuUploadMaxDestinationSpanBytes, 1024);
});

test("rebuilt core exports CPU-thread checkpoint capture before renderer resync", async () => {
  const source = await readFile(new URL("../core/upstream/dolphin_web_core.cpp", import.meta.url), "utf8");
  const callback = source.indexOf("State::SetOnAfterLoadCallback");
  const capture = source.indexOf("s_last_loaded_ticks_low.store", callback);
  const resync = source.indexOf("fifo.EmulatorState(true)", callback);
  assert.ok(callback >= 0 && capture > callback && resync > capture);
  for (const name of [
    "GetLastLoadedCoreTicksLow",
    "GetLastLoadedCoreTicksHigh",
    "GetLastLoadedPPCPC",
    "GetLastLoadedCheckpointGeneration",
  ]) {
    assert.match(source, new RegExp(`std::uint32_t ${name}\\(\\)`));
  }
  const manifest = JSON.parse(
    await readFile(new URL("../provenance/dolphin-core-abi-v1.json", import.meta.url), "utf8")
  );
  assert.ok(
    !manifest.sourceOnlyExportsPendingRebuild.includes("_SetSoftwareRasterProfileEnabled"),
    "the software raster profile export must not remain pending",
  );
  assert.ok(manifest.moduleExports.includes("_SetSoftwareRasterProfileEnabled"));
  for (const name of [
    "_GetLastLoadedCheckpointGeneration",
    "_GetLastLoadedCoreTicksHigh",
    "_GetLastLoadedCoreTicksLow",
    "_GetLastLoadedPPCPC",
    "_SetXfbFastPaths",
  ]) {
    assert.ok(manifest.moduleExports.includes(name), `${name} must be present in the rebuilt core`);
  }
});

test("deep merge preserves untouched telemetry branches", () => {
  const merged = deepMerge(createCausalTelemetry(), { audio: { underrunCount: 2 } });
  assert.equal(merged.audio.underrunCount, 2);
  assert.equal(merged.audio.overrunCount, 0);
  assert.equal(merged.presentation.backend, "none");
});

test("flattening a pre-overhead schema snapshot supplies inert marker counters", () => {
  const value = createCausalTelemetry({ enabled: true });
  delete value.input.marker.overhead;
  const flat = flattenCausalTelemetry(value);
  assert.equal(flat.causalInputPhotonOverheadEnabled, false);
  assert.equal(flat.causalInputPhotonFrameCopyPaintCalls, 0);
  assert.equal(flat.causalInputPhotonPadStatsPollParseCalls, 0);
});
