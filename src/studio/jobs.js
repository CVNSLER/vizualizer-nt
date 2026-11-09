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
function toBuffer(chs, sr) {
  const b = new AudioBuffer({ numberOfChannels: chs.length, length: chs[0].length, sampleRate: sr });
  chs.forEach((c, i) => b.copyToChannel(c, i));
  return b;
}

export function trackJob(buffer, onProgress) {
  const chs = copyChs(buffer);
  return job({ cmd: 'track', chs, fs: buffer.sampleRate }, chs.map((c) => c.buffer), onProgress);
}
export async function renderPitchJob(buffer, track, notes, onProgress) {
  const chs = copyChs(buffer);
  const out = await job({ cmd: 'render', chs, fs: buffer.sampleRate, track, notes }, chs.map((c) => c.buffer), onProgress);
  return toBuffer(out, buffer.sampleRate);
}
export async function denoiseJob(buffer, strength, onProgress) {
  const chs = copyChs(buffer);
  const out = await job({ cmd: 'denoise', chs, fs: buffer.sampleRate, strength }, chs.map((c) => c.buffer), onProgress);
  return toBuffer(out, buffer.sampleRate);
}
export function statsJob(buffer) {
  const chs = copyChs(buffer);
  return job({ cmd: 'stats', chs, fs: buffer.sampleRate }, chs.map((c) => c.buffer));
}
