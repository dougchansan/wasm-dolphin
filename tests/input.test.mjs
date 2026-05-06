import assert from "node:assert/strict";
import test from "node:test";

import {
  BUTTONS,
  DEFAULT_PAD_STATE,
  buttonMaskFromPressed,
  formatControlLabel,
  inputStateFromPressed,
  mergePressedSets,
  pressedFromGamepad,
  readGamepadInput,
  resolveKeyboardButton,
  updatePressedSet
} from "../src/input.js";

test("keyboard bindings resolve GameCube-style controls", () => {
  assert.equal(resolveKeyboardButton("KeyX"), "A");
  assert.equal(resolveKeyboardButton("KeyZ"), "B");
  assert.equal(resolveKeyboardButton("KeyW"), "STICK_UP");
  assert.equal(resolveKeyboardButton("KeyA"), "STICK_LEFT");
  assert.equal(resolveKeyboardButton("KeyS"), "STICK_DOWN");
  assert.equal(resolveKeyboardButton("KeyD"), "STICK_RIGHT");
  assert.equal(resolveKeyboardButton("Enter"), "START");
  assert.equal(resolveKeyboardButton("Escape"), null);
});

test("pressed sets convert to a stable bit mask", () => {
  const pressed = new Set(["A", "B", "D_UP"]);
  assert.equal(buttonMaskFromPressed(pressed), BUTTONS.A | BUTTONS.B | BUTTONS.D_UP);
});

test("pressed set updates are immutable", () => {
  const original = new Set(["A"]);
  const next = updatePressedSet(original, "B", true);
  const released = updatePressedSet(next, "A", false);

  assert.deepEqual([...original], ["A"]);
  assert.equal(next.has("B"), true);
  assert.equal(released.has("A"), false);
});

test("gamepad buttons and axes map into pressed controls", () => {
  const gamepad = {
    axes: [0.5, -0.5, -0.75, 0.75],
    buttons: Array.from({ length: 16 }, () => ({ pressed: false }))
  };
  gamepad.buttons[0].pressed = true;
  gamepad.buttons[9].pressed = true;
  gamepad.buttons[6].value = 0.6;

  const pressed = pressedFromGamepad(gamepad);

  assert.equal(pressed.has("A"), true);
  assert.equal(pressed.has("START"), true);
  assert.equal(pressed.has("L"), true);
  assert.equal(pressed.has("STICK_RIGHT"), true);
  assert.equal(pressed.has("STICK_UP"), true);
  assert.equal(pressed.has("C_STICK_LEFT"), true);
  assert.equal(pressed.has("C_STICK_DOWN"), true);
});

test("gamepad input exposes analog GameCube pad state", () => {
  const gamepad = {
    axes: [1, -1, -0.5, 0.5],
    buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0 }))
  };
  gamepad.buttons[0].pressed = true;
  gamepad.buttons[7].value = 0.75;

  const { pressed, state } = readGamepadInput(gamepad);

  assert.equal(pressed.has("A"), true);
  assert.equal(pressed.has("R"), true);
  assert.equal(state.mask & BUTTONS.A, BUTTONS.A);
  assert.equal(state.analogA, 0xff);
  assert.equal(state.triggerRight, 0xbf);
  assert.equal(state.stickX, 0xe0);
  assert.equal(state.stickY, 0xe0);
  assert.equal(state.cStickX, 0x50);
  assert.equal(state.cStickY, 0x50);
});

test("digital input produces neutral analog defaults with pressed extremes", () => {
  const state = inputStateFromPressed(new Set(["STICK_LEFT", "C_STICK_UP", "B"]));

  assert.equal(state.mask, BUTTONS.STICK_LEFT | BUTTONS.C_STICK_UP | BUTTONS.B);
  assert.equal(state.stickX, 0x20);
  assert.equal(state.stickY, DEFAULT_PAD_STATE.stickY);
  assert.equal(state.cStickX, DEFAULT_PAD_STATE.cStickX);
  assert.equal(state.cStickY, 0xe0);
  assert.equal(state.analogB, 0xff);
});

test("pressed sets merge without duplicates", () => {
  const merged = mergePressedSets(new Set(["A"]), new Set(["A", "B"]));
  assert.deepEqual([...merged], ["A", "B"]);
});

test("control labels are display-friendly", () => {
  assert.equal(formatControlLabel("D_UP"), "D UP");
});
