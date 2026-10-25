const { chromium } = require('playwright');
const path = require('path');
const OUT = require('path').join(__dirname, 'out'); require('fs').mkdirSync(OUT, { recursive: true });
const fs = require('fs');

const htmlPath = process.argv[2] || path.join(__dirname, '..', 'index.html');
const mapPath = process.argv[3] || path.join(__dirname, '..', 'data', 'gp10-address-map.json');
const dumpPath = process.argv[4] || path.join(__dirname, 'fixtures', 'temp-patch-dump.txt');
const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
const a2i = (s) => s.split(' ').reduce((v, b) => (v << 7) | parseInt(b, 16), 0);
const blocks = map.patchBlocks.map((b) => ({ base: a2i(b.addr), len: b.length, name: b.name }));
// temp patch memory from the real dump
const mem = {};
for (const ln of fs.readFileSync(dumpPath, 'utf8').split('\n')) {
  const m = ln.match(/^([0-9A-F ]{11})  \+\d+  ((?:[0-9A-F]{2} ?)+)/);
  if (!m) continue;
  const base = a2i(m[1].trim());
  m[2].trim().split(' ').forEach((v, i) => { mem[base + i] = parseInt(v, 16); });
}
const init = { blocks, mem };

const mock = `
(() => {
  const INIT = ${JSON.stringify(init)};
  const cs = (b) => (128 - (b.reduce((a, x) => a + x, 0) % 128)) % 128;
  const a2i = (a) => a.reduce((v, b) => (v << 7) | b, 0) >>> 0;
  const i2a = (n) => { const o = []; for (let i = 0; i < 4; i++) { o.unshift(n & 0x7F); n >>>= 7; } return o; };
  const TEMP = a2i([0x20,0,0,0]), SPAN = a2i([0,4,0,0]);
  const mem = new Map(Object.entries(INIT.mem).map(([k, v]) => [+k, v]));
  const tempBytes = () => { const o = {}; for (const [k, v] of mem) if (k >= TEMP && k < TEMP + SPAN) o[k - TEMP] = v; return o; };
  const base0 = tempBytes();
  // user patches: copy of temp with different name and amp gain
  for (let p = 1; p <= 99; p++) {
    for (const [off, v] of Object.entries(base0)) mem.set(TEMP + SPAN * p + +off, v);
    const nm = ('USER ' + String(p).padStart(2, '0')).padEnd(12, ' ');
    for (let i = 0; i < 12; i++) mem.set(TEMP + SPAN * p + i, nm.charCodeAt(i));
    mem.set(TEMP + SPAN * p + a2i([0,0,0x50,2]), p);
  }
  let current = 12; // 0-based -> patch 13
  const load = (p) => { for (const off of Object.keys(base0)) mem.set(TEMP + +off, mem.get(TEMP + SPAN * p + +off)); };
  load(13);
  window.__dev = { mem, sent: [], get current() { return current; }, setGain(v) { mem.set(TEMP + a2i([0,0,0x50,2]), v); } };
  const input = { id: 'in1', name: 'GP-10', manufacturer: 'Roland', type: 'input', state: 'connected', onmidimessage: null };
  const daw = { id: 'in2', name: 'GP-10 DAW CTRL', manufacturer: 'Roland', type: 'input', state: 'connected', onmidimessage: null };
  let t = 0;
  const emit = (bytes) => { t = Math.max(t, performance.now()) + 3; const d = t - performance.now(); setTimeout(() => input.onmidimessage && input.onmidimessage({ data: new Uint8Array(bytes) }), d); };
  const dt1 = (addr, data) => { const body = [...addr, ...data]; return [0xF0,0x41,0x10,0,0,0,5,0x12,...body,cs(body),0xF7]; };
  function blocksAt(start, size) {
    // which patch region?
    if (start < TEMP) return [];
    const p = Math.floor((start - TEMP) / SPAN); const pbase = TEMP + SPAN * p;
    const out = [];
    for (const b of INIT.blocks) {
      const bs = pbase + (b.base - TEMP); const be = bs + b.len;
      const s = Math.max(bs, start), e = Math.min(be, start + size);
      if (s < e && (s === bs || start > bs)) { const data = []; for (let a = s; a < e; a++) data.push(mem.get(a) ?? 0); out.push([s, data]); }
    }
    return out;
  }
  const output = { id: 'out1', name: 'GP-10', manufacturer: 'Roland', type: 'output', state: 'connected',
    send(b) {
      b = Array.from(b); window.__dev.sent.push(b);
      if (b[0] === 0xF0 && b[1] === 0x7E && b[4] === 0x01) { emit([0xF0,0x7E,0x10,0x06,0x02,0x41,0x05,0x03,0,0,0,0,0,0,0xF7]); return; }
      if ((b[0] & 0xF0) === 0xC0) { current = b[1]; load(current + 1); return; }
      if (b[0] !== 0xF0 || b[1] !== 0x41) return;
      const body = b.slice(8, -2);
      if (cs(body) !== b[b.length - 2]) { window.__dev.badcs = (window.__dev.badcs || 0) + 1; return; }
      const addr = a2i(body.slice(0, 4));
      if (b[7] === 0x11) {
        const size = a2i(body.slice(4, 8));
        if (addr === 0) { emit(dt1([0,0,0,0], [current])); return; }
        for (const [s, data] of blocksAt(addr, size)) emit(dt1(i2a(s), data));
      } else if (b[7] === 0x12) {
        const data = body.slice(4);
        if (addr === 0) { window.__dev.setupWrites = (window.__dev.setupWrites || 0) + 1; current = data[0]; load(current + 1); return; }
        data.forEach((v, i) => mem.set(addr + i, v));
      }
    } };
  navigator.requestMIDIAccess = async () => ({ sysexEnabled: true, inputs: new Map([['in1', input], ['in2', daw]]), outputs: new Map([['out1', output]]), onstatechange: null });
})();`;

const param = (page, name) => page.locator('.param').filter({ has: page.locator('.nm', { hasText: new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') }) }).first();
const hexs = (a) => a.map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join(' ');
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1360, height: 1500 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(mock);
  await page.goto('file://' + path.resolve(htmlPath));
  await page.screenshot({ path: path.join(OUT, 'ed-empty.png') });
  await page.click('#btnConnect');
  await page.waitForSelector('#editor:not([hidden])', { timeout: 5000 });
  await page.waitForTimeout(400);
  console.log('status:', await page.textContent('#status'), '| patch:', await page.textContent('#patchNo'), await page.inputValue('#patchName'));
  console.log('chain:', await page.$$eval('#chain .chip', (c) => c.map((x) => (x.classList.contains('on') ? '*' : '') + x.textContent).join(' ')));
  // open AMP
  await page.locator('.tab', { hasText: /^AMP$/ }).click();
  const gainBox = param(page,'Gain');
  console.log('amp gain shown:', await gainBox.locator('.val').textContent(), '| amp params:', await page.$$eval('#params .param', (p) => p.length));
  await page.evaluate(() => window.__dev.sent.length = 0);
  const slider = gainBox.locator('input[type=range]');
  await slider.fill('110'); await page.waitForTimeout(80);
  const sent1 = await page.evaluate(() => window.__dev.sent);
  console.log('sent on gain change:', sent1.map(hexs));
  console.log('device gain now:', await page.evaluate(() => window.__dev.mem.get(((0x20 << 21) | (0x50 << 7) | 2))));
  // amp type select
  const typeSel = param(page,'Type').locator('select');
  console.log('amp type options:', await typeSel.locator('option').count(), 'current:', await typeSel.evaluate((s) => s.options[s.selectedIndex].text));
  // delay time (nibble)
  await page.locator('.tab', { hasText: /^DELAY$/ }).click();
  await page.evaluate(() => window.__dev.sent.length = 0);
  const dt = param(page,'Time');
  console.log('delay time label before:', await dt.locator('.val').textContent());
  await dt.locator('input[type=range]').fill('500'); await page.waitForTimeout(80);
  console.log('delay time label after:', await dt.locator('.val').textContent(), '| sent:', (await page.evaluate(() => window.__dev.sent)).map(hexs));
  // FX select switching sub block
  await page.locator('.tab', { hasText: /^FX$/ }).click();
  const fxSel = param(page,'Fx Select').locator('select');
  await fxSel.selectOption({ label: 'DELAY' }); await page.waitForTimeout(80);
  console.log('fx subhead:', await page.textContent('#params .subhead'), '| params:', await page.$$eval('#params .param .nm', (n) => n.slice(0, 6).map((x) => x.textContent)));
  await fxSel.selectOption({ label: 'PHASER' }); await page.waitForTimeout(80);
  console.log('fx subhead2:', await page.textContent('#params .subhead'));
  // modeling type -> detail tab
  await page.locator('.tab', { hasText: /^MODELING$/ }).click();
  const mt = param(page,'Modeling Type').locator('select');
  console.log('modeling type:', await mt.evaluate((s) => s.options[s.selectedIndex].text));
  await mt.selectOption({ label: 'SYNTH' }); await page.waitForTimeout(80);
  console.log('tabs now:', await page.$$eval('#tabs .tab', (t) => t.map((x) => x.textContent).join(',')));
  await page.locator('.tab', { hasText: /^SYNTH$/ }).click();
  const synthNames = await page.$$eval('#params .param .nm', (n) => n.map((x) => x.textContent));
  console.log('SYNTH visible params:', synthNames.length, synthNames.slice(0, 5));
  const st = param(page,'SYNTH Type').locator('select');
  await st.selectOption({ label: 'OSC SYNTH' }); await page.waitForTimeout(80);
  console.log('SYNTH(OSC) visible params:', await page.$$eval('#params .param', (n) => n.length));
  // chain dblclick toggles
  await page.evaluate(() => window.__dev.sent.length = 0);
  await page.dblclick('#chain .chip:has-text("REVERB")'); await page.waitForTimeout(80);
  console.log('reverb toggle sent:', (await page.evaluate(() => window.__dev.sent)).map(hexs));
  // patch name
  await page.fill('#patchName', 'CLAUDE TEST'); await page.press('#patchName', 'Enter'); await page.waitForTimeout(60);
  console.log('device name:', await page.evaluate(() => String.fromCharCode(...Array.from({ length: 12 }, (_, i) => window.__dev.mem.get((0x20 << 21) + i)))));
  // patch list + select
  await page.click('#btnNames');
  await page.waitForFunction(() => document.querySelectorAll('#patchList li').length === 99 && !document.querySelector('#btnNames').disabled, null, { timeout: 20000 });
  console.log('list sample:', await page.$$eval('#patchList li', (l) => [l[0].textContent, l[12].textContent, l[12].className, l[98].textContent]));
  await page.click('#patchList li:nth-child(5)');
  await page.waitForTimeout(900);
  console.log('after select 5: no', await page.textContent('#patchNo'), 'name', await page.inputValue('#patchName'), 'setupWrites', await page.evaluate(() => window.__dev.setupWrites));
  await page.locator('.tab', { hasText: /^AMP$/ }).click();
  console.log('amp gain of patch 5:', await param(page,'Gain').locator('.val').textContent());
  // sync from device
  await page.check('#chkSync');
  await page.evaluate(() => window.__dev.setGain(77));
  await page.waitForTimeout(2200);
  console.log('synced gain:', await param(page,'Gain').locator('.val').textContent());
  await page.uncheck('#chkSync');
  // export / import syx
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnExport')]);
  const syx = path.join(OUT, 'patch.syx'); await dl.saveAs(syx);
  const bytes = fs.readFileSync(syx); console.log('syx bytes:', bytes.length, 'messages:', bytes.filter((x) => x === 0xF0).length);
  await page.evaluate(() => window.__dev.setGain(5));
  await page.setInputFiles('#fileSyx', syx); await page.waitForTimeout(2000);
  console.log('after import device gain:', await page.evaluate(() => window.__dev.mem.get(((0x20 << 21) | (0x50 << 7) | 2))), 'bad cs at device:', await page.evaluate(() => window.__dev.badcs || 0));
  console.log('errors:', errors);
  await page.locator('.tab', { hasText: /^AMP$/ }).click();
  await page.screenshot({ path: path.join(OUT, 'ed-light.png'), fullPage: false });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: path.join(OUT, 'ed-dark.png'), fullPage: false });
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.screenshot({ path: path.join(OUT, 'ed-mobile.png'), fullPage: false });
  console.log('mobile overflow:', await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth));
  await browser.close();
})();
