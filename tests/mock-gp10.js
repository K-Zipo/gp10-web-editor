// Builds an init script that installs a mock GP-10 behind navigator.requestMIDIAccess.
// The mock answers RQ1 block by block like the real unit, applies DT1 writes,
// switches patches via the Setup "Current Patch Number" or Program Change,
// and keeps a log of everything the page sent in window.__dev.sent.
const fs = require('fs');

function buildMock(mapPath, dumpPath) {
  const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  const a2i = (s) => s.split(' ').reduce((v, b) => (v << 7) | parseInt(b, 16), 0);
  const blocks = map.patchBlocks.map((b) => ({ base: a2i(b.addr), len: b.length }));
  const mem = {};
  for (const ln of fs.readFileSync(dumpPath, 'utf8').split('\n')) {
    const m = ln.match(/^([0-9A-F ]{11})  \+\d+  ((?:[0-9A-F]{2} ?)+)/);
    if (!m) continue;
    const base = a2i(m[1].trim());
    m[2].trim().split(' ').forEach((v, i) => { mem[base + i] = parseInt(v, 16); });
  }
  const init = JSON.stringify({ blocks, mem });
  return `
(() => {
  const INIT = ${init};
  const cs = (b) => (128 - (b.reduce((a, x) => a + x, 0) % 128)) % 128;
  const a2i = (a) => a.reduce((v, b) => (v << 7) | b, 0) >>> 0;
  const i2a = (n) => { const o = []; for (let i = 0; i < 4; i++) { o.unshift(n & 0x7F); n >>>= 7; } return o; };
  const TEMP = a2i([0x20, 0, 0, 0]), SPAN = a2i([0, 4, 0, 0]);
  const mem = new Map(Object.entries(INIT.mem).map(([k, v]) => [+k, v]));
  const base0 = {}; for (const [k, v] of mem) if (k >= TEMP && k < TEMP + SPAN) base0[k - TEMP] = v;
  for (let p = 1; p <= 99; p++) {
    for (const [off, v] of Object.entries(base0)) mem.set(TEMP + SPAN * p + +off, v);
    const nm = ('USER ' + String(p).padStart(2, '0')).padEnd(12, ' ');
    for (let i = 0; i < 12; i++) mem.set(TEMP + SPAN * p + i, nm.charCodeAt(i));
    mem.set(TEMP + SPAN * p + a2i([0, 0, 0x50, 2]), p);
  }
  let current = 12;
  const load = (p) => { for (const off of Object.keys(base0)) mem.set(TEMP + +off, mem.get(TEMP + SPAN * p + +off)); };
  load(13);
  window.__dev = { mem, sent: [], get current() { return current; }, poke(addr, v) { mem.set(a2i(addr), v); }, peek(addr) { return mem.get(a2i(addr)); } };
  const input = { id: 'in1', name: 'GP-10', manufacturer: 'Roland', type: 'input', state: 'connected', onmidimessage: null };
  const daw = { id: 'in2', name: 'GP-10 DAW CTRL', manufacturer: 'Roland', type: 'input', state: 'connected', onmidimessage: null };
  let t = 0;
  let usbRx = null; // when the page uses WebUSB, replies are queued as USB-MIDI packets here
  const emit = (bytes) => {
    if (usbRx) { usbRx.push(bytes); return; }
    t = Math.max(t, performance.now()) + 3; setTimeout(() => input.onmidimessage && input.onmidimessage({ data: new Uint8Array(bytes) }), t - performance.now());
  };
  const dt1 = (addr, data) => { const body = [...addr, ...data]; return [0xF0, 0x41, 0x10, 0, 0, 0, 5, 0x12, ...body, cs(body), 0xF7]; };
  function blocksAt(start, size) {
    if (start < TEMP) return [];
    const pbase = TEMP + SPAN * Math.floor((start - TEMP) / SPAN); const out = [];
    for (const b of INIT.blocks) {
      const bs = pbase + (b.base - TEMP); const be = bs + b.len;
      const s = Math.max(bs, start), e = Math.min(be, start + size);
      if (s < e) { const data = []; for (let a = s; a < e; a++) data.push(mem.get(a) ?? 0); out.push([s, data]); }
    }
    return out;
  }
  const output = { id: 'out1', name: 'GP-10', manufacturer: 'Roland', type: 'output', state: 'connected',
    send(b) {
      b = Array.from(b); window.__dev.sent.push(b);
      if (b[0] === 0xF0 && b[1] === 0x7E && b[4] === 0x01) { emit([0xF0, 0x7E, 0x10, 0x06, 0x02, 0x41, 0x05, 0x03, 0, 0, 0, 0, 0, 0, 0xF7]); return; }
      if ((b[0] & 0xF0) === 0xC0) { current = b[1]; load(current + 1); return; }
      if (b[0] !== 0xF0 || b[1] !== 0x41) return;
      const body = b.slice(8, -2);
      if (cs(body) !== b[b.length - 2]) { window.__dev.badcs = (window.__dev.badcs || 0) + 1; return; }
      const addr = a2i(body.slice(0, 4));
      if (b[7] === 0x11) {
        const size = a2i(body.slice(4, 8));
        if (addr === 0) { emit(dt1([0, 0, 0, 0], [current])); return; }
        for (const [s, data] of blocksAt(addr, size)) emit(dt1(i2a(s), data));
      } else if (b[7] === 0x12) {
        const data = body.slice(4);
        if (addr === 0) { window.__dev.setupWrites = (window.__dev.setupWrites || 0) + 1; current = data[0]; load(current + 1); return; }
        data.forEach((v, i) => mem.set(addr + i, v));
      }
    } };
  // WebUSB face of the same mock: vendor interface 3 with bulk OUT 3 / IN 4, two cables,
  // the RPN burst the real unit sends first, and replies split into 64-byte transfers.
  const usbPk = (bytes, cable) => { const o = []; const c = cable << 4; let i = 0;
    while (i < bytes.length) {
      if (bytes[i] === 0xF0) { let j = bytes.indexOf(0xF7, i); const sx = bytes.slice(i, j + 1);
        for (let k = 0; k < sx.length; k += 3) { const ch = sx.slice(k, k + 3); const last = k + 3 >= sx.length; o.push(c | (!last ? 4 : ch.length === 1 ? 5 : ch.length === 2 ? 6 : 7), ch[0], ch[1] || 0, ch[2] || 0); }
        i = j + 1; } else { const n = (bytes[i] & 0xE0) === 0xC0 ? 2 : 3; o.push(c | (bytes[i] >> 4), bytes[i], bytes[i + 1], n === 3 ? bytes[i + 2] : 0); i += n; } }
    return o; };
  const usbUnpk = (d) => { const L = [0, 0, 2, 3, 3, 1, 2, 3, 3, 3, 3, 3, 2, 2, 3, 1]; const out = []; let cur = [];
    for (let i = 0; i + 3 < d.length; i += 4) { if (d[i] >> 4) continue; const n = L[d[i] & 15]; const cin = d[i] & 15;
      for (let k = 1; k <= n; k++) cur.push(d[i + k]);
      if (cin !== 4) { out.push(cur); cur = []; } }
    return out; };
  const ep = (n, d, ty, sz) => ({ endpointNumber: n, direction: d, type: ty, packetSize: sz });
  const alt = (cls, sub, eps, set = 0) => ({ alternateSetting: set, interfaceClass: cls, interfaceSubclass: sub, interfaceProtocol: 0, interfaceName: null, endpoints: eps });
  const cfg = { configurationValue: 1, configurationName: null, interfaces: [
    { interfaceNumber: 0, claimed: false, alternates: [alt(0xFF, 0xFF, [])] },
    { interfaceNumber: 1, claimed: false, alternates: [alt(0xFF, 2, []), alt(0xFF, 2, [ep(13, 'out', 'isochronous', 256)], 1)] },
    { interfaceNumber: 2, claimed: false, alternates: [alt(0xFF, 2, []), alt(0xFF, 2, [ep(14, 'in', 'isochronous', 256)], 1)] },
    { interfaceNumber: 3, claimed: false, alternates: [alt(0xFF, 3, [ep(3, 'out', 'bulk', 512), ep(4, 'in', 'bulk', 512)]), alt(0xFF, 3, [ep(3, 'out', 'bulk', 512), ep(5, 'in', 'interrupt', 512)], 1)] },
  ] };
  const rxBytes = []; let rxWake = null; let gen = 0; // closing cancels pending reads, as on the real device
  const usbListeners = new Set();
  const usbDev = { productName: 'GP-10', manufacturerName: 'BOSS', vendorId: 0x0582, productId: 0x0185, deviceClass: 255, configurations: [cfg], configuration: null, opened: false,
    async open() { this.opened = true; }, async close() { this.opened = false; usbRx = null; gen++; rxBytes.length = 0; if (rxWake) { const w = rxWake; rxWake = null; w(); } window.__dev.usbClosed = (window.__dev.usbClosed || 0) + 1; },
    async selectConfiguration() { this.configuration = cfg; },
    async claimInterface(n) { if (window.__usbClaimFails) throw new DOMException('Unable to claim interface.', 'NetworkError'); window.__dev.claimed = n;
      usbRx = { push(bytes) { rxBytes.push(...usbPk(bytes, 0)); if (rxWake) { const w = rxWake; rxWake = null; w(); } } };
      // the RPN burst on both cables, as the real unit sends after the claim
      for (const v of [[0xB0, 0x65, 0], [0xB0, 0x64, 0], [0xB0, 0x06, 0x18], [0xB0, 0x26, 0]]) rxBytes.push(...usbPk(v, 0), ...usbPk(v, 1)); },
    async releaseInterface() {}, async selectAlternateInterface() {}, async clearHalt() {},
    async transferOut(n, data) { window.__dev.usbOut = (window.__dev.usbOut || 0) + 1; for (const m of usbUnpk(Array.from(data))) output.send(m); return { status: 'ok', bytesWritten: data.length }; },
    async transferIn(n, len) {
      const g = gen;
      while (!rxBytes.length) { if (!this.opened || g !== gen) throw new DOMException('The device was closed.', 'NetworkError'); await new Promise((r) => { rxWake = r; setTimeout(r, 30); }); }
      if (g !== gen) throw new DOMException('The transfer was cancelled.', 'AbortError');
      const chunk = rxBytes.splice(0, 64); await new Promise((r) => setTimeout(r, 2));
      return { status: 'ok', data: new DataView(new Uint8Array(chunk).buffer) }; } };
  window.__dev.unplug = () => { usbDev.opened = false; for (const f of usbListeners) f({ device: usbDev }); };
  Object.defineProperty(navigator, 'usb', { configurable: true, value: {
    requestDevice: async () => usbDev, getDevices: async () => (window.__dev.claimed != null ? [usbDev] : []),
    addEventListener: (t, f) => { if (t === 'disconnect') usbListeners.add(f); }, removeEventListener: (t, f) => usbListeners.delete(f) } });
  navigator.requestMIDIAccess = async () => ({ sysexEnabled: true, inputs: new Map([['in1', input], ['in2', daw]]), outputs: new Map([['out1', output]]), onstatechange: null });
})();`;
}

module.exports = { buildMock };
