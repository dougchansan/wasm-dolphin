import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const { WII_BITS, WII_LAYOUTS, WiiPointer, buildWiiInputState, readWiiGamepad, resolveWiiKey } =
  await import(new URL('src/wii-input.js', root));

// The C++ side of the contract.
const patch = await fs.readFile(new URL('core/upstream/dolphin_web_wiimote.h', root), 'utf8');
const discio = await fs.readFile(new URL('core/upstream/dolphin_web_discio.cpp', root), 'utf8');
const cppBit = (name) => {
  const m = new RegExp(`constexpr std::uint32_t BIT_${name} = 1u << (\\d+);`).exec(patch);
  assert.ok(m, `BIT_${name} missing from dolphin_web_wiimote.h`);
  return 1 << Number(m[1]);
};

test('JS Wii bits match the core', () => {
  const names = {
    A: 'A', B: 'B', ONE: 'ONE', TWO: 'TWO', PLUS: 'PLUS', C: 'C_L', Z: 'Z_R', ZL: 'ZL',
    UP: 'UP', DOWN: 'DOWN', LEFT: 'LEFT', RIGHT: 'RIGHT', ZR: 'ZR', MINUS: 'MINUS',
    HOME: 'HOME', SHAKE: 'SHAKE', TILT_LEFT: 'TILT_LEFT', TILT_RIGHT: 'TILT_RIGHT',
    TILT_FORWARD: 'TILT_FORWARD', TILT_BACKWARD: 'TILT_BACKWARD', SIDEWAYS: 'SIDEWAYS',
    POINTER: 'POINTER', SWING_FORWARD: 'SWING_FORWARD', SWING_LEFT: 'SWING_LEFT',
    SWING_RIGHT: 'SWING_RIGHT', SWING_UP: 'SWING_UP', SWING_DOWN: 'SWING_DOWN'
  };
  for (const [js, cpp] of Object.entries(names)) assert.equal(WII_BITS[js], cppBit(cpp), js);
  assert.match(patch, /EXTENSION_SHIFT = 22;/);
  assert.match(discio, /WEB_WII_MODE = 1u << 31;/);
});

test('snapshot carries Wii mode, extension, buttons and pointer', () => {
  const pointer = new WiiPointer();
  pointer.x = 1; pointer.y = -1; pointer.visible = true;
  const s = buildWiiInputState({ layout: 'nunchuk', pressed: new Set(['A', 'C', 'STICK_UP']), pointer });
  assert.equal(s.mask >>> 31, 1);
  assert.equal((s.mask >>> 22) & 3, 1);
  assert.ok(s.mask & WII_BITS.A && s.mask & WII_BITS.C && s.mask & WII_BITS.POINTER);
  assert.equal(s.stickY, 0xff);
  assert.equal(s.stickX, 0x80);
  assert.equal(s.analogA, 0xff);
  assert.equal(s.analogB, 0x01);

  const side = buildWiiInputState({ layout: 'sideways', pressed: new Set(), pointer });
  assert.ok(side.mask & WII_BITS.SIDEWAYS);
  assert.equal(side.mask & WII_BITS.POINTER, 0);
  assert.equal((side.mask >>> 22) & 3, 0);

  const classic = buildWiiInputState({ layout: 'classic', pressed: new Set(['C']), pointer: null });
  assert.equal((classic.mask >>> 22) & 3, 2);
  assert.equal(classic.triggerLeft, 0xff);
  assert.ok(WII_LAYOUTS.gamecube);
});

test('keyboard and gamepad mappings', () => {
  assert.equal(resolveWiiKey('nunchuk', 'KeyX'), 'A');
  assert.equal(resolveWiiKey('sideways', 'KeyX'), 'TWO');
  assert.equal(resolveWiiKey('classic', 'KeyF'), 'ZL');
  assert.equal(resolveWiiKey('remote', 'Space'), 'SWING');
  assert.equal(WII_BITS.SWING, WII_BITS.SHAKE | WII_BITS.SWING_FORWARD);
  assert.equal(resolveWiiKey('sideways', 'Space'), 'SHAKE');
  const buttons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }));
  buttons[0] = { pressed: true, value: 1 };
  buttons[4] = { pressed: true, value: 1 };
  const pad = { buttons, axes: [0, -1, 0.5, 0] };
  const n = readWiiGamepad(pad, 'nunchuk');
  assert.ok(n.pressed.has('A') && n.pressed.has('C'));
  assert.ok(n.stick.y > 0.99);
  const c = readWiiGamepad(pad, 'classic');
  assert.ok(c.pressed.has('B') && c.pressed.has('C'));
  const sw = readWiiGamepad(pad, 'sideways');
  assert.ok(sw.pressed.has('TWO') && sw.pressed.has('UP'));
});

test('gamepad pointer integrates and recentres', () => {
  const p = new WiiPointer();
  p.stepStick({ x: 0, y: 0 }, false, 1000);
  assert.equal(p.stepStick({ x: 1, y: 0 }, false, 1050), true);
  assert.ok(p.x > 0 && p.visible);
  p.stepStick({ x: 0, y: 0 }, true, 1060);
  assert.equal(p.x, 0);
});
