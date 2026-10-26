// Unit tests for tools/usbmidi.js (USB-MIDI packet encoding and decoding).
const assert = require('assert');
const U = require('../tools/usbmidi.js');
const hx = (s) => s.trim().split(/\s+/).map((x) => parseInt(x, 16));

function parseAll(data, cable = 0) { const out = []; const feed = U.createParser((m) => out.push(m)); for (const b of U.packetsToBytes(data, cable)) feed(b); return out; }

// 1. The two transfers captured from a real GP-10 (Mac, driver stopped).
const t1 = hx('0B B0 65 00 1B B0 65 00 0B B0 64 00 1B B0 64 00 0B B0 06 18 1B B0 06 18 0B B0 26 00 1B B0 26 00 0B B0 65 7F 1B B0 65 7F 0B B0 64 7F 1B B0 64 7F');
const t2 = hx('04 F0 7E 10 04 06 02 41 04 05 03 00 04 00 00 00 07 00 00 F7');
const m1 = parseAll(t1);
assert.deepStrictEqual(m1, [[0xB0, 0x65, 0], [0xB0, 0x64, 0], [0xB0, 0x06, 0x18], [0xB0, 0x26, 0], [0xB0, 0x65, 0x7F], [0xB0, 0x64, 0x7F]]);
assert.strictEqual(parseAll(t1, 1).length, 6, 'cable 1 carries the same burst');
assert.deepStrictEqual(parseAll(t2), [hx('F0 7E 10 06 02 41 05 03 00 00 00 00 00 00 F7')]);

// 2. The identity request encodes exactly as the probe sent it.
assert.deepStrictEqual(Array.from(U.bytesToPackets(hx('F0 7E 7F 06 01 F7'))), hx('04 F0 7E 7F 07 06 01 F7'));

// 3. SysEx endings with 1, 2 and 3 bytes in the last packet; round trip.
for (const n of [6, 7, 8, 15, 16, 17]) {
  const m = [0xF0, ...Array.from({ length: n - 2 }, (_, i) => i & 0x7F), 0xF7];
  const pk = U.bytesToPackets(m);
  assert.strictEqual(pk.length % 4, 0);
  assert.strictEqual(pk[pk.length - 4] & 0x0F, [7, 5, 6][(n % 3)], `CIN for length ${n}`);
  assert.deepStrictEqual(parseAll(pk), [m]);
}

// 4. Short messages: Program Change (2 bytes), CC, and a run of several.
assert.deepStrictEqual(Array.from(U.bytesToPackets([0xC0, 12])), [0x0C, 0xC0, 12, 0]);
assert.deepStrictEqual(Array.from(U.bytesToPackets([0xB0, 0, 0, 0xB0, 0x20, 0, 0xC0, 5])), hx('0B B0 00 00 0B B0 20 00 0C C0 05 00'));
assert.deepStrictEqual(Array.from(U.bytesToPackets([0xF8])), [0x0F, 0xF8, 0, 0]);

// 5. A SysEx split across transfers, interleaved with cable-1 traffic and clock.
const dt1 = hx('F0 41 10 00 00 00 05 12 20 00 50 02 4F 5F F7');
const pk = Array.from(U.bytesToPackets(dt1));
const noisy = [...pk.slice(0, 8), 0x1B, 0xB0, 0x07, 0x40, 0x0F, 0xF8, 0, 0, ...pk.slice(8)];
const got = []; const feed = U.createParser((m) => got.push(m));
for (const part of [noisy.slice(0, 12), noisy.slice(12)]) for (const b of U.packetsToBytes(part, 0)) feed(b);
assert.deepStrictEqual(got, [[0xF8], dt1]);

// 6. Interface choice follows the real GP-10 layout (iface 3, alt 0, bulk OUT 3 / IN 4).
const ep = (n, d, t) => ({ endpointNumber: n, direction: d, type: t, packetSize: 512 });
const alt = (c, s, e, a = 0) => ({ alternateSetting: a, interfaceClass: c, interfaceSubclass: s, endpoints: e });
const dev = { configurations: [{ configurationValue: 1, interfaces: [
  { interfaceNumber: 0, alternates: [alt(255, 255, [])] },
  { interfaceNumber: 1, alternates: [alt(255, 2, []), alt(255, 2, [ep(13, 'out', 'isochronous')], 1)] },
  { interfaceNumber: 3, alternates: [alt(255, 3, [ep(3, 'out', 'bulk'), ep(4, 'in', 'bulk')]), alt(255, 3, [ep(3, 'out', 'bulk'), ep(5, 'in', 'interrupt')], 1)] },
] }] };
assert.deepStrictEqual(U.findMidiInterface(dev), { config: 1, iface: 3, alt: 0, score: 4, inEp: 4, outEp: 3, inSize: 512 });
console.log('usbmidi OK');
