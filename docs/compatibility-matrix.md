# GameCube boot-compatibility matrix

First breadth test of the upstream core beyond Melee. 45 unique disc images,
45 s each, on the shipping software-hybrid path
(`video=software&presenter=webgpu&cpu=dual&wasmjit=1&jitwarmup=700&fastsw=1`).

Reproduce with:

```bash
node tools/boot-matrix.mjs --library "F:/Games/Library/GameCube" --duration 45
```

Raw results, per-game samples, and screenshots land in `.omx/boot-matrix/<stamp>/`.

## Headline

| | |
| --- | --- |
| Discs tested | 45 |
| Mount failures | **0** |
| Reached a real rendered screen | **44** |
| Still on a boot logo at 45 s | 1 |
| Rendering defects found | 1 |

Every disc mounted. `.iso`, `.rvz`, `.ciso`, and `.nkit.iso` all work — RVZ and
CISO are decompressed inside the core, so no host-side conversion is needed.
`.zip` is not a disc format and must be extracted first.

## Verified by screenshot

Each game's canvas was read and compared against the screen it should be
showing. 44 of 45 rendered correctly — publisher logos, memory-card dialogs,
title screens, menus, and in several cases live gameplay:

- **In-game/gameplay verified:** Luigi's Mansion (mansion interior, HUD intact),
  Wario World (castle throne room), Kirby Air Ride (mid-race with countdown),
  Sonic Adventure 2 Battle (bridge cutscene).
- **Menus/dialogs verified:** Wind Waker, Four Swords, Ocarina of Time & Master
  Quest, Mario Kart Double Dash, Super Mario Sunshine, Star Fox Adventures,
  Soulcalibur II, Super Monkey Ball Deluxe, Pokémon Box, Pokémon Channel,
  Resident Evil 1/2/3, Melee.
- **Boot logos verified:** Metroid Prime, Metroid Prime 2, Metal Gear Solid: The
  Twin Snakes, Pokémon Colosseum, Pokémon XD, Paper Mario, RE Code Veronica X,
  RE Zero, GoldenEye Rogue Agent, Naruto.

## Defects found

**Yu-Gi-Oh! The Falsebound Kingdom has corrupted menu text.** The scene renders
correctly, but the "NEW GAME" / "LOAD GAME" labels carry heavy blue and magenta
fringing. Geometry and textures elsewhere are clean, so this points at a
specific text/overlay blend path rather than a general rasterizer fault.
Reproduces identically across runs.

Two games end the run on a blank frame but are **not** defects — Naruto and
Paper Mario are mid-FMV transition at 45 s and render correctly at earlier
checkpoints.

## The first sweep found a bug in this repo, not in the games

The initial run reported Animal Crossing rendering nothing while its core ran
at 100 % game speed with ~7000 draws a frame. That was not a game problem. It
was a regression in `createWebGpuPresenter`, which had been made to force the
canvas to 640x480 for the hardware renderer's benefit — on a function the
shipping software hybrid shares. Animal Crossing presents 608x464, so it went
black, silently, with no validation or device error.

Two plausible-looking theories were tested and killed first, which is worth
recording because both would have been easy to believe:

- **VI field mode.** Animal Crossing runs `halfline=1030`. So do Mario Kart
  Double Dash, Twilight Princess, Pikmin 2 and Wario World, all rendering
  correctly. Not the discriminator.
- **Truncated dumps.** Both Animal Crossing images are 19-26 MB against a
  1.36 GB disc. The FST holds 11 entries totalling ~26 MB with in-range
  offsets: the game really is that small, and RVZ/NKit strip the padding.

What actually localised it was running the same disc on `presenter=webgl`,
which rendered it correctly — moving the fault off the core, the disc and the
VI and onto the WebGPU presenter. Fixed; the table above is the post-fix sweep.

The general lesson for this harness: a breadth sweep is as likely to find a bug
in the emulator's own presentation path as in any game, and only a game whose
XFB is not 640x480 could have exposed this one. Melee never would have.

## Speed: why one number would lie

One disc never left the boot logo inside the window — Animal Crossing
(`.nkit.iso`) at ~7 %. Its RVZ sibling of the same game ID reaches the title
screen at 98-103 %, so this is boot-phase variance, not a per-title limit.
Pikmin 2 (`.iso`) was in the same state before the presenter fix and now
progresses at ~54 %.

For everything else, the window average and the steady-state tail disagree in
**both** directions, so neither is a compatibility grade:

- Shadow the Hedgehog 29 % window → **99.5 %** tail, Sonic Adventure 2 Battle
  26 % → **99.5 %**. The JIT engaged late; steady state is full speed.
- Metroid Prime 2 99 % window → **25 %** tail, Resident Evil 3 97 % → **24.5 %**.
  These reached a heavy scene and genuinely slowed down.

The number depends entirely on which scene the 45 s window happened to land in.
Roughly half the library sits at 95–103 % once warm; the heavier 3D titles
(Metroid Prime, MGS, F-Zero GX, Star Fox Adventures, Soulcalibur) run 20–50 %.

Run-to-run variance in early boot is real and was observed directly: Animal
Crossing's RVZ classified differently across two runs of the same build. Treat
any single boot-phase number as a sample, not a measurement.

## What this does not claim

45 s of generic "press A and Start" proves a game boots, mounts, and renders.
It does not prove playability, audio correctness, or that a game stays stable
past its opening minutes. Per-game route validation — the way
`tools/menu-progress-validate.mjs` drives Melee — is still the only way to make
that claim for a specific title.
