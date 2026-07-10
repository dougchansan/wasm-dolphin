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
shader dumps or an unbounded log.

| Classifier code | Meaning |
| --- | --- |
| `PASS_SPLIT_AT_DRAIN` | The consumer ended an open render pass because its current ring snapshot ended. |
| `MISSING_RESOURCES` | At least one replay record referenced a resource absent from the consumer maps. |
| `EFB_DRAW_NO_MUTATION` | A real EFB draw executed, but the sampled EFB readback remained all zero. |
| `WAITING_FOR_DRAW` | No fully bound real draw has executed yet. |
| `WAITING_FOR_EFB_READBACK` | A draw executed, but the bounded EFB readback checkpoint has not completed. |
| `PASS` | A nonzero EFB readback and a completed present submission were both observed. |

## Current replay-boundary hypothesis

Static inspection found that the producer publishes `BEGIN_PASS`, state, draw,
and `END_PASS` as separate atomic ring records. The worker previously sampled
the producer write index once per drain and unconditionally ended any open pass
at that snapshot boundary. A snapshot can therefore split a valid producer
pass, discard the consumer's pass-local state, and replay later state or draw
records with no pass open.

The classifier is the dynamic check for that condition. It does not establish
that every black frame has the same cause: after pass atomicity is clean, use
the missing-resource and EFB-mutation stages to identify the next failure.

## Validation discipline

Use the version-matched Kirby/Link battle save state and repeat the same headed
Chrome run. Preserve the raw JSON, URL, repository commit, core artifact hash,
browser/GPU identity, scene, and duration. Do not infer a rendering or
performance improvement from the classifier alone; compare canvas hashes,
unique visual FPS, and game-speed metrics before and after a behavior change.
