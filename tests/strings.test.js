// End-to-end test of the Modeling string mixer (String Level 1–6 / String Pan 1–6).
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { buildMock } = require('./mock-gp10');

const OUT = path.join(__dirname, 'out'); fs.mkdirSync(OUT, { recursive: true });
const htmlPath = path.join(__dirname, '..', 'index.html');
const mock = buildMock(path.join(__dirname, '..', 'data', 'gp10-address-map.json'), path.join(__dirname, 'fixtures', 'temp-patch-dump.txt'));
const LV = (i) => [0x20, 0, 0x10, 0x05 + i], PN = (i) => [0x20, 0, 0x10, 0x0B + i];
const peek = (page, a) => page.evaluate((a) => window.__dev.peek(a), a);

async function open(browser, viewport) {
  const page = await browser.newPage({ viewport, hasTouch: viewport.width < 600 });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(mock);
  await page.goto('file://' + htmlPath);
  await page.click('#btnConnect2'); await page.waitForSelector('#inspector:not([hidden])'); await page.waitForTimeout(300);
  await page.locator('#rail .tile[data-view="MODELING"]').click(); await page.waitForSelector('.smix');
  return { page, errors };
}

(async () => {
  const browser = await chromium.launch();
  const { page, errors } = await open(browser, { width: 1440, height: 900 });
  console.log('levels', await Promise.all([0, 1, 2, 3, 4, 5].map((i) => peek(page, LV(i)))), 'pans', await Promise.all([0, 1, 2, 3, 4, 5].map((i) => peek(page, PN(i)))));
  // no String Level / Pan tiles left in the generic grid
  assert.strictEqual(await page.locator('#ctls .cell .n', { hasText: /^String (Level|Pan)/ }).count(), 0);

  // click on level track of string 2 at 30%
  const lev = page.locator('.srows .lev').nth(1); const lb = await lev.boundingBox();
  await page.mouse.click(lb.x + lb.width * 0.3, lb.y + lb.height / 2); await page.waitForTimeout(60);
  const l2 = await peek(page, LV(1)); console.log('string 2 level →', l2); assert.ok(l2 >= 28 && l2 <= 32);
  // drag pan of string 6 to the left edge
  const pan = page.locator('.srows .pan').nth(5); const pb = await pan.boundingBox();
  await page.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2); await page.mouse.down(); await page.mouse.move(pb.x + 2, pb.y + pb.height / 2, { steps: 6 }); await page.mouse.up(); await page.waitForTimeout(60);
  assert.ok((await peek(page, PN(5))) <= 2);
  assert.ok(/^L/.test((await page.locator('.srows .sv').nth(11).textContent()).trim()));
  // hover after release does not move it
  const p6 = await peek(page, PN(5)); await page.mouse.move(pb.x + pb.width * 0.8, pb.y + pb.height / 2, { steps: 5 }); assert.strictEqual(await peek(page, PN(5)), p6);
  // keyboard
  await page.locator('.srows .lev').nth(0).focus(); await page.keyboard.press('PageDown'); await page.waitForTimeout(40);
  const l1 = await peek(page, LV(0));
  // double-click resets pan to centre
  await pan.dblclick(); await page.waitForTimeout(40); assert.strictEqual(await peek(page, PN(5)), 50);
  // Spread / Center / All 100
  await page.locator('.smix-head .chip', { hasText: 'Spread' }).click(); await page.waitForTimeout(40);
  assert.deepStrictEqual(await Promise.all([0, 1, 2, 3, 4, 5].map((i) => peek(page, PN(i)))), [75, 65, 55, 45, 35, 25]);
  await page.screenshot({ path: path.join(OUT, 'strings-desk.png'), clip: await page.locator('#inspector').boundingBox() });
  await page.locator('.smix-head .chip', { hasText: 'All 100' }).click(); await page.waitForTimeout(40);
  assert.ok((await Promise.all([0, 1, 2, 3, 4, 5].map((i) => peek(page, LV(i))))).every((v) => v === 100));
  console.log('string 1 after PageDown', l1, '| pan dots', await page.locator('.srows .pan .dot').count());
  // device change shows after reload
  await page.evaluate((a) => window.__dev.poke(a, 0), LV(3)); await page.click('#btnReload'); await page.waitForTimeout(500);
  assert.strictEqual((await page.locator('.srows .sv').nth(6).textContent()).trim(), '0');
  assert.ok(await page.locator('.srows .pan').nth(3).evaluate((e) => e.classList.contains('mute')));
  // all centred: the six numbered dots must not overlap
  await page.locator('.smix-head .chip', { hasText: 'Center' }).click(); await page.waitForTimeout(40);
  const boxes = await page.$$eval('.srows .pan .dot', (ds) => ds.map((d) => { const r = d.getBoundingClientRect(); return [r.top, r.bottom]; }));
  for (let i = 1; i < 6; i++) assert.ok(boxes[i][0] >= boxes[i - 1][1], 'dots overlap when centred');
  await page.screenshot({ path: path.join(OUT, 'strings-center.png'), clip: await page.locator('.smix').boundingBox() }); // all centred
  assert.deepStrictEqual(errors, []);
  await page.close();

  const ph = await open(browser, { width: 412, height: 900 });
  await ph.page.locator('.smix-head .chip', { hasText: 'Spread' }).click(); await ph.page.waitForTimeout(40);
  const sw = await ph.page.evaluate(() => document.documentElement.scrollWidth); console.log('phone scrollWidth', sw); assert.ok(sw <= 412);
  await ph.page.locator('.smix').screenshot({ path: path.join(OUT, 'strings-phone.png') });
  assert.deepStrictEqual(ph.errors, []);
  await browser.close(); console.log('OK');
})().catch((e) => { console.error(e); process.exit(1); });
