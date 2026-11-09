// Promise wrappers around the studio worker. Each call gets its own worker so jobs can run in
// parallel and be cancelled by terminating them.
import StudioWorker from './worker.js?worker&inline';

function job(msg, transfer, onProgress) {
  const w = new StudioWorker();
  const promise = new Promise((resolve, reject) => {
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') onProgress?.(m.p);
      else if (m.type === 'done') { w.terminate(); resolve(m.result); }
      else { w.terminate(); reject(new Error(m.message)); }
    };
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'worker error')); };
    w.postMessage({ id: 1, ...msg }, transfer);
  });
  promise.cancel = () => w.terminate();
  return promise;
}

const copyChs = (buf) => Array.from({ length: Math.min(2, buf.numberOfChannels) }, (_, c) => Float32Array.from(buf.getChannelData(c)));
export function statsJob(buffer) {
  const chs = copyChs(buffer);
  return job({ cmd: 'stats', chs, fs: buffer.sampleRate }, chs.map((c) => c.buffer));
}
export function harshJob(buffer, max = 6) {
  const chs = copyChs(buffer);
  return job({ cmd: 'harsh', chs, fs: buffer.sampleRate, max }, chs.map((c) => c.buffer));
}
