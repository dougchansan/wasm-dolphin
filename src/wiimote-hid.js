// Real Wii Remotes over WebHID. See docs/wii-remote.md.
//
// Works with a Mayflash DolphinBar in mode 4 (it shows up as four
// "Nintendo RVL-CNT-01" HID interfaces, one per player) and with remotes
// paired straight to the computer over Bluetooth. Raw HID reports pass
// through to Dolphin's real-remote code in the core, which talks to the
// remote exactly as desktop Dolphin does: IR camera, accelerometer,
// extensions, rumble and speaker are the real hardware.
// SPDX-License-Identifier: GPL-2.0-or-later

const FILTERS = [
  { vendorId: 0x057e, productId: 0x0306 }, // Wii Remote, and every DolphinBar slot
  { vendorId: 0x057e, productId: 0x0330 } // Wii Remote Plus
];
const STATUS_REQUEST = 0x15;
const STATUS_REPORT = 0x20;
const PROBE_TIMEOUT_MS = 1500;
const REPROBE_MS = 2000;
const SLOTS = 4;

export function webHidSupported() {
  return typeof navigator !== "undefined" && "hid" in navigator;
}

export class WiimoteHidBridge {
  // host: EmulatorHost (wiimoteHid(op, slot, bytes), onWiimoteHidWrite)
  // onChange(summary): called whenever remotes come or go.
  constructor(host, onChange = () => {}) {
    this.host = host;
    this.onChange = onChange;
    this.entries = new Map(); // HIDDevice -> { slot, probing, confirmed, lastReply }
    this.slots = new Array(SLOTS).fill(null); // slot -> HIDDevice
    this.timer = null;
    host.onWiimoteHidWrite = (slot, bytes) => this.write(slot, bytes);
    if (webHidSupported()) {
      navigator.hid.addEventListener("disconnect", (event) => this.forget(event.device));
      navigator.hid.addEventListener("connect", (event) => this.add([event.device]));
    }
  }

  get connectedCount() {
    return this.slots.filter(Boolean).length;
  }

  summary() {
    return {
      supported: webHidSupported(),
      interfaces: this.entries.size,
      remotes: this.connectedCount,
      names: this.slots.map((d, i) => (d ? `P${i + 1}` : null)).filter(Boolean)
    };
  }

  // Needs a user gesture (a click): shows Chrome's device picker.
  async request() {
    if (!webHidSupported()) throw new Error("This browser has no WebHID. Use Chrome or Edge.");
    const devices = await navigator.hid.requestDevice({ filters: FILTERS });
    await this.add(devices);
    return this.summary();
  }

  // Reopens devices this site was already allowed to use (no prompt).
  async restore() {
    if (!webHidSupported()) return this.summary();
    const devices = await navigator.hid.getDevices();
    await this.add(devices.filter((d) => FILTERS.some((f) => f.vendorId === d.vendorId && f.productId === d.productId)));
    return this.summary();
  }

  async add(devices) {
    for (const device of devices) {
      if (this.entries.has(device)) continue;
      const entry = { slot: null, probing: false, confirmed: false, lastReply: 0, attachedInCore: false };
      this.entries.set(device, entry);
      device.addEventListener("inputreport", (event) => this.onReport(device, event));
      try {
        if (!device.opened) await device.open();
      } catch (error) {
        console.warn("[wii] could not open HID device", device.productName, error);
        this.entries.delete(device);
        continue;
      }
      this.probe(device);
    }
    this.ensureTimer();
    this.onChange(this.summary());
  }

  // A DolphinBar exposes all four interfaces even with no remote synced to
  // them. Like Dolphin's hidapi backend, ask for a status report: only an
  // interface with a remote behind it accepts the write and answers.
  async probe(device) {
    const entry = this.entries.get(device);
    if (!entry || entry.probing || entry.slot !== null) return;
    entry.probing = true;
    entry.lastReply = 0;
    try {
      await device.sendReport(STATUS_REQUEST, new Uint8Array([0x00]));
      const started = performance.now();
      while (!entry.lastReply && performance.now() - started < PROBE_TIMEOUT_MS) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (entry.lastReply) this.assign(device);
    } catch {
      // Empty DolphinBar slot (or remote asleep): try again later.
    } finally {
      entry.probing = false;
    }
  }

  assign(device) {
    const entry = this.entries.get(device);
    const slot = this.slots.indexOf(null);
    if (!entry || slot < 0) return;
    entry.slot = slot;
    entry.attachedInCore = false;
    this.slots[slot] = device;
    this.syncCore();
    console.info(`[wii] real Wii Remote on ${device.productName || "HID"} is player ${slot + 1}`);
    this.onChange(this.summary());
  }

  release(device) {
    const entry = this.entries.get(device);
    if (!entry || entry.slot === null) return;
    const slot = entry.slot;
    this.slots[slot] = null;
    entry.slot = null;
    if (entry.attachedInCore) this.host.wiimoteHid("detach", slot);
    entry.attachedInCore = false;
    console.info(`[wii] player ${slot + 1} Wii Remote went away`);
    this.onChange(this.summary());
  }

  forget(device) {
    this.release(device);
    this.entries.delete(device);
    this.onChange(this.summary());
  }

  // Tell the core about remotes; retried until the core has loaded.
  syncCore() {
    for (const [, entry] of this.entries) {
      if (entry.slot !== null && !entry.attachedInCore) {
        entry.attachedInCore = this.host.wiimoteHid("attach", entry.slot) === true;
      }
    }
  }

  ensureTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.syncCore();
      for (const [device, entry] of this.entries) {
        if (entry.slot === null && !entry.probing) this.probe(device);
      }
    }, REPROBE_MS);
  }

  onReport(device, event) {
    const entry = this.entries.get(device);
    if (!entry) return;
    if (event.reportId === STATUS_REPORT || entry.slot !== null) entry.lastReply = performance.now();
    if (entry.slot === null || !entry.attachedInCore) return;
    const data = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
    const bytes = new Uint8Array(data.length + 1);
    bytes[0] = event.reportId;
    bytes.set(data, 1);
    this.host.wiimoteHid("report", entry.slot, bytes);
  }

  async write(slot, bytes) {
    const device = this.slots[slot];
    if (!device || !bytes?.length) return;
    try {
      await device.sendReport(bytes[0], bytes.subarray(1));
    } catch (error) {
      // The remote was switched off or lost its DolphinBar link.
      console.warn(`[wii] write to player ${slot + 1} failed`, error?.message || error);
      this.release(device);
    }
  }

  // Re-announce after the core restarts (a new worker starts empty).
  reattachAll() {
    for (const [, entry] of this.entries) entry.attachedInCore = false;
    this.syncCore();
  }
}
