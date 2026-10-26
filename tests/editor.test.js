// End-to-end test of the editor (index.html) against a mock GP-10.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { buildMock } = require('./mock-gp10');

const OUT = path.join(__dirname, 'out'); fs.mkdirSync(OUT, { recursive: true });
const htmlPath = process.argv[2] || path.join(__dirname, '..', 'index.html');
const mapPath = path.join(__dirname, '..', 'data', 'gp10-address-map.json');
const dumpPath = path.join(__dirname, 'fixtures', 'temp-patch-dump.txt');
const hexs = (a) => a.map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join(' ');
const ctl = (page, name) => page.locator('#ctls .ctl').filter({ has: page.locator('.n', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) }).first();
const tile = (page, key) => page.locator(`#rail .tile[data-view="${key}"]`);

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.googleapis|ERR_/.test(m.text())) errors.push(m.text()); });
  await page.addInitScript(buildMock(mapPath, dumpPath));
  await page.goto('file://' + path.resolve(htmlPath));
  await page.screenshot({ path: path.join(OUT, 'ui-welcome.png') });

  await page.click('#btnConnect2');
  await page.waitForSelector('#inspector:not([hidden])', { timeout: 5000 });
  await page.waitForTimeout(300);
  console.log('status:', await page.textContent('#statusText'), '| patch', await page.textContent('#patchNo'), await page.inputValue('#patchName'));
  const rail = await page.$$eval('#rail > *', (els) => els.map((e) => e.dataset.view || e.textContent.trim()).filter(Boolean));
  console.log('rail:', rail.join(' '));

  // AMP
  await tile(page, 'AMP').click();
  const gain = ctl(page, 'Gain');
  console.log('amp:', await page.textContent('#inspModel'), '| gain', await gain.locator('.v').textContent());
  await page.evaluate(() => { window.__dev.sent.length = 0; });
  const knob = gain.locator('.knob');
  await knob.focus(); await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp'); await page.waitForTimeout(80);
  const s1 = await page.evaluate(() => window.__dev.sent);
  console.log('gain keyboard → sent', s1.map(hexs));
  assert.strictEqual(await page.evaluate(() => window.__dev.peek([0x20, 0, 0x50, 2])), 15, 'gain on device should be 13+2');
  // drag the knob upward
  const box = await knob.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 110, { steps: 8 }); await page.mouse.up(); await page.waitForTimeout(80);
  console.log('gain after drag:', await gain.locator('.v').textContent(), 'device', await page.evaluate(() => window.__dev.peek([0x20, 0, 0x50, 2])));
  // inline typing
  await knob.dblclick(); await page.keyboard.press('Control+A'); await page.keyboard.type('42'); await page.keyboard.press('Enter'); await page.waitForTimeout(80);
  assert.strictEqual(await page.evaluate(() => window.__dev.peek([0x20, 0, 0x50, 2])), 42, 'typed value');
  // model browser
  await page.click('#browser button:has-text("JC-120")'); await page.waitForTimeout(80);
  console.log('amp type after browser click:', await page.textContent('#inspModel'), '| tile:', await tile(page, 'AMP').locator('.md').textContent());
  // T-Comp signed display
  console.log('t-comp:', await ctl(page, 'T-Comp').locator('.v').textContent());
  // power toggle via tile button
  const before = await page.evaluate(() => window.__dev.peek([0x20, 0, 0x50, 0]));
  await tile(page, 'AMP').locator('.pw').click(); await page.waitForTimeout(80);
  console.log('amp switch', before, '→', await page.evaluate(() => window.__dev.peek([0x20, 0, 0x50, 0])), '| power label', await page.textContent('#inspPower'));
  await page.screenshot({ path: path.join(OUT, 'ui-amp.png') });

  // DELAY nibble param
  await tile(page, 'DELAY').click();
  const time = ctl(page, 'Time');
  await time.locator('.knob').dblclick(); await page.keyboard.press('Control+A'); await page.keyboard.type('500'); await page.keyboard.press('Enter'); await page.waitForTimeout(80);
  const tb = await page.evaluate(() => [1, 2, 3].map((i) => window.__dev.peek([0x20, 1, 0x70, 1 + i])));
  console.log('delay time', await time.locator('.v').textContent(), 'device bytes', hexs(tb));
  assert.deepStrictEqual(tb, [0x01, 0x0F, 0x04]);

  // FX sub block via browser
  await tile(page, 'FX').click();
  await page.click('#browser button:has-text("PHASER")'); await page.waitForTimeout(80);
  console.log('fx:', await page.textContent('#inspModel'), '| controls', await page.$$eval('#ctls .ctl .n', (n) => n.map((x) => x.textContent).join(', ')));

  // MODELING: two browser sections, switch to SYNTH then GR-300
  await tile(page, 'MODELING').click();
  console.log('modeling browser:', await page.$$eval('#browser h3', (h) => h.map((x) => x.textContent)));
  await page.click('#browser button:has-text("SYNTH")'); await page.waitForTimeout(80);
  await page.click('#browser button:has-text("GR-300")'); await page.waitForTimeout(80);
  console.log('modeling:', await page.textContent('#inspModel'), '| groups', await page.$$eval('#ctls .group h3', (h) => h.map((x) => x.textContent).join(',')), '| controls', await page.$$eval('#ctls .ctl', (c) => c.length));
  await page.screenshot({ path: path.join(OUT, 'ui-modeling.png') });

  // utility views
  for (const v of ['パッチ', 'チューニング', 'コントローラー', 'アサイン']) {
    await page.click(`#views button:has-text("${v}")`); await page.waitForTimeout(50);
    console.log(v, '→ groups', await page.$$eval('#ctls .group h3', (h) => h.slice(0, 4).map((x) => x.textContent).join(',')), 'controls', await page.$$eval('#ctls .ctl', (c) => c.length));
  }
  await page.screenshot({ path: path.join(OUT, 'ui-assign.png') });
  // mixer node
  await page.click('#rail .node.mixer'); await page.waitForTimeout(50);
  console.log('mixer controls:', await page.$$eval('#ctls .ctl .n', (n) => n.map((x) => x.textContent).join(', ')));

  // drag reorder: move REVERB before AMP
  const chainBefore = await page.evaluate(() => Array.from({ length: 11 }, (_, i) => window.__dev.peek([0x20, 0, 0x48, i])));
  await tile(page, 'REVERB').dragTo(tile(page, 'AMP')); await page.waitForTimeout(100);
  const chainAfter = await page.evaluate(() => Array.from({ length: 11 }, (_, i) => window.__dev.peek([0x20, 0, 0x48, i])));
  console.log('chain', chainBefore.join(','), '→', chainAfter.join(','));
  console.log('rail after drag:', (await page.$$eval('#rail .tile', (t) => t.map((x) => x.dataset.view))).join(' '));

  // patch name and list
  await page.fill('#patchName', 'HX STYLE'); await page.press('#patchName', 'Enter'); await page.waitForTimeout(50);
  console.log('device name:', await page.evaluate(() => String.fromCharCode(...Array.from({ length: 12 }, (_, i) => window.__dev.peek([0x20, 0, 0, i])))));
  await page.click('#btnNames');
  await page.waitForFunction(() => document.querySelectorAll('#patchList li').length === 99 && !document.querySelector('#btnNames').disabled, null, { timeout: 20000 });
  await page.fill('#patchSearch', '07'); await page.waitForTimeout(50);
  console.log('search 07:', await page.$$eval('#patchList li', (l) => l.map((x) => x.textContent)));
  await page.fill('#patchSearch', '');
  await page.click('#patchList li:nth-child(5)'); await page.waitForTimeout(900);
  console.log('after select:', await page.textContent('#patchNo'), await page.inputValue('#patchName'));

  // sync
  await page.check('#chkSync', { force: true });
  await tile(page, 'AMP').click();
  await page.evaluate(() => window.__dev.poke([0x20, 0, 0x50, 2], 77));
  await page.waitForTimeout(2200);
  console.log('synced gain:', await ctl(page, 'Gain').locator('.v').textContent());
  await page.uncheck('#chkSync', { force: true });

  // syx round trip
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnExport')]);
  const syx = path.join(OUT, 'patch.syx'); await dl.saveAs(syx);
  await page.evaluate(() => window.__dev.poke([0x20, 0, 0x50, 2], 3));
  await page.setInputFiles('#fileSyx', syx); await page.waitForTimeout(2000);
  console.log('after import gain:', await page.evaluate(() => window.__dev.peek([0x20, 0, 0x50, 2])), 'bad checksum at device:', await page.evaluate(() => window.__dev.badcs || 0));

  // log drawer
  await page.click('#btnLog'); await page.waitForTimeout(50);
  console.log('log lines:', (await page.textContent('#log')).split('\n').length);
  await page.click('#btnLogClose');

  await tile(page, 'AMP').click();
  await page.screenshot({ path: path.join(OUT, 'ui-final.png') });
  await page.setViewportSize({ width: 390, height: 860 }); await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, 'ui-mobile.png') });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  console.log('mobile page overflow:', overflow);
  if (overflow) {
    console.log(await page.evaluate(() => Array.from(document.querySelectorAll('body *'))
      .filter((e) => e.getBoundingClientRect().right > innerWidth + 1 && !e.closest('#rail'))
      .slice(0, 12).map((e) => `${e.tagName}.${e.className}#${e.id} [${(e.textContent||'').trim().slice(0,20)}] parent=${e.parentElement.className} w=${Math.round(e.getBoundingClientRect().width)} right=${Math.round(e.getBoundingClientRect().right)}`)));
  }
  console.log('errors:', errors);
  assert.strictEqual(errors.length, 0);
  assert.strictEqual(overflow, false);
  await browser.close();
  console.log('OK');
})().catch((e) => { console.error(e); process.exit(1); });
