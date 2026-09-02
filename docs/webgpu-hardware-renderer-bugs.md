# WebGPU hardware renderer — open bugs

State of `?video=wgpu` measured across all 45 discs in the test library, same
machine, same harness, same day as the software-hybrid sweep it is compared
against. Every claim below was checked against the canvas screenshot, not the
verdict column.

Reproduce:

```bash
VIDEO=wgpu node tools/boot-matrix.mjs --library "<disc library>" --duration 45
```

## Status: the main defect is fixed

`ClearRegion` was honouring depth-only clears as colour clears, wiping a
fully-rendered EFB immediately before the XFB copy. Fixed in patch 0053.
The sections below are kept as the record of how it was found and what
remains.

### Measured after the fix, all 45 discs

**Every speed number recorded before 2026-08-30 is understated.** The JIT
disable guard judged the JIT by presentation rate against a baseline captured
when it engaged, so entering any heavy scene fused the JIT off -- exactly when
it mattered. Fixed by judging on core fps instead. Boot counts before that date
are also suspect: both harnesses read the optional JIT-cache prewarm status as a
fatal mount failure, producing phantom `mount-fail` verdicts (see issue #10).

Current baseline, `video=wgpu`, 45 discs, after both fixes:

| | value |
| --- | ---: |
| boots | 41 (2 static, 2 black) |
| titles at >=95% game speed | 13 |
| titles at >=80% | 17 |
| mean unique visual fps | 28.4 |

Verified by eye at full speed: Melee (99.5%, character select), Wario World
(100%, throne room), F-Zero GX (99%). Speed is genuinely per-title, not
measurement drift -- mean by sweep position is 69/42/46/54/74%, with no trend.

Previous figures, kept for comparison: mean unique visual fps 7.1 software vs
23.2 hardware, 32 of 45 higher on hardware, 43 vs 41 boots.

Eight titles hold a locked 60 unique fps at ~100% game speed, each
screenshot-verified: F-Zero GX (8 -> 60 fps, 23% -> 101% speed), Wario World,
Mario Kart Double Dash, Kirby Air Ride, Pikmin 2, Melee (Rev 2), Pokemon Box.

F-Zero GX is the clearest case for the hardware path existing at all: it was
the software rasterizer's worst result in the library and is now among the
best.

### What still fails on the hardware path

| game | verdict | note |
| --- | --- | --- |
| Animal Crossing (RVZ + NKit) | static | issue #11, fails on BOTH backends |
| Resident Evil Code: Veronica X | black | unchanged, uninvestigated |
| Soulcalibur II | static | **not a defect** - parked on its autosave dialog, rendering correctly |
| Super Mario Sunshine | boots | menu renders, background still black |

Sunshine proves at least one more frame-destroying path exists. Of the three
hypotheses previously "measured away", the first was wrong -- see below.

1. **`target_rc` partial clears. NOT falsified; the original reasoning was too
   broad.** The old argument was that the EFB is 640x528 while games clear to
   448 high, so every clear is already partial and Wario World issues 7,800 of
   them and renders correctly. That holds only for a game with ONE viewport,
   where over-clearing empty rows costs nothing. Instrumenting `ClearRegion`
   (patch 0055, `WGPUDEEPDIAG=1`) shows Mario Kart Wii issuing clears of
   128x128 at (0,0), 256x256 at (176,100), 192x96 at (208,180) and 32x32 at
   (0,456) -- small rects at non-zero offsets, each of which currently wipes
   the whole 640x528 EFB. The game sets a matching scissor on most of them.
   The defect is real (issue #17).

   No fix exists yet. Routing partial clears to VideoCommon's scissored-quad
   fallback was tried and reverted: it ends and restarts a render pass per
   clear, and Wario World's ~7,800 clears a frame drop it to a near-black
   frame at 2.0 visual fps. A working fix needs a clear that does not tear
   down the pass.
2. **The XFB copy is taken too early.** Falsified. The EFB passes before each
   copy use `loadOp=load`, so content accumulates ACROSS the backbuffer
   present. Re-aligning a frame as the span between XFB copies, Sunshine's
   copy captures ~196 draws including its largest batch. The backbuffer
   present is not the GX frame boundary; draw counts split across it look
   discarded and are not.
3. **The renderer cannot draw the scene.** Falsified. `DIAG_EFB_TO_CANVAS`
   (JS-only, no rebuild) blits the EFB straight to the canvas and shows
   Sunshine's complete file-select screen -- beach, palm tree, ocean,
   seagulls, Mario, file boxes, OPTIONS sign.

What remains is downstream of the copy: the **XFB blit source rect** (XFB#47
is a 2560x1024 atlas and the backbuffer is 320x240, so which region is sampled
matters) or the **copy's own source rect** (Sunshine copies 640x448 where
Wario copies 512x448, against a 640x528 EFB).

Methodological note, learned five times on this bug: **structure does not show
content.** Sizes, rects, bind targets and draw counts each produced a confident
wrong reading. The only probe that read actual pixels contradicted the
structural inference immediately. Measure output, not description.

---

## Summary (pre-fix baseline, kept for comparison)

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

## Wii / Mario Kart Wii: presentation is exonerated (2026-09-01)

Mario Kart Wii renders 2D correctly and 3D as flat rectangles. A whole-frame
capture (`?framecap=N`) settles where that comes from.

One frame, present #4000, 586 records:

```
BEGINPASS fb#14 (EFB 640x528)      game renders, ~540 draws
BEGINPASS fb#93 608x456            EFB->XFB copy, binds tex#14
BEGINPASS fb#47 2560x1024          vp 0,0+304x456, binds tex#14
BEGINPASS fb#0 BACKBUFFER 640x480
  VIEWPORT 0,65+640x350            correct widescreen letterbox
  BINDTEX  tex#93 608x456          the XFB entry
  DRAW x1
PRESENT
```

**The EFB viewed directly in-race shows the same breakage as the screen.**
Everything after the EFB carries a defect that already exists in it, so this is
issue #8 and not a presentation bug.

Ruled out with evidence: backbuffer size (was 320x240 against a 640x480
request — real, fixed, symptom persists), the XFB->backbuffer blit's geometry
and buffer choice, the EFB->XFB copy and its source rect, XFB entry population,
and the XFB RAM fallback (104 cache hits, 0 misses). #15's half-width blit is
real but targets fb#47, which nothing samples for presentation.

### Diagnostics available

| flag | what it shows |
| --- | --- |
| `?efbdiag=1` | blits the EFB colour texture straight to the canvas |
| `?efbdiag=2` | blits the XFB entry last presented |
| `?framecap=N` | dumps the Nth present as an ordered pass/draw trace |
| `?jitverbose=1` | ranks instructions that block JIT compilation |

### Method note

Three separate single-sample readings during this investigation were wrong:
"the EFB does not contain the 3D world" (the measurement never ran), "presented
entries are sometimes empty" (a readback artifact from encoder batching), and
"the XFB entry has no HUD" (a pre-race intro frame compared against an in-race
one). Each looked decisive. The whole-frame capture exists because piecewise
probes kept producing mutually inconsistent pictures — which is the signature
of measuring the wrong thing, not of a subtle bug.

## Bugs

### 1. 3D geometry missing while 2D overlays draw — FIXED (patch 0053)

The clearest repro in the library, and the one to start from.

- **Wario World** — near-empty frame with two small tan rectangles. The software
  path renders a fully detailed castle throne room from the same scene. 97% game
  speed, `132/381 draw`.

  **Correction:** that figure was long read as "draws submitted and mostly not
  landing". It is not a landed-vs-submitted ratio. The HUD field is
  `prim/draw` -- `g_stats.this_frame.num_prims` over
  `num_draw_calls` (core/upstream/dolphin_web_discio.cpp) -- both counted at
  SUBMISSION by Dolphin. It carries no information about what reached the EFB.
  Wario World reads 136/379 when rendering correctly and 124/380 when rendering
  a near-black frame, so the metric does not even separate working from broken.
- **Super Mario Sunshine** — the "File created." dialog renders correctly on
  pure black. The entire beach scene behind it is absent.

Both show the same shape: overlay/UI geometry survives, world geometry does not.
Draw counts are non-zero, so this is not a submission failure.

### 2. Colour/texture corruption in 3D scenes — FIXED for Luigi's Mansion (same cause)

- **Luigi's Mansion** — the mansion interior renders with correct geometry but
  desaturated to sepia. The software path renders it in full colour.
- **Kirby Air Ride** — the race scene renders but is heavily pink-shifted; grass
  that is green on the software path is pale pink here.

Geometry is right and lighting is plausible, so this points at texture sampling,
format, or a TEV/blend stage rather than at transform or rasterisation.

### 3. Melee mount is intermittent on the hardware path — OPEN (issue #10)

Across four runs of `video=wgpu` on Super Smash Bros. Melee: two boot normally
(96-99% game speed, correct character-select render), two fail with
`mount-fail` after a 120s timeout. Roughly 50%, on the project's primary target.
The software path did not fail to mount once across three full sweeps.

### 4. Unique-frame rate is unmeasurable on the hardware path — FIXED (issue #7)

Every hardware run reports `0.0 visual` while the canvas demonstrably produces
40+ distinct frames. Visual FPS is derived from `xfb-hash`, which the hardware
path bypasses (`visualSampleSource` in `upstream-discio-worker.js`).

This matters more than it looks. The entire justification for the hardware
renderer is beating the software rasteriser's unique-frame ceiling, and that
number currently cannot be measured on the path meant to beat it. Any perf claim
about `video=wgpu` is unsupported until this is fixed.

### 5. Resident Evil Code: Veronica X renders black — OPEN

Verdict `black` for the whole window. Lower confidence than the others: the
software run was on a different scene at the 45s mark, so this may be an FMV
rather than a defect. Confirm against an earlier checkpoint before chasing it.

## Not bugs

Recorded so they are not re-investigated:

- **Naruto and Paper Mario** end their window on a blank frame on *both* paths.
  They are mid-FMV transition at 45s and render correctly at earlier checkpoints.
- **SoulCalibur 2 Plus** is `static` because it holds an autosave dialog. The
  frame is correct.

## Suggested order (updated)

Bugs 1, 2 and 4 are resolved. What remains, in order:

1. **Super Mario Sunshine's missing background.** The one open rendering
   defect with a clear repro, but FIVE hypotheses have now been measured and
   rejected (see above, plus "presentation reads the EFB" -- Wario World
   renders correctly with a 0%-lit EFB at present time). Do NOT continue
   instrumenting the pipeline's description. Every wrong reading so far came
   from inferring content from structure: sizes, rects, bind targets, draw
   counts. Read back the BACKBUFFER TEXTURE itself after present, and bisect
   by suppressing individual passes to see which removal changes the image.
2. **Animal Crossing (#11).** Fails on both backends, so it is not a hardware-
   path bug. The EFB receives 178-188M colour writes and the presented buffer
   is still exactly zero, so the fault is in the EFB -> XFB copy.
3. **Melee mount intermittency (#10).** Needs a repeat-count harness; a single
   green run proves nothing.
4. **Kirby Air Ride colour (#9).** Never re-verified like-for-like -- the
   original report was a race scene, the post-fix check reached player select.
5. **Resident Evil Code: Veronica X.** Lowest confidence that it is a defect
   at all.

Screenshots for every game and checkpoint are written to the sweep output
directory (`page-t*.png` for HUD state, `canvas-t*.png` for the rendered frame).
