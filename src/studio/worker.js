// Background jobs for the studio: pitch tracking, pitch rendering, noise reduction, level stats.
import { trackPitch, findNotes, shiftCurve, renderPitch } from './pitch.js';
import { denoise, levelStats } from './dsp.js';

self.onmessage = (e) => {
  const { id, cmd } = e.data;
  const progress = (p) => self.postMessage({ id, type: 'progress', p });
  try {
    if (cmd === 'track') {
      const { chs, fs } = e.data;
      const mono = new Float32Array(chs[0].length);
      for (const c of chs) for (let i = 0; i < mono.length; i++) mono[i] += c[i] / chs.length;
      const track = trackPitch(mono, fs, progress);
      const notes = findNotes(track);
      self.postMessage({ id, type: 'done', result: { track, notes } });
    } else if (cmd === 'render') {
      const { chs, fs, track, notes } = e.data;
      const out = renderPitch(chs, fs, track, shiftCurve(track, notes), progress);
      self.postMessage({ id, type: 'done', result: out }, out.map((c) => c.buffer));
    } else if (cmd === 'denoise') {
      const { chs, fs, strength } = e.data;
      const out = chs.map((c, i) => { const r = denoise(c, fs, strength); progress((i + 1) / chs.length); return r; });
      self.postMessage({ id, type: 'done', result: out }, out.map((c) => c.buffer));
    } else if (cmd === 'stats') {
      const { chs, fs } = e.data;
      self.postMessage({ id, type: 'done', result: levelStats(chs, fs) });
    }
  } catch (err) {
    self.postMessage({ id, type: 'error', message: String(err?.message || err) });
  }
};
