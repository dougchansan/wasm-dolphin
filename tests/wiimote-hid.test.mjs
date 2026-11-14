import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

// Browser-ish globals for the DolphinBar simulator and the bridge.
globalThis.Navigator = class Navigator {};
Object.defineProperty(globalThis, 'navigator', { value: new Navigator(), configurable: true });
globalThis.window = globalThis;
new Function(await fs.readFile(new URL('./fixtures/fake-wiimote-hid.js', import.meta.url), 'utf8'))();
const { WiimoteHidBridge } = await import('../src/wiimote-hid.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('DolphinBar: only the interface with a remote becomes player 1; reports and writes pass through', async () => {
  const calls = [];
  const host = { loaded: false, wiimoteHid(op, slot, bytes) { if (!this.loaded) return false; calls.push({ op, slot, bytes }); return true; } };
  const bridge = new WiimoteHidBridge(host);
  const summary = await bridge.request();
  assert.equal(summary.interfaces, 4);
  await sleep(1800); // status probe of all four interfaces
  assert.equal(bridge.connectedCount, 1);
  assert.equal(bridge.slots[0], window.__fakeWiimote.devices[0]);

  // Core not loaded yet: attach waits, then lands once it is.
  assert.equal(calls.length, 0);
  host.loaded = true;
  bridge.syncCore();
  assert.deepEqual(calls[0], { op: 'attach', slot: 0, bytes: undefined });

  await window.__fakeWiimote.press(['A'], 40);
  const reports = calls.filter((c) => c.op === 'report');
  assert.ok(reports.length > 0, 'input reports forwarded');
  assert.ok(reports.some((r) => r.bytes[0] === 0x30 && r.bytes[2] & 0x08), 'A press seen in a 0x30 report');

  // Core -> remote: set reporting mode 0x33 and read the accel calibration.
  host.onWiimoteHidWrite ??= null;
  await bridge.write(0, new Uint8Array([0x12, 0x04, 0x33]));
  await bridge.write(0, new Uint8Array([0x17, 0x00, 0x00, 0x00, 0x16, 0x00, 0x0a]));
  await sleep(40);
  assert.ok(window.__fakeWiimote.log.includes('12 04 33'));
  const read = calls.find((c) => c.op === 'report' && c.bytes[0] === 0x21);
  assert.ok(read, 'read reply forwarded');
  assert.deepEqual([...read.bytes.slice(6, 9)], [0x80, 0x80, 0x80]);
  assert.ok(calls.some((c) => c.op === 'report' && c.bytes[0] === 0x33), 'IR+accel mode reports');

  // Remote goes away: writes fail, slot is released and the core told.
  window.__fakeWiimote.devices[0].remote = null;
  await bridge.write(0, new Uint8Array([0x11, 0x10]));
  assert.equal(bridge.connectedCount, 0);
  assert.ok(calls.some((c) => c.op === 'detach' && c.slot === 0));
  clearInterval(bridge.timer);
  clearInterval(window.__fakeWiimote.remote.timer);
});
