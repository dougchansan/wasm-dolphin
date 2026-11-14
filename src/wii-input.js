// Emulated Wii Remote input (keyboard, mouse, gamepad).
//
// A Wii snapshot rides the existing pad-state transport. Setting bit 31 of
// the mask tells the core (core/upstream/dolphin_web_wiimote.h) to unplug the
// GameCube pad and drive Wii Remote 1 from the bits and bytes below instead.
// See docs/wii-remote.md.
// SPDX-License-Identifier: GPL-2.0-or-later

export const WII_BITS = Object.freeze({
  A: 1 << 0,
  B: 1 << 1,
  ONE: 1 << 2, // classic x
  TWO: 1 << 3, // classic y
  PLUS: 1 << 4,
  C: 1 << 5, // classic L
  Z: 1 << 6, // classic R
  ZL: 1 << 7,
  UP: 1 << 8,
  DOWN: 1 << 9,
  LEFT: 1 << 10,
  RIGHT: 1 << 11,
  ZR: 1 << 12,
  MINUS: 1 << 13,
  HOME: 1 << 14,
  SHAKE: 1 << 15,
  TILT_LEFT: 1 << 16,
  TILT_RIGHT: 1 << 17,
  TILT_FORWARD: 1 << 18,
  TILT_BACKWARD: 1 << 19,
  SIDEWAYS: 1 << 20,
  POINTER: 1 << 21,
  SWING_FORWARD: 1 << 24,
  SWING_LEFT: 1 << 25,
  SWING_RIGHT: 1 << 26,
  SWING_UP: 1 << 27,
  SWING_DOWN: 1 << 28,
  // Space / RB: a shake plus a forward swing. Wii Sports reads the shake's
  // acceleration spike as a stroke (tennis serve and returns, tested).
  SWING: (1 << 15) | (1 << 24)
});
const EXTENSION_SHIFT = 22;
const WII_MODE = 0x8000_0000;

// Controller layouts the player can choose between.
export const WII_LAYOUTS = Object.freeze({
  nunchuk: { label: "Wii Remote + Nunchuk", extension: 1, sideways: false, pointer: true },
  remote: { label: "Wii Remote (pointing)", extension: 0, sideways: false, pointer: true },
  sideways: { label: "Wii Remote sideways", extension: 0, sideways: true, pointer: false },
  classic: { label: "Classic Controller", extension: 2, sideways: false, pointer: true },
  gamecube: { label: "GameCube controller", extension: 0, sideways: false, pointer: false }
});

// Keyboard: event.code -> Wii button name, per layout.
const KEYS_POINTING = {
  KeyX: "A",
  KeyZ: "B",
  Digit1: "ONE",
  Digit2: "TWO",
  Enter: "PLUS",
  Backspace: "MINUS",
  Minus: "MINUS",
  KeyH: "HOME",
  ArrowUp: "UP",
  ArrowDown: "DOWN",
  ArrowLeft: "LEFT",
  ArrowRight: "RIGHT",
  KeyW: "STICK_UP",
  KeyS: "STICK_DOWN",
  KeyA: "STICK_LEFT",
  KeyD: "STICK_RIGHT",
  KeyQ: "C",
  KeyE: "Z",
  Space: "SWING",
  KeyF: "SWING_LEFT",
  KeyG: "SWING_RIGHT",
  KeyT: "SWING_UP",
  KeyV: "SWING_DOWN",
  KeyR: "SHAKE",
  KeyI: "TILT_FORWARD",
  KeyK: "TILT_BACKWARD",
  KeyJ: "TILT_LEFT",
  KeyL: "TILT_RIGHT"
};
const KEYS_SIDEWAYS = {
  KeyX: "TWO",
  KeyZ: "ONE",
  KeyC: "A",
  KeyV: "B",
  Enter: "PLUS",
  Backspace: "MINUS",
  Minus: "MINUS",
  KeyH: "HOME",
  ArrowUp: "UP",
  ArrowDown: "DOWN",
  ArrowLeft: "LEFT",
  ArrowRight: "RIGHT",
  KeyW: "UP",
  KeyS: "DOWN",
  KeyA: "LEFT",
  KeyD: "RIGHT",
  Space: "SHAKE",
  ShiftLeft: "SHAKE",
  KeyI: "TILT_FORWARD",
  KeyK: "TILT_BACKWARD",
  KeyJ: "TILT_LEFT",
  KeyL: "TILT_RIGHT"
};
const KEYS_CLASSIC = {
  KeyX: "A",
  KeyZ: "B",
  KeyC: "ONE",
  KeyV: "TWO",
  KeyQ: "C",
  KeyE: "Z",
  KeyF: "ZL",
  KeyR: "ZR",
  Enter: "PLUS",
  Backspace: "MINUS",
  Minus: "MINUS",
  KeyH: "HOME",
  ArrowUp: "UP",
  ArrowDown: "DOWN",
  ArrowLeft: "LEFT",
  ArrowRight: "RIGHT",
  KeyW: "STICK_UP",
  KeyS: "STICK_DOWN",
  KeyA: "STICK_LEFT",
  KeyD: "STICK_RIGHT",
  KeyI: "RSTICK_UP",
  KeyK: "RSTICK_DOWN",
  KeyJ: "RSTICK_LEFT",
  KeyL: "RSTICK_RIGHT"
};

export function resolveWiiKey(layout, code) {
  const table = layout === "sideways" ? KEYS_SIDEWAYS : layout === "classic" ? KEYS_CLASSIC : KEYS_POINTING;
  return table[code] ?? null;
}

// Short help text shown under the player, per layout.
export const WII_HELP = Object.freeze({
  nunchuk:
    "Mouse points · left click A · right click B · X/Z = A/B · 1/2 · Enter + · Backspace − · H Home · " +
    "WASD Nunchuk stick · Q/E = C/Z · Space swing · F/G swing left/right · T/V swing up/down · R shake · " +
    "IJKL tilt · arrows D-pad. " +
    "Gamepad: A/B/X/Y = A/B/1/2 · LB C · LT Z · RB swing · L3 shake · RT B · right stick points (R3 recentres).",
  remote:
    "Mouse points · left click A · right click B · X/Z = A/B · 1/2 · Enter + · Backspace − · H Home · " +
    "Space swing · F/G swing left/right · T/V swing up/down · R shake · IJKL tilt · arrows D-pad. " +
    "Gamepad: A/B/X/Y = A/B/1/2 · RB swing (left stick flicks swing left/right/up/down) · LB shake · RT B · " +
    "right stick points (R3 recentres).",
  sideways:
    "Held sideways: arrows/WASD D-pad · X = 2 · Z = 1 · C = A · V = B · Space shake · J/L tilt (steer) · " +
    "Enter + · Backspace − · H Home. " +
    "Gamepad: A = 2 · B/X = 1 · Y = A · LB/RB shake · right stick tilts.",
  classic:
    "Classic Controller: X/Z = a/b · C/V = x/y · Q/E = L/R · F/R = ZL/ZR · WASD left stick · IJKL right stick · " +
    "arrows D-pad · Enter + · Backspace −. Gamepad maps by position (Pro layout).",
  gamecube: "GameCube controller in port 1 (for Wii games that support it). Same keys as GameCube games."
});

const GAMEPAD_DEADZONE = 0.18;
const GAMEPAD_DIGITAL = 0.55;
const POINTER_SPEED = 1.4; // screen half-widths per second at full right-stick deflection

function deadzone(value) {
  if (!Number.isFinite(value)) return 0;
  const mag = Math.abs(value);
  if (mag < GAMEPAD_DEADZONE) return 0;
  return ((mag - GAMEPAD_DEADZONE) / (1 - GAMEPAD_DEADZONE)) * Math.sign(value);
}

function pressedButton(gamepad, index) {
  return Boolean(gamepad.buttons[index]?.pressed);
}

// Reads a standard-mapping gamepad into Wii terms for the given layout.
// Returns { pressed: Set<name>, stick: {x,y}, rstick: {x,y}, triggers: {l,r} }.
export function readWiiGamepad(gamepad, layout) {
  const pressed = new Set();
  const result = { pressed, stick: { x: 0, y: 0 }, rstick: { x: 0, y: 0 }, triggers: { l: 0, r: 0 } };
  if (!gamepad) return result;

  const map = (index, name) => {
    if (pressedButton(gamepad, index)) pressed.add(name);
  };
  const [lx = 0, ly = 0, rx = 0, ry = 0] = gamepad.axes;
  result.stick = { x: deadzone(lx), y: -deadzone(ly) };
  result.rstick = { x: deadzone(rx), y: -deadzone(ry) };
  const lt = gamepad.buttons[6]?.value ?? (pressedButton(gamepad, 6) ? 1 : 0);
  const rt = gamepad.buttons[7]?.value ?? (pressedButton(gamepad, 7) ? 1 : 0);

  map(12, "UP");
  map(13, "DOWN");
  map(14, "LEFT");
  map(15, "RIGHT");
  map(8, "MINUS");
  map(9, "PLUS");
  map(16, "HOME");

  if (layout === "sideways") {
    map(0, "TWO");
    map(1, "ONE");
    map(2, "ONE");
    map(3, "A");
    map(4, "SHAKE");
    map(5, "SHAKE");
    if (rt > 0.5) pressed.add("B");
    if (lx <= -GAMEPAD_DIGITAL) pressed.add("LEFT");
    if (lx >= GAMEPAD_DIGITAL) pressed.add("RIGHT");
    if (ly <= -GAMEPAD_DIGITAL) pressed.add("UP");
    if (ly >= GAMEPAD_DIGITAL) pressed.add("DOWN");
    if (rx <= -GAMEPAD_DIGITAL) pressed.add("TILT_LEFT");
    if (rx >= GAMEPAD_DIGITAL) pressed.add("TILT_RIGHT");
    if (ry <= -GAMEPAD_DIGITAL) pressed.add("TILT_FORWARD");
    if (ry >= GAMEPAD_DIGITAL) pressed.add("TILT_BACKWARD");
    result.stick = { x: 0, y: 0 };
    result.rstick = { x: 0, y: 0 };
  } else if (layout === "classic") {
    // Pro layout, by position: bottom b, right a, left y, top x.
    map(0, "B");
    map(1, "A");
    map(2, "TWO");
    map(3, "ONE");
    map(4, "C"); // L
    map(5, "Z"); // R
    if (lt > 0.5) pressed.add("ZL");
    if (rt > 0.5) pressed.add("ZR");
    map(10, "HOME");
  } else {
    map(0, "A");
    map(1, "B");
    map(2, "ONE");
    map(3, "TWO");
    map(5, "SWING");
    if (rt > 0.5) pressed.add("B");
    if (layout === "nunchuk") {
      map(4, "C");
      if (lt > 0.5) pressed.add("Z");
      map(10, "SHAKE");
    } else {
      map(4, "SHAKE");
      // No Nunchuk: the left stick flicks the remote.
      if (lx <= -GAMEPAD_DIGITAL) pressed.add("SWING_LEFT");
      if (lx >= GAMEPAD_DIGITAL) pressed.add("SWING_RIGHT");
      if (ly <= -GAMEPAD_DIGITAL) pressed.add("SWING_UP");
      if (ly >= GAMEPAD_DIGITAL) pressed.add("SWING_DOWN");
      result.stick = { x: 0, y: 0 };
    }
    if (pressedButton(gamepad, 11)) pressed.add("RECENTER");
  }
  return result;
}

// The IR pointer, in -1..1 with +y up. The mouse sets it absolutely; a
// gamepad's right stick moves it, so it stays put when the stick is let go.
export class WiiPointer {
  constructor() {
    this.x = 0;
    this.y = 0;
    this.visible = false;
    this.source = null;
    this.lastTick = 0;
  }

  setFromElement(element, clientX, clientY) {
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    this.x = Math.max(-1, Math.min(1, ((clientX - rect.left) / rect.width) * 2 - 1));
    this.y = Math.max(-1, Math.min(1, 1 - ((clientY - rect.top) / rect.height) * 2));
    this.visible = true;
    this.source = "mouse";
  }

  hideIfMouse() {
    if (this.source === "mouse") this.visible = false;
  }

  // Returns true when the pointer moved.
  stepStick(stick, recenter, now = performance.now()) {
    const dt = this.lastTick ? Math.min(0.05, (now - this.lastTick) / 1000) : 0;
    this.lastTick = now;
    if (recenter) {
      const moved = this.x !== 0 || this.y !== 0 || !this.visible;
      this.x = 0;
      this.y = 0;
      this.visible = true;
      this.source = "gamepad";
      return moved;
    }
    if (!stick.x && !stick.y) return false;
    this.x = Math.max(-1, Math.min(1, this.x + stick.x * POINTER_SPEED * dt));
    this.y = Math.max(-1, Math.min(1, this.y + stick.y * POINTER_SPEED * dt));
    this.visible = true;
    this.source = "gamepad";
    return true;
  }
}

function axisByte(value) {
  return Math.max(0, Math.min(0xff, Math.round(0x80 + Math.max(-1, Math.min(1, value)) * 127)));
}

function digitalAxis(pressed, negative, positive) {
  const n = pressed.has(negative);
  const p = pressed.has(positive);
  return n === p ? 0 : p ? 1 : -1;
}

// Builds the snapshot SetInputState sends to the core.
export function buildWiiInputState({ layout, pressed, stick, rstick, triggers, pointer }) {
  const config = WII_LAYOUTS[layout] ?? WII_LAYOUTS.nunchuk;
  let mask = WII_MODE | (config.extension << EXTENSION_SHIFT);
  for (const name of pressed) mask |= WII_BITS[name] ?? 0;
  if (config.sideways) mask |= WII_BITS.SIDEWAYS;
  if (config.pointer && pointer?.visible) mask |= WII_BITS.POINTER;

  const sx = digitalAxis(pressed, "STICK_LEFT", "STICK_RIGHT") || stick?.x || 0;
  const sy = digitalAxis(pressed, "STICK_DOWN", "STICK_UP") || stick?.y || 0;
  const rx = digitalAxis(pressed, "RSTICK_LEFT", "RSTICK_RIGHT") || rstick?.x || 0;
  const ry = digitalAxis(pressed, "RSTICK_DOWN", "RSTICK_UP") || rstick?.y || 0;
  const l = Math.max(pressed.has("C") && layout === "classic" ? 1 : 0, triggers?.l || 0);
  const r = Math.max(pressed.has("Z") && layout === "classic" ? 1 : 0, triggers?.r || 0);

  return {
    mask: mask >>> 0,
    stickX: axisByte(sx),
    stickY: axisByte(sy),
    cStickX: axisByte(rx),
    cStickY: axisByte(ry),
    triggerLeft: Math.round(Math.max(0, Math.min(1, l)) * 0xff),
    triggerRight: Math.round(Math.max(0, Math.min(1, r)) * 0xff),
    analogA: axisByte(pointer?.x || 0),
    analogB: axisByte(pointer?.y || 0)
  };
}
