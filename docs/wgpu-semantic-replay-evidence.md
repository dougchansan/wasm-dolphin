# WGPU semantic replay evidence

`wgpusemantic=1` enables a default-off observer for the true hardware WebGPU
path. It does not package, reorder, suppress, or execute commands. The observer
exists to prove that any future replay-package optimization preserves the
accepted legacy command stream before that optimization can affect rendering.

The flag requires `video=wgpu&metrics=1` and implies the native ownership trace.
A validation URL therefore includes:

```text
video=wgpu&metrics=1&wgpusemantic=1
```

## Evidence chain

The worker combines four independently checked layers:

1. native publication and transaction ownership records;
2. the accepted eight-word legacy command and an immutable payload snapshot;
3. resource-incarnation and ordered dependency annotations;
4. WDS2 encoding followed by the independent WDS2 decoder.

The legacy command is decoded before its upload span can be released or reused,
but it enters the semantic chain only after the replay handler accepts it and
immediately before the authoritative command-ring read cursor advances. Held
upload payloads use the existing retained copy rather than reading a released
arena span.

Runtime evidence appears under `wgpuSemanticRuntime` in renderer diagnostics
and under `webgpu.semanticRuntime` in causal telemetry. A usable prefix requires
`evidenceValid=true`, zero ownership drops/mismatches, equal committed and
independently decoded event counts, and a clean checkpoint.

## Resource reset semantics

The initial resource baseline is attested only before ownership tracing attaches
and before `setVideoBackend`, when all eight browser resource maps are empty, the
WebGPU device is ready, no command ring is registered, and zero commands have
been processed. The native initial `EPOCH` record alone is only an observation
start and cannot establish this baseline.

Save-state loads and core reset retain browser WebGPU objects, so they are not
consumer resets. Save-state loads advance a load epoch while preserving resource
generations. Current device-loss handling also does not clear every resource map;
semantic evidence therefore becomes invalid on device loss.

## Current limitation

This observer validates the accepted legacy stream; it does not yet decode a
real pass-package wire format or prove legacy/package parity. A load-fence discard
can also leave published ownership records unmatched. That must be represented
as an explicit discard disposition before a discarded prefix can be considered
clean evidence.

