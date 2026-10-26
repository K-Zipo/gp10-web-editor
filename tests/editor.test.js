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
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const cell = (page, name) => page.locator('#ctls .cell').filter({ has: page.locator('.n', { hasText: new RegExp(`^${esc(name)}$`) }) }).first();
const tile = (page, key) => page.locator(`#rail .tile[data-view="${key}"]`);
const peek = (page, a) => page.evaluate((a) => window.__dev.peek(a), a);
const GAIN = [0x20, 0, 0x50, 2];

// synthesize a touch gesture on an element with pointer events
async function touchSwipe(page, locator, dx, dy) {
  const box = await locator.boundingBox();
  await page.evaluate(({ x, y, dx, dy, sel }) => {
    const el = document.elementFromPoint(x, y);
    const fire = (type, cx, cy) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: cx, clientY: cy, button: 0, buttons: type === 'pointerup' ? 0 : 1 }));
    fire('pointerdown', x, y);
    for (let i = 1; i <= 10; i++) fire('pointermove', x + (dx * i) / 10, y + (dy * i) / 10);
    fire('pointerup', x + dx, y + dy);
  }, { x: box.x + box.width / 2, y: box.y + box.height / 2, dx, dy });
  await page.waitForTimeout(80);
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|ERR_/.test(m.text())) errors.push(m.text()); });
  await page.addInitScript(buildMock(mapPath, dumpPath));
  await page.goto('file://' + path.resolve(htmlPath));
  await page.screenshot({ path: path.join(OUT, 'ui-welcome.png') });

  await page.click('#btnConnect2');
  await page.waitForSelector('#inspector:not([hidden])', { timeout: 5000 });
  await page.waitForTimeout(300);
  console.log('status:', await page.textContent('#statusText'), '| patch', await page.textContent('#patchNo'), await page.inputValue('#patchName'));
  console.log('rail:', (await page.$$eval('#rail > *', (els) => els.map((e) => e.dataset.view || e.textContent.trim()).filter(Boolean))).join(' '));
  console.log('pictures drawn:', await page.$$eval('#rail .tile .gr svg', (s) => s.filter((x) => x.innerHTML.length > 20).length), 'of', await page.$$eval('#rail .tile', (t) => t.length));

  // AMP: keyboard
  await tile(page, 'AMP').click();
  const gain = cell(page, 'Gain');
  console.log('amp:', await page.textContent('#inspModel'), '| gain', await gain.locator('.big').textContent());
  await page.evaluate(() => { window.__dev.sent.length = 0; });
  await gain.focus(); await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp'); await page.waitForTimeout(80);
  console.log('keyboard → sent', (await page.evaluate(() => window.__dev.sent)).map(hexs));
  assert.strictEqual(await peek(page, GAIN), 15);
  // mouse drag (horizontal)
  const gb = await gain.boundingBox();
  await page.mouse.move(gb.x + 30, gb.y + 50); await page.mouse.down(); await page.mouse.move(gb.x + 30 + 120, gb.y + 50, { steps: 8 }); await page.mouse.up(); await page.waitForTimeout(80);
  const afterMouse = await peek(page, GAIN);
  console.log('mouse drag → gain', afterMouse, '| shown', await gain.locator('.big').textContent());
  assert.ok(afterMouse > 40);
  // touch: horizontal swipe changes, vertical swipe does not
  const beforeTouch = await peek(page, GAIN);
  await touchSwipe(page, gain, -90, 4);
  const afterSwipe = await peek(page, GAIN);
  await touchSwipe(page, gain, 3, 120);
  const afterVertical = await peek(page, GAIN);
  console.log('touch swipe left', beforeTouch, '→', afterSwipe, '| vertical swipe', afterVertical);
  assert.ok(afterSwipe < beforeTouch); assert.strictEqual(afterVertical, afterSwipe);
  // +/- buttons
  await gain.hover(); await gain.locator('.pm button').nth(1).click(); await page.waitForTimeout(60);
  assert.strictEqual(await peek(page, GAIN), afterSwipe + 1);
  // type a value
  await gain.dblclick(); await page.keyboard.press('Control+A'); await page.keyboard.type('42'); await page.keyboard.press('Enter'); await page.waitForTimeout(80);
  assert.strictEqual(await peek(page, GAIN), 42);
  // list picker
  await cell(page, 'Gain Switch').click(); await page.waitForSelector('#picker:not([hidden])');
  console.log('picker options:', await page.$$eval('#pickerOpts button', (b) => b.map((x) => x.textContent).join(',')));
  await page.click('#pickerOpts button:has-text("HIGH")'); await page.waitForTimeout(60);
  console.log('gain switch →', await peek(page, [0x20, 0, 0x50, 0x0A]), '| picker hidden', await page.isHidden('#picker'));
  // switch cell
  const br0 = await peek(page, [0x20, 0, 0x50, 9]);
  await cell(page, 'Bright').click(); await page.waitForTimeout(60);
  console.log('bright', br0, '→', await peek(page, [0x20, 0, 0x50, 9]));
  // browser
  await page.click('#browser button:has-text("JC-120")'); await page.waitForTimeout(80);
  console.log('amp type:', await page.textContent('#inspModel'), '| T-Comp', await cell(page, 'T-Comp').locator('.big').textContent());
  await page.screenshot({ path: path.join(OUT, 'ui-amp.png') });

  // DELAY nibble param
  await tile(page, 'DELAY').click();
  const time = cell(page, 'Time');
  await time.dblclick(); await page.keyboard.press('Control+A'); await page.keyboard.type('500'); await page.keyboard.press('Enter'); await page.waitForTimeout(80);
  const tb = await page.evaluate(() => [1, 2, 3].map((i) => window.__dev.peek([0x20, 1, 0x70, 1 + i])));
  console.log('delay time', await time.locator('.big').textContent(), '| device', hexs(tb));
  assert.deepStrictEqual(tb, [0x01, 0x0F, 0x04]);
  // move buttons
  const order0 = await page.$$eval('#rail .tile', (t) => t.map((x) => x.dataset.view).join(' '));
  await page.click('#inspMove button:has-text("Move left")'); await page.waitForTimeout(60);
  console.log('move left:', order0, '→', await page.$$eval('#rail .tile', (t) => t.map((x) => x.dataset.view).join(' ')));
  await page.screenshot({ path: path.join(OUT, 'ui-delay.png') });

  // FX via browser
  await tile(page, 'FX').click();
  await page.click('#browser button:has-text("PHASER")'); await page.waitForTimeout(80);
  console.log('fx:', await page.textContent('#inspModel'), '|', await page.$$eval('#ctls .cell .n', (n) => n.map((x) => x.textContent).join(', ')));

  // MODELING
  await tile(page, 'MODELING').click();
  console.log('modeling browser:', await page.$$eval('#browser h3', (h) => h.map((x) => x.textContent)));
  await page.click('#browser button:has-text("SYNTH")'); await page.waitForTimeout(80);
  await page.click('#browser button:has-text("GR-300")'); await page.waitForTimeout(80);
  console.log('modeling:', await page.textContent('#inspModel'), '| groups', await page.$$eval('#ctls .ghead', (h) => h.map((x) => x.textContent).join(',')), '| cells', await page.$$eval('#ctls .cell', (c) => c.length));
  await page.screenshot({ path: path.join(OUT, 'ui-modeling.png') });

  for (const v of ['Patch', 'Tuning', 'Controllers', 'Assigns']) {
    await page.click(`#views button:has-text("${v}")`); await page.waitForTimeout(50);
    console.log(v, '→ groups', await page.$$eval('#ctls .ghead', (h) => h.slice(0, 4).map((x) => x.textContent).join(',')), 'cells', await page.$$eval('#ctls .cell', (c) => c.length));
  }
  await page.click('#rail .node.mixer'); await page.waitForTimeout(50);
  console.log('mixer:', await page.$$eval('#ctls .cell .n', (n) => n.map((x) => x.textContent).join(', ')));

  // drag reorder
  const c0 = await page.evaluate(() => Array.from({ length: 11 }, (_, i) => window.__dev.peek([0x20, 0, 0x48, i])));
  await tile(page, 'REVERB').dragTo(tile(page, 'AMP')); await page.waitForTimeout(100);
  const c1 = await page.evaluate(() => Array.from({ length: 11 }, (_, i) => window.__dev.peek([0x20, 0, 0x48, i])));
  console.log('chain', c0.join(','), '→', c1.join(','));
  assert.notDeepStrictEqual(c0, c1);

  // patch name, list, select
  await page.fill('#patchName', 'TILES'); await page.press('#patchName', 'Enter'); await page.waitForTimeout(50);
  console.log('device name:', await page.evaluate(() => String.fromCharCode(...Array.from({ length: 12 }, (_, i) => window.__dev.peek([0x20, 0, 0, i])))));
  await page.click('#btnNames');
  await page.waitForFunction(() => document.querySelectorAll('#patchList li').length === 99 && !document.querySelector('#btnNames').disabled, null, { timeout: 20000 });
  await page.fill('#patchSearch', '07'); await page.waitForTimeout(50);
  console.log('filter 07:', await page.$$eval('#patchList li', (l) => l.map((x) => x.textContent)));
  await page.fill('#patchSearch', '');
  await page.click('#patchList li:nth-child(5)'); await page.waitForTimeout(900);
  console.log('after select:', await page.textContent('#patchNo'), await page.inputValue('#patchName'));

  // follow device
  await page.check('#chkSync', { force: true });
  await tile(page, 'AMP').click();
  await page.evaluate(() => window.__dev.poke([0x20, 0, 0x50, 2], 77));
  await page.waitForTimeout(2200);
  console.log('followed gain:', await cell(page, 'Gain').locator('.big').textContent());
  await page.uncheck('#chkSync', { force: true });

  // .syx round trip
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnExport')]);
  const syx = path.join(OUT, 'patch.syx'); await dl.saveAs(syx);
  await page.evaluate(() => window.__dev.poke([0x20, 0, 0x50, 2], 3));
  await page.setInputFiles('#fileSyx', syx); await page.waitForTimeout(2000);
  console.log('after import gain:', await peek(page, GAIN), '| bad checksum at device:', await page.evaluate(() => window.__dev.badcs || 0));
  assert.strictEqual(await peek(page, GAIN), 77);

  await page.click('#btnLog'); await page.waitForTimeout(50);
  console.log('log lines:', (await page.textContent('#log')).split('\n').length);
  await page.click('#btnLogClose');

  await tile(page, 'AMP').click(); await cell(page, 'Gain').focus();
  await page.screenshot({ path: path.join(OUT, 'ui-final.png') });
  await page.setViewportSize({ width: 390, height: 860 }); await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, 'ui-mobile.png') });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  await cell(page, 'Speaker Type').click(); await page.waitForTimeout(100);
  await page.screenshot({ path: path.join(OUT, 'ui-mobile-picker.png') });
  await page.keyboard.press('Escape');
  console.log('mobile page overflow:', overflow, '| errors:', errors);
  assert.strictEqual(errors.length, 0);
  assert.strictEqual(overflow, false);
  await browser.close();
  console.log('OK');
})().catch((e) => { console.error(e); process.exit(1); });
