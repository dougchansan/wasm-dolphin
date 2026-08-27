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
| Reached a real rendered screen | **43** |
| Still on a boot logo at 45 s | 2 |
| Rendering defects found | 2 |

Every disc mounted. `.iso`, `.rvz`, `.ciso`, and `.nkit.iso` all work — RVZ and
CISO are decompressed inside the core, so no host-side conversion is needed.
`.zip` is not a disc format and must be extracted first.

## Verified by screenshot

Each game's canvas was read and compared against the screen it should be
showing. 43 of 45 rendered correctly — publisher logos, memory-card dialogs,
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

**Animal Crossing (RVZ) renders nothing.** The core is healthy — 93–101 % game
speed, 60 core fps, thousands of draws submitted per frame (`7221/259 draw`) —
but the canvas is black for the entire run and unique visual fps reads exactly
`0.0`. Emulation is fine and the presentation path produces no frames at all.
This is the cleanest "renders nothing while the core is perfectly alive" repro
in the library and the best case to debug the XFB/present path against.

**Yu-Gi-Oh! The Falsebound Kingdom has corrupted menu text.** The scene renders
correctly, but the "NEW GAME" / "LOAD GAME" labels carry heavy blue and magenta
fringing. Geometry and textures elsewhere are clean, so this points at a
specific text/overlay blend path rather than a general rasterizer fault.

Two other games end the run on a blank frame but are **not** defects — Naruto
and Paper Mario are mid-FMV transition at 45 s and render correctly at earlier
checkpoints.

## Speed: why one number would lie

Two games never left the boot logo inside the window — Animal Crossing
(`.nkit.iso`) and Pikmin 2 (`.iso`), both ~7 %. Both have a sibling dump of the
same game ID that booted to full speed, so this is boot-phase variance, not a
per-title limit.

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
