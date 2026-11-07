// Offline audio analysis. Everything the visuals need is computed once per
// track at a fixed rate, so preview and export always look exactly the same.

export const ANALYSIS_FPS = 60;
export const NUM_BANDS = 64;
const FFT_SIZE = 2048;

function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

function percentile(arr, p) {
  const s = Float32Array.from(arr).sort();
  return s[Math.min(s.length - 1, Math.floor(p * s.length))] || 1e-9;
}

// Simple 2nd-order low-pass (RBJ biquad)
function lowpass(x, sr, fc) {
  const w0 = (2 * Math.PI * fc) / sr, q = 0.707;
  const alpha = Math.sin(w0) / (2 * q), cw = Math.cos(w0);
  const b0 = (1 - cw) / 2, b1 = 1 - cw, b2 = (1 - cw) / 2;
  const a0 = 1 + alpha, a1 = -2 * cw, a2 = 1 - alpha;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

export async function decodeFile(file) {
  const buf = await file.arrayBuffer();
  const ctx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(2, 44100, 44100);
  return await ctx.decodeAudioData(buf);
}

export function analyse(audioBuffer, onProgress) {
  const sr = audioBuffer.sampleRate;
  const len = audioBuffer.length;
  const mono = new Float32Array(len);
  for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
    const d = audioBuffer.getChannelData(c);
    for (let i = 0; i < len; i++) mono[i] += d[i] / audioBuffer.numberOfChannels;
  }
  const frames = Math.ceil((len / sr) * ANALYSIS_FPS);
  const hop = sr / ANALYSIS_FPS;

  // log-spaced band edges, 30 Hz .. 16 kHz
  const edges = [];
  for (let b = 0; b <= NUM_BANDS; b++) {
    const f = 30 * Math.pow(16000 / 30, b / NUM_BANDS);
    edges.push(Math.max(1, Math.round((f / sr) * FFT_SIZE)));
  }
  const hann = new Float32Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));

  const bands = new Float32Array(frames * NUM_BANDS);
  const bass = new Float32Array(frames), mid = new Float32Array(frames), high = new Float32Array(frames);
  const rms = new Float32Array(frames), flux = new Float32Array(frames);
  const re = new Float32Array(FFT_SIZE), im = new Float32Array(FFT_SIZE);
  let prevMag = new Float32Array(FFT_SIZE / 2);
  const binHz = sr / FFT_SIZE;

  for (let f = 0; f < frames; f++) {
    const center = Math.floor(f * hop);
    let e = 0;
    for (let i = 0; i < FFT_SIZE; i++) {
      const idx = center - FFT_SIZE / 2 + i;
      const v = idx >= 0 && idx < len ? mono[idx] : 0;
      re[i] = v * hann[i]; im[i] = 0; e += v * v;
    }
    rms[f] = Math.sqrt(e / FFT_SIZE);
    fftInPlace(re, im);
    const mag = new Float32Array(FFT_SIZE / 2);
    let fl = 0, bs = 0, md = 0, hi = 0;
    for (let k = 0; k < FFT_SIZE / 2; k++) {
      const m = Math.hypot(re[k], im[k]);
      mag[k] = m;
      const d = m - prevMag[k];
      if (d > 0) fl += d;
      const hz = k * binHz;
      if (hz >= 25 && hz < 160) bs += m * m;
      else if (hz >= 160 && hz < 2500) md += m * m;
      else if (hz >= 2500 && hz < 14000) hi += m * m;
    }
    prevMag = mag;
    flux[f] = fl; bass[f] = Math.sqrt(bs); mid[f] = Math.sqrt(md); high[f] = Math.sqrt(hi);
    for (let b = 0; b < NUM_BANDS; b++) {
      let s = 0, lo = edges[b], hiE = Math.max(edges[b + 1], lo + 1);
      for (let k = lo; k < hiE && k < mag.length; k++) s = Math.max(s, mag[k]);
      bands[f * NUM_BANDS + b] = Math.log10(1 + s * 10);
    }
    if (onProgress && f % 500 === 0) onProgress(f / frames);
  }

  // normalise each feature to roughly 0..1
  const norm = (a, p = 0.98) => { const m = percentile(a, p); for (let i = 0; i < a.length; i++) a[i] = Math.min(1.5, a[i] / m); };
  [bass, mid, high, rms, flux].forEach((a) => norm(a));
  for (let b = 0; b < NUM_BANDS; b++) {
    const col = new Float32Array(frames);
    for (let f = 0; f < frames; f++) col[f] = bands[f * NUM_BANDS + b];
    const m = percentile(col, 0.985);
    // tilt: give highs a little boost so the spectrum looks even
    const tilt = 1 + 0.35 * (b / NUM_BANDS);
    for (let f = 0; f < frames; f++) bands[f * NUM_BANDS + b] = Math.min(1.2, (col[f] / m) * tilt);
  }

  // smoothed (attack/release) versions for nicer motion
  const smooth = (a, att, rel) => {
    const o = new Float32Array(a.length); let v = 0;
    for (let i = 0; i < a.length; i++) { const k = a[i] > v ? att : rel; v += (a[i] - v) * k; o[i] = v; }
    return o;
  };
  const bassS = smooth(bass, 0.6, 0.12);
  const rmsS = smooth(rms, 0.5, 0.08);
  const bandsS = new Float32Array(bands.length);
  for (let b = 0; b < NUM_BANDS; b++) {
    let v = 0;
    for (let f = 0; f < frames; f++) {
      const x = bands[f * NUM_BANDS + b];
      v += (x - v) * (x > v ? 0.65 : 0.18);
      bandsS[f * NUM_BANDS + b] = v;
    }
  }

  // onset / beat detection: adaptive threshold on spectral flux
  const beats = [];
  const W = Math.round(ANALYSIS_FPS * 0.25);
  let last = -1e9;
  for (let f = 1; f < frames - 1; f++) {
    let s = 0, n = 0;
    for (let k = Math.max(0, f - W); k < Math.min(frames, f + W); k++) { s += flux[k]; n++; }
    const thr = (s / n) * 1.45 + 0.08;
    if (flux[f] > thr && flux[f] >= flux[f - 1] && flux[f] >= flux[f + 1] && f - last > ANALYSIS_FPS * 0.12) {
      const strength = Math.min(1.5, flux[f]);
      // which register dominated this hit
      const reg = bass[f] > mid[f] * 1.1 ? 0 : high[f] > mid[f] ? 2 : 1;
      beats.push({ t: f / ANALYSIS_FPS, s: strength, reg });
      last = f;
    }
  }

  // tempo estimate from inter-onset intervals
  let bpm = 120;
  if (beats.length > 8) {
    const hist = new Float32Array(200);
    for (let i = 0; i < beats.length; i++)
      for (let j = i + 1; j < Math.min(beats.length, i + 8); j++) {
        let b = 60 / (beats[j].t - beats[i].t);
        while (b < 70) b *= 2; while (b > 180) b /= 2;
        hist[Math.round(b)] += 1;
      }
    let best = 0;
    for (let i = 70; i <= 180; i++) {
      const v = hist[i - 1] + hist[i] * 2 + hist[i + 1];
      if (v > best) { best = v; bpm = i; }
    }
  }

  // bass waveform (for "shake" that follows the actual vibration)
  const lp = lowpass(lowpass(mono, sr, 160), sr, 160);
  const bassWave = new Float32Array(Math.ceil((len / sr) * 600)); // 600 Hz sampled
  let mx = 1e-9;
  for (let i = 0; i < bassWave.length; i++) {
    const v = lp[Math.min(len - 1, Math.floor((i / 600) * sr))];
    bassWave[i] = v; mx = Math.max(mx, Math.abs(v));
  }
  const p = percentile(bassWave.map(Math.abs), 0.99);
  for (let i = 0; i < bassWave.length; i++) bassWave[i] = Math.max(-1.5, Math.min(1.5, bassWave[i] / p));

  // raw waveform at 600 Hz for the waveform template
  const wave = new Float32Array(bassWave.length);
  const wp = percentile(mono.filter((_, i) => i % 64 === 0).map(Math.abs), 0.995);
  for (let i = 0; i < wave.length; i++) wave[i] = Math.max(-1.3, Math.min(1.3, mono[Math.min(len - 1, Math.floor((i / 600) * sr))] / wp));

  onProgress && onProgress(1);
  return { frames, duration: len / sr, bands, bandsS, bass, bassS, mid, high, rms, rmsS, flux, beats, bpm, bassWave, wave };
}

// Feature lookup at time t (seconds)
export function sample(an, t) {
  const fi = Math.max(0, Math.min(an.frames - 1, Math.floor(t * ANALYSIS_FPS)));
  const bands = an.bandsS.subarray(fi * NUM_BANDS, fi * NUM_BANDS + NUM_BANDS);
  const raw = an.bands.subarray(fi * NUM_BANDS, fi * NUM_BANDS + NUM_BANDS);
  // beats within the last few seconds
  let lastBeat = null;
  for (let i = an.beats.length - 1; i >= 0; i--) if (an.beats[i].t <= t) { lastBeat = an.beats[i]; break; }
  const sinceBeat = lastBeat ? t - lastBeat.t : 99;
  const bw = (dt) => an.bassWave[Math.max(0, Math.min(an.bassWave.length - 1, Math.floor((t + dt) * 600)))];
  return {
    t, fi, bands, raw,
    bass: an.bassS[fi], bassRaw: an.bass[fi], mid: an.mid[fi], high: an.high[fi],
    rms: an.rmsS[fi], flux: an.flux[fi],
    lastBeat, sinceBeat, bpm: an.bpm,
    bassWave: bw,
    beatsBetween: (t0, t1) => an.beats.filter((b) => b.t > t0 && b.t <= t1),
    wave: (dt) => an.wave[Math.max(0, Math.min(an.wave.length - 1, Math.floor((t + dt) * 600)))],
    // smoothed spectrum `dt` seconds ago (for history-based visuals)
    bandsAt: (dt) => {
      const j = Math.max(0, Math.min(an.frames - 1, fi - Math.round(dt * ANALYSIS_FPS)));
      return an.bandsS.subarray(j * NUM_BANDS, j * NUM_BANDS + NUM_BANDS);
    },
    bassAt: (dt) => an.bassS[Math.max(0, Math.min(an.frames - 1, fi - Math.round(dt * ANALYSIS_FPS)))],
    duration: an.duration,
  };
}
