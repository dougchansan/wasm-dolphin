# WebGPU hardware renderer — open bugs

State of `?video=wgpu` measured across all 45 discs in the test library, same
machine, same harness, same day as the software-hybrid sweep it is compared
against. Every claim below was checked against the canvas screenshot, not the
verdict column.

Reproduce:

```bash
VIDEO=wgpu node tools/boot-matrix.mjs --library "<disc library>" --duration 45
```

## Summary

| | software hybrid | `video=wgpu` |
| --- | ---: | ---: |
| boots | 43 | 39 |
| static | 2 | 4 |
| black | 0 | 1 |
| mount-fail | 0 | 1 |

The verdict counts understate the problem. The real split is by content type:

- **2D and UI render correctly.** Wind Waker's save dialog, Mario Kart's mode
  select, Sonic Heroes' team select, F-Zero GX's name entry, Twilight Princess
  and Pikmin 2 memory-card prompts are all correct.
- **3D scene content is missing or wrong.** This is where every defect below
  lives.

Speed is not a compensating win: 10 games faster by more than 5 points, 15
slower, mean 69.8% -> 61.2%. Large wins (F-Zero GX 23 -> 98) sit beside large
losses (Shadow the Hedgehog 101 -> 31). Both are scene-dependent; see the
measurement note in [ARCHITECTURE.md](ARCHITECTURE.md).

## Bugs

### 1. 3D geometry missing while 2D overlays draw

The clearest repro in the library, and the one to start from.

- **Wario World** — near-empty frame with two small tan rectangles. The software
  path renders a fully detailed castle throne room from the same scene. 97% game
  speed, `132/381 draw`, so draws are being submitted and mostly not landing.
- **Super Mario Sunshine** — the "File created." dialog renders correctly on
  pure black. The entire beach scene behind it is absent.

Both show the same shape: overlay/UI geometry survives, world geometry does not.
Draw counts are non-zero, so this is not a submission failure.

### 2. Colour/texture corruption in 3D scenes

- **Luigi's Mansion** — the mansion interior renders with correct geometry but
  desaturated to sepia. The software path renders it in full colour.
- **Kirby Air Ride** — the race scene renders but is heavily pink-shifted; grass
  that is green on the software path is pale pink here.

Geometry is right and lighting is plausible, so this points at texture sampling,
format, or a TEV/blend stage rather than at transform or rasterisation.

### 3. Melee mount is intermittent on the hardware path

Across four runs of `video=wgpu` on Super Smash Bros. Melee: two boot normally
(96-99% game speed, correct character-select render), two fail with
`mount-fail` after a 120s timeout. Roughly 50%, on the project's primary target.
The software path did not fail to mount once across three full sweeps.

### 4. Unique-frame rate is unmeasurable on the hardware path

Every hardware run reports `0.0 visual` while the canvas demonstrably produces
40+ distinct frames. Visual FPS is derived from `xfb-hash`, which the hardware
path bypasses (`visualSampleSource` in `upstream-discio-worker.js`).

This matters more than it looks. The entire justification for the hardware
renderer is beating the software rasteriser's unique-frame ceiling, and that
number currently cannot be measured on the path meant to beat it. Any perf claim
about `video=wgpu` is unsupported until this is fixed.

### 5. Resident Evil Code: Veronica X renders black

Verdict `black` for the whole window. Lower confidence than the others: the
software run was on a different scene at the 45s mark, so this may be an FMV
rather than a defect. Confirm against an earlier checkpoint before chasing it.

## Not bugs

Recorded so they are not re-investigated:

- **Naruto and Paper Mario** end their window on a blank frame on *both* paths.
  They are mid-FMV transition at 45s and render correctly at earlier checkpoints.
- **SoulCalibur 2 Plus** is `static` because it holds an autosave dialog. The
  frame is correct.

## Suggested order

1. **Bug 4 first**, even though it is the least visible. It is small, and until
   it is fixed there is no way to tell whether any later change helped.
2. **Bug 1** next, using Wario World: high draw count, almost no output, a
   simple scene, and a correct software reference frame to diff against.
3. **Bug 2** after, using Luigi's Mansion: geometry is already correct there, so
   it isolates the texture/blend stage without transform noise.
4. **Bug 3** needs a repeat-count harness, not a single run — it is intermittent
   and a single green run proves nothing.

Screenshots for every game and checkpoint are written to the sweep output
directory (`page-t*.png` for HUD state, `canvas-t*.png` for the rendered frame).
