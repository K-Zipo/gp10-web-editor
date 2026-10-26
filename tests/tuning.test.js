// End-to-end test of the Tuning view (fretboard) against the mock GP-10.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { buildMock } = require('./mock-gp10');

const OUT = path.join(__dirname, 'out'); fs.mkdirSync(OUT, { recursive: true });
const htmlPath = path.join(__dirname, '..', 'index.html');
const mock = buildMock(path.join(__dirname, '..', 'data', 'gp10-address-map.json'), path.join(__dirname, 'fixtures', 'temp-patch-dump.txt'));
const T = (off) => [0x20, 0, 0x40, off];
const peek = (page, a) => page.evaluate((a) => window.__dev.peek(a), a);
const notes = (page) => page.$$eval('.fb .fb-note', (els) => els.map((e) => Array.from(e.childNodes, (n) => n.textContent).join(' ').replace(/\s+/g, ' ').trim()));
const SEL = T(0x01), SHIFT = (i) => T(0x02 + i), FINE = (i) => T(0x08 + i);

async function open(browser, viewport) {
  const page = await browser.newPage({ viewport, hasTouch: viewport.width < 600 });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(mock);
  await page.addInitScript(() => { try { localStorage.clear(); } catch { /* none */ } });
  await page.goto('file://' + htmlPath);
  await page.click('#btnConnect2'); await page.waitForSelector('#inspector:not([hidden])'); await page.waitForTimeout(300);
  await page.locator('#views button', { hasText: 'Tuning' }).click();
  await page.waitForSelector('.fb');
  return { page, errors };
}

(async () => {
  const browser = await chromium.launch();
  const { page, errors } = await open(browser, { width: 1440, height: 900 });
  console.log('initial select', await peek(page, SEL), '| notes', (await notes(page)).join(' | '));

  // OPEN D preset
  await page.locator('.tune-head .chip[data-preset="OPEN D"]').click(); await page.waitForTimeout(80);
  const od = await notes(page);
  console.log('OPEN D:', od.join(' | '));
  assert.deepStrictEqual(od, ['E → D', 'B → A', 'G → F♯', 'D', 'A', 'E → D']);
  assert.strictEqual(await peek(page, SEL), 0);
  await page.locator('#inspector').screenshot({ path: path.join(OUT, 'tune-open-d.png') });

  // DROP Db uses flats
  await page.locator('.tune-head .chip[data-preset="DROP Db"]').click(); await page.waitForTimeout(60);
  const db = await notes(page); console.log('DROP Db:', db.join(' | '));
  assert.strictEqual(db[5], 'E → D♭'); assert.strictEqual(db[0], 'E → E♭');

  // STEP −/+
  await page.locator('.tune-head .chip[aria-label="Step down"]').click(); await page.waitForTimeout(60);
  assert.strictEqual(await page.evaluate(() => { const p = window.__gp10ed.P('TUNE', 'Alternate Tuning Select'); return window.__gp10ed.display(p, window.__gp10ed.getVal(p)); }), '-1 STEP');
  await page.locator('.tune-head .chip[aria-label="Step down"]').click(); await page.waitForTimeout(60);
  assert.strictEqual((await page.textContent('.tune-head .chip[data-step]')).trim(), '-2');

  // Back to OPEN D, then tap the 4th fret space on string 6 → preset is copied to USER, string 6 becomes −… wait: tap on the board
  await page.locator('.tune-head .chip[data-preset="OPEN D"]').click(); await page.waitForTimeout(60);
  const box = await page.locator('.board').boundingBox();
  const xAt = (v) => box.x + box.width * (0.5 + (v - 0.5 * Math.sign(v)) / 12 / 2);
  const yAt = (row) => box.y + box.height * ((row + 0.5) / 6);
  await page.mouse.click(xAt(-5), yAt(5)); await page.waitForTimeout(80);
  const userNotes = await notes(page);
  console.log('after tapping −5 on string 6:', userNotes.join(' | '), '| select', await peek(page, SEL));
  assert.strictEqual(await peek(page, SEL), 36, 'switched to USER');
  assert.deepStrictEqual(await Promise.all([0, 1, 2, 3, 4, 5].map((i) => peek(page, SHIFT(i)))), [22, 22, 23, 24, 24, 19]);
  assert.strictEqual(userNotes[5], 'E → B');

  // drag string 1 with the mouse up to +3
  await page.mouse.move(xAt(0), yAt(0)); await page.mouse.down(); await page.mouse.move(xAt(3), yAt(0), { steps: 6 }); await page.mouse.up(); await page.waitForTimeout(80);
  assert.strictEqual(await peek(page, SHIFT(0)), 27);
  // keyboard on string 2's dot
  await page.locator('.board .fg').nth(1).focus(); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.waitForTimeout(60);
  assert.strictEqual(await peek(page, SHIFT(1)), 24);
  // fine: click right part of the scale on string 3
  const fb = await page.locator('.fb-fine').nth(2).boundingBox();
  await page.mouse.click(fb.x + fb.width * 0.7, fb.y + fb.height / 2); await page.waitForTimeout(60);
  const fine3 = (await peek(page, FINE(2))) - 50; console.log('fine string 3 =', fine3);
  assert.ok(fine3 >= 18 && fine3 <= 22);
  // ±24 range by keyboard past 12
  await page.locator('.board .fg').nth(3).focus(); for (let i = 0; i < 14; i++) await page.keyboard.press('ArrowRight'); await page.waitForTimeout(80);
  assert.strictEqual(await peek(page, SHIFT(3)), 38);
  assert.strictEqual((await page.textContent('.board .range')).trim(), '±24');
  // switch on
  const sw0 = await peek(page, T(0)); await page.click('.tune-head .power'); await page.waitForTimeout(60);
  assert.strictEqual(await peek(page, T(0)), sw0 ? 0 : 1);
  await page.locator('#inspector').screenshot({ path: path.join(OUT, 'tune-user.png') });

  // 12-string tab
  await page.locator('.tune-tabs button', { hasText: '12-string' }).click(); await page.waitForSelector('.tune-cells');
  console.log('12-string notes:', (await notes(page)).join(' | '), '| level cells', await page.locator('.tune-cells .cell').count());
  assert.strictEqual(await page.locator('.tune-cells .cell').count(), 12);
  await page.locator('#inspector').screenshot({ path: path.join(OUT, 'tune-12.png') });
  // bend tab
  await page.locator('.tune-tabs button', { hasText: 'String bend' }).click(); await page.waitForTimeout(80);
  await page.locator('.board .fg').nth(0).focus(); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.waitForTimeout(60);
  console.log('bend notes:', (await notes(page)).join(' | '));
  await page.locator('#inspector').screenshot({ path: path.join(OUT, 'tune-bend.png') });
  // device-side change is reflected on Reload
  await page.locator('.tune-tabs button', { hasText: 'Alternate tuning' }).click(); await page.waitForTimeout(60);
  await page.evaluate((a) => window.__dev.poke(a, 4), SEL); // DROP D
  await page.click('#btnReload'); await page.waitForTimeout(500);
  assert.strictEqual((await notes(page))[5], 'E → D');
  assert.deepStrictEqual(errors, []);
  await page.close();

  // phone
  const ph = await open(browser, { width: 412, height: 900 });
  await ph.page.locator('.tune-head .chip[data-preset="OPEN G"]').click(); await ph.page.waitForTimeout(80);
  console.log('phone OPEN G:', (await notes(ph.page)).join(' | '));
  const sw = await ph.page.evaluate(() => document.documentElement.scrollWidth);
  console.log('phone scrollWidth', sw); assert.ok(sw <= 412);
  await ph.page.locator('#inspector').screenshot({ path: path.join(OUT, 'tune-phone.png') });
  assert.deepStrictEqual(ph.errors, []);
  await browser.close(); console.log('OK');
})().catch((e) => { console.error(e); process.exit(1); });
