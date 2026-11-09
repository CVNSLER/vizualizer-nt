import DeepWorker from './worker.js?worker&inline';

// Runs the deep analysis in a background thread so the app never freezes.
export function runDeepAnalysis(audioBuffer, onProgress) {
  const len = audioBuffer.length;
  const mono = new Float32Array(len);
  for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
    const d = audioBuffer.getChannelData(c);
    for (let i = 0; i < len; i++) mono[i] += d[i] / audioBuffer.numberOfChannels;
  }
  const w = new DeepWorker();
  const promise = new Promise((resolve, reject) => {
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') onProgress?.(m.p, m.stage);
      else if (m.type === 'done') { w.terminate(); resolve(m.result); }
      else if (m.type === 'error') { w.terminate(); reject(new Error(m.message)); }
    };
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'worker error')); };
  });
  w.postMessage({ samples: mono, sampleRate: audioBuffer.sampleRate }, [mono.buffer]);
  return { promise, cancel: () => w.terminate() };
}
