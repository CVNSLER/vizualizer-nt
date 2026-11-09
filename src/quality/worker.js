import { analyseQuality, diagnose, enhance } from './quality.js';

self.onmessage = (e) => {
  const { cmd, chs, fs, vocals, target, plan } = e.data;
  try {
    if (cmd === 'analyse') {
      const m = analyseQuality(chs, fs, vocals || []);
      self.postMessage({ type: 'done', result: { metrics: m, ...diagnose(m, target) } });
    } else if (cmd === 'enhance') {
      const { chs: out, stages } = enhance(chs, fs, plan, (p) => self.postMessage({ type: 'progress', p }));
      const after = analyseQuality(out, fs, vocals || []);
      self.postMessage({ type: 'done', result: { chs: out, after, stages, ...diagnose(after, plan.target) } }, out.map((c) => c.buffer));
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
