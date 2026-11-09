import { Mp3Encoder } from '@breezystack/lamejs';

self.onmessage = (e) => {
  const { chs, sr, kbps } = e.data;
  try {
    const ch = chs.length;
    const rate = [32000, 44100, 48000].includes(sr) ? sr : 44100;
    const enc = new Mp3Encoder(ch, rate, kbps);
    const toI16 = (f) => { const o = new Int16Array(f.length); for (let i = 0; i < f.length; i++) { const v = Math.max(-1, Math.min(1, f[i])); o[i] = v < 0 ? v * 32768 : v * 32767; } return o; };
    const L = toI16(chs[0]), R = ch > 1 ? toI16(chs[1]) : null;
    const parts = [];
    const block = 1152 * 20;
    for (let i = 0; i < L.length; i += block) {
      const l = L.subarray(i, i + block);
      const buf = R ? enc.encodeBuffer(l, R.subarray(i, i + block)) : enc.encodeBuffer(l);
      if (buf.length) parts.push(new Uint8Array(buf));
      if ((i / block) % 20 === 0) self.postMessage({ type: 'progress', p: i / L.length });
    }
    const fin = enc.flush();
    if (fin.length) parts.push(new Uint8Array(fin));
    const total = parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(total);
    let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
    self.postMessage({ type: 'done', data: out.buffer }, [out.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
