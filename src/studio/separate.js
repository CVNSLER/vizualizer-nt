// Vocal / drums / bass / other separation (HTDemucs). Heavy work happens in a worker.
import SepWorker from './sepworker.js?worker&inline';

export const STEMS = ['drums', 'bass', 'other', 'vocals'];
const HF_URL = 'https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx';

async function resample(buffer, sr, channels = 2) {
  if (buffer.sampleRate === sr && buffer.numberOfChannels === channels) return buffer;
  const ctx = new OfflineAudioContext(channels, Math.ceil(buffer.duration * sr), sr);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start();
  return ctx.startRendering();
}

function modelSources() {
  const list = [];
  // the web version keeps the model split into parts next to the page
  try { list.push({ manifest: new URL('demucs/manifest.json', document.baseURI).href }); } catch { /* ignore */ }
  list.push({ url: HF_URL });
  if (location.protocol === 'file:') list.reverse();
  return list;
}

/**
 * Separate `buffer` into four stems. Returns { drums, bass, other, vocals } AudioBuffers
 * at the original sample rate, plus `ep` ('webgpu' | 'wasm').
 * onProgress({ stage: 'runtime'|'download'|'init'|'separate', p, eta })
 */
export function separateStems(buffer, onProgress = () => {}, { prefer, modelFile } = {}) {
  let worker = null, cancelled = false;
  const promise = (async () => {
    const model = modelFile ? await modelFile.arrayBuffer() : null;
    const b44 = await resample(buffer, 44100, 2);
    const L = Float32Array.from(b44.getChannelData(0)), R = Float32Array.from(b44.getChannelData(1));
    const res = await new Promise((resolve, reject) => {
      worker = new SepWorker();
      let ep = null;
      worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'progress') onProgress(m);
        else if (m.type === 'ep') { ep = m.ep; onProgress({ stage: 'ep', ep }); }
        else if (m.type === 'done') { worker.terminate(); resolve({ stems: m.stems, ep: m.ep || ep }); }
        else { worker.terminate(); reject(new Error(m.message)); }
      };
      worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message || 'worker error')); };
      worker.postMessage({ L, R, sources: modelSources(), prefer, modelFile: model }, [L.buffer, R.buffer, ...(model ? [model] : [])]);
    });
    if (cancelled) throw new Error('ABORTED');
    const sr = buffer.sampleRate, out = { ep: res.ep };
    for (let k = 0; k < 4; k++) {
      const tmp = new AudioBuffer({ numberOfChannels: 2, length: res.stems[k][0].length, sampleRate: 44100 });
      tmp.copyToChannel(res.stems[k][0], 0); tmp.copyToChannel(res.stems[k][1], 1);
      let b = sr === 44100 ? tmp : await resample(tmp, sr, 2);
      // keep exactly the length of the source so stems stay sample-aligned with it
      if (b.length !== buffer.length) {
        const fit = new AudioBuffer({ numberOfChannels: 2, length: buffer.length, sampleRate: sr });
        for (let c = 0; c < 2; c++) fit.copyToChannel(b.getChannelData(c).subarray(0, buffer.length), c);
        b = fit;
      }
      out[STEMS[k]] = b;
    }
    return out;
  })();
  return { promise, cancel: () => { cancelled = true; worker?.terminate(); } };
}

export const MODEL_URL = HF_URL;
export const MODEL_BYTES = 180534758;
/** true when the model is already saved in this browser / app */
export function modelSaved() {
  return new Promise((resolve) => {
    const w = new SepWorker();
    w.onmessage = (e) => { if (e.data.type === 'has') { w.terminate(); resolve(e.data.has); } };
    w.onerror = () => { w.terminate(); resolve(false); };
    w.postMessage({ cmd: 'has' });
  });
}
