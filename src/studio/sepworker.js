// Stem separation with HTDemucs (Meta, MIT) running in ONNX Runtime Web.
// Pre/post-processing (STFT, masks, overlap-add) comes from demucs-web (MIT).
// The model (~180 MB) is downloaded once and kept in IndexedDB.
import { CONSTANTS, prepareModelInput, standaloneMask, standaloneIspec } from 'demucs-web';

const ORT_VER = '1.22.0';
const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VER}/dist/`;
const MODEL_SIZE = 180534758;
const DB = 'viz-models', STORE = 'files', KEY = 'htdemucs-embedded-v1';
const { TRAINING_SAMPLES: SEG, MODEL_SPEC_BINS: BINS, MODEL_SPEC_FRAMES: FRAMES, SEGMENT_OVERLAP } = CONSTANTS;

const post = (m, t) => self.postMessage(m, t || []);

function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbGet(k) {
  try {
    const db = await idb();
    return await new Promise((res) => { const q = db.transaction(STORE).objectStore(STORE).get(k); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); });
  } catch { return null; }
}
async function idbPut(k, v) {
  try {
    const db = await idb();
    await new Promise((res) => { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).put(v, k); tx.oncomplete = res; tx.onerror = res; });
  } catch { /* storage full or blocked: we simply download again next time */ }
}

async function download(url, onBytes) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  if (!r.body) { const b = new Uint8Array(await r.arrayBuffer()); onBytes(b.length); return [b]; }
  const reader = r.body.getReader(), parts = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); onBytes(value.length);
  }
  return parts;
}

// sources: [{ manifest: url }] (model split into parts next to the page) or [{ url }]
async function loadModel(sources, file) {
  if (file) {
    // the user picked the model file by hand (when the page may not download it itself)
    if (file.byteLength !== MODEL_SIZE) throw new Error('MODEL_FILE_WRONG');
    await idbPut(KEY, file);
    return file;
  }
  const cached = await idbGet(KEY);
  if (cached && cached.byteLength === MODEL_SIZE) return cached;
  let got = 0, lastErr = null;
  const onBytes = (n) => { got += n; post({ type: 'progress', stage: 'download', p: Math.min(1, got / MODEL_SIZE) }); };
  for (const s of sources) {
    try {
      got = 0;
      let parts = [];
      if (s.manifest) {
        const m = await (await fetch(s.manifest)).json();
        const base = new URL('.', s.manifest).href;
        for (const p of m.parts) parts.push(...(await download(new URL(p, base).href, onBytes)));
      } else parts = await download(s.url, onBytes);
      const size = parts.reduce((n, p) => n + p.length, 0);
      if (size !== MODEL_SIZE) throw new Error(`model size ${size}`);
      const all = new Uint8Array(size);
      let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
      await idbPut(KEY, all.buffer);
      return all.buffer;
    } catch (e) { lastErr = e; }
  }
  throw new Error('MODEL_DOWNLOAD ' + (lastErr?.message || ''));
}

// ONNX Runtime: the full build (WebGPU + CPU) from the CDN when the page may fetch from it;
// otherwise the CPU-only build whose .wasm is served next to the page (the web version).
let gpuBuild = true;
async function fetchBytes(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status}`);
  return r.arrayBuffer();
}
async function loadOrt(local) {
  if (self.ort) return;
  const tried = [];
  let binary = null, base = ORT_BASE;
  try { binary = await fetchBytes(ORT_BASE + 'ort-wasm-simd-threaded.jsep.wasm'); } catch (e) { tried.push('cdn ' + e.message); }
  if (!binary && local) {
    try { binary = await fetchBytes(local + 'ort-wasm-simd-threaded.wasm'); gpuBuild = false; base = local; } catch (e) { tried.push('local ' + e.message); }
  }
  if (!binary) throw new Error('RUNTIME_DOWNLOAD ' + tried.join('; '));
  const file = gpuBuild ? 'ort.min.js' : 'ort.wasm.min.js';
  try { importScripts(ORT_BASE + file); } catch {
    try { if (gpuBuild) throw 0; importScripts(base + file); } catch {
      // module worker (dev server): no importScripts
      self.ort = await import(/* @vite-ignore */ ORT_BASE + file.replace('.js', '.mjs'));
    }
  }
  const glue = gpuBuild ? 'ort-wasm-simd-threaded.jsep.mjs' : 'ort-wasm-simd-threaded.mjs';
  self.ort.env.wasm.wasmBinary = binary;
  self.ort.env.wasm.wasmPaths = { mjs: (gpuBuild ? ORT_BASE : base) + glue };
}

async function makeSession(model, prefer) {
  const ort = self.ort;
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
  const tries = [];
  if (gpuBuild && prefer !== 'wasm' && self.navigator?.gpu) tries.push(['webgpu', 'wasm']);
  tries.push(['wasm']);
  const errs = [];
  for (const eps of tries) {
    try {
      const s = await ort.InferenceSession.create(new Uint8Array(model), { executionProviders: eps, graphOptimizationLevel: 'basic' });
      return { session: s, ep: eps[0] };
    } catch (e) { errs.push(`${eps[0]}: ${String(e?.message || e).slice(0, 160)}`); }
  }
  throw new Error(errs.join(' | '));
}

async function runSegment(session, L, R) {
  const ort = self.ort;
  const input = prepareModelInput(L, R);
  const feeds = {};
  feeds[session.inputNames[0]] = new ort.Tensor('float32', input.waveform, [1, 2, SEG]);
  if (session.inputNames.length > 1) feeds[session.inputNames[1]] = new ort.Tensor('float32', input.magSpec, [1, 4, BINS, FRAMES]);
  const out = await session.run(feeds);
  let time = null, freq = null;
  for (const n of session.outputNames) {
    const t = out[n];
    if (t.dims.length === 4 && t.dims[2] === 2) time = t; else if (t.dims.length === 5 && t.dims[2] === 4) freq = t;
  }
  if (!time) throw new Error('no time output');
  const tracks = [];
  const specs = freq ? standaloneMask(freq.data) : null;
  const S = time.dims[3];
  for (let k = 0; k < 4; k++) {
    const l = new Float32Array(S), r = new Float32Array(S);
    const base = k * 2 * S;
    for (let i = 0; i < S; i++) { l[i] = time.data[base + i]; r[i] = time.data[base + S + i]; }
    if (specs) {
      const f = standaloneIspec(specs[k], SEG);
      for (let i = 0; i < S; i++) { l[i] += f.left[i] || 0; r[i] += f.right[i] || 0; }
    }
    tracks.push([l, r]);
  }
  for (const n of session.outputNames) out[n].dispose?.();
  return tracks;
}

self.onmessage = async (e) => {
  if (e.data.cmd === 'has') { const c = await idbGet(KEY); post({ type: 'has', has: !!(c && c.byteLength === MODEL_SIZE) }); return; }
  const { L, R, sources, prefer, modelFile, ortLocal } = e.data;
  try {
    post({ type: 'progress', stage: 'runtime', p: 0 });
    await loadOrt(ortLocal);
    const model = await loadModel(sources, modelFile);
    post({ type: 'progress', stage: 'init', p: 0 });
    let { session, ep } = await makeSession(model, prefer);
    post({ type: 'ep', ep });

    const n = L.length;
    const stride = Math.floor(SEG * (1 - SEGMENT_OVERLAP));
    const starts = [];
    for (let s = 0; s < n; s += stride) { starts.push(s); if (s + SEG >= n) break; }
    const out = Array.from({ length: 4 }, () => [new Float32Array(n), new Float32Array(n)]);
    const wsum = new Float32Array(n);
    const ramp = stride * 0.5;
    const t0 = performance.now();
    for (let si = 0; si < starts.length; si++) {
      const start = starts[si], len = Math.min(SEG, n - start);
      const sl = new Float32Array(SEG), sr = new Float32Array(SEG);
      sl.set(L.subarray(start, start + len)); sr.set(R.subarray(start, start + len));
      let tracks = await runSegment(session, sl, sr);
      // a GPU driver that returns garbage: redo everything on the CPU
      if (ep === 'webgpu' && !Number.isFinite(tracks[3][0][len >> 1] + tracks[0][0][len >> 2])) {
        await session.release?.();
        ({ session, ep } = await makeSession(model, 'wasm'));
        post({ type: 'ep', ep });
        tracks = await runSegment(session, sl, sr);
      }
      // triangular cross-fade between overlapping segments (edges of the song keep full weight)
      for (let i = 0; i < len; i++) {
        const a = start === 0 ? 1 : Math.min(1, (i + 1) / ramp);
        const b = start + len >= n ? 1 : Math.min(1, (len - i) / ramp);
        const w = Math.min(a, b);
        wsum[start + i] += w;
        for (let k = 0; k < 4; k++) { out[k][0][start + i] += tracks[k][0][i] * w; out[k][1][start + i] += tracks[k][1][i] * w; }
      }
      const el = (performance.now() - t0) / 1000;
      post({ type: 'progress', stage: 'separate', p: (si + 1) / starts.length, eta: (el / (si + 1)) * (starts.length - si - 1) });
    }
    for (let i = 0; i < n; i++) {
      const w = wsum[i] > 1e-6 ? 1 / wsum[i] : 0;
      for (let k = 0; k < 4; k++) { out[k][0][i] *= w; out[k][1][i] *= w; }
    }
    await session.release?.();
    // order: drums, bass, other, vocals
    post({ type: 'done', stems: out, ep }, out.flatMap((c) => [c[0].buffer, c[1].buffer]));
  } catch (err) {
    post({ type: 'error', message: String(err?.message || err) });
  }
};
