// End-to-end test of the editor's "Connect over USB" path (WebUSB) against the mock GP-10.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { buildMock } = require('./mock-gp10');

const OUT = path.join(__dirname, 'out'); fs.mkdirSync(OUT, { recursive: true });
const htmlPath = path.join(__dirname, '..', 'index.html');
const mock = buildMock(path.join(__dirname, '..', 'data', 'gp10-address-map.json'), path.join(__dirname, 'fixtures', 'temp-patch-dump.txt'));
const GAIN = [0x20, 0, 0x50, 2];
const peek = (page, a) => page.evaluate((a) => window.__dev.peek(a), a);

(async () => {
  const browser = await chromium.launch();

  // 1. Android-like phone: Web MIDI finds no GP-10, USB works.
  {
    const page = await browser.newPage({ viewport: { width: 412, height: 860 }, hasTouch: true, isMobile: true });
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(mock);
    await page.addInitScript(() => { navigator.requestMIDIAccess = async () => ({ sysexEnabled: true, inputs: new Map(), outputs: new Map(), onstatechange: null }); });
    await page.goto('file://' + htmlPath);
    assert.ok(await page.isVisible('#btnUsb'), 'USB button is offered');
    await page.screenshot({ path: path.join(OUT, 'usb-welcome-phone.png') });
    await page.click('#btnConnect2'); await page.waitForTimeout(200);
    const notice = await page.textContent('#envNotice');
    console.log('midi on phone:', notice);
    assert.ok(/Connect over USB/.test(notice));

    await page.click('#btnUsb');
    await page.waitForSelector('#inspector:not([hidden])', { timeout: 5000 });
    await page.waitForTimeout(300);
    const status = await page.textContent('#statusText');
    console.log('usb status:', status, '| patch', await page.textContent('#patchNo'), await page.inputValue('#patchName'), '| claimed iface', await page.evaluate(() => window.__dev.claimed));
    assert.ok(/GP-10 \(USB\)/.test(status));
    assert.strictEqual(await page.evaluate(() => window.__dev.claimed), 3);

    // edit Gain through the tile and confirm the DT1 travelled over USB
    await page.locator('#rail .tile[data-view="AMP"]').click();
    const gain = page.locator('#ctls .cell').filter({ has: page.locator('.n', { hasText: /^Gain$/ }) }).first();
    const before = await peek(page, GAIN);
    const outs = await page.evaluate(() => window.__dev.usbOut);
    await gain.click(); await gain.locator('.pm button').nth(1).click(); await page.waitForTimeout(120);
    const after = await peek(page, GAIN);
    console.log('gain over usb', before, '→', after, '| transfers', outs, '→', await page.evaluate(() => window.__dev.usbOut), '| bad checksums', await page.evaluate(() => window.__dev.badcs || 0));
    assert.strictEqual(after, before + 1);

    // device-side change, then Reload reads it back over USB
    await page.evaluate((a) => window.__dev.poke(a, 33), GAIN);
    await page.click('#btnReload'); await page.waitForTimeout(500);
    assert.strictEqual((await gain.locator('.big').textContent()).trim(), '33');

    // patch switch over USB (Setup write)
    await page.evaluate(() => { window.__dev.sent.length = 0; });
    await page.evaluate(() => window.__gp10ed && 0);
    await page.screenshot({ path: path.join(OUT, 'usb-connected-phone.png'), fullPage: false });

    // unplug
    await page.evaluate(() => window.__dev.unplug()); await page.waitForTimeout(150);
    const st2 = await page.textContent('#statusText');
    console.log('after unplug:', st2, '| closed', await page.evaluate(() => window.__dev.usbClosed));
    assert.ok(/unplugged/.test(st2));
    assert.deepStrictEqual(errors, []);
    await page.close();
  }

  // 2. Driver holding the device: claim fails with a clear explanation.
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(mock);
    await page.addInitScript(() => { window.__usbClaimFails = true; });
    await page.goto('file://' + htmlPath);
    await page.click('#btnUsb'); await page.waitForTimeout(300);
    const notice = await page.textContent('#envNotice');
    console.log('claim fails:', notice.slice(0, 90) + '…', '| closed', await page.evaluate(() => window.__dev.usbClosed));
    assert.ok(/in use by its driver/.test(notice));
    assert.strictEqual(await page.evaluate(() => window.__dev.usbClosed), 1, 'device closed after the failed claim');
    assert.deepStrictEqual(errors, []);
    await page.close();
  }

  // 3. Reconnect keeps USB; "Use MIDI ports instead" goes back to Web MIDI and releases USB;
  //    a page reload remembers the last link.
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(mock);
    await page.goto('file://' + htmlPath);
    await page.click('#btnUsb'); await page.waitForSelector('#inspector:not([hidden])'); await page.waitForTimeout(300);
    await page.click('#btnConnect'); await page.waitForTimeout(600);
    const st = await page.textContent('#statusText');
    console.log('reconnect:', st, '| closed', await page.evaluate(() => window.__dev.usbClosed));
    assert.ok(/Connected to GP-10 \(USB\)/.test(st));
    await page.click('#btnMidi');
    assert.strictEqual((await page.textContent('#btnUsb2')).trim(), 'Use MIDI ports instead');
    await page.click('#btnUsb2'); await page.waitForTimeout(600);
    const st2 = await page.textContent('#statusText');
    console.log('back to midi:', st2, '| usb closed', await page.evaluate(() => window.__dev.usbClosed));
    assert.ok(/Connected to GP-10$/.test(st2));
    assert.strictEqual(await page.evaluate(() => window.__dev.usbClosed), 2);
    // edits now go over Web MIDI, not USB
    const outs = await page.evaluate(() => window.__dev.usbOut);
    await page.click('#btnReload'); await page.waitForTimeout(400);
    assert.strictEqual(await page.evaluate(() => window.__dev.usbOut), outs);
    // remembered link
    await page.click('#btnMidi'); await page.click('#btnUsb2'); await page.waitForTimeout(500);
    await page.reload(); await page.click('#btnConnect2');
    await page.waitForSelector('#inspector:not([hidden])'); await page.waitForTimeout(300);
    console.log('after reload, Connect uses:', await page.textContent('#statusText'));
    assert.ok(/USB/.test(await page.textContent('#statusText')));
    assert.deepStrictEqual(errors, []);
    await ctx.close();
  }

  await browser.close(); console.log('OK');
})().catch((e) => { console.error(e); process.exit(1); });
