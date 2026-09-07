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

Current baseline, `video=wgpu`, 46 discs (Wario World extracted from its zip),
2026-09-07, after the ClearRect viewport fix, `JITWARMUP=60`:

| | value |
| --- | ---: |
| boots | 39 (5 static, 2 black) |
| titles at >=95% game speed | 22 |
| titles at >=80% | 23 |

Report: `.omx/boot-matrix/2026-09-07T03-52-17-254Z/results.md`. The five
statics: Animal Crossing x2 (issue #11), SoulCalibur 2 Plus and One Piece
Grand Adventure (both parked on a memory-card dialog, rendering correctly),
and Sonic Adventure DX (black through its intro, renders its attract scene at
30s, and the 45s window ends on a later blank transition -- the Naruto/Paper
Mario pattern, checked three ways below). The two blacks are Resident Evil
Code: Veronica X and GoldenEye Rogue Agent disc 2, which dies with a worker
error at frame 105. Screenshot-verified in this sweep: **Super Mario
Sunshine's beach background now renders** behind the file select, and Kirby
Air Ride's race is in full colour with green grass.

Previous baseline, 45 discs, before the viewport fix:

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
| Super Mario Sunshine | boots | **fixed 2026-09-07**: beach background renders behind the file select (ClearRect viewport fix, below) |

Sunshine proved at least one more frame-destroying path existed; it was the
ClearRect depth going through the viewport, the same defect as Mario Kart
Wii's black world. Of the three
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

   Routing partial clears to VideoCommon's scissored-quad fallback was tried
   and reverted: it ends and restarts a render pass per clear, and Wario
   World's ~7,800 clears a frame drop it to a near-black frame at 2.0 visual
   fps. A working fix needs a clear that does not tear down the pass.

   **Fixed and ON by default (2026-09-06). Opt out with
   `?disable=0x2000000`.** The `ClearRect` opcode draws a scissored full-screen
   triangle inside the open pass, so the pass is never torn down. It blanked
   the frame from the day it was added until the cause was measured: it wrote
   the producer's clear depth, 0.9999999403953552, while the `loadOp` path
   writes `dcv = 0.0` because this backend runs the reverse-Z convention and
   flips every flippable compare to the greater family. Against a reference of
   1.0 nothing passes the depth test, so every draw after a depth-clearing
   `ClearRect` was rejected. It now uses the same value the `loadOp` path uses.

   With it enabled, Double Dash renders a full correct 3D scene and Mario Kart
   Wii renders its 2D overlay exactly as on the default path -- where before it
   produced an entirely black frame. (Mario Kart Wii's 3D world stayed black
   for one more reason, found and fixed on 2026-09-06: the clear triangle's
   depth was going through the game's viewport depth range. See the root-cause
   section under the Mario Kart Wii heading below.)

   Five-title A/B, 60-70s each, `video=wgpu presenter=webgpu`, clear path off
   then on:

   | title | off | on |
   | --- | --- | --- |
   | Wario World | 70 hashes, 100%, 60.0 fps | 70 hashes, 100%, 60.0 fps |
   | Melee | 47 hashes, 100% | 41 hashes, 101% |
   | Double Dash | 56 hashes, 100% | 54 hashes, 100% |
   | F-Zero GX | 54 hashes, 100% | 55 hashes, 100% |
   | Pikmin 2 | 24 hashes, 46% | 24 hashes, 47% |

   No regression anywhere. Wario World matters most: it is the title the
   earlier scissored-quad rewrite dropped to 2.0 visual fps, it issues ~7,800
   clears a frame, and it is untouched at a full 60. Hash counts move within
   scene-timing noise and speeds are unchanged.

   Two of the first runs reported `hashes=0 speed=0%` and looked like total
   regressions; both were "Timed out waiting for Dolphin mount", a harness
   startup failure on back-to-back runs, and passed on a retry. Worth checking
   the log before reading a zero as a result.

   The cost of not enabling it is now quantified: the EFB pass is begun 16
   times in one Mario Kart Wii frame with 4 whole-attachment clears, and only
   142 of 390 EFB draws land after the last one. **64% of the frame's geometry
   is destroyed by clears that should not be touching it.**

   Enabling it costs a little speed rather than gaining any. On the
   deterministic save states, default-on versus forced-off: Double Dash 28% vs
   32%, Mario Kart Wii 43% vs 45% -- 4 and 2 points lower, the price of a
   scissored draw per clear instead of a free `loadOp`. The five-title sweep
   above showed no change because those runs are menus and attract modes rather
   than loaded races. Correctness was chosen over the few points; the opt-out
   restores the old behaviour exactly.
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

### Reference rig for Mario Kart Wii (2026-09-03)

Every earlier MKW comparison in this file compared two runs driven by the
harness's random input script, which diverge -- so they compared different
scenes. Three retractions came from that. There is now a deterministic rig:

```bash
MSYS_NO_PATHCONV=1 BASE_URL="http://127.0.0.1:8080/"   ROM="F:/Emulation/Wii_ISO/Mario Kart Wii (USA) (En,Fr,Es).iso"   VIDEO=wgpu PRESENTER=webgpu   SAVE_STATE_URL="/__mkw-race.sav" SAVE_STATE_AT=40   INPUT_SCRIPT=none DURATION=80   node tools/menu-progress-validate.mjs
```

`__mkw-race.sav` is an in-race state captured with `SAVE_STATE_CAPTURE_AT`; it
is gitignored (`*.sav`), so re-capture it if missing. `INPUT_SCRIPT=none` is
what makes the scene identical across runs. Swap `VIDEO=software` for the
reference frame: software renders this state correctly, WebGPU does not, which
is what establishes the remaining defects as backend bugs rather than game
state.

**`PRESENTER=webgpu` is required with `VIDEO=wgpu`.** The harness defaults the
presenter to `webgl` for every value of `VIDEO` except `software`. With
`video=wgpu presenter=webgl` the command ring is never consumed --
`completedPassCount = 0` -- the canvas stays static, and the run silently
measures nothing while still reporting fps. Any `video=wgpu` result recorded
without it is suspect.

### Root cause of the black world (2026-09-06): the ClearRect depth went through the viewport

Found by reading the EFB depth buffer INSIDE the frame rather than at present
time (`DIAG_DEPTH_TRACE` in `src/upstream-discio-worker.js`: it ends the EFB
pass after chosen draws and before each depth-clearing ClearRect, copies the
depth and colour attachments in the same encoder, and re-opens the pass with
load ops and the game's state restored).

The clear triangle is a draw, so its depth is subject to the viewport depth
range like any other fragment: `window z = minDepth + z * (maxDepth - minDepth)`.
Mario Kart Wii issues its full-viewport clear while the HUD viewport
z(0.89,0.99) is active, so the "0.0" reverse-Z clear wrote **0.89** across the
whole EFB -- a plane nearer than the entire world band z(0.00,0.84). Every world
fragment then failed `greater-equal` and the world was black; the HUD, at
>= 0.89, passed. Measured in one frame:

| readback | depth in the viewport |
| --- | --- |
| after world draw 1 (carried over from the previous frame's clear) | 0.89 at every texel |
| after 119 world draws, all `greater-equal`/write | still 0.89 everywhere |
| after the HUD draws | max rises to 0.98 |
| after the ClearRect, only non-writing draws in between | 0.89 everywhere again |
| control: clear pipeline z=0.5 under the world viewport z(0.00,0.84) | lands as 0.42 |

The control row is the direct proof of the mechanism. The fix sets the depth
range of the game's viewport to [0,1] for the clear triangle, keeping its
rect, and restores the game's range after it. (A first version also widened
the rect to the full pass; Sonic Adventure DX came out black in the sweep
after it, which turned out to be its intro timing rather than the rect --
identical results with the fix off, on, and rect-preserving -- but the
narrower form is what shipped since nothing needed the wider rect.) With it the trace reads 0.0 after the clear, world depth writes land, the
colour buffer holds the scene before the clear, and the screenshot shows road,
barrier, grass, sky and billboard under the pause overlay -- HUD and world
together, on the reverse-Z convention the shader implies. No `GX_NATIVE_DEPTH`
workaround is needed; it "worked" because its unflipped `less-equal` passed
the world against the 0.99 the clear wrote under that convention.

Deterministic states, `video=wgpu presenter=webgpu`, before -> after: Mario
Kart Wii 43% -> 55% game speed, Double Dash 28% -> 34%, and Double Dash's race
scene is unchanged. The viewport reset is skipped when the game's viewport is
already the full-pass [0,1] one, since Wario World issues ~7,800 clears a
frame. Wario World A/B, fix off -> on, 70s each: 63 -> 65 hashes, 80% -> 93%
average speed, 25 -> 30 present fps, throne room correct both ways. F-Zero GX
boots to its name-entry screen at 63-86% with 48 distinct frames. (The
harness's per-sample speed on Wario World alternates 0%/200% while the frame
counter advances steadily; that is the sampler, so the averages above are the
numbers to read.)

A second state leak of the same kind, fixed alongside: after the clear
triangle, ClearRect restored the scissor to the full pass rather than the
scissor the game had set, so every draw until the game's next scissor change
ran un-scissored. It now restores the game's last scissor. Mario Kart Wii and
Wario World render the same with it (38 and 70 hashes, 66% and 94%).

**Why the previous session's depth readback read all zero, and why the first
two runs of this probe did too, control included:** `mapAsync` was called on
the readback buffer before the encoder that copies into it was submitted. Dawn
rejects that submit ("used in submit while pending map") and drops the whole
command buffer -- the frame's draws, the copy, everything -- while the buffer
still maps and reads the zeros it was created with. The trace now queues every
map and drains the queue after `queue.submit()`. A readback that cannot see
its own control write is a null instrument; that check is what caught it.

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
