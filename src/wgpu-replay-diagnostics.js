const DEFAULT_MAX_EVENTS = 32;
const DEFAULT_MAX_MISSING_IDS_PER_KIND = 4;

export function requestedWgpuReplayDiagnostics(search = globalThis.location?.search ?? "") {
  return new URLSearchParams(search).get("wgpuclassify") === "1";
}

export function requestedWgpuDeepReplayDiagnostics(search = globalThis.location?.search ?? "") {
  return new URLSearchParams(search).get("wgpudeepdiag") === "1";
}

export function requestedWgpuAtomicPassReplay(search = globalThis.location?.search ?? "") {
  return new URLSearchParams(search).get("wgpuatomic") !== "0";
}

export function selectAtomicReplayLimit({
  read,
  write,
  opAt,
  beginOp = 12,
  endOp = 21
}) {
  const available = (write - read) >>> 0;
  let safeLimit = read >>> 0;
  let passStart = null;

  for (let offset = 0; offset < available; offset += 1) {
    const index = (read + offset) >>> 0;
    const op = opAt(index);
    if (passStart === null) {
      if (op === beginOp) {
        passStart = index;
      } else {
        safeLimit = (index + 1) >>> 0;
      }
      continue;
    }

    if (op === endOp) {
      passStart = null;
      safeLimit = (index + 1) >>> 0;
    }
  }

  return passStart === null ? safeLimit : passStart;
}

export function createWgpuReplayClassifier({
  maxEvents = DEFAULT_MAX_EVENTS,
  maxMissingIdsPerKind = DEFAULT_MAX_MISSING_IDS_PER_KIND,
  scope = "session",
  now = () => performance.now()
} = {}) {
  const events = [];
  let eventsDropped = 0;
  let passOpen = false;
  let currentFramebufferId = 0;

  const passAtomicity = {
    status: "pending",
    beginCount: 0,
    explicitEndCount: 0,
    splitAtDrainCount: 0,
    heldIncompletePassCount: 0,
    recordsOutsidePass: 0
  };
  const missingResources = {
    status: "pending",
    total: 0,
    counts: {},
    ids: {}
  };
  const efbMutation = {
    status: "pending",
    framebufferId: 0,
    clearCount: 0,
    drawCount: 0,
    readbackCount: 0,
    postDrawReadbackCount: 0,
    nonzeroReadbackCount: 0,
    drawCountAtLastReadback: 0,
    lastNonzeroBytes: 0,
    lastMaxByte: 0
  };
  const firstRealDraw = {
    status: "pending",
    indexed: false,
    framebufferId: 0,
    pipelineId: 0
  };
  const firstEfbDraw = {
    status: "pending",
    indexed: false,
    framebufferId: 0,
    pipelineId: 0,
    state: null
  };
  const firstIndexedEfbDraw = {
    status: "pending",
    framebufferId: 0,
    pipelineId: 0,
    state: null
  };
  const firstNonzeroEfb = {
    status: "pending",
    framebufferId: 0,
    nonzeroBytes: 0,
    maxByte: 0,
    presentSequence: 0,
    readbackOrdinal: 0,
    drawCountAtReadback: 0
  };
  const presentSubmission = {
    status: "pending",
    commandCount: 0,
    submittedCount: 0,
    completedCount: 0,
    errorCount: 0
  };

  function recordEvent(type, detail = {}) {
    const event = { type, at: now(), ...detail };
    if (events.length < maxEvents) events.push(event);
    else eventsDropped += 1;
  }

  function recordPassBegin({ framebufferId = 0, recordIndex = 0 } = {}) {
    passOpen = true;
    currentFramebufferId = framebufferId >>> 0;
    passAtomicity.beginCount += 1;
    recordEvent("pass-begin", { framebufferId: currentFramebufferId, recordIndex });
  }

  function recordPassEnd({ reason = "explicit", recordIndex = 0 } = {}) {
    if (!passOpen) return;
    passOpen = false;
    if (reason === "drain-boundary") passAtomicity.splitAtDrainCount += 1;
    if (reason === "explicit") passAtomicity.explicitEndCount += 1;
    recordEvent("pass-end", { reason, recordIndex, framebufferId: currentFramebufferId });
    currentFramebufferId = 0;
  }

  function recordStateOutsidePass({ op, recordIndex = 0 } = {}) {
    passAtomicity.recordsOutsidePass += 1;
    recordEvent("state-outside-pass", { op, recordIndex });
  }

  function recordAtomicHold({ recordIndex = 0, writeIndex = 0 } = {}) {
    passAtomicity.heldIncompletePassCount += 1;
    recordEvent("incomplete-pass-held", { recordIndex, writeIndex });
  }

  function recordMissingResource({ kind = "unknown", id = 0 } = {}) {
    missingResources.total += 1;
    missingResources.counts[kind] = (missingResources.counts[kind] || 0) + 1;
    const ids = missingResources.ids[kind] || (missingResources.ids[kind] = []);
    if (ids.length < maxMissingIdsPerKind && !ids.includes(id)) ids.push(id);
    recordEvent("missing-resource", { kind, id });
  }

  function recordEfbClear({ framebufferId = 0, rgba = [] } = {}) {
    efbMutation.framebufferId = framebufferId >>> 0;
    efbMutation.clearCount += 1;
    recordEvent("efb-clear", { framebufferId, rgba: rgba.slice(0, 4) });
  }

  function recordRealDraw({
    framebufferId = 0,
    indexed = false,
    pipelineId = 0,
    efb = false,
    state = null
  } = {}) {
    if (firstRealDraw.status !== "pass") {
      firstRealDraw.status = "pass";
      firstRealDraw.indexed = Boolean(indexed);
      firstRealDraw.framebufferId = framebufferId >>> 0;
      firstRealDraw.pipelineId = pipelineId >>> 0;
      recordEvent("first-real-draw", { framebufferId, indexed: Boolean(indexed), pipelineId });
    }
    if (efb || (framebufferId && framebufferId === efbMutation.framebufferId)) {
      efbMutation.framebufferId = framebufferId >>> 0;
      efbMutation.drawCount += 1;
      if (firstEfbDraw.status !== "pass") {
        firstEfbDraw.status = "pass";
        firstEfbDraw.indexed = Boolean(indexed);
        firstEfbDraw.framebufferId = framebufferId >>> 0;
        firstEfbDraw.pipelineId = pipelineId >>> 0;
        firstEfbDraw.state = state == null ? null : structuredClone(state);
        recordEvent("first-efb-draw", {
          framebufferId,
          indexed: Boolean(indexed),
          pipelineId
        });
      }
      if (indexed && firstIndexedEfbDraw.status !== "pass") {
        firstIndexedEfbDraw.status = "pass";
        firstIndexedEfbDraw.framebufferId = framebufferId >>> 0;
        firstIndexedEfbDraw.pipelineId = pipelineId >>> 0;
        firstIndexedEfbDraw.state = state == null ? null : structuredClone(state);
        recordEvent("first-indexed-efb-draw", { framebufferId, pipelineId });
      }
    }
  }

  function needsFirstEfbDrawState(indexed = false) {
    return firstEfbDraw.status !== "pass" ||
      (indexed && firstIndexedEfbDraw.status !== "pass");
  }

  function recordEfbReadback({
    framebufferId = 0,
    nonzeroBytes = 0,
    maxByte = 0,
    drawCountAtEncode = efbMutation.drawCount,
    presentSequence = 0
  } = {}) {
    efbMutation.framebufferId = framebufferId >>> 0;
    efbMutation.readbackCount += 1;
    efbMutation.drawCountAtLastReadback = drawCountAtEncode;
    if (drawCountAtEncode > 0) efbMutation.postDrawReadbackCount += 1;
    efbMutation.lastNonzeroBytes = nonzeroBytes;
    efbMutation.lastMaxByte = maxByte;
    if (nonzeroBytes > 0) {
      efbMutation.nonzeroReadbackCount += 1;
      if (firstNonzeroEfb.status !== "pass") {
        firstNonzeroEfb.status = "pass";
        firstNonzeroEfb.framebufferId = framebufferId >>> 0;
        firstNonzeroEfb.nonzeroBytes = nonzeroBytes;
        firstNonzeroEfb.maxByte = maxByte;
        firstNonzeroEfb.presentSequence = presentSequence >>> 0;
        firstNonzeroEfb.readbackOrdinal = efbMutation.readbackCount;
        firstNonzeroEfb.drawCountAtReadback = drawCountAtEncode;
        recordEvent("first-nonzero-efb", {
          framebufferId,
          nonzeroBytes,
          maxByte,
          presentSequence,
          readbackOrdinal: efbMutation.readbackCount,
          drawCountAtReadback: drawCountAtEncode
        });
      }
    }
  }

  function captureEfbDrawCount() {
    return efbMutation.drawCount;
  }

  function needsPostDrawEfbReadback(minimumDrawCount = 64) {
    return efbMutation.drawCount >= minimumDrawCount && efbMutation.postDrawReadbackCount === 0;
  }

  function recordPresentCommand({ recordIndex = 0 } = {}) {
    presentSubmission.commandCount += 1;
    recordEvent("present-command", { recordIndex });
  }

  function recordSubmission({ reason = "unknown", submitted = false, error = null } = {}) {
    if (submitted) presentSubmission.submittedCount += 1;
    if (error) presentSubmission.errorCount += 1;
    recordEvent("submission", { reason, submitted: Boolean(submitted), error: error ? String(error) : undefined });
  }

  function recordPresentCompletion({ completed = false, error = null } = {}) {
    if (completed) presentSubmission.completedCount += 1;
    if (error) presentSubmission.errorCount += 1;
    recordEvent("present-completion", { completed: Boolean(completed), error: error ? String(error) : undefined });
  }

  function snapshot() {
    passAtomicity.status = passAtomicity.splitAtDrainCount || passAtomicity.recordsOutsidePass ? "fail" :
      passAtomicity.explicitEndCount ? "pass" : "pending";
    missingResources.status = missingResources.total ? "fail" : "pending";
    efbMutation.status = efbMutation.nonzeroReadbackCount ? "pass" :
      efbMutation.postDrawReadbackCount ? "fail" : "pending";
    presentSubmission.status = presentSubmission.errorCount ? "fail" :
      presentSubmission.completedCount ? "pass" : presentSubmission.submittedCount ? "running" : "pending";

    let classifier = { status: "running", code: "WAITING_FOR_DRAW" };
    if (passAtomicity.splitAtDrainCount) classifier = { status: "fail", code: "PASS_SPLIT_AT_DRAIN" };
    else if (missingResources.total) classifier = { status: "fail", code: "MISSING_RESOURCES" };
    else if (efbMutation.nonzeroReadbackCount && presentSubmission.completedCount) classifier = { status: "pass", code: "PASS" };
    else if (efbMutation.postDrawReadbackCount) classifier = { status: "fail", code: "EFB_DRAW_NO_MUTATION" };
    else if (efbMutation.drawCount && efbMutation.readbackCount) classifier = {
      status: "running",
      code: "WAITING_FOR_POST_DRAW_EFB_READBACK"
    };
    else if (firstRealDraw.status === "pass") classifier = { status: "running", code: "WAITING_FOR_EFB_READBACK" };

    return structuredClone({
      schema: "wasm-dolphin.wgpu-replay-classifier.v1",
      scope,
      classifier,
      stages: {
        passAtomicity,
        missingResources,
        efbMutation,
        firstRealDraw,
        firstEfbDraw,
        firstIndexedEfbDraw,
        firstNonzeroEfb,
        presentSubmission
      },
      events,
      eventsDropped
    });
  }

  return {
    recordPassBegin,
    recordPassEnd,
    recordStateOutsidePass,
    recordAtomicHold,
    recordMissingResource,
    recordEfbClear,
    recordRealDraw,
    needsFirstEfbDrawState,
    recordEfbReadback,
    captureEfbDrawCount,
    needsPostDrawEfbReadback,
    recordPresentCommand,
    recordSubmission,
    recordPresentCompletion,
    snapshot
  };
}
