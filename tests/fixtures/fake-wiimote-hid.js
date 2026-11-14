// Test double for a Mayflash DolphinBar (mode 4) with one Wii Remote synced.
//
// Loaded by tests/wiimote-hid.test.mjs, or as a Playwright init script;
// replaces navigator.hid with four "Nintendo RVL-CNT-01" interfaces like the
// real bar. Only interface 0 has a remote behind it; writes to the others
// fail, as on the hardware. The remote implements the Wii Remote HID protocol
// closely enough for Wii games: status/ack/read/write reports, the EEPROM
// calibration blocks (from Dolphin's WiimoteEmu defaults), every data
// reporting mode, IR camera dots for a sensor bar, and the accelerometer.
//
// window.__fakeWiimote.press(["A"], holdMs)   press buttons
// window.__fakeWiimote.point(x, y)            aim, -1..1 (+y up)
// window.__fakeWiimote.swing(ms)              a swing on the accelerometer
// window.__fakeWiimote.log                    output reports the game sent
(() => {
  const BUTTONS = {
    LEFT: [0, 0x01], RIGHT: [0, 0x02], DOWN: [0, 0x04], UP: [0, 0x08], PLUS: [0, 0x10],
    TWO: [1, 0x01], ONE: [1, 0x02], B: [1, 0x04], A: [1, 0x08], MINUS: [1, 0x10], HOME: [1, 0x80]
  };
  const cksum = (bytes) => bytes.reduce((a, b) => (a + b) & 0xff, 0x55);

  function makeEeprom() {
    const e = new Uint8Array(0x1700);
    const LX = 0x7f, LY = 0x5d, HX = 0x380, HY = 0x2a2;
    const ir = [
      LX & 0xff, LY & 0xff,
      ((LY & 0x300) >> 2) | ((LX & 0x300) >> 4) | ((LY & 0x300) >> 6) | ((HX & 0x300) >> 8),
      HX & 0xff, LY & 0xff, HX & 0xff, HY & 0xff,
      ((HY & 0x300) >> 2) | ((HX & 0x300) >> 4) | ((HY & 0x300) >> 6) | ((LX & 0x300) >> 8),
      LX & 0xff, HY & 0xff
    ];
    ir.push(cksum(ir));
    const accel = [0x80, 0x80, 0x80, 0, 0x9a, 0x9a, 0x9a, 0, 0];
    accel.push(cksum(accel));
    e.set(ir, 0x00); e.set(ir, 0x0b); e.set(accel, 0x16); e.set(accel, 0x20);
    e.set([0x00, 0x00, 0x00, 0xff, 0x11, 0xee, 0x00, 0x00, 0x33, 0xcc, 0x44, 0xbb,
      0x00, 0x00, 0x66, 0x99, 0x77, 0x88, 0x00, 0x00, 0x2b, 0x01, 0xe8, 0x13], 0x16d0);
    return e;
  }

  class FakeRemote {
    constructor(device) {
      this.device = device;
      this.eeprom = makeEeprom();
      this.regs = { 0x51: new Uint8Array(256), 0x58: new Uint8Array(256) }; // speaker, IR camera
      this.buttons = [0, 0];
      this.mode = 0x30;
      this.continuous = false;
      this.leds = 0;
      this.ir = false;
      this.speaker = false;
      this.pointer = { x: 0, y: 0 };
      this.accel = { x: 0x200, y: 0x200, z: 0x268 };
      this.timer = setInterval(() => this.sendData(), 10);
      this.log = [];
    }

    emit(id, payload) {
      const data = new Uint8Array(payload);
      queueMicrotask(() => {
        const event = new Event("inputreport");
        event.reportId = id;
        event.data = new DataView(data.buffer);
        event.device = this.device;
        this.device.dispatchEvent(event);
      });
    }

    core() { return [this.buttons[0], this.buttons[1]]; }
    ack(rid, err = 0) { this.emit(0x22, [...this.core(), rid, err]); }

    status() {
      const flags = (this.ir ? 0x08 : 0) | (this.speaker ? 0x04 : 0) | (this.leds & 0xf0);
      this.emit(0x20, [...this.core(), flags, 0, 0, 0xc0]);
    }

    output(id, d) {
      this.log.push([id, ...d].map((b) => b.toString(16).padStart(2, "0")).join(" "));
      if (this.log.length > 400) this.log.shift();
      const wantAck = (d[0] & 0x02) !== 0;
      switch (id) {
        case 0x10: break; // rumble
        case 0x11: this.leds = d[0] & 0xf0; if (wantAck) this.ack(id); break;
        case 0x12: this.continuous = (d[0] & 0x04) !== 0; this.mode = d[1]; if (wantAck) this.ack(id); this.sendData(); break;
        case 0x13: case 0x1a: this.ir = (d[0] & 0x04) !== 0; if (wantAck) this.ack(id); break;
        case 0x14: this.speaker = (d[0] & 0x04) !== 0; if (wantAck) this.ack(id); break;
        case 0x19: if (wantAck) this.ack(id); break;
        case 0x15: this.status(); break;
        case 0x16: this.write(d); break;
        case 0x17: this.read(d); break;
        case 0x18: break; // speaker data
        default: break;
      }
    }

    write(d) {
      const space = d[0] & 0x04 ? "reg" : "eeprom";
      const addr = (d[1] << 16) | (d[2] << 8) | d[3];
      const size = d[4];
      const bytes = d.slice(5, 5 + size);
      if (space === "eeprom") {
        if (addr + size > this.eeprom.length) return this.ack(0x16, 8);
        this.eeprom.set(bytes, addr);
        return this.ack(0x16, 0);
      }
      const slave = (addr >> 17) & 0x7f;
      if (!this.regs[slave]) return this.ack(0x16, 7);
      this.regs[slave].set(bytes, addr & 0xff);
      this.ack(0x16, 0);
    }

    read(d) {
      const space = d[0] & 0x04 ? "reg" : "eeprom";
      const addr = (d[1] << 16) | (d[2] << 8) | d[3];
      let size = (d[4] << 8) | d[5];
      const reply = (offset, chunk, err) => {
        const a = (addr + offset) & 0xffff;
        const body = new Array(16).fill(0);
        if (chunk) chunk.forEach((b, i) => { body[i] = b; });
        const sizeErr = err ? 0xf0 | err : ((chunk.length - 1) << 4);
        this.emit(0x21, [...this.core(), sizeErr, a >> 8, a & 0xff, ...body]);
      };
      if (space === "eeprom") {
        if (addr + size > this.eeprom.length) return reply(0, null, 8);
      } else {
        const slave = (addr >> 17) & 0x7f;
        if (!this.regs[slave]) return reply(0, null, 7);
      }
      const src = space === "eeprom" ? this.eeprom : this.regs[(addr >> 17) & 0x7f];
      const base = space === "eeprom" ? addr : addr & 0xff;
      for (let off = 0; size > 0; off += 16) {
        const n = Math.min(16, size);
        reply(off, Array.from(src.slice(base + off, base + off + n)), 0);
        size -= n;
      }
    }

    accelBytes() {
      const { x, y, z } = this.accel;
      // 10-bit values: top 8 bits in the report, low bits in the button bytes.
      const b0 = this.buttons[0] | ((x & 0x3) << 5);
      const b1 = this.buttons[1] | (((y >> 1) & 1) << 5) | (((z >> 1) & 1) << 6);
      return { core: [b0, b1], bytes: [(x >> 2) & 0xff, (y >> 2) & 0xff, (z >> 2) & 0xff] };
    }

    dots() {
      if (!this.ir) return [];
      // Sensor-bar LEDs as the camera (1024x768) sees them; aiming right
      // moves them left, aiming up moves them down the image.
      const cx = 512 - this.pointer.x * 420;
      const cy = 384 + this.pointer.y * 300;
      return [[cx - 110, cy], [cx + 110, cy]].filter(([x, y]) => x >= 0 && x < 1024 && y >= 0 && y < 768);
    }

    irBasic() {
      const d = this.dots();
      const out = new Array(10).fill(0xff);
      const put = (i, a, b) => {
        const o = i * 5;
        const [x1, y1] = a ? a.map(Math.round) : [1023, 1023];
        const [x2, y2] = b ? b.map(Math.round) : [1023, 1023];
        out[o] = x1 & 0xff; out[o + 1] = y1 & 0xff;
        out[o + 2] = ((y1 >> 8) & 3) << 6 | ((x1 >> 8) & 3) << 4 | ((y2 >> 8) & 3) << 2 | ((x2 >> 8) & 3);
        out[o + 3] = x2 & 0xff; out[o + 4] = y2 & 0xff;
      };
      put(0, d[0], d[1]);
      return out;
    }

    irExtended() {
      const d = this.dots();
      const out = new Array(12).fill(0xff);
      d.forEach(([fx, fy], i) => {
        const x = Math.round(fx), y = Math.round(fy);
        out[i * 3] = x & 0xff;
        out[i * 3 + 1] = y & 0xff;
        out[i * 3 + 2] = ((y >> 8) & 3) << 6 | ((x >> 8) & 3) << 4 | 3;
      });
      return out;
    }

    sendData() {
      const { core, bytes } = this.accelBytes();
      const ext = (n) => new Array(n).fill(0);
      switch (this.mode) {
        case 0x30: return this.emit(0x30, this.core());
        case 0x31: return this.emit(0x31, [...core, ...bytes]);
        case 0x32: return this.emit(0x32, [...this.core(), ...ext(8)]);
        case 0x33: return this.emit(0x33, [...core, ...bytes, ...this.irExtended()]);
        case 0x34: return this.emit(0x34, [...this.core(), ...ext(19)]);
        case 0x35: return this.emit(0x35, [...core, ...bytes, ...ext(16)]);
        case 0x36: return this.emit(0x36, [...this.core(), ...this.irBasic(), ...ext(9)]);
        case 0x37: return this.emit(0x37, [...core, ...bytes, ...this.irBasic(), ...ext(6)]);
        default: return this.emit(0x30, this.core());
      }
    }
  }

  class FakeHidDevice extends EventTarget {
    constructor(index, hasRemote) {
      super();
      this.index = index;
      this.vendorId = 0x057e;
      this.productId = 0x0306;
      this.productName = "Nintendo RVL-CNT-01";
      this.opened = false;
      this.collections = [];
      this.oninputreport = null;
      this.remote = hasRemote ? new FakeRemote(this) : null;
    }
    async open() { this.opened = true; }
    async close() { this.opened = false; }
    async forget() {}
    async sendReport(reportId, data) {
      if (!this.opened) throw new DOMException("Device not opened", "InvalidStateError");
      // An empty DolphinBar slot refuses writes (EPIPE on the hardware).
      if (!this.remote) throw new DOMException("Failed to write the report.", "NotAllowedError");
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      this.remote.output(reportId, Array.from(bytes));
    }
    async sendFeatureReport() { throw new DOMException("unsupported", "NotSupportedError"); }
    async receiveFeatureReport() { throw new DOMException("unsupported", "NotSupportedError"); }
  }

  const devices = [0, 1, 2, 3].map((i) => new FakeHidDevice(i, i === 0));
  let granted = false;
  const hid = new (class extends EventTarget {
    async getDevices() { return granted ? devices : []; }
    async requestDevice() { granted = true; return devices; }
  })();
  Object.defineProperty(Navigator.prototype, "hid", { get: () => hid, configurable: true });

  const remote = devices[0].remote;
  window.__fakeWiimote = {
    devices,
    remote,
    get log() { return remote.log; },
    press(names, holdMs = 150) {
      for (const n of names) { const [i, bit] = BUTTONS[n]; remote.buttons[i] |= bit; }
      remote.sendData();
      return new Promise((resolve) => setTimeout(() => {
        for (const n of names) { const [i, bit] = BUTTONS[n]; remote.buttons[i] &= ~bit; }
        remote.sendData();
        resolve();
      }, holdMs));
    },
    point(x, y) { remote.pointer = { x, y }; },
    swing(ms = 300) {
      const start = performance.now();
      return new Promise((resolve) => {
        const step = () => {
          const t = (performance.now() - start) / ms;
          if (t >= 1) { remote.accel = { x: 0x200, y: 0x200, z: 0x268 }; return resolve(); }
          const s = Math.sin(t * Math.PI * 2);
          remote.accel = { x: 0x200 + Math.round(s * 0x1f0), y: 0x200 - Math.round(Math.abs(s) * 0x180), z: 0x268 + Math.round(s * 0x100) };
          setTimeout(step, 8);
        };
        step();
      });
    }
  };
})();
