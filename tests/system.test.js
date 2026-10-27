// End-to-end test of the System tab (general, controllers, guitar to MIDI) against the mock GP-10.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { buildMock } = require('./mock-gp10');

const OUT = path.join(__dirname, 'out'); fs.mkdirSync(OUT, { recursive: true });
const htmlPath = path.join(__dirname, '..', 'index.html');
const mock = buildMock(path.join(__dirname, '..', 'data', 'gp10-address-map.json'), path.join(__dirname, 'fixtures', 'temp-patch-dump.txt'));
const peek = (page, a) => page.evaluate((a) => window.__dev.peek(a), a);
const cell = (page, name) => page.locator('.sysgrp .cell').filter({ has: page.locator('.n', { hasText: new RegExp(`^${name}$`) }) });
const sysTab = (page, t) => page.locator('.tune-tabs button', { hasText: t }).click();

async function pick(page, c, option) {
  await c.click(); await page.waitForSelector('#picker:not([hidden])');
  await page.locator('#picker button', { hasText: new RegExp(`^${option}$`) }).click(); await page.waitForTimeout(60);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(mock);
  await page.goto('file://' + htmlPath);
  await page.click('#btnConnect2'); await page.waitForSelector('#inspector:not([hidden])'); await page.waitForTimeout(500);
  await page.locator('#views button', { hasText: /^System$/ }).click(); await sysTab(page, 'General'); await page.waitForSelector('.sysgrp');

  // General: tuner pitch 440, patch range tiles appear only when limited
  console.log('tuner pitch', (await cell(page, 'Pitch \\(Hz\\)').locator('.big').textContent()).trim());
  assert.strictEqual(await cell(page, 'First patch').isVisible(), false);
  await cell(page, 'Limit patches').click(); await page.waitForTimeout(60);
  assert.strictEqual(await peek(page, [0x10, 0, 0, 0x08]), 1);
  assert.strictEqual(await cell(page, 'First patch').isVisible(), true);
  await page.screenshot({ path: path.join(OUT, 'system-general.png'), clip: await page.locator('#inspector').boundingBox() });

  // Controllers: CTL1 → PATCH UP shows "Patches up" only
  await sysTab(page, 'Controllers'); await page.waitForSelector('.sysgrp');
  const ctl1 = page.locator('.sysgrp').filter({ has: page.locator('h3', { hasText: /^CTL1$/ }) });
  const visibleNames = async () => (await ctl1.locator('.cell:not([hidden]) .n').allTextContents()).join(', ');
  console.log('CTL1 before:', await visibleNames());
  await pick(page, ctl1.locator('.cell').first(), 'PATCH UP');
  console.log('CTL1 PATCH UP:', await visibleNames());
  assert.strictEqual(await peek(page, [0x10, 0, 0x08, 0x00]), 2);
  assert.deepStrictEqual(await ctl1.locator('.cell:not([hidden]) .n').allTextContents(), ['Function', 'Mode', 'Patches up']);
  await pick(page, ctl1.locator('.cell').first(), 'PATCH SEL');
  assert.deepStrictEqual(await ctl1.locator('.cell:not([hidden]) .n').allTextContents(), ['Function', 'Mode', 'Go to patch']);
  // GK S2 writes its own address
  const gks2 = page.locator('.sysgrp').filter({ has: page.locator('h3', { hasText: /^GK S2$/ }) });
  await pick(page, gks2.locator('.cell').first(), 'TUNER ON/OFF');
  assert.strictEqual(await peek(page, [0x10, 0, 0x08, 0x15]), 5);
  await page.screenshot({ path: path.join(OUT, 'system-controllers.png'), fullPage: true });

  // Guitar to MIDI: channel hint follows mode and base channel
  await sysTab(page, 'Guitar to MIDI'); await page.waitForSelector('.sysgrp');
  const hint = async () => (await page.locator('.tune > .tune-note').last().textContent()).trim();
  console.log('g2m:', await hint());
  assert.strictEqual(await hint(), 'Strings 1–6 send on channels 1–6.');
  await cell(page, 'Channel \\(string 1\\)').focus(); for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowUp'); await page.waitForTimeout(60);
  assert.strictEqual(await hint(), 'Strings 1–6 send on channels 5–10.');
  await cell(page, 'Mode').click(); await page.waitForSelector('#picker:not([hidden])'); await page.locator('#picker button', { hasText: /^MONO$/ }).click(); await page.waitForTimeout(60);
  assert.strictEqual(await hint(), 'All strings send on channel 5.');
  await page.screenshot({ path: path.join(OUT, 'system-g2m.png'), clip: await page.locator('#inspector').boundingBox() });
  assert.deepStrictEqual(errors, []);
  await page.close();

  const ph = await browser.newPage({ viewport: { width: 412, height: 900 }, hasTouch: true });
  await ph.addInitScript(mock); await ph.goto('file://' + htmlPath);
  await ph.click('#btnConnect2'); await ph.waitForSelector('#inspector:not([hidden])'); await ph.waitForTimeout(500);
  await ph.locator('#views button', { hasText: /^System$/ }).click(); await ph.locator('.tune-tabs button', { hasText: 'Controllers' }).click(); await ph.waitForTimeout(100);
  const sw = await ph.evaluate(() => document.documentElement.scrollWidth); console.log('phone scrollWidth', sw); assert.ok(sw <= 412);
  await browser.close(); console.log('OK');
})().catch((e) => { console.error(e); process.exit(1); });
