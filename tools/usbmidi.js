// USB-MIDI 1.0 transport for the GP-10 over WebUSB.
// Used when no GP-10 driver is present (Android, or a Mac without the driver):
// the browser claims the GP-10's vendor-specific MIDI interface itself and
// exchanges standard 4-byte USB-MIDI event packets on its bulk endpoints.
// The GP-10 carries two virtual cables: cable 0 is the "GP-10" port, cable 1
// is "GP-10 DAW CTRL". The editor only uses cable 0.
//
// The editor inlines this file at build time. Node can require() it for tests.
const UsbMidi = (() => {
  const VENDOR = 0x0582;
  const GP10 = 0x0185;
  // Number of MIDI bytes carried by each Code Index Number.
  const CIN_LEN = [0, 0, 2, 3, 3, 1, 2, 3, 3, 3, 3, 3, 2, 2, 3, 1];

  function msgLen(status) {
    if (status < 0xF0) return (status & 0xE0) === 0xC0 ? 2 : 3;
    if (status === 0xF1 || status === 0xF3) return 2;
    if (status === 0xF2) return 3;
    return 1;
  }

  // Splits a byte stream into whole MIDI messages. Handles SysEx that spans
  // several packets or transfers, and real-time bytes inside SysEx.
  function createParser(emit) {
    let sx = null; let cur = null;
    return function feed(b) {
      if (b >= 0xF8) { emit([b]); return; }
      if (b === 0xF0) { sx = [b]; cur = null; return; }
      if (sx) {
        if (b === 0xF7) { sx.push(b); const m = sx; sx = null; emit(m); return; }
        if (b < 0x80) { sx.push(b); return; }
        sx = null;
      }
      if (b >= 0x80) {
        if (b === 0xF7) return;
        cur = [b];
        if (msgLen(b) === 1) { emit(cur); cur = null; }
        return;
      }
      if (!cur) return;
      cur.push(b);
      if (cur.length === msgLen(cur[0])) { emit(cur); cur = null; }
    };
  }

  // Returns the MIDI bytes of every packet on the given cable, in order.
  function packetsToBytes(data, cable = 0) {
    const out = [];
    for (let i = 0; i + 3 < data.length; i += 4) {
      if ((data[i] >> 4) !== cable) continue;
      const n = CIN_LEN[data[i] & 0x0F];
      for (let k = 1; k <= n; k++) out.push(data[i + k]);
    }
    return out;
  }

  // Encodes complete MIDI messages (SysEx or short messages) as packets.
  function bytesToPackets(bytes, cable = 0) {
    const out = []; const c = (cable & 0x0F) << 4;
    const put = (cin, a, b = 0, d = 0) => out.push(c | cin, a, b, d);
    let i = 0;
    while (i < bytes.length) {
      const s = bytes[i];
      if (s === 0xF0) {
        let j = i; while (j < bytes.length && bytes[j] !== 0xF7) j++;
        const sx = bytes.slice(i, Math.min(j + 1, bytes.length));
        for (let k = 0; k < sx.length; k += 3) {
          const ch = sx.slice(k, k + 3); const last = k + 3 >= sx.length;
          const cin = !last ? 0x4 : ch.length === 1 ? 0x5 : ch.length === 2 ? 0x6 : 0x7;
          put(cin, ch[0], ch[1] || 0, ch[2] || 0);
        }
        i = j + 1; continue;
      }
      if (s < 0x80) { i++; continue; }
      const n = msgLen(s); const m = bytes.slice(i, i + n);
      let cin;
      if (s < 0xF0) cin = s >> 4;
      else if (s >= 0xF8) cin = 0xF;
      else cin = n === 1 ? 0x5 : n === 2 ? 0x2 : 0x3;
      put(cin, m[0], m[1] || 0, m[2] || 0);
      i += n;
    }
    return new Uint8Array(out);
  }

  // Finds the GP-10's MIDI interface: vendor class 0xFF, subclass 3, with a
  // bulk IN and a bulk OUT endpoint. Falls back to any interface with both.
  function findMidiInterface(dev) {
    const configs = dev.configurations || [];
    const found = [];
    for (const cfg of configs) for (const itf of cfg.interfaces) for (const alt of itf.alternates) {
      const eps = alt.endpoints || [];
      const inEp = eps.find((e) => e.direction === 'in' && e.type === 'bulk');
      const outEp = eps.find((e) => e.direction === 'out' && e.type === 'bulk');
      if (!inEp || !outEp) continue;
      found.push({ config: cfg.configurationValue, iface: itf.interfaceNumber, alt: alt.alternateSetting,
        score: (alt.interfaceClass === 0xFF ? 2 : 0) + (alt.interfaceSubclass === 3 ? 1 : 0) + (alt.alternateSetting === 0 ? 1 : 0),
        inEp: inEp.endpointNumber, outEp: outEp.endpointNumber, inSize: inEp.packetSize || 64 });
    }
    found.sort((a, b) => b.score - a.score);
    return found[0] || null;
  }

  const isGp10 = (d) => d.vendorId === VENDOR && d.productId === GP10;

  // Asks the user to pick the GP-10, or reuses one this page was already
  // allowed to use. Must be called from a click.
  async function pick(usb) {
    const known = (await usb.getDevices?.() || []).find(isGp10);
    if (known) return known;
    return usb.requestDevice({ filters: [{ vendorId: VENDOR, productId: GP10 }] });
  }

  function explain(e, step) {
    const msg = String(e && e.message || e);
    if (step === 'claim' || /claim/i.test(msg)) {
      return new Error('The GP-10 is in use by its driver or another app, so the browser cannot take it over. Connecting over USB works only where the GP-10 driver is not installed or running (for example on Android). With the driver installed, use Connect instead. Also close BOSS TONE STUDIO and other tabs that use the GP-10.');
    }
    if (/access denied|security/i.test(msg)) return new Error(`The browser was not allowed to open the GP-10 (${msg}). On Linux, the USB device needs a udev rule that lets your user open it.`);
    return new Error(`Could not open the GP-10 over USB (${step}: ${msg})`);
  }

  // Opens the device and returns MIDIInput/MIDIOutput-like objects so the
  // editor can use it the same way as a Web MIDI port pair.
  async function open(dev, { usb, onclose } = {}) {
    const itf = findMidiInterface(dev);
    if (!itf) throw new Error('This device has no USB-MIDI interface the editor can use.');
    let step = 'open';
    try {
      if (!dev.opened) await dev.open();
      step = 'configuration';
      if (!dev.configuration || dev.configuration.configurationValue !== itf.config) await dev.selectConfiguration(itf.config);
      step = 'claim';
      await dev.claimInterface(itf.iface);
      step = 'alternate';
      if (itf.alt !== 0) await dev.selectAlternateInterface(itf.iface, itf.alt);
    } catch (e) {
      try { if (dev.opened) await dev.close(); } catch (_) { /* already closed */ }
      throw explain(e, step);
    }

    const name = `${dev.productName || 'GP-10'} (USB)`;
    const input = { id: 'usb-in', name, type: 'input', state: 'connected', onmidimessage: null };
    let closed = false; let writes = Promise.resolve();
    const output = {
      id: 'usb-out', name, type: 'output', state: 'connected',
      send(bytes) {
        if (closed) throw new Error('The USB connection is closed');
        const pk = bytesToPackets(Array.from(bytes), 0);
        writes = writes.then(() => dev.transferOut(itf.outEp, pk)).then((r) => {
          if (r && r.status && r.status !== 'ok') throw new Error(`USB write ${r.status}`);
        }).catch((e) => { if (!closed) console.warn('GP-10 USB write failed:', e); });
      },
    };
    const feed = createParser((m) => { if (input.onmidimessage) input.onmidimessage({ data: new Uint8Array(m), timeStamp: performance.now() }); });

    const shut = async (why) => {
      if (closed) return; closed = true;
      input.state = output.state = 'disconnected';
      if (usb && usb.removeEventListener) usb.removeEventListener('disconnect', onDisconnect);
      try { await dev.releaseInterface(itf.iface); } catch (_) { /* unplugged */ }
      try { await dev.close(); } catch (_) { /* unplugged */ }
      if (onclose) onclose(why);
    };
    function onDisconnect(e) { if (e.device === dev) shut('unplugged'); }
    if (usb && usb.addEventListener) usb.addEventListener('disconnect', onDisconnect);

    (async () => {
      let errors = 0;
      while (!closed) {
        let r;
        try { r = await dev.transferIn(itf.inEp, Math.max(64, itf.inSize)); }
        catch (e) {
          if (closed) return;
          if (++errors > 3) { shut('error'); return; }
          await new Promise((res) => setTimeout(res, 50));
          continue;
        }
        if (closed) return;
        if (r.status === 'stall') { try { await dev.clearHalt('in', itf.inEp); } catch (_) { /* ignore */ } continue; }
        errors = 0;
        if (!r.data || !r.data.byteLength) continue;
        const u8 = new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
        for (const b of packetsToBytes(u8, 0)) feed(b);
      }
    })();

    return { input, output, name, iface: itf, close: () => shut('closed'), get closed() { return closed; } };
  }

  return { VENDOR, GP10, isGp10, pick, open, findMidiInterface, packetsToBytes, bytesToPackets, createParser };
})();
if (typeof module !== 'undefined') module.exports = UsbMidi;
