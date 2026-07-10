# True WebGPU replay classifier

The true hardware renderer (`video=wgpu`) replays Dolphin GPU commands from a
shared ring in `src/upstream-discio-worker.js`. Add `wgpuclassify=1` to a
validation URL to collect a bounded, machine-readable classifier alongside the
normal renderer diagnostics:

```text
?core=upstream&video=wgpu&presenter=webgpu&wgpuclassify=1&metrics=1
```

The perf harness stores the result at
`rendererDiagnostics.wgpuReplayClassifier` in its raw JSON. Without the query
flag that field is `null`; the classifier does not run.

Atomic pass replay is enabled by default. `wgpuatomic=0` restores the legacy
snapshot behavior for a controlled A/B or immediate rollback; it is not the
recommended path.

## What it classifies

The `wasm-dolphin.wgpu-replay-classifier.v1` payload records six ordered
checkpoints:

1. pass atomicity, including a pass forcibly ended at a drain boundary;
2. missing pipelines, bind groups, buffers, textures, or samplers;
3. EFB clear, real draw, and readback mutation counts;
4. the first real Dolphin draw submitted to a render pass;
5. the first EFB readback containing a nonzero byte;
6. present command submission and the first queue-completion result.

Event storage and missing-resource ID samples are capped. Counters continue to
increase after those caps, so the payload remains useful without producing
shader dumps or an unbounded log. A `loadStateFile` request resets the payload
to scope `load-state-file`, preventing boot activity from being mistaken for
evidence about the loaded Kirby/Link scene.

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

A clean headed Chrome run at commit `4980693` directly observed this invariant
failure: 29 passes ended at a drain boundary and 425 subsequent state records
were replayed outside a pass. The raw manifest is stored locally at
`.omx/wgpu-real/classifier-4980693-clean/software-stable/manifest.json`.

The consumer now scans the visible ring prefix and stops before an incomplete
`BEGIN_PASS`. It advances the shared read index only after the matching
`END_PASS` is visible, while still consuming safe resource records before the
pass. The ring is large enough for the observed command batches; retain
`wgpuatomic=0` while validating unusual scenes in case a future pass approaches
the ring capacity.

This is a replay-correctness fix, not a claim that `video=wgpu` is playable. In
one headed same-code A/B, legacy replay recorded 372 split passes and 63,014
state records outside a pass; atomic replay recorded zero of either. Atomic
replay also produced a nonzero pre-save EFB sample. After the Kirby/Link save
was loaded and resumed, however, more than 110,000 classified EFB draws still
ended in an all-zero EFB sample and the canvas remained the diagnostic grid at
zero presentation/visual FPS. The single A/B showed no material throughput
change and is not a performance qualification. The next failure boundary is
therefore battle draw-to-EFB mutation, before XFB presentation.

The classifier is the dynamic check for that condition. It does not establish
that every black frame has the same cause: after pass atomicity is clean, use
the missing-resource and EFB-mutation stages to identify the next failure.

## Validation discipline

Use the version-matched Kirby/Link battle save state and repeat the same headed
Chrome run. Preserve the raw JSON, URL, repository commit, core artifact hash,
browser/GPU identity, scene, and duration. Do not infer a rendering or
performance improvement from the classifier alone; compare canvas hashes,
unique visual FPS, and game-speed metrics before and after a behavior change.

When the known WGPU XFB checkpoint prevents a diagnostic run from reaching the
timed scene, set `PERF_CONTINUE_INVALID_CHECKPOINT=1`. The harness will resume
and capture evidence but keeps the run invalid and non-qualifying.
