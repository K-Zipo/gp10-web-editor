const { chromium } = require('playwright');
const path = require('path');
const OUT = require('path').join(__dirname, 'out'); require('fs').mkdirSync(OUT, { recursive: true });

const mock = `
(() => {
  const cs = (b) => (128 - (b.reduce((a, x) => a + x, 0) % 128)) % 128;
  const listeners = [];
  const input = { id: 'in1', name: 'GP-10', manufacturer: 'Roland', type: 'input', state: 'connected', onmidimessage: null };
  const daw = { id: 'in2', name: 'GP-10 DAW CTRL', manufacturer: 'Roland', type: 'input', state: 'connected', onmidimessage: null };
  const emit = (bytes) => setTimeout(() => input.onmidimessage && input.onmidimessage({ data: new Uint8Array(bytes) }), 15);
  const output = { id: 'out1', name: 'GP-10', manufacturer: 'Roland', type: 'output', state: 'connected',
    send(b) {
      b = Array.from(b);
      window.__sent = (window.__sent || []).concat([b]);
      if (b.join() === [0xF0,0x7E,0x7F,0x06,0x01,0xF7].join()) { emit([0xF0,0x7E,0x10,0x06,0x02,0x41,0x05,0x03,0,0,0,0,0,0,0xF7]); return; }
      // RQ1: F0 41 10 00 00 00 05 11 a a a a s s s s cs F7
      if (b[1] === 0x41 && b[2] === 0x10 && b.slice(3,7).join() === '0,0,0,5' && b[7] === 0x11) {
        const addr = b.slice(8,12), size = b.slice(12,16);
        if (cs(b.slice(8,16)) !== b[16]) return; // bad checksum ignored
        if (addr[0] === 0x10 || addr[0] === 0x20) {
          const n = size[3];
          const data = Array.from({length:n}, (_, i) => 'Clean Tone      '.charCodeAt(i % 16));
          const body = [...addr, ...data];
          emit([0xF0,0x41,0x10,0,0,0,5,0x12,...body,cs(body),0xF7]);
        }
      }
    } };
  const access = { sysexEnabled: true, inputs: new Map([['in1', input], ['in2', daw]]), outputs: new Map([['out1', output]]), onstatechange: null };
  navigator.requestMIDIAccess = async () => access;
  window.__emitCC = () => emit([0xB0, 0x0B, 0x21]);
})();`;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(mock);
  await page.goto('file://' + path.resolve(process.argv[2] || path.join(__dirname, '..', 'bench', 'index.html')));

  // unit: checksum GS reset example -> 0x41
  const csv = await page.evaluate(() => window.__gp10.checksum([0x40, 0x00, 0x7F, 0x00]));
  console.log('checksum GS reset =', csv.toString(16), csv === 0x41 ? 'OK' : 'NG');

  await page.click('#btnAccess');
  await page.waitForTimeout(200);
  console.log('selected in/out:', await page.$eval('#selIn', (s) => s.options[s.selectedIndex].text), '/', await page.$eval('#selOut', (s) => s.options[s.selectedIndex].text));
  console.log('status:', await page.textContent('#status'));

  await page.click('#btnIdent');
  await page.waitForTimeout(300);
  console.log('ident:\n' + await page.textContent('#identRes'));

  await page.fill('#inAddr', '10 00 00 00');
  await page.click('#btnRQ1');
  await page.waitForTimeout(300);
  console.log('rq1:\n' + await page.textContent('#rq1Res'));

  await page.fill('#inAddr', '30 00 00 00');
  await page.click('#btnRQ1');
  await page.waitForTimeout(700);
  console.log('rq1 (no reply):', await page.textContent('#rq1Res'));

  await page.fill('#inTimeout', '80');
  await page.fill('#inFrom', '0E'); await page.fill('#inTo', '22');
  await page.click('#btnScan');
  await page.waitForFunction(() => document.getElementById('btnStop').disabled, null, { timeout: 15000 });
  console.log('scan info:', await page.textContent('#scanInfo'));
  console.log('scan rows:', await page.$$eval('#scanBody tr', (r) => r.map((x) => x.children[0].textContent)));

  // raw with checksum
  await page.fill('#rawIn', 'F0 41 10 00 00 00 05 11 10 00 00 00 00 00 00 04 F7');
  await page.click('#btnPreview');
  console.log('raw preview:', await page.textContent('#rawRes'));
  await page.click('#btnRaw');
  await page.waitForTimeout(200);

  await page.evaluate(() => window.__emitCC());
  await page.waitForTimeout(100);
  const rows = await page.$$eval('#logBody tr', (r) => r.slice(-6).map((x) => Array.from(x.children).map((c) => c.textContent).join(' | ')));
  console.log('last log rows:\n' + rows.join('\n'));
  console.log('page errors:', errors);
  await page.screenshot({ path: path.join(OUT, 'shot-light.png'), fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: path.join(OUT, 'shot-dark.png') });
  await page.setViewportSize({ width: 390, height: 900 });
  await page.screenshot({ path: path.join(OUT, 'shot-mobile.png') });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  console.log('mobile horizontal overflow:', overflow);
  await browser.close();
})();
