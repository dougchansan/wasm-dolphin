# True WebGPU replay classifier

The true hardware renderer (`video=wgpu`) replays Dolphin GPU commands from a
shared ring in `src/upstream-discio-worker.js`. Add `wgpuclassify=1` to a
validation URL to collect a bounded, machine-readable classifier alongside the
normal renderer diagnostics:

```text
?core=upstream&video=wgpu&presenter=webgpu&wgpuclassify=1&metrics=1
```

The perf harness stores the result at `renderer.wgpuReplayClassifier` in the
run's raw `manifest.json`. Without the query
flag that field is `null`; the classifier does not run.

Atomic pass replay is enabled by default. `wgpuatomic=0` restores the legacy
snapshot behavior for a controlled A/B or immediate rollback; it is not the
recommended path.

## What it classifies

The `wasm-dolphin.wgpu-replay-classifier.v2` payload records bounded ordered
checkpoints:

1. pass atomicity, including a pass forcibly ended at a drain boundary;
2. missing pipelines, bind groups, buffers, textures, or samplers;
3. EFB clear, real draw, and readback mutation counts;
4. the first EFB draw and first indexed EFB draw, including pipeline, bind
   groups, vertex/index buffers, viewport, scissor, and draw arguments;
5. the first EFB readback containing a nonzero byte, including its present
   sequence and readback ordinal;
6. present command submission and the first queue-completion result;
7. the save-load generation, ring indices, pending-pass state, bounded drain
   samples, backlog high-water mark, upload bytes, and upload-arena wraps;
8. separate EFB, presented-source/XFB, and backbuffer readbacks, including RGB
   and alpha counts so opaque black is not mistaken for color output.

Event storage and missing-resource ID samples are capped. Counters continue to
increase after those caps, so the payload remains useful without producing
shader dumps or an unbounded log. A `loadStateFile` request resets the payload
to scope `load-state-file`, preventing boot activity from being mistaken for
evidence about the loaded Kirby/Link scene. New payloads also carry a monotonic
classifier generation. Header word 3 is exposed as `uploadReadIndex` telemetry
but this JS diagnostic does not advance it; the producer/consumer upload-lifetime
protocol must own that release point.

EFB readbacks are encoded at `SUBMIT_PRESENT`, after the commands already
recorded in that encoder and before its `submitEnc("present")`. They therefore
sample the EFB state at that present boundary. They are not an invasive
"immediately after the first draw" probe: a later clear in the same emulated
frame can legitimately precede the sample. `drawCountAtLastReadback` and
`lastPresentSequence` preserve that distinction.

| Classifier code | Meaning |
| --- | --- |
| `PASS_SPLIT_AT_DRAIN` | The consumer ended an open render pass because its current ring snapshot ended. |
| `MISSING_RESOURCES` | At least one replay record referenced a resource absent from the consumer maps. |
| `EFB_DRAW_NO_MUTATION` | A real EFB draw executed, but the sampled EFB readback remained all zero. |
| `WAITING_FOR_DRAW` | No fully bound real draw has executed yet. |
| `WAITING_FOR_EFB_READBACK` | A draw executed, but the bounded EFB readback checkpoint has not completed. |
| `WAITING_FOR_POST_DRAW_EFB_READBACK` | The available EFB sample predates the observed draws. |
| `PASS` | A nonzero EFB readback and a completed present submission were both observed. |

## Replay-boundary finding and fix

Static inspection found that the producer publishes `BEGIN_PASS`, state, draw,
and `END_PASS` as separate atomic ring records. The worker previously sampled
the producer write index once per drain and unconditionally ended any open pass
at that snapshot boundary. A snapshot can therefore split a valid producer
pass, discard the consumer's pass-local state, and replay later state or draw
records with no pass open.

The consumer now scans the visible ring prefix and stops before an incomplete
`BEGIN_PASS`. It advances the shared read index only after the matching
`END_PASS` is visible, while still consuming safe resource records before the
pass. The ring is large enough for the observed command batches; retain
`wgpuatomic=0` while validating unusual scenes in case a future pass approaches
the ring capacity.

This is a replay-correctness fix, not a claim that `video=wgpu` is playable.
The current evidence package contains synthetic boundary tests plus headed
atomic-replay diagnostics; it does not package the older legacy-replay research
runs and does not rely on their counters.

A separate transport defect made `nojitcache=1` skip the pthread command-ring and
show-image listeners together with the optional JIT cache. That coupling is now
removed: renderer transport always installs, while cache broadcast, compile,
and lazy-fill work remains disabled. A post-fix headed run with `nojitcache=1`
registered the ring, replayed 8,323 atomic passes with no splits or outside-pass
records, submitted 394,160 real EFB draws, and completed present submission.
All nine bounded post-draw EFB readbacks in that short run were zero, so it
reported `EFB_DRAW_NO_MUTATION`; presentation and visual FPS remained zero.
That result was a time-bounded observation, not proof that no later draw could
mutate the EFB. These diagnostics are not a performance qualification.

A longer headed run on the same Ryzen 9 9950X3D/RDNA-4 machine later observed
the EFB become nonzero at present sequence 871: 920,925 of 1,351,680 sampled
bytes were nonzero. Later runs again ended with only zero samples. The original
short-run classification was therefore too broad: commands and valid draws can
mutate the EFB, but mutation timing is not deterministic and the visible canvas
still does not show the game. The bounded state snapshot identifies the first
EFB command as a utility `draw(3)` on pipeline 22 and the first indexed EFB
draw as pipeline 420; both had resolved pipelines, all three bind groups, and
no missing-resource or validation error. Treat the remaining problem as a
load/replay/presentation correctness issue, not a proven permanent shader-draw
failure. Raw values and hashes are packaged in
`perf-results/wgpu-first-efb-2026-07-10.json`.

Historical Day-28 shader/UV dumps and per-draw EFB maps are now default-off;
they were still running in the replay hot path after their investigations had
finished. Use `wgpudeepdiag=1` only to reproduce those probes. Two diagnostic
15-second pairs moved replay cost per command in the favorable direction with
the probes disabled, but the runs remain non-qualifying and do not establish a
stable gameplay-performance gain.

The classifier is the dynamic check for that condition. It does not establish
that every black frame has the same cause: after pass atomicity is clean, use
the missing-resource and EFB-mutation stages to identify the next failure.

## Save-load and upload-lifetime finding

Repeated headed Chrome runs against the fixed Kirby-versus-Link save produced
different ring states at the load boundary. One boundary was empty. Another
contained 924 pending records beginning with `BEGIN_PASS`: one begin, no end,
108 indexed draws, and 78,244 bytes of upload records. Save loading therefore
does not currently establish a deterministic replay epoch.

The same run reached a 117,979-record backlog containing 63,369,752 bytes of
upload references and two pointer wraps while the shared upload arena is only
32 MiB. That violates the upload-lifetime capacity invariant: pending commands
can refer to arena regions the producer has already reused. Stale vertex,
index, uniform, or texture payloads are consequently a concrete explanation
for valid-looking draws that leave the EFB wrong.

`wgpupump=1` is a default-off experiment that enables frequent replay polling
and advertises only a 16,384-record producer credit window. It reduced observed
backlog high water to 13,147 records in a 30-second diagnostic and kept the
bounded high-water upload set to 6,582,068 bytes. This is useful isolation, not
the final upload-lifetime protocol and not a performance qualification. The
correct producer fix needs a monotonic upload cursor plus consumer release only
after `writeBuffer`, `writeTexture`, or a heap copy has consumed each payload.

That 30-second run still recorded 524,151 EFB draws and eight present-boundary
EFB samples with zero RGB through present 1033. At present 310, however, the
selected source texture had 918,651 nonzero RGB bytes and the backbuffer had
209,289 nonzero RGB bytes. Queue completion succeeded. The data proves that
some downstream textures mutate; it does not prove that they contain the
correct game frame.

`wgpudetached=1` is another default-off diagnostic. It presents through a
standalone worker `OffscreenCanvas`, waits for submitted GPU work, transfers a
coalesced `ImageBitmap`, and paints it on the main canvas. A headed confirmation
delivered and painted 404/404 bitmaps with zero drops (0.035 ms last draw,
3.215 ms maximum), yet the visible result remained the wrong colored
checker/demo-like output and both presentation and visual FPS metrics remained
zero. This rules out bitmap delivery failure for that experiment; it does not
make `video=wgpu` playable.

The machine-readable evidence and raw-artifact hashes are in
`perf-results/wgpu-replay-epoch-2026-07-10.json`. Every cited WGPU run failed
the known battle/XFB checkpoint and is explicitly non-qualifying.

## Experimental query flags

| Flag | Purpose | Default |
| --- | --- | --- |
| `wgpuclassify=1` | Enable bounded v2 replay/load/presentation classification | Off |
| `wgpudeepdiag=1` | Restore historical high-volume shader and draw probes | Off |
| `wgpuatomic=0` | Roll back atomic-pass replay for controlled comparison | Atomic replay is on |
| `wgpuloadfence=1` | Discard a pre-load incomplete pass through its first end marker | Off |
| `wgpupump=1` | Enable frequent replay polling and the 16,384-record credit experiment | Off |
| `wgpudetached=1` | Send GPU-completed worker-canvas bitmaps to the main canvas | Off |

## Validation discipline

Use the version-matched Kirby/Link battle save state and repeat the same headed
Chrome run. Preserve the raw JSON, URL, repository commit, core artifact hash,
browser/GPU identity, scene, and duration. Do not infer a rendering or
performance improvement from the classifier alone; compare canvas hashes,
unique visual FPS, and game-speed metrics before and after a behavior change.

When the known WGPU XFB checkpoint prevents a diagnostic run from reaching the
timed scene, set `PERF_CONTINUE_INVALID_CHECKPOINT=1`. The harness will resume
and capture evidence but keeps the run invalid and non-qualifying.
