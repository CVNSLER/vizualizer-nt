// Export the music on its own: WAV (16-bit PCM) or MP3 (LAME, encoded in a worker).
import Mp3Worker from './mp3worker.js?worker&inline';

function slice(buffer, start, end) {
  const sr = buffer.sampleRate;
  const a = Math.max(0, Math.floor(start * sr)), b = Math.min(buffer.length, Math.floor(end * sr));
  const chs = [];
  for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) chs.push(buffer.getChannelData(c).slice(a, b));
  // 10 ms fades so a cut fragment does not click
  const f = Math.min(Math.floor(0.01 * sr), chs[0].length >> 1);
  for (const ch of chs) for (let i = 0; i < f; i++) { const k = i / f; ch[i] *= k; ch[ch.length - 1 - i] *= k; }
  return { chs, sr };
}

export function wavBytes(buffer, start = 0, end = buffer.duration) {
  const { chs, sr } = slice(buffer, start, end);
  const ch = chs.length, n = chs[0].length;
  const data = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const w = (o, s) => { for (let i = 0; i < s.length; i++) data.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); data.setUint32(4, 36 + n * ch * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, ch, true); data.setUint32(24, sr, true);
  data.setUint32(28, sr * ch * 2, true); data.setUint16(32, ch * 2, true); data.setUint16(34, 16, true); w(36, 'data'); data.setUint32(40, n * ch * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) {
    const d = (Math.random() - Math.random()) / 65536; // TPDF dither
    const v = Math.max(-1, Math.min(1, chs[c][i] + d));
    data.setInt16(o, v < 0 ? v * 32768 : v * 32767, true); o += 2;
  }
  return new Uint8Array(data.buffer);
}

export function mp3Bytes(buffer, start = 0, end = buffer.duration, kbps = 320, onProgress) {
  const { chs, sr } = slice(buffer, start, end);
  return new Promise((resolve, reject) => {
    const w = new Mp3Worker();
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') onProgress?.(m.p);
      else if (m.type === 'done') { w.terminate(); resolve(new Uint8Array(m.data)); }
      else { w.terminate(); reject(new Error(m.message)); }
    };
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'mp3 worker')); };
    w.postMessage({ chs, sr, kbps }, chs.map((c) => c.buffer));
  });
}

// Minimal ZIP (stored, no compression): the artifact viewer only lets pages save some file
// types, so music is handed over inside a .zip there.
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(d) { let c = 0xffffffff; for (let i = 0; i < d.length; i++) c = CRC[(c ^ d[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
export function zipOne(name, bytes) {
  const nm = new TextEncoder().encode(name), crc = crc32(bytes), n = bytes.length;
  const lh = new DataView(new ArrayBuffer(30)), ch = new DataView(new ArrayBuffer(46)), end = new DataView(new ArrayBuffer(22));
  lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint32(14, crc, true); lh.setUint32(18, n, true); lh.setUint32(22, n, true); lh.setUint16(26, nm.length, true);
  ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint32(16, crc, true); ch.setUint32(20, n, true); ch.setUint32(24, n, true); ch.setUint16(28, nm.length, true);
  const cdOff = 30 + nm.length + n;
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, 1, true); end.setUint16(10, 1, true); end.setUint32(12, 46 + nm.length, true); end.setUint32(16, cdOff, true);
  const out = new Uint8Array(cdOff + 46 + nm.length + 22);
  let o = 0;
  for (const part of [new Uint8Array(lh.buffer), nm, bytes, new Uint8Array(ch.buffer), nm, new Uint8Array(end.buffer)]) { out.set(part, o); o += part.length; }
  return out;
}

/** Save a music file the best way this environment allows. Returns the saved name or null. */
export async function saveAudio(bytes, name, title) {
  const ext = name.split('.').pop();
  if (window.desktop) {
    const path = await window.desktop.chooseSavePath(name, title, ext);
    if (!path) return null;
    const CH = 8 * 1024 * 1024;
    for (let off = 0; off < bytes.length; off += CH) await window.desktop.writeChunk(bytes.subarray(off, off + CH));
    await window.desktop.finishSave(true);
    return path;
  }
  const dl = window.claude?.use ? await window.claude.use('downloads').catch(() => null) : null;
  if (dl) {
    const zipName = name.replace(/\.[^.]+$/, '') + '.zip';
    try {
      await dl.save({ filename: zipName, data: new Blob([zipOne(name, bytes)]) });
      return zipName;
    } catch (e) {
      if (e?.code === 'declined') return null;
      throw new Error(e?.message || String(e?.code || e));
    }
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: ext === 'mp3' ? 'audio/mpeg' : 'audio/wav' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return name;
}
