import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const source = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
const start = source.indexOf("function wireKeyboard() {");
const end = source.indexOf("function wireTouchControls()", start);
const wireKeyboard = source.slice(start, end);

test("blur releases held keyboard buttons without requiring keyup", () => {
  const keys = new Set();
  const touch = new Set();
  const gamepad = new Set();
  const documentHandlers = new Map();
  const windowHandlers = new Map();
  const snapshots = [];
  runInNewContext(wireKeyboard + "\nwireKeyboard()", {
    keyboardPressed: keys,
    touchPressed: touch,
    gamepadPressed: gamepad,
    document: { addEventListener(type, fn) { documentHandlers.set(type, fn); } },
    window: { addEventListener(type, fn) { windowHandlers.set(type, fn); } },
    resolveKeyboardButton(code) { return code === "KeyW" ? "UP" : null; },
    updatePressedSet(set, button, down) {
      const next = new Set(set);
      if (down) next.add(button);
      else next.delete(button);
      return next;
    },
    syncInput(source) {
      snapshots.push({ source, pressed: [...new Set([...keys, ...touch, ...gamepad])] });
    }
  });

  documentHandlers.get("keydown")({
    code: "KeyW", repeat: false, preventDefault() {}
  });
  assert.deepEqual([...keys], ["UP"]);
  assert.ok(windowHandlers.has("blur"), "missing window blur release handler");
  windowHandlers.get("blur")();
  assert.deepEqual([...keys], []);
  assert.deepEqual(snapshots.at(-1), { source: "Keyboard", pressed: [] });

  // A late keyup should remain harmless.
  documentHandlers.get("keyup")({ code: "KeyW", preventDefault() {} });
  assert.deepEqual([...keys], []);

  // An idle blur should not send another input update.
  const updates = snapshots.length;
  windowHandlers.get("blur")();
  assert.equal(snapshots.length, updates);

  const pressW = () => documentHandlers.get("keydown")({
    code: "KeyW", repeat: false, preventDefault() {}
  });
  gamepad.add("B");
  pressW();
  windowHandlers.get("blur")();
  assert.deepEqual(snapshots.at(-1), { source: "Gamepad", pressed: ["B"] });

  gamepad.clear();
  touch.add("A");
  pressW();
  windowHandlers.get("blur")();
  assert.deepEqual(snapshots.at(-1), { source: "Touch", pressed: ["A"] });
});
