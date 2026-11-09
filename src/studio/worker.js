// Background jobs for the studio: level statistics and the unpleasant-sound finder.
import { levelStats, findHarsh } from './dsp.js';

self.onmessage = (e) => {
  const { id, cmd, chs, fs } = e.data;
  try {
    const result = cmd === 'harsh' ? findHarsh(chs, fs, e.data.max) : levelStats(chs, fs);
    self.postMessage({ id, type: 'done', result });
  } catch (err) {
    self.postMessage({ id, type: 'error', message: String(err?.message || err) });
  }
};
