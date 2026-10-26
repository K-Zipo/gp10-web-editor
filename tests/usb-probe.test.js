// Tests bench/usb.html against a fake navigator.usb device.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const OUT = path.join(__dirname, 'out'); fs.mkdirSync(OUT, { recursive: true });
const page0 = path.join(__dirname, '..', 'bench', 'usb.html');

const fake = (claimFails) => `
(() => {
  const pk = (bytes) => { const o = []; for (let i = 0; i < bytes.length; i += 3) { const c = bytes.slice(i, i + 3); const last = i + 3 >= bytes.length; o.push(!last ? 4 : c.length === 1 ? 5 : c.length === 2 ? 6 : 7, ...c, ...new Array(3 - c.length).fill(0)); } return new Uint8Array(o); };
  let pending = null; window.__sent = [];
  const ep = (n, d, t, s) => ({ endpointNumber: n, direction: d, type: t, packetSize: s });
  const alt = (cls, sub, eps, set = 0) => ({ alternateSetting: set, interfaceClass: cls, interfaceSubclass: sub, interfaceProtocol: 0, interfaceName: null, endpoints: eps });
  const config = { configurationValue: 1, configurationName: null, interfaces: [
    { interfaceNumber: 0, claimed: false, alternates: [alt(0xFF, 2, [])] },
    { interfaceNumber: 1, claimed: false, alternates: [alt(0xFF, 2, [], 0), alt(0xFF, 2, [ep(1, 'out', 'isochronous', 360)], 1)] },
    { interfaceNumber: 2, claimed: false, alternates: [alt(0xFF, 2, [], 0), alt(0xFF, 2, [ep(13, 'in', 'isochronous', 360)], 1)] },
    { interfaceNumber: 3, claimed: false, alternates: [alt(0xFF, 3, [ep(2, 'out', 'bulk', 512), ep(4, 'in', 'bulk', 512)])] },
  ] };
  const dev = { productName: 'GP-10', manufacturerName: 'Roland', vendorId: 0x0582, productId: 0x0185, usbVersionMajor: 2, usbVersionMinor: 0, deviceClass: 0xFF, configurations: [config], configuration: null,
    async open() {}, async close() {}, async selectConfiguration() { this.configuration = config; },
    async claimInterface(n) { if (${claimFails}) throw new DOMException('Unable to claim interface.', 'NetworkError'); },
    async releaseInterface() {}, async selectAlternateInterface() {},
    async transferOut(n, data) { window.__sent.push(Array.from(data)); pending = pk([0xF0, 0x7E, 0x10, 0x06, 0x02, 0x41, 0x05, 0x03, 0, 0, 0, 0, 0, 0, 0xF7]); return { status: 'ok', bytesWritten: data.length }; },
    async transferIn(n, len) { await new Promise((r) => setTimeout(r, 10)); if (!pending) return new Promise(() => {}); const d = pending; pending = null; return { status: 'ok', data: new DataView(d.buffer) }; } };
  Object.defineProperty(navigator, 'usb', { value: { requestDevice: async () => dev } });
})();`;

(async () => {
  const browser = await chromium.launch();
  for (const claimFails of [false, true]) {
    const page = await browser.newPage({ viewport: { width: 1000, height: 1400 } });
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(fake(claimFails));
    await page.goto('file://' + page0);
    await page.click('#btnPick'); await page.waitForTimeout(100);
    console.log(`[claimFails=${claimFails}] verdict:`, (await page.textContent('#verdict')).trim().slice(0, 60));
    await page.click('#btnTest'); await page.waitForTimeout(700);
    console.log('  test:', (await page.textContent('#testResult strong')).trim(), '| sent', JSON.stringify(await page.evaluate(() => window.__sent)));
    const rep = JSON.parse(await page.textContent('#report'));
    console.log('  report candidate', JSON.stringify(rep.candidate), '| reply', rep.test.reply || rep.test.error);
    if (!claimFails) assert.ok(rep.test.ok); else assert.ok(!rep.test.ok && /claim/i.test(rep.test.error));
    assert.deepStrictEqual(errors, []);
    await page.screenshot({ path: path.join(OUT, `usb-probe-${claimFails ? 'claimed' : 'ok'}.png`), fullPage: true });
    await page.close();
  }
  // packet helpers round trip
  const p = await browser.newPage(); await p.goto('file://' + page0);
  const rt = await p.evaluate(() => { const m = [0xF0, 0x41, 0x10, 0, 0, 0, 5, 0x12, 0x20, 0, 0x50, 2, 0x6E, 0x20, 0xF7]; return window.__probe.packetsToBytes(window.__probe.sysexToPackets(m)).join(',') === m.join(','); });
  console.log('packet round trip:', rt); assert.ok(rt);
  await browser.close(); console.log('OK');
})().catch((e) => { console.error(e); process.exit(1); });
