// Background job for the studio: level statistics of a buffer.
import { levelStats } from './dsp.js';

self.onmessage = (e) => {
  const { id, chs, fs } = e.data;
  try {
    self.postMessage({ id, type: 'done', result: levelStats(chs, fs) });
  } catch (err) {
    self.postMessage({ id, type: 'error', message: String(err?.message || err) });
  }
};
