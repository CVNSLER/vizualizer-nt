// "Algoritm": deep, offline music analysis.
//
// Pipeline (all classic DSP, no machine-learning model):
//  1. STFT (1024 / hop 256 @ 22.05 kHz, ~11.6 ms resolution)
//  2. Harmonic / percussive separation by median filtering (Fitzgerald 2010)
//  3. Drum events from per-band onset functions of the percussive part:
//       kick  35-150 Hz, snare/clap 150-400 Hz body + 1.5-5 kHz noise, hats 6-11 kHz
//       closed vs open hat from the decay time of the 6-11 kHz band
//  4. Tempo (autocorrelation with a tempo prior) + dynamic-programming beat tracker (Ellis 2007),
//     downbeats from the kick-on-1 / snare-on-2-and-4 pattern
//  5. Vocal activity from the harmonic part: pitch salience (subharmonic summation),
//     formant-band energy and natural pitch movement (vibrato / glides)
//  6. SFX: risers / downlifters from long spectral-centroid sweeps, impacts from huge
//     broadband hits with long tails, noise sweeps from spectral flatness
//  7. Key (Krumhansl-Schmuckler on chroma)
//  8. Structure: bar-synchronous features -> self-similarity -> checkerboard novelty ->
//     phrase-snapped boundaries -> segment clustering (A/B/C) and section roles.
//
// Output curves are sampled at 60 fps so visuals can read them per frame.

const SR = 22050;
const N = 1024;
const HOP = 256;
const NB = N / 2 + 1;
const FPS = SR / HOP; // ~86 frames / s
const OUT_FPS = 60;
// an onset in frame t is heard at about 3/4 of the analysis window
const LAG = (0.75 * N) / SR;
const ft = (t) => t / FPS + LAG;

// ---------------------------------------------------------------- utils
function resample(x, sr) {
  if (sr === SR) return x;
  const n = Math.floor((x.length * SR) / sr);
  const out = new Float32Array(n);
  const k = sr / SR;
  // light low-pass by averaging when downsampling
  const span = Math.max(1, Math.floor(k));
  for (let i = 0; i < n; i++) {
    const p = i * k, i0 = Math.floor(p);
    let s = 0, c = 0;
    for (let j = 0; j < span; j++) { const v = x[i0 + j]; if (v !== undefined) { s += v; c++; } }
    out[i] = c ? s / c : 0;
  }
  return out;
}

function makeFFT(n) {
  const rev = new Uint32Array(n);
  for (let i = 0, j = 0; i < n; i++) {
    rev[i] = j;
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
  }
  const cos = new Float32Array(n / 2), sin = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos((-2 * Math.PI * i) / n); sin[i] = Math.sin((-2 * Math.PI * i) / n); }
  return (re, im) => {
    for (let i = 0; i < n; i++) { const r = rev[i]; if (i < r) { let t = re[i]; re[i] = re[r]; re[r] = t; t = im[i]; im[i] = im[r]; im[r] = t; } }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1, step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let k = 0; k < half; k++) {
          const wr = cos[k * step], wi = sin[k * step];
          const a = i + k, b = a + half;
          const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
  };
}

function percentile(arr, p) {
  const s = Float32Array.from(arr).sort();
  return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.floor(p * s.length)))] : 0;
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const hz2bin = (hz) => Math.round((hz * N) / SR);

function median(buf, n) {
  // insertion sort is fastest for the tiny windows used here
  for (let i = 1; i < n; i++) { const v = buf[i]; let j = i - 1; while (j >= 0 && buf[j] > v) { buf[j + 1] = buf[j]; j--; } buf[j + 1] = v; }
  return buf[n >> 1];
}

function smooth(a, w) {
  return movingMean(a, Math.max(1, Math.floor(w / 2)));
}
function movingMean(a, w) {
  const o = new Float32Array(a.length);
  const pre = new Float64Array(a.length + 1);
  for (let i = 0; i < a.length; i++) pre[i + 1] = pre[i] + a[i];
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - w), hi = Math.min(a.length, i + w + 1);
    o[i] = (pre[hi] - pre[lo]) / (hi - lo);
  }
  return o;
}

// ---------------------------------------------------------------- main
export function deepAnalyse(input, inputSr, progress = () => {}) {
  const x = resample(input, inputSr);
  const T = Math.max(1, Math.floor((x.length - N) / HOP) + 1);
  const duration = x.length / SR;

  // 1. STFT magnitude
  progress(0.02, 'stft');
  const S = new Float32Array(T * NB);
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const fft = makeFFT(N);
  const re = new Float32Array(N), im = new Float32Array(N);
  const rmsF = new Float32Array(T);
  for (let t = 0; t < T; t++) {
    const off = t * HOP;
    let e = 0;
    for (let i = 0; i < N; i++) { const v = x[off + i] || 0; re[i] = v * win[i]; im[i] = 0; e += v * v; }
    rmsF[t] = Math.sqrt(e / N);
    fft(re, im);
    const base = t * NB;
    for (let k = 0; k < NB; k++) S[base + k] = Math.hypot(re[k], im[k]);
    if (t % 2000 === 0) progress(0.02 + 0.13 * (t / T), 'stft');
  }

  // 2. HPSS by median filtering
  progress(0.15, 'hpss');
  const LT = 17, LF = 17, ht = LT >> 1, hf = LF >> 1;
  const Hm = new Float32Array(T * NB), Pm = new Float32Array(T * NB);
  const buf = new Float32Array(Math.max(LT, LF));
  const medT = new Float32Array(T * NB);
  for (let k = 0; k < NB; k++) {
    for (let t = 0; t < T; t++) {
      let n = 0;
      for (let j = t - ht; j <= t + ht; j++) if (j >= 0 && j < T) buf[n++] = S[j * NB + k];
      medT[t * NB + k] = median(buf, n);
    }
    if (k % 64 === 0) progress(0.15 + 0.12 * (k / NB), 'hpss');
  }
  for (let t = 0; t < T; t++) {
    const base = t * NB;
    for (let k = 0; k < NB; k++) {
      let n = 0;
      for (let j = k - hf; j <= k + hf; j++) if (j >= 0 && j < NB) buf[n++] = S[base + j];
      const pm = median(buf, n), hmv = medT[base + k];
      const h2 = hmv * hmv, p2 = pm * pm, d = h2 + p2 + 1e-12;
      Hm[base + k] = S[base + k] * (h2 / d);
      Pm[base + k] = S[base + k] * (p2 / d);
    }
    if (t % 2000 === 0) progress(0.27 + 0.12 * (t / T), 'hpss');
  }

  // 3. band energies of the percussive part
  progress(0.4, 'drums');
  const band = (M, lo, hi) => {
    const a = new Float32Array(T), b0 = hz2bin(lo), b1 = Math.min(NB - 1, hz2bin(hi));
    for (let t = 0; t < T; t++) { let s = 0; const base = t * NB; for (let k = b0; k <= b1; k++) s += M[base + k] * M[base + k]; a[t] = s; }
    return a;
  };
  const eLow = band(Pm, 35, 150), eMid = band(Pm, 150, 400), eNoise = band(Pm, 1500, 5000), eAir = band(Pm, 6000, 10800);
  const eAll = band(S, 30, 10800);
  const eAirFull = band(S, 6000, 10800);

  const onsetFn = (e) => {
    const lg = new Float32Array(T);
    for (let t = 0; t < T; t++) lg[t] = Math.log10(1e-10 + e[t]);
    const p20 = percentile(lg, 0.2), p97 = percentile(lg, 0.97);
    const o = new Float32Array(T);
    for (let t = 3; t < T; t++) {
      const prev = (lg[t - 1] + lg[t - 2] + lg[t - 3]) / 3;
      const d = Math.max(0, lg[t] - Math.max(prev, lg[t - 1] - 0.05));
      o[t] = d * clamp((lg[t] - p20) / (p97 - p20 + 1e-9), 0, 1.2);
    }
    const p = percentile(o, 0.995) || 1;
    for (let t = 0; t < T; t++) o[t] = Math.min(1.5, o[t] / p);
    return o;
  };
  const oLow = onsetFn(eLow), oMid = onsetFn(eMid), oNoise = onsetFn(eNoise), oAir = onsetFn(eAir), oAll = onsetFn(eAll);

  const pick = (o, minGapS, delta, floor) => {
    const mm = movingMean(o, 12);
    let mean = 0; for (let t = 0; t < T; t++) mean += o[t]; mean /= T;
    let sd = 0; for (let t = 0; t < T; t++) sd += (o[t] - mean) ** 2; sd = Math.sqrt(sd / T);
    const gap = Math.round(minGapS * FPS);
    const out = [];
    let last = -1e9;
    for (let t = 2; t < T - 2; t++) {
      const v = o[t];
      if (v < floor || v < mm[t] + delta * sd) continue;
      if (v < o[t - 1] || v < o[t - 2] || v < o[t + 1] || v < o[t + 2]) continue;
      if (t - last < gap) { if (out.length && v > out[out.length - 1].v) { out[out.length - 1] = { t, v }; last = t; } continue; }
      out.push({ t, v }); last = t;
    }
    return out;
  };
  const near = (arr, t, r) => { let best = 0; for (let j = Math.max(0, t - r); j <= Math.min(T - 1, t + r); j++) best = Math.max(best, arr[j]); return best; };

  // kick: low-band hit that dominates the spectrum at that instant
  const kicks = [];
  const lowCands = pick(oLow, 0.09, 0.9, 0.12);
  const lowAt = (t) => Math.max(eLow[t], eLow[t + 1] || 0, eLow[t + 2] || 0, eLow[t + 3] || 0);
  const strongLow = lowCands.filter((c) => c.v > 0.5).map((c) => lowAt(c.t));
  const lowRef = strongLow.length ? percentile(strongLow, 0.5) : percentile(eLow, 0.99);
  for (const c of lowCands) {
    const t = c.t;
    const lowE = lowAt(t);
    const tot = lowE + eMid[t + 2] + eNoise[t + 2] + eAir[t + 2] + 1e-12;
    // a real kick carries a lot of sub energy compared with other kicks; snare bleed does not
    if (lowE >= 0.18 * lowRef && lowE / tot > 0.2) kicks.push({ t: ft(t), s: clamp(c.v, 0.1, 1.3), f: t });
  }
  // snare / clap: noisy 1.5-5k burst with body (or clap) and not just air
  const snares = [];
  const noiseCands = pick(oNoise, 0.09, 0.9, 0.15);
  const noiseAt = (t) => Math.max(eNoise[t], eNoise[t + 1] || 0, eNoise[t + 2] || 0, eNoise[t + 3] || 0);
  const strongNoise = noiseCands.filter((c) => c.v > 0.5).map((c) => noiseAt(c.t));
  const noiseRef = strongNoise.length ? percentile(strongNoise, 0.75) : percentile(eNoise, 0.99);
  for (const c of noiseCands) {
    const t = c.t;
    const body = near(oMid, t, 2), air = near(oAir, t, 1);
    const tot = eLow[t] + eMid[t] + eNoise[t] + eAir[t] + 1e-12;
    const noiseShare = (eNoise[t] + eMid[t]) / tot;
    const tt = Math.min(T - 1, t + 2);
    // snares and claps keep most of their noise below 5 kHz, hats live above 6 kHz
    const belowAir = (eNoise[tt] + eMid[tt]) / (eAir[tt] + 1e-12);
    // a kick's beater click has a sharp onset too, but almost no noise energy next to its sub
    const loud = noiseAt(t) >= 0.08 * noiseRef && noiseAt(t) / (lowAt(t) + 1e-12) > 0.03;
    if ((body > 0.18 || noiseShare > 0.35) && belowAir > 0.6 && loud) snares.push({ t: ft(t), s: clamp(c.v, 0.1, 1.3), f: t });
  }
  // hats: energy mostly above 6 kHz; open if the air band rings > 120 ms
  const hats = [], ohats = [];
  const snareFrames = new Set(snares.map((s) => s.f));
  for (const c of pick(oAir, 0.05, 0.6, 0.1)) {
    const t = c.t;
    let isSnare = false;
    for (let j = t - 2; j <= t + 2; j++) if (snareFrames.has(j)) isSnare = true;
    const tt = Math.min(T - 1, t + 2);
    const airShare = eAir[tt] / (eNoise[tt] + 1e-12);
    if (isSnare && airShare < 2.5) continue;
    if (!isSnare && airShare < 0.4) continue;
    // the ringing tail of an open hat is sustained noise, so measure it on the full spectrum
    const peak = Math.max(eAirFull[t], eAirFull[t + 1] || 0, eAirFull[t + 2] || 0);
    let d = 2;
    while (t + d < T && d < FPS && eAirFull[t + d] > 0.25 * peak) d++;
    const ev = { t: ft(t), s: clamp(c.v, 0.1, 1.3), f: t };
    (d / FPS > 0.12 ? ohats : hats).push(ev);
  }

  // bass (808 / bass line): sustained low notes live in the harmonic part
  const eBassH = band(Hm, 40, 250);
  const oBass = onsetFn(eBassH);
  const bassNotes = [];
  {
    const cands = pick(oBass, 0.1, 0.8, 0.15);
    const ref = percentile(eBassH, 0.97) || 1;
    for (const c of cands) {
      const e = Math.max(eBassH[c.t], eBassH[c.t + 2] || 0, eBassH[c.t + 4] || 0);
      if (e > 0.12 * ref) bassNotes.push({ t: ft(c.t), s: clamp(c.v, 0.1, 1.3) });
    }
  }
  const bassEnv = new Float32Array(T);
  {
    const p97 = percentile(eBassH, 0.97) || 1;
    for (let t = 0; t < T; t++) bassEnv[t] = clamp(Math.sqrt(eBassH[t] / p97), 0, 1.3);
  }

  // 4. tempo + beat tracking
  progress(0.5, 'beats');
  const odf = new Float32Array(T);
  for (let t = 0; t < T; t++) odf[t] = 0.4 * oLow[t] + 0.3 * oNoise[t] + 0.15 * oAir[t] + 0.35 * oAll[t];
  const minLag = Math.round((60 / 200) * FPS), maxLag = Math.round((60 / 60) * FPS);
  const ac = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let t = lag; t < T; t++) s += odf[t] * odf[t - lag];
    ac[lag] = s / (T - lag);
  }
  let bestLag = minLag, bestScore = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * FPS) / lag;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    // reward lags whose double also correlates (metrical consistency)
    const dbl = 2 * lag <= maxLag ? ac[2 * lag] : 0;
    const sc = (ac[lag] + 0.5 * dbl) * prior;
    if (sc > bestScore) { bestScore = sc; bestLag = lag; }
  }
  // parabolic refinement
  const a0 = ac[bestLag - 1] || 0, a1 = ac[bestLag], a2 = ac[bestLag + 1] || 0;
  const refine = (a0 - a2) / (2 * (a0 - 2 * a1 + a2) || 1);
  const period = bestLag + clamp(refine, -0.5, 0.5);
  const bpm = Math.round(((60 * FPS) / period) * 10) / 10;

  // DP beat tracker
  const score = new Float32Array(T), back = new Int32Array(T).fill(-1);
  const alpha = 100;
  for (let t = 0; t < T; t++) {
    let best = 0, arg = -1;
    const lo = Math.max(0, Math.floor(t - 2 * period)), hi = Math.floor(t - period / 2);
    for (let p = lo; p <= hi; p++) {
      const pen = -alpha * Math.log((t - p) / period) ** 2;
      const v = score[p] + pen;
      if (v > best) { best = v; arg = p; }
    }
    score[t] = odf[t] + best;
    back[t] = arg;
  }
  let tEnd = T - 1, mx = -1;
  for (let t = Math.max(0, T - Math.round(period * 2)); t < T; t++) if (score[t] > mx) { mx = score[t]; tEnd = t; }
  const beatFrames = [];
  for (let t = tEnd; t >= 0; t = back[t]) { beatFrames.push(t); if (back[t] < 0) break; }
  beatFrames.reverse();
  const beats = beatFrames.map((f) => ft(f));

  // downbeat phase: kick on 1, snare on 2 and 4
  const evNear = (list, t, r = 0.07) => { let s = 0; for (const e of list) if (Math.abs(e.t - t) < r) s = Math.max(s, e.s); return s; };
  const kickAt = beats.map((b) => evNear(kicks, b)), snareAt = beats.map((b) => evNear(snares, b));
  let phase = 0, phaseScore = -1e9;
  for (let ph = 0; ph < 4; ph++) {
    let sc = 0;
    for (let i = 0; i < beats.length; i++) {
      const pos = (i - ph + 400) % 4;
      if (pos === 0) sc += kickAt[i] * 1.5 - snareAt[i] * 0.7;
      if (pos === 1 || pos === 3) sc += snareAt[i] * 1.2;
      if (pos === 2) sc += kickAt[i] * 0.4;
    }
    if (sc > phaseScore) { phaseScore = sc; phase = ph; }
  }
  const downbeats = beats.filter((_, i) => (i - phase + 400) % 4 === 0);

  // 5. vocal activity from the harmonic part
  progress(0.6, 'vocal');
  const f0s = [];
  for (let m = 45; m <= 81; m++) f0s.push(440 * 2 ** ((m - 69) / 12)); // A2..A5
  const vConf = new Float32Array(T), vPitch = new Float32Array(T), vForm = new Float32Array(T), hEnergy = new Float32Array(T);
  const bLo = hz2bin(80), bF0 = hz2bin(1000), bF1 = hz2bin(4000), bHi = hz2bin(5000);
  for (let t = 0; t < T; t++) {
    const base = t * NB;
    let tot = 0, form = 0;
    for (let k = bLo; k <= bHi; k++) { const v = Hm[base + k]; tot += v; if (k >= bF0 && k <= bF1) form += v; }
    hEnergy[t] = tot;
    if (tot < 1e-6) continue;
    let best = 0, bestF = 0;
    for (const f0 of f0s) {
      let s = 0;
      for (let h = 1; h <= 8; h++) {
        const pos = (h * f0 * N) / SR;
        const k0 = Math.floor(pos);
        if (k0 + 1 >= NB) break;
        const fr = pos - k0;
        s += (Hm[base + k0] * (1 - fr) + Hm[base + k0 + 1] * fr) * 0.86 ** (h - 1);
      }
      if (s > best) { best = s; bestF = f0; }
    }
    vConf[t] = best / tot;
    vPitch[t] = bestF;
    vForm[t] = form / tot;
    if (t % 3000 === 0) progress(0.6 + 0.1 * (t / T), 'vocal');
  }
  // pitch movement (cents std in ~0.25 s): voices glide and wobble, synth pads sit still
  const vScore = new Float32Array(T);
  const hP20 = percentile(hEnergy, 0.25), hP95 = percentile(hEnergy, 0.95);
  const cP = percentile(vConf, 0.95) || 1;
  const W = Math.round(0.12 * FPS);
  for (let t = 0; t < T; t++) {
    let s = 0, s2 = 0, n = 0;
    for (let j = Math.max(0, t - W); j <= Math.min(T - 1, t + W); j++) {
      if (!vPitch[j]) continue;
      const c = 1200 * Math.log2(vPitch[j] / 440);
      s += c; s2 += c * c; n++;
    }
    const sd = n > 2 ? Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2)) : 0;
    const motion = sd > 8 && sd < 300 ? 1 : sd <= 8 ? 0.45 : 0.6;
    const loud = clamp((hEnergy[t] - hP20) / (hP95 - hP20 + 1e-9), 0, 1);
    vScore[t] = clamp(vConf[t] / cP, 0, 1.2) * (0.55 + vForm[t]) * motion * loud;
  }
  const vS = smooth(vScore, Math.round(0.2 * FPS));
  // adaptive threshold: a fraction of the clearly-voiced level of this song
  const vThrOn = Math.max(0.12, 0.55 * percentile(vS, 0.97)), vThrOff = vThrOn * 0.7;
  const vocals = [];
  let on = false, st = 0;
  for (let t = 0; t < T; t++) {
    if (!on && vS[t] > vThrOn) { on = true; st = t; }
    else if (on && vS[t] < vThrOff) { on = false; vocals.push([st, t]); }
  }
  if (on) vocals.push([st, T - 1]);
  const vocalSegs = [];
  for (const [a, b] of vocals) {
    const last = vocalSegs[vocalSegs.length - 1];
    if (last && a / FPS - last.t1 < 0.5) last.t1 = b / FPS;
    else vocalSegs.push({ t0: a / FPS, t1: b / FPS });
  }
  const vocalFinal = vocalSegs.filter((v) => v.t1 - v.t0 >= 0.3).map((v) => {
    let c = 0, n = 0;
    for (let t = Math.floor(v.t0 * FPS); t <= Math.floor(v.t1 * FPS); t++) { c += vS[t]; n++; }
    return { ...v, conf: clamp(c / Math.max(1, n), 0, 1) };
  });

  // 6. SFX
  progress(0.72, 'sfx');
  const cent = new Float32Array(T), flat = new Float32Array(T);
  for (let t = 0; t < T; t++) {
    const base = t * NB;
    let s = 0, w = 0, lg = 0, ar = 0, n = 0;
    for (let k = 4; k < NB - 1; k++) {
      const v = (k > 14 ? Hm[base + k] : 0) + 1e-9;
      s += v * Math.log2((k * SR) / N); w += v;
      if (k > hz2bin(500)) { lg += Math.log(v); ar += v; n++; }
    }
    cent[t] = s / w;
    flat[t] = Math.exp(lg / n) / (ar / n);
  }
  const centS = smooth(cent, Math.round(0.25 * FPS));
  const eHi = new Float32Array(T); for (let t = 0; t < T; t++) eHi[t] = Math.log10(1e-10 + band1(Hm, t, 1500, 10800));
  function band1(M, t, lo, hi) { let s = 0; const base = t * NB; for (let k = hz2bin(lo); k <= Math.min(NB - 1, hz2bin(hi)); k++) s += M[base + k] * M[base + k]; return s; }
  const RW = Math.round(1.5 * FPS);
  const slope = new Float32Array(T), r2 = new Float32Array(T), hiSlope = new Float32Array(T);
  for (let t = RW; t < T; t++) {
    let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0, sh = 0, sxh = 0;
    for (let j = 0; j < RW; j++) {
      const xx = j / FPS, yy = centS[t - RW + j], hh = eHi[t - RW + j];
      sx += xx; sy += yy; sxx += xx * xx; sxy += xx * yy; syy += yy * yy; sh += hh; sxh += xx * hh;
    }
    const d = RW * sxx - sx * sx;
    const b = (RW * sxy - sx * sy) / d;
    const bh = (RW * sxh - sx * sh) / d;
    const vy = RW * syy - sy * sy;
    slope[t] = b; hiSlope[t] = bh;
    r2[t] = vy > 0 ? ((RW * sxy - sx * sy) ** 2) / (d * vy) : 0;
  }
  const runs = (cond, minLen) => {
    const out = []; let s0 = -1;
    for (let t = 0; t <= T; t++) {
      const c = t < T && cond(t);
      if (c && s0 < 0) s0 = t;
      if (!c && s0 >= 0) { if ((t - s0) / FPS >= minLen) out.push([s0, t]); s0 = -1; }
    }
    return out;
  };
  const sfx = [];
  for (const [a, b] of runs((t) => slope[t] > 0.32 && r2[t] > 0.6 && hiSlope[t] > -0.05, 0.6))
    sfx.push({ type: 'riser', t0: Math.max(0, a - RW) / FPS, t1: b / FPS });
  for (const [a, b] of runs((t) => slope[t] < -0.32 && r2[t] > 0.6, 0.6))
    sfx.push({ type: 'downlifter', t0: Math.max(0, a - RW) / FPS, t1: b / FPS });
  const fS = smooth(flat, Math.round(0.3 * FPS));
  const flatThr = Math.max(0.35, percentile(fS, 0.97));
  const eAll30 = percentile(eAll, 0.3);
  for (const [a, b] of runs((t) => fS[t] > flatThr && eAll[t] > eAll30, 0.5))
    sfx.push({ type: 'noise', t0: a / FPS, t1: b / FPS });
  const allP99 = percentile(oAll, 0.993);
  for (const c of pick(oAll, 1.0, 1.5, Math.max(0.5, allP99))) {
    const t = c.t;
    const broad = [oLow, oMid, oNoise, oAir].filter((o) => near(o, t, 2) > 0.35).length;
    const tail = eAll[Math.min(T - 1, t + Math.round(0.35 * FPS))] / (eAll[t] + 1e-12);
    if (broad >= 3 && tail > 0.35) sfx.push({ type: 'impact', t0: t / FPS, t1: t / FPS + 0.6 });
  }
  // the tail of a riser falls back down: that is not a separate downlifter
  for (let i = sfx.length - 1; i >= 0; i--) {
    const d = sfx[i];
    if (d.type === 'downlifter' && sfx.some((r) => r.type === 'riser' && d.t0 >= r.t0 && d.t0 <= r.t1 + 1.0)) sfx.splice(i, 1);
  }
  sfx.sort((a, b) => a.t0 - b.t0);

  // 7. chroma + key
  progress(0.8, 'key');
  const chromaF = new Float32Array(T * 12);
  const pcOfBin = new Int8Array(NB).fill(-1);
  for (let k = hz2bin(80); k <= hz2bin(4000); k++) pcOfBin[k] = ((Math.round(12 * Math.log2(((k * SR) / N) / 440) + 69) % 12) + 12) % 12;
  const chromaSum = new Float64Array(12);
  for (let t = 0; t < T; t++) {
    const base = t * NB;
    for (let k = 0; k < NB; k++) { const pc = pcOfBin[k]; if (pc >= 0) chromaF[t * 12 + pc] += Hm[base + k]; }
    for (let c = 0; c < 12; c++) chromaSum[c] += chromaF[t * 12 + c];
  }
  const MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const MIN = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  const corr = (a, b) => { const ma = a.reduce((x, y) => x + y) / 12, mb = b.reduce((x, y) => x + y) / 12; let n = 0, da = 0, db = 0; for (let i = 0; i < 12; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; } return n / Math.sqrt(da * db + 1e-12); };
  const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  let key = { name: 'C', mode: 'major', conf: 0 };
  const cs = Array.from(chromaSum);
  for (let r = 0; r < 12; r++) {
    const rot = cs.slice(r).concat(cs.slice(0, r));
    const a = corr(rot, MAJ), b = corr(rot, MIN);
    if (a > key.conf) key = { name: NAMES[r], mode: 'major', conf: a };
    if (b > key.conf) key = { name: NAMES[r], mode: 'minor', conf: b };
  }

  // 8. structure
  progress(0.86, 'structure');
  let grid = downbeats.length >= 8 ? downbeats.slice() : [];
  if (!grid.length) { for (let t = 0; t < duration; t += 2) grid.push(t); }
  if (grid[0] > 0.5) grid.unshift(0);
  grid.push(duration);
  const nBars = grid.length - 1;
  const countIn = (list, a, b) => list.reduce((s, e) => s + (e.t >= a && e.t < b ? 1 : 0), 0);
  const vocalIn = (a, b) => vocalFinal.reduce((s, v) => s + Math.max(0, Math.min(b, v.t1) - Math.max(a, v.t0)), 0) / Math.max(0.01, b - a);
  const feats = [], barE = [], barD = [], barV = [];
  for (let i = 0; i < nBars; i++) {
    const a = grid[i], b = grid[i + 1];
    const f0 = Math.floor(a * FPS), f1 = Math.max(f0 + 1, Math.min(T, Math.floor(b * FPS)));
    const ch = new Float32Array(12);
    let e = 0, lo = 0, mi = 0, no = 0, ai = 0;
    for (let t = f0; t < f1; t++) {
      for (let c = 0; c < 12; c++) ch[c] += chromaF[t * 12 + c];
      e += rmsF[t]; lo += eLow[t]; mi += eMid[t]; no += eNoise[t]; ai += eAir[t];
    }
    const n = f1 - f0;
    const chN = Math.hypot(...ch) || 1;
    const k = countIn(kicks, a, b), sn = countIn(snares, a, b), hh = countIn(hats, a, b) + countIn(ohats, a, b);
    const v = vocalIn(a, b);
    feats.push([...Array.from(ch, (c) => c / chN), Math.log10(1e-9 + lo / n), Math.log10(1e-9 + mi / n), Math.log10(1e-9 + no / n), Math.log10(1e-9 + ai / n), k, sn, hh, v * 4, e / n]);
    barE.push(e / n); barD.push(k + sn); barV.push(v);
  }
  const D = feats[0]?.length || 0;
  const W8 = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.5, 1.5, 1.5, 1.5, 1.5, 1.5, 1.2, 1.5, 2];
  for (let d = 0; d < D; d++) {
    let m = 0; for (const f of feats) m += f[d]; m /= feats.length;
    let sd = 0; for (const f of feats) sd += (f[d] - m) ** 2; sd = Math.sqrt(sd / feats.length) || 1;
    for (const f of feats) f[d] = ((f[d] - m) / sd) * (W8[d] || 1);
  }
  const cos = (a, b) => { let n = 0, x = 0, y = 0; for (let d = 0; d < D; d++) { n += a[d] * b[d]; x += a[d] * a[d]; y += b[d] * b[d]; } return n / Math.sqrt(x * y + 1e-12); };
  const K = 4;
  const nov = new Float32Array(nBars);
  for (let i = 1; i < nBars; i++) {
    let s = 0;
    for (let a = -K; a < K; a++) for (let b = -K; b < K; b++) {
      const ia = i + a, ib = i + b;
      if (ia < 0 || ib < 0 || ia >= nBars || ib >= nBars) continue;
      const sign = (a < 0) === (b < 0) ? 1 : -1;
      const g = Math.exp(-((a + 0.5) ** 2 + (b + 0.5) ** 2) / (2 * (K / 2) ** 2));
      s += sign * g * cos(feats[ia], feats[ib]);
    }
    nov[i] = Math.max(0, s);
  }
  const nm = nov.reduce((a, b) => a + b, 0) / nBars;
  const nsd = Math.sqrt(nov.reduce((a, b) => a + (b - nm) ** 2, 0) / nBars);
  let bounds = [0];
  for (let i = 2; i < nBars - 1; i++) {
    if (nov[i] >= nov[i - 1] && nov[i] >= nov[i + 1] && nov[i] > nm + 0.4 * nsd) bounds.push(i);
  }
  // snap to the 4-bar phrase grid when close
  bounds = bounds.map((b) => { const s = Math.round(b / 4) * 4; return Math.abs(s - b) <= 1 && s < nBars ? s : b; });
  bounds = [...new Set(bounds)].sort((a, b) => a - b);
  // minimum 4 bars per section
  const merged = [0];
  for (const b of bounds.slice(1)) if (b - merged[merged.length - 1] >= 4) merged.push(b);
  if (nBars - merged[merged.length - 1] < 4 && merged.length > 1) merged.pop();
  merged.push(nBars);

  const segs = [];
  for (let i = 0; i < merged.length - 1; i++) {
    const a = merged[i], b = merged[i + 1];
    const mean = new Array(D).fill(0);
    let E = 0, Dd = 0, V = 0;
    for (let j = a; j < b; j++) { for (let d = 0; d < D; d++) mean[d] += feats[j][d] / (b - a); E += barE[j]; Dd += barD[j]; V += barV[j]; }
    const t0 = grid[a], t1 = grid[b];
    const rise = b - a >= 2 ? barE[b - 1] / (barE[a] + 1e-9) : 1;
    const half = Math.floor((a + b) / 2);
    const snFirst = countIn(snares, grid[a], grid[half]), snLast = countIn(snares, grid[half], t1);
    segs.push({ t0, t1, bars: b - a, feat: mean, E: E / (b - a), D: Dd / (b - a), V: V / (b - a), rise, snRoll: snLast > Math.max(3, snFirst * 1.6), riser: sfx.some((s) => s.type === 'riser' && s.t1 > t0 && s.t0 < t1) });
  }
  // cluster -> letters
  let letter = 0;
  for (let i = 0; i < segs.length; i++) {
    if (segs[i].group !== undefined) continue;
    segs[i].group = letter;
    for (let j = i + 1; j < segs.length; j++) if (segs[j].group === undefined && cos(segs[i].feat, segs[j].feat) > 0.82) segs[j].group = letter;
    letter++;
  }
  // roles
  const Es = segs.map((s) => s.E).sort((a, b) => a - b);
  const eMed = Es[Math.floor(Es.length / 2)] || 0, eHiThr = Es[Math.floor(Es.length * 0.7)] || 0;
  const maxD = Math.max(1e-9, ...segs.map((s) => s.D));
  segs.forEach((s, i) => {
    let kind = s.V > 0.3 ? 'verse' : 'section';
    if (s.E >= eHiThr && s.D > 0.55 * maxD) kind = s.V > 0.35 ? 'chorus' : 'drop';
    else if (s.D < 0.3 * maxD && i > 0 && i < segs.length - 1) kind = 'breakdown';
    if (i === 0 && s.E <= eMed) kind = 'intro';
    if (i === segs.length - 1 && segs.length > 2 && s.E <= eMed) kind = 'outro';
    s.kind = kind;
  });
  segs.forEach((s, i) => {
    const next = segs[i + 1];
    if (next && (next.kind === 'drop' || next.kind === 'chorus') && s.kind !== 'drop' && s.kind !== 'chorus' && s.kind !== 'intro' && (s.riser || s.snRoll || s.rise > 1.4)) s.kind = 'build';
  });
  const sections = segs.map((s) => ({
    t0: s.t0, t1: s.t1, bars: s.bars, kind: s.kind, letter: String.fromCharCode(65 + Math.min(25, s.group)),
    energy: s.E, drums: s.D, vocal: s.V,
  }));
  const eMax = Math.max(1e-9, ...sections.map((s) => s.energy));
  sections.forEach((s) => { s.energy = s.energy / eMax; });

  // 9. curves at 60 fps
  progress(0.95, 'curves');
  const n60 = Math.ceil(duration * OUT_FPS) + 1;
  const pulse = (list, decay) => {
    const c = new Float32Array(n60);
    for (const e of list) {
      const f0 = Math.round(e.t * OUT_FPS), len = Math.ceil(decay * 5 * OUT_FPS);
      for (let j = 0; j < len && f0 + j < n60; j++) c[f0 + j] = Math.max(c[f0 + j], e.s * Math.exp(-(j / OUT_FPS) / decay));
    }
    return c;
  };
  const curves = {
    kick: pulse(kicks, 0.11), snare: pulse(snares, 0.13), hat: pulse(hats, 0.045), ohat: pulse(ohats, 0.22),
    vocal: new Float32Array(n60), sfx: new Float32Array(n60), bass: new Float32Array(n60),
  };
  for (let i = 0; i < n60; i++) curves.bass[i] = bassEnv[Math.min(T - 1, Math.max(0, Math.floor((i / OUT_FPS - LAG) * FPS)))];
  for (let i = 0; i < n60; i++) {
    const t = Math.min(T - 1, Math.floor((i / OUT_FPS) * FPS));
    let inV = 0;
    for (const v of vocalFinal) if (i / OUT_FPS >= v.t0 && i / OUT_FPS <= v.t1) { inV = 1; break; }
    curves.vocal[i] = inV * clamp(vS[t] / (vThrOn * 1.6), 0.25, 1);
  }
  for (const s of sfx) {
    const f0 = Math.floor(s.t0 * OUT_FPS), f1 = Math.min(n60 - 1, Math.ceil(s.t1 * OUT_FPS));
    for (let i = f0; i <= f1; i++) {
      const k = (i - f0) / Math.max(1, f1 - f0);
      const v = s.type === 'riser' ? k : s.type === 'downlifter' ? 1 - k : s.type === 'impact' ? Math.exp(-k * 4) : 0.5;
      curves.sfx[i] = Math.max(curves.sfx[i], v);
    }
  }

  progress(1, 'done');
  const strip = (l) => l.map(({ t, s }) => ({ t, s }));
  return {
    version: 1, duration, bpm, key, beats, downbeats,
    events: { kick: strip(kicks), snare: strip(snares), hat: strip(hats), ohat: strip(ohats), bass: bassNotes },
    vocals: vocalFinal, sfx, sections, curves, curveFps: OUT_FPS,
  };
}
