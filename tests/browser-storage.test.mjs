import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const source = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
const slice = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const functions = [
  slice("function wireDiagnostics() {", "function populateSettingsForm("),
  slice("function setDebugOpen(open) {", "// Auto-screenshot:"),
  slice("function setOverlayVisible(visible) {", "// The dial is a range input")
].join("\n");

function setup(storage) {
  const element = () => ({
    hidden: false,
    listeners: {},
    classList: { toggle() {} },
    setAttribute() {},
    addEventListener(name, fn) { this.listeners[name] = fn; }
  });
  const elements = {
    debugPanel: element(),
    screenHud: element(),
    debugToggle: element(),
    overlayToggle: element()
  };
  runInNewContext(functions + "\nwireDiagnostics()", {
    elements,
    localStorage: storage,
    DEBUG_PREF_KEY: "debug",
    OSD_PREF_KEY: "osd",
    lastFrameInfo: null,
    setAutoScreenshotEnabled() {}
  });
  return elements;
}

test("blocked localStorage does not prevent initialization or toggling diagnostics", () => {
  const storage = {
    getItem() { throw new DOMException("blocked", "SecurityError"); },
    setItem() { throw new DOMException("blocked", "SecurityError"); }
  };
  const elements = setup(storage);
  assert.equal(elements.debugPanel.hidden, true);
  assert.equal(elements.screenHud.hidden, false);
  assert.doesNotThrow(() => elements.debugToggle.listeners.click());
  assert.doesNotThrow(() => elements.overlayToggle.listeners.click());
});

test("readable preferences survive a failed write", () => {
  const storage = {
    getItem(key) { return key === "debug" ? "1" : "0"; },
    setItem() { throw new DOMException("blocked", "SecurityError"); }
  };
  const elements = setup(storage);
  assert.equal(elements.debugPanel.hidden, false);
  assert.equal(elements.screenHud.hidden, true);
});

test("normal storage retains preferences and saves toggle changes", () => {
  const values = new Map([["debug", "1"], ["osd", "0"]]);
  const elements = setup({
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); }
  });
  assert.equal(elements.debugPanel.hidden, false);
  assert.equal(elements.screenHud.hidden, true);
  elements.debugToggle.listeners.click();
  elements.overlayToggle.listeners.click();
  assert.equal(values.get("debug"), "0");
  assert.equal(values.get("osd"), "1");
});
