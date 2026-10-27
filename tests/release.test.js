// Regression: a press that leaves the control before it starts dragging, and is released
// elsewhere, must not leave the control "held" — passing over it later must not change it.
const { chromium } = require('playwright');
const path = require('path');
const assert = require('assert');
const { buildMock } = require('./mock-gp10');

const htmlPath = path.join(__dirname, '..', 'index.html');
const mock = buildMock(path.join(__dirname, '..', 'data', 'gp10-address-map.json'), path.join(__dirname, 'fixtures', 'temp-patch-dump.txt'));
const GAIN = [0x20, 0, 0x50, 2];
const peek = (page, a) => page.evaluate((a) => window.__dev.peek(a), a);

async function pressLeaveRelease(page, box, out) {
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(out.x, out.y); // jumps out in one event, before the 4 px drag threshold is seen on the control
  await page.mouse.up();
  await page.waitForTimeout(50);
}
async function hoverAcross(page, box) {
  await page.mouse.move(box.x + 5, box.y + box.height / 2);
  await page.mouse.move(box.x + box.width - 5, box.y + box.height / 2, { steps: 12 });
  await page.mouse.move(box.x + box.width / 2, box.y + 4, { steps: 6 });
  await page.waitForTimeout(80);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(mock);
  await page.goto('file://' + htmlPath);
  await page.click('#btnConnect2'); await page.waitForSelector('#inspector:not([hidden])'); await page.waitForTimeout(300);
  const out = { x: 700, y: 30 };

  // 1. parameter tile
  await page.locator('#rail .tile[data-view="AMP"]').click();
  const gain = page.locator('#ctls .cell').filter({ has: page.locator('.n', { hasText: /^Gain$/ }) }).first();
  const gb = await gain.boundingBox();
  const g0 = await peek(page, GAIN);
  await pressLeaveRelease(page, gb, out);
  await hoverAcross(page, gb);
  const g1 = await peek(page, GAIN);
  console.log('tile: gain', g0, '→', g1, '(after hover with no button)');
  assert.strictEqual(g1, g0, 'hovering a tile after a stray press changed it');

  // 2. a normal drag still works and stops at release
  await page.mouse.move(gb.x + 30, gb.y + 50); await page.mouse.down(); await page.mouse.move(gb.x + 110, gb.y + 50, { steps: 8 }); await page.mouse.up(); await page.waitForTimeout(80); // let the last value reach the device
  const g2 = await peek(page, GAIN); assert.ok(g2 > g1, 'drag still changes the value');
  await hoverAcross(page, gb); assert.strictEqual(await peek(page, GAIN), g2, 'released drag stays released');

  // 3. fretboard and fine scale
  await page.locator('#views button', { hasText: 'Tuning' }).click(); await page.waitForSelector('.fb');
  const before = await page.evaluate(() => Array.from({ length: 16 }, (_, i) => window.__dev.peek([0x20, 0, 0x40, i])).join(','));
  const fine = await page.locator('.fb-fine').nth(1).boundingBox();
  await pressLeaveRelease(page, fine, out);
  const afterPress = await page.evaluate(() => Array.from({ length: 16 }, (_, i) => window.__dev.peek([0x20, 0, 0x40, i])).join(','));
  await hoverAcross(page, fine);
  const board = await page.locator('.board').boundingBox();
  await hoverAcross(page, board);
  const afterHover = await page.evaluate(() => Array.from({ length: 16 }, (_, i) => window.__dev.peek([0x20, 0, 0x40, i])).join(','));
  console.log('tuning changed by hover:', afterPress !== afterHover);
  assert.strictEqual(afterHover, afterPress, 'hovering the fretboard after a press changed it');
  void before;

  // 4. hold-to-repeat on + stops when the tile is redrawn under the finger
  await page.locator('#rail .tile[data-view="AMP"]').click();
  const gain2 = page.locator('#ctls .cell').filter({ has: page.locator('.n', { hasText: /^Gain$/ }) }).first();
  await gain2.hover(); const plus = gain2.locator('.pm button').nth(1); const pb = await plus.boundingBox();
  await page.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2); await page.mouse.down();
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__gp10ed.select('AMP')); // redraw while held
  await page.mouse.up(); await page.waitForTimeout(50);
  const r1 = await peek(page, GAIN); await page.waitForTimeout(400); const r2 = await peek(page, GAIN);
  console.log('repeat after redraw:', r1, '→', r2);
  assert.strictEqual(r2, r1, 'hold-to-repeat kept running after release');

  assert.deepStrictEqual(errors, []);
  await browser.close(); console.log('OK');
})().catch((e) => { console.error(e); process.exit(1); });
