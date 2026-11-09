import QWorker from './worker.js?worker&inline';

function run(msg, transfer, onProgress) {
  const w = new QWorker();
  return new Promise((resolve, reject) => {
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') onProgress?.(m.p);
      else if (m.type === 'done') { w.terminate(); resolve(m.result); }
      else { w.terminate(); reject(new Error(m.message)); }
    };
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'worker error')); };
    w.postMessage(msg, transfer);
  });
}
const channels = (buf) => Array.from({ length: Math.min(2, buf.numberOfChannels) }, (_, c) => Float32Array.from(buf.getChannelData(c)));

export function checkQuality(buffer, vocals, target) {
  const chs = channels(buffer);
  return run({ cmd: 'analyse', chs, fs: buffer.sampleRate, vocals, target }, chs.map((c) => c.buffer));
}

export async function improveQuality(buffer, plan, vocals, onProgress) {
  const chs = channels(buffer);
  const res = await run({ cmd: 'enhance', chs, fs: buffer.sampleRate, plan, vocals }, chs.map((c) => c.buffer), onProgress);
  const ctx = new OfflineAudioContext(res.chs.length, res.chs[0].length, buffer.sampleRate);
  const out = ctx.createBuffer(res.chs.length, res.chs[0].length, buffer.sampleRate);
  res.chs.forEach((c, i) => out.copyToChannel(c, i));
  return { buffer: out, after: res.after, issues: res.issues, score: res.score };
}

// 16-bit WAV for playback in the <audio> element
export function toWavUrl(buffer) {
  const ch = buffer.numberOfChannels, n = buffer.length, sr = buffer.sampleRate;
  const data = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const w = (o, s) => { for (let i = 0; i < s.length; i++) data.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); data.setUint32(4, 36 + n * ch * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, ch, true); data.setUint32(24, sr, true);
  data.setUint32(28, sr * ch * 2, true); data.setUint16(32, ch * 2, true); data.setUint16(34, 16, true); w(36, 'data'); data.setUint32(40, n * ch * 2, true);
  const cs = Array.from({ length: ch }, (_, c) => buffer.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) {
    const d = (Math.random() - Math.random()) / 65536; // TPDF dither
    const v = Math.max(-1, Math.min(1, cs[c][i] + d));
    data.setInt16(o, v < 0 ? v * 32768 : v * 32767, true); o += 2;
  }
  return URL.createObjectURL(new Blob([data.buffer], { type: 'audio/wav' }));
}
