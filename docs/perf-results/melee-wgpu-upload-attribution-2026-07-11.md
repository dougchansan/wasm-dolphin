# Melee hardware-WGPU upload attribution (2026-07-11)

This package records the item-1 instrumentation validation for the direct
`__battle.sav` Kirby-versus-Link scene. It validates conserved WebGPU upload
accounting; it is not evidence of a performance improvement.

Eight headed Chrome runs formed two complete four-run blocks. In every run,
role call/byte totals exactly equaled opcode and upload-bucket totals. The
screening comparison was rejected (median effect -3.86%; 95% block-bootstrap
interval -7.25% to -0.47%), and qualification failed because some runs retained
upload timeouts, abort/drop counters, or a zero first-pass RGB EFB probe.

The companion JSON contains per-run conserved totals plus manifest and summary
hashes. The full event streams remain machine-local under gitignored `.omx/`
paths and are not committed.

Decision: keep the attribution instrumentation as a measurement tool; do not
promote any rendering optimization from this screen.
