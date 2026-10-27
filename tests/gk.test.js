// End-to-end test of the GK setting view (system area) against the mock GP-10.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { buildMock } = require('./mock-gp10');

const OUT = path.join(__dirname, 'out'); fs.mkdirSync(OUT, { recursive: true });
const htmlPath = path.join(__dirname, '..', 'index.html');
const mock = buildMock(path.join(__dirname, '..', 'data', 'gp10-address-map.json'), path.join(__dirname, 'fixtures', 'temp-patch-dump.txt'));
const GK = (set, off) => [0x10, 0, 0x10 + set * 8, off];
const peek = (page, a) => page.evaluate((a) => window.__dev.peek(a), a);
const poke = (page, a, v) => page.evaluate(([a, v]) => window.__dev.poke(a, v), [a, v]);

async function open(browser, viewport, ctxOpts = {}) {
  const ctx = await browser.newContext({ viewport, hasTouch: viewport.width < 600, acceptDownloads: true, ...ctxOpts });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(mock);
  await page.goto('file://' + htmlPath);
  await page.click('#btnConnect2'); await page.waitForSelector('#inspector:not([hidden])'); await page.waitForTimeout(500);
  await page.locator('#views button', { hasText: /^GK$/ }).click(); await page.waitForSelector('.srows');
  return { ctx, page, errors };
}

(async () => {
  const browser = await chromium.launch();
  const { ctx, page, errors } = await open(browser, { width: 1440, height: 1000 });
  const vals = await page.$$eval('.srows .sv', (e) => e.map((x) => x.textContent));
  console.log('lanes', vals.join(' '));
  assert.deepStrictEqual(vals.slice(0, 2), ['50', '20.0']);
  assert.strictEqual(await page.locator('.srows .strk').count(), 12);
  // the patch's GK set is marked
  const inUse = await page.$$eval('.tune-tabs button i', (e) => e.map((x) => x.classList.contains('on')));
  console.log('in use', inUse);
  assert.strictEqual(inUse.filter(Boolean).length, 1);

  // set 1: click sens of string 3 at 80 %
  const tr = page.locator('.srows .lev').nth(4); const b = await tr.boundingBox();
  await page.mouse.click(b.x + 12 + (b.width - 24) * 0.8, b.y + b.height / 2); await page.waitForTimeout(80);
  console.log('set 1 sens 3 =', await peek(page, GK(1, 0x09))); assert.strictEqual(await peek(page, GK(1, 0x09)), 80);
  // set 2: distance of string 6, keyboard End → 30.0 mm
  await page.locator('.tune-tabs button', { hasText: 'GK set 2' }).click(); await page.waitForTimeout(60);
  await page.locator('.srows .lev').nth(11).focus(); await page.keyboard.press('End'); await page.waitForTimeout(80);
  assert.strictEqual(await peek(page, GK(2, 0x12)), 40);
  assert.strictEqual(await peek(page, GK(1, 0x12)), 20, 'set 1 untouched');
  assert.strictEqual((await page.locator('.srows .sv').nth(11).textContent()).trim(), '30.0');
  // Scale tile shows mm list value
  const scale = await page.locator('#ctls .cell').filter({ has: page.locator('.n', { hasText: /^Scale$/ }) }).locator('.big').textContent();
  console.log('scale', scale); assert.ok(/648/.test(scale));
  await page.screenshot({ path: path.join(OUT, 'gk-desk.png'), clip: await page.locator('#inspector').boundingBox() });

  // switching the system to set 3 moves the marker
  await poke(page, [0x10, 0, 0, 0x07], 3); await page.click('#btnReload'); await page.waitForTimeout(900);
  const inUse3 = await page.$$eval('.tune-tabs button i', (e) => e.map((x) => x.classList.contains('on')));
  assert.deepStrictEqual(inUse3, [false, false, true]);

  // backup → change → restore
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('.tune-tabs .chip', { hasText: 'Back up' }).click()]);
  const file = path.join(OUT, 'gk-system.syx'); await dl.saveAs(file);
  const bytes = fs.readFileSync(file); console.log('backup bytes', bytes.length, '| file', dl.suggestedFilename());
  assert.strictEqual(bytes.length, (12 + 37 + 11 + 22 * 3) + 6 * 14);
  await poke(page, GK(1, 0x09), 3); await page.click('#btnReload'); await page.waitForTimeout(900);
  page.once('dialog', (d) => d.accept());
  await page.setInputFiles('#fileSys', file); await page.waitForTimeout(1500);
  assert.strictEqual(await peek(page, GK(1, 0x09)), 80, 'restored');
  // patch .syx export still holds patch data only
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#btnExport')]);
  const pf = path.join(OUT, 'gk-patch.syx'); await dl2.saveAs(pf);
  assert.ok(!fs.readFileSync(pf).includes(Buffer.from([0x12, 0x10, 0x00])), 'patch export has no system blocks');
  assert.deepStrictEqual(errors, []);
  await ctx.close();

  const ph = await open(browser, { width: 412, height: 900 });
  const sw = await ph.page.evaluate(() => document.documentElement.scrollWidth); console.log('phone scrollWidth', sw); assert.ok(sw <= 412);
  await ph.page.screenshot({ path: path.join(OUT, 'gk-phone.png'), fullPage: true });
  assert.deepStrictEqual(ph.errors, []);
  await browser.close(); console.log('OK');
})().catch((e) => { console.error(e); process.exit(1); });
