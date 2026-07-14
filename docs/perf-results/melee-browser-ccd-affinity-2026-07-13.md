# Headed Chrome CCD-affinity screen (2026-07-13)

This host-level screen tested whether Windows scheduling across the two CCDs of
the Ryzen 9 9950X3D contributes to benchmark variance. It does. This is not an
emulator speedup and does not establish realtime rendering by itself.

Windows topology reported logical CPUs 0-15 behind a 96 MiB L3 cache and CPUs
16-31 behind a 32 MiB L3 cache. A temporary wrapper constrained only Chrome
processes created for each run; processes exited at the end of every run and no
power-plan setting was changed.

| Arm | Runs | Mean game speed | Median game speed |
| --- | ---: | ---: | ---: |
| CPUs 0-15 / V-cache CCD | 4 | 66.832% | 61.828% |
| CPUs 16-31 / other CCD | 4 | 55.514% | 55.166% |

The V-cache arm was +20.39% by mean and +12.08% by median. One V-cache run
reached 82.671%, demonstrating that scheduler placement explains a substantial
part of the previously observed 54-83% regime spread, but not the remaining gap
to realtime. All eight null-drain runs were valid.

Raw artifacts are under `.omx/wgpu-realtime-100/affinity-{lower,upper}-null-{1..4}`.

Future comparisons on this machine should constrain the test browser to CPUs
0-15 and record the mask. The timestamp-based discovery wrapper used for this
screen is local measurement scaffolding, not a product default. The committed
perf harness instead uses temporary parent affinity so only its browser process
tree inherits the requested mask.

On this machine, use:

```powershell
$env:PERF_CPU_AFFINITY_MASK = '0xFFFF'
npm run perf:gate
```

The harness fails closed on an invalid or unapplied mask and records the parent
mask snapshot, requested application, and restoration in the run manifest,
summary, and aggregate report. An end-to-end smoke recorded
`0xffffffff -> 0xffff -> 0xffffffff`, completed the fixed work unit, and was
individually valid. Its 60.914% speed is a single infrastructure smoke, not a
new performance claim.
