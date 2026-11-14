# Wii Remote input

Wii discs boot on this core, but until now nothing could drive a Wii Remote:
`CoreInit` never called `Wiimote::Initialize`, so Wii titles ran with no
remote at all. This adds two ways to play them.

1. **An emulated Wii Remote** driven by keyboard, mouse and gamepad, with an
   optional Nunchuk or Classic Controller.
2. **Real Wii Remotes over WebHID.** This works with a Mayflash DolphinBar in
   mode 4, which shows up as four "Nintendo RVL-CNT-01" HID interfaces, one per
   player. It also works with a remote paired to the computer over Bluetooth.
   Raw HID reports pass straight through to Dolphin's own real-remote code.

The committed core in `cores/dolphin/` is **not** rebuilt in this change. Until
it is, the page hides the Wii controls, because it only shows them when the
loaded core reports Wii Remote support. The four new exports are listed in
`provenance/dolphin-core-abi-v1.json` under `sourceOnlyExportsPendingRebuild`.

## Using it

When a Wii disc mounts, a bar appears above the player:

| Layout | Keyboard / mouse | Standard gamepad |
|---|---|---|
| Wii Remote + Nunchuk (default) | mouse points · left click A · right click B · X/Z = A/B · 1/2 · Enter + · Backspace − · H Home · WASD stick · Q/E = C/Z · Space swing · F/G/T/V swing left/right/up/down · R shake · IJKL tilt · arrows D-pad | A/B/X/Y = A/B/1/2 · LB C · LT Z · RB swing · L3 shake · RT B · right stick moves the pointer, R3 recentres |
| Wii Remote (pointing) | as above, without the Nunchuk | left stick flicks the remote (swing directions), LB shake |
| Wii Remote sideways | arrows/WASD D-pad · X = 2 · Z = 1 · C = A · V = B · Space shake · J/L tilt | A = 2 · B/X = 1 · Y = A · LB/RB shake · right stick tilts |
| Classic Controller | X/Z = a/b · C/V = x/y · Q/E = L/R · F/R = ZL/ZR · WASD / IJKL sticks | by position (Pro layout) |
| GameCube controller | the normal GameCube controls, for Wii games that support the pad | |

Layouts are remembered per game ID. **Use real Wii Remotes** opens Chrome's
WebHID picker. A DolphinBar has to be in mode 4, and then you press 1+2 on each
remote. The first remote found becomes player 1, the next player 2, and so on.
When a remote leaves, its player slot goes back to the emulated remote (player
1) or to nothing.

## How it works

### Emulated remote: no new transport

The page already sends one pad snapshot per input change (`SetInputState`,
SharedArrayBuffer plus a postMessage fallback). A Wii snapshot rides the same
path. Bit 31 of the mask switches it into Wii mode, which makes
`DolphinWeb_GetPadStatus` report the GameCube pad unplugged so that games
reading both don't get double input. The rest of the mask and the spare bytes
carry the remote:

| Bits / field | Meaning in Wii mode |
|---|---|
| 0–7 | A, B, 1 (classic x), 2 (classic y), +, C (classic L), Z (classic R), ZL |
| 8–11 | D-pad |
| 12–21 | ZR, −, Home, shake, tilt left/right/forward/backward, sideways, pointer visible |
| 22–23 | extension: 0 none, 1 Nunchuk, 2 Classic |
| 24–28 | swing forward/left/right/up/down |
| stick | Nunchuk stick / classic left stick |
| c-stick | classic right stick |
| analogA / analogB | IR pointer X / Y |
| triggers | classic L / R analog |

On the core side (`core/upstream/dolphin_web_wiimote.h`), a ControllerInterface
device called `Web/0/Browser` exposes the snapshot as named inputs. Wii Remote 1
is mapped onto it with ordinary Dolphin expressions: buttons, Point (IR),
Shake, Tilt, Swing, Sideways Hold, and the Nunchuk and Classic groups. The
selected extension follows the Extension input every frame. Dolphin's
WiimoteEmu therefore produces the camera points, accelerometer data and
extension reports itself.

The mapping is also saved to `WiimoteNew.ini`, because Dolphin reloads that
file whenever a Wii title starts (`SConfig::OnESTitleChanged`).
`tests/wii-input.test.mjs` checks that the JS bit layout matches the C++
constants.

### Real remotes: WebHID → WiimoteReal

`src/wiimote-hid.js` opens the HID interfaces on the page. A DolphinBar exposes
all four interfaces even when no remote is synced to them. So, like Dolphin's
hidapi backend, the page sends a status request and only takes an interface
that answers. Input reports go to the worker as one-way `wiimoteHid` messages
and are pushed into the core with `WebHidPushReport`.

Patch `0068-webhid-wiimote-scanner.patch` adds a scanner backend to
`WiimoteScanner::ThreadFunc` through a weak hook,
`DolphinWeb_CreateWiimoteScanner`, which is defined by the host. It also adds
the four exports. The backend hands Dolphin a `WiimoteReal::Wiimote` whose
`IORead`/`IOWrite` are queues. The worker drains the writes every 4 ms
(`WebHidPopWrite`) and posts them back to the page for
`HIDDevice.sendReport`. Attaching a slot sets that slot's `WiimoteSource` to
Real. Detaching it sets slot 1 back to Emulated and the other slots to None.

## Build

I built the core on Linux, not with the locked Windows toolchain, so this
build is **not** byte-identical to a locked one:

- Emscripten 5.0.7 (emsdk `bafd64c`, as locked)
- CMake 3.28.3
- Ninja 1.11.1
- Rust nightly 1.102.0 (2026-11-12), not the locked 1.97
- Upstream Dolphin, all 67 patches and the pinned SPIRV repos, configured with
  the same CMake arguments as `tools/configure-upstream-wasm.mjs`

It produced a 13 MB core with SHA-256 `c672ceac…fe4e`. The committed core is
15 MB. I did not investigate the size difference, which is one more reason this
change leaves the committed core alone and asks for a rebuild through the
locked pipeline.

## Evidence

I tested on an AMD Ryzen 5 5500 with a Radeon RX 7600-class GPU, Linux 7.0,
and Chrome for Testing 153 (Playwright 1.63). The browser ran **headed under
Xvfb**, which counts as non-qualifying for renderer claims; none are made
here. The disc was Wii Sports + Wii Sports Resort (USA), game ID `SP2E01`. I
used `presenter=2d` only so that screenshots capture the canvas.

**Emulated remote**, `?presenter=2d&wasmjit=0`:

- The pointer (mouse) moved across the combo disc's game picker, and A
  selected Wii Sports.
- From there it went through the strap screen, A+B on the title, the save-file
  prompt, the main menu (pointing), Bowling and Tennis, player count, guest
  Mii, "Play with this Mii", and the safety card.
- In the Bowling lane scene the HUD read 102% speed and 62 core FPS.
- Tennis: Shake served (toss, then hit) and the ball went into play
  (`images/wii-remote/tennis-serve-rally.png`).
- Bowling: B lifted the ball and walked the Mii up, but **no throw was
  recognised** with any digital input I tried (forward swing, down then up,
  B released early or late, shake). The game wants an arm arc that
  keyboard swings don't reproduce.
- Dolphin's digital Swing inputs on their own did not register as Tennis
  strokes; Shake did. Space and RB therefore send shake and a forward swing
  together.

**Simulated DolphinBar** (`tests/fixtures/fake-wiimote-hid.js`, injected in
place of `navigator.hid`):

- Of the four interfaces, only the one with a remote probed in, and it became
  player 1.
- Through the passthrough, the game did the real remote handshake:
  - read the 0x1770 probe and the calibration blocks at 0x0000, 0x002A and
    0x0062;
  - enabled the IR camera (0x13 and 0x1A) and wrote its registers starting at
    0xB00030;
  - selected reporting mode 0x33.
- The simulated IR dots moved the game's hand cursor in the right direction,
  and A from the simulated remote linked it and advanced the game to the Wii
  Sports title (`images/wii-remote/dolphinbar-sim-*.png`).

**GameCube regression.** Wind Waker on the same build boots at 114% speed with
the JIT on, and Start/A on the GameCube pad work.

**Tests.** `npm test` has the same 10 failures as `main` on this machine (the
native harnesses that need the Windows toolchain). Everything else passes,
including the new tests:

- `tests/wii-input.test.mjs`: bit layout, keyboard and gamepad mappings, the
  pointer.
- `tests/wiimote-hid.test.mjs`: the bridge against the simulated DolphinBar
  (probing, attach-before-load, report and write passthrough, detach on write
  failure).

### Wii Sports + Resort crashes on the JIT

With default settings (dual core, WASM JIT on), picking Wii Sports on the
`SP2E01` picker stopped rendering. The core dropped to 0 FPS and the log showed
`GFX FIFO: Unknown Opcode (0x42 …)`. The JIT had been enabled before the
hand-off, which loads Wii Sports' program over the picker's.

| URL change | Hand-off | Speed after |
|---|---|---|
| none (JIT on) | crash | — |
| `cpu=single` | ok | 16–23% |
| `syncidle=1` (new flag; restores Dolphin's default SyncOnSkipIdle) | ok | 20–29% |
| `wasmjit=0` | ok | 99–103% |

My suspicion is stale JIT blocks after the new DOL loads, but I did not
root-cause it. This change does not alter the JIT defaults. `?syncidle=1` is
added as an opt-in flag; its default stays off, as before.

## Not verified

- **Real hardware:** a real DolphinBar, a Bluetooth-paired remote, more than
  one real remote, rumble and speaker output, and a real Nunchuk.
- **Other layouts:** sideways, Classic Controller, the GameCube-pad layout, and
  every gamepad mapping in a game. These are unit-tested only.
- **Other browsers:** Firefox and Safari have no WebHID, so the real-remote
  button is disabled there.
- **Other titles:** any Wii title besides Wii Sports.
