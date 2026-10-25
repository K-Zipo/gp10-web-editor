const { chromium } = require('playwright');
const path = require('path');
const OUT = require('path').join(__dirname, 'out'); require('fs').mkdirSync(OUT, { recursive: true });

const mock = `
(() => {
  const cs = (b) => (128 - (b.reduce((a, x) => a + x, 0) % 128)) % 128;
  const name = Array.from('SYMPHO DRIVE').map((c) => c.charCodeAt(0));
  window.__params = Array.from({ length: 40 }, (_, i) => (i * 7) % 100);
  const input = { id: 'in1', name: 'GP-10', manufacturer: 'Roland', type: 'input', state: 'connected', onmidimessage: null };
  const emit = (bytes, d) => setTimeout(() => input.onmidimessage && input.onmidimessage({ data: new Uint8Array(bytes) }), d);
  const dt1 = (addr, data) => { const body = [...addr, ...data]; return [0xF0,0x41,0x10,0,0,0,5,0x12,...body,cs(body),0xF7]; };
  const output = { id: 'out1', name: 'GP-10', manufacturer: 'Roland', type: 'output', state: 'connected',
    send(b) {
      b = Array.from(b);
      if (b[1] === 0x41 && b[7] === 0x11 && b[8] === 0x20) {
        emit(dt1([0x20,0,0,0], name), 10);
        emit(dt1([0x20,0,1,0], window.__params), 40);
      }
    } };
  const access = { sysexEnabled: true, inputs: new Map([['in1', input]]), outputs: new Map([['out1', output]]), onstatechange: null };
  navigator.requestMIDIAccess = async () => access;
})();`;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(mock);
  await page.goto('file://' + path.resolve(process.argv[2] || path.join(__dirname, '..', 'bench', 'index.html')));
  console.log('7bit addr math 20 00 01 00 + 130 =', await page.evaluate(() => { const g = window.__gp10; return g.intToAddr(g.addrToInt([0x20,0,1,0]) + 130).map((x) => x.toString(16)).join(' '); }));
  await page.click('#btnAccess'); await page.waitForTimeout(150);
  await page.click('#btnDump'); await page.waitForTimeout(500);
  console.log('info1:', await page.textContent('#dumpInfo'));
  await page.evaluate(() => { window.__params[5] = 99; window.__params[17] = 3; });
  await page.click('#btnDump'); await page.waitForTimeout(500);
  console.log('info2:', await page.textContent('#dumpInfo'));
  console.log('diff rows:', await page.$$eval('#diffBody tr', (r) => r.map((x) => Array.from(x.children).slice(1).map((c) => c.textContent).join(' | '))));
  console.log('highlighted:', await page.$$eval('#dumpView b.chg', (b) => b.length));
  // polling
  await page.check('#chkPoll');
  await page.waitForTimeout(700);
  await page.evaluate(() => { window.__params[30] = 42; });
  await page.waitForTimeout(1800);
  await page.uncheck('#chkPoll');
  await page.waitForTimeout(1500);
  console.log('after poll rows:', await page.$$eval('#diffBody tr', (r) => r.length), 'ever:', await page.$$eval('#dumpView b.ever', (b) => b.length));
  console.log('log entries (quiet mode):', await page.textContent('#logCount'));
  console.log('dump first lines:\n' + (await page.$eval('#dumpView', (d) => d.innerText)).split('\n').slice(0, 6).join('\n'));
  console.log('errors:', errors);
  await page.locator('section.wide').first().screenshot({ path: path.join(OUT, 'shot-dump.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.locator('section.wide').first().screenshot({ path: path.join(OUT, 'shot-dump-dark.png') });
  await page.setViewportSize({ width: 390, height: 900 });
  console.log('mobile overflow:', await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth));
  await browser.close();
})();
