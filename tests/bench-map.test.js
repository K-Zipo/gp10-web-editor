const { chromium } = require('playwright');
const path = require('path');
const OUT = require('path').join(__dirname, 'out'); require('fs').mkdirSync(OUT, { recursive: true });
const fs = require('fs');

const mock = `
(() => {
  const cs = (b) => (128 - (b.reduce((a, x) => a + x, 0) % 128)) % 128;
  const name = Array.from('STRINGS     ').map((c) => c.charCodeAt(0));
  window.__amp = [0x01,0x07,0x4E,0x0A,0x28,0x32,0x32,0x32,0,0,1,0,0x32,0,1,1,1,5,0x64];
  const input = { id: 'in1', name: 'GP-10', manufacturer: 'Roland', type: 'input', state: 'connected', onmidimessage: null };
  const emit = (bytes, d) => setTimeout(() => input.onmidimessage && input.onmidimessage({ data: new Uint8Array(bytes) }), d);
  const dt1 = (addr, data) => { const body = [...addr, ...data]; return [0xF0,0x41,0x10,0,0,0,5,0x12,...body,cs(body),0xF7]; };
  const output = { id: 'out1', name: 'GP-10', manufacturer: 'Roland', type: 'output', state: 'connected',
    send(b) { b = Array.from(b); if (b[7] === 0x11 && b[8] === 0x20) { emit(dt1([0x20,0,0,0], name), 10); emit(dt1([0x20,0,0x50,0], window.__amp), 30); } } };
  navigator.requestMIDIAccess = async () => ({ sysexEnabled: true, inputs: new Map([['in1', input]]), outputs: new Map([['out1', output]]), onstatechange: null });
})();`;

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 1800 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(mock);
  await page.goto('file://' + path.resolve(process.argv[2] || path.join(__dirname, '..', 'bench', 'index.html')));
  console.log('seed map rows:', await page.$$eval('#mapBody tr', (r) => r.map((x) => x.children[0].textContent + ' ' + x.children[1].textContent)));
  await page.click('#btnAccess'); await page.waitForTimeout(150);
  console.log('dump size default:', await page.inputValue('#inDumpSize'));
  await page.click('#btnDump'); await page.waitForTimeout(500);
  await page.evaluate(() => { window.__amp[2] = 0x4F; window.__amp[5] = 0x40; });
  await page.click('#btnDump'); await page.waitForTimeout(500);
  const rows = await page.$$eval('#diffBody tr', (r) => r.map((x) => [x.children[1].textContent, x.children[3].textContent, x.querySelector('input').value]));
  console.log('diff rows:', rows);
  // name the BASS candidate from diff row
  const inp = page.locator('#diffBody tr input').filter({ hasNot: page.locator('[value]') });
  const target = page.locator('#diffBody input[data-addr="20 00 50 05"]');
  await target.fill('AMP BASS?'); await target.dispatchEvent('change');
  console.log('map rows:', await page.$$eval('#mapBody tr', (r) => r.map((x) => Array.from(x.children).slice(0, 5).map((c) => c.textContent).join(' | '))));
  console.log('labelled bytes in dump:', await page.$$eval('#dumpView b.lab', (b) => b.map((x) => x.title).filter((v, i, a) => a.indexOf(v) === i)));
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnMapExport')]);
  const p = path.join(OUT, 'map.json'); await dl.saveAs(p);
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  console.log('export params:', j.params.map((x) => `${x.addr} ${x.name} ${x.observedMin}-${x.observedMax}`));
  // import round-trip into fresh storage
  await page.evaluate(() => localStorage.removeItem('gp10bench.map'));
  await page.reload(); await page.waitForTimeout(200);
  await page.setInputFiles('#fileMap', p); await page.waitForTimeout(300);
  console.log('after import:', await page.textContent('#mapInfo'), await page.$$eval('#mapBody tr', (r) => r.length));
  console.log('errors:', errors);
  await page.locator('section.wide').nth(1).screenshot({ path: path.join(OUT, 'shot-map.png') });
  await page.setViewportSize({ width: 390, height: 900 });
  console.log('mobile overflow:', await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth));
  await browser.close();
})();
