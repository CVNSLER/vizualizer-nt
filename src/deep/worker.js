import { deepAnalyse } from './analyzer.js';

self.onmessage = (e) => {
  const { samples, sampleRate } = e.data;
  try {
    const res = deepAnalyse(samples, sampleRate, (p, stage) => self.postMessage({ type: 'progress', p, stage }));
    const c = res.curves;
    self.postMessage({ type: 'done', result: res }, [c.kick.buffer, c.snare.buffer, c.hat.buffer, c.ohat.buffer, c.vocal.buffer, c.sfx.buffer, c.bass.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
