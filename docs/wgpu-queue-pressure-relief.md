# Hardware-WGPU queue-pressure relief experiment

Status: scoped, default-off experiment. This is not a promoted rendering mode.

## Problem statement

Direct Kirby-versus-Link measurements isolate the recurring 1.7-second worker
freeze to `GPUQueue.writeBuffer` after the WASM heap copy. The blocking write
is small (roughly 1.5–12 KiB) and its producer role changes between UBO and
packed geometry. This indicates cumulative browser/Dawn upload-staging
backpressure rather than one pathological payload.

The same worker event loop handles replay, audio RPCs, and input application.
When `writeBuffer` blocks, audio underruns and input-marker supersession follow.
Outer 4/6 ms replay budgets cannot interrupt a single synchronous queue call.

## Proposed experiment

`wgpuqueuewait=1` enables asynchronous pressure relief. The default remains
off. The experiment arms after either:

- 1,024 successful queue upload calls, or
- 2 MiB of successful queue upload payloads.

The initial 8,192-call/16-MiB smoke still accumulated one 1.88-second startup
fence. The tighter thresholds are intended to drain before that cliff rather
than merely converting it into a long asynchronous wait.

When armed, replay continues through the current atomic render pass. At the
next safe pass/submission boundary it submits encoded work, publishes the
consumed command index, and returns to the event loop without consuming or
releasing the next upload. It starts `queue.onSubmittedWorkDone()` as a promise,
not a blocking wait. Audio, input, presentation, and host callbacks can run
while the GPU queue drains. Replay resumes through the existing pump only after
the same renderer/load generation completes the wait.

## Safety invariants

- Never yield or wait inside an open render pass.
- Submit encoded work before requesting queue completion.
- Never stage or release an unconsumed upload suffix during a relief stop.
- Preserve monotonic command and upload-watermark ownership.
- Suppress replay pump and presentation redrains while waiting.
- Ignore stale completion callbacks after load, reset, or device replacement.
- On rejection, record the failure, disable relief for the run, and resume the
  legacy pump rather than deadlocking.
- Omitting `wgpuqueuewait=1` must preserve the current path.

The producer may block on the bounded upload arena while the asynchronous wait
is pending. That is intentional: the GPU queue progresses independently and
the worker event loop remains free.

## Required evidence

Raw telemetry must record thresholds, trigger reason, interval calls/bytes,
boundary overshoot, wait count/duration/failure/stale callbacks, backlog and
watermark at arm/resume, suppressed drains, and audio/input activity while
waiting.

Promotion requires balanced direct-save A/B evidence with:

- materially lower maximum queue-write and drain duration;
- zero WebGPU errors, upload timeouts, batch aborts/drops, or pass splits;
- nonzero indexed-EFB, XFB, and backbuffer evidence;
- improved audio gaps and exact input propagation;
- game-speed noninferiority lower 95% bound above -1%.

If the experiment only trades the synchronous stall for lower game speed, it
remains default-off and a separate renderer worker or mapped staging pool is
the next architectural option.
