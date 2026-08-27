# GameCube boot-compatibility matrix

First breadth test of this branch beyond Melee. 45 unique disc images, 45 s
each, on the recommended software-hybrid path from `docs/current-status.md`
(`video=software&presenter=webgpu&cpu=dual&wasmjit=1&jitwarmup=700&fastsw=1`).

```bash
node tools/boot-matrix.mjs --library "F:/Games/Library/GameCube" --duration 45
```

Raw results, per-game samples, and screenshots land in `.omx/boot-matrix/<stamp>/`.

## Headline

| | |
| --- | --- |
| Discs tested | 45 |
| Mount failures | **0** |
| Reached a real rendered screen | **43** |
| Alive but parked on one frame | 3 |
| Rendering defects found | 2 |

Every disc mounted. `.iso`, `.rvz`, `.ciso` and `.nkit.iso` all work — RVZ and
CISO are decompressed inside the core, so no host-side conversion is needed.
`.zip` is not a disc format and must be extracted first.

## Defects

**Animal Crossing renders nothing.** The core is healthy — 100-105 % game
speed, 60 core fps, 3,900-7,300 draws submitted per frame — but the canvas is
black for the whole run and unique visual fps reads exactly `0.0`. It fails
identically under `presenter=webgl` **and** `presenter=webgpu`, so the fault is
upstream of the presenter, somewhere in the software raster or frame-delivery
path. Animal Crossing presents 608x464, which is an unusual XFB geometry for
this library; every game that renders correctly here is 448, 480 or 538 tall.
That correlation is the obvious first lead and has not yet been tested.

This is worth prioritising because the same game renders correctly on the
`webgpu-hardware-renderer` branch, where the equivalent symptom was a
presenter-only bug and was fixed. Here it survives a presenter swap, so it is a
different and deeper fault.

**Yu-Gi-Oh! The Falsebound Kingdom has corrupted menu text.** The scene renders
correctly, but the "NEW GAME" / "LOAD GAME" labels carry heavy blue and magenta
fringing. Geometry and textures elsewhere are clean, so this points at a
text/overlay blend path rather than a general rasterizer fault. It reproduces
pixel-for-pixel on the other branch too, so it is long-standing in both lines
rather than a recent regression.

The other two parked entries are not defects: SoulCalibur 2 Plus is holding its
autosave dialog and Animal Crossing's `.nkit.iso` is still on the boot logo at
9 %, both correctly rendered.

## Compared against the webgpu-hardware-renderer branch

Both sides measured with the same harness and library on the same machine, so
the comparison is like-for-like.

| | this branch | webgpu-hardware-renderer |
| --- | ---: | ---: |
| boots | 42 | 44 |
| alive but static | 3 | 1 |
| mount failures | 0 | 0 |
| mean steady-state speed | 72.2 % | 69.8 % |

Per game, on steady-state speed: 14 faster here by more than 3 points, 6 slower,
25 within 3 points.

**The speed differences are mostly not renderer differences.** The largest
apparent win, Sonic Adventure 2 Battle at +73 points, is a game that was still
inside JIT warmup when the other branch's window closed; both reach ~99 % once
warm. The largest apparent loss, Resident Evil 3 at -80, is a run that had
entered an FMV with `0/0 draw` when the window closed, against a title screen on
the other side. The 45 s window lands in a different scene on each run and the
tail number follows the scene, not the code. Only the verdict column and the
screenshots carry real signal here.

What the comparison does establish: **this branch regresses Animal Crossing**.
It renders on the other branch and is black here under both presenters.

## Speed: why one number would lie

The window average and the steady-state tail disagree in both directions, so
neither is a compatibility grade:

- Shadow the Hedgehog and Sonic Adventure 2 Battle read ~26-29 % over the whole
  window and ~99.5 % on the tail. The JIT engaged late; steady state is full
  speed.
- Resident Evil 3 and Metroid Prime 2 read the other way, high over the window
  and low on the tail, because they reached a heavy scene.

By steady-state tail, roughly half the library sits at 90 %+, and the heavier 3D
titles (Metroid Prime, Metal Gear Solid, F-Zero GX, Star Fox Adventures,
Soulcalibur) plus anything still in JIT warmup at 45 s make up the rest.

## What this does not claim

45 s of generic "press A and Start" proves a game boots, mounts, and renders. It
does not prove playability, audio correctness, or that a game stays stable past
its opening minutes. Per-game route validation — the way
`tools/menu-progress-validate.mjs` drives Melee — is still the only way to make
that claim for a specific title.

The harness reads the emulator's own counters. Two separate bugs in this
session's runs came from the probe misreading a healthy emulator rather than
from any game, so a surprising verdict should be checked against the canvas
screenshots before it is believed.
