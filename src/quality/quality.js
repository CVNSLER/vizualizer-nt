import { STAGES } from './stages.js';
// "Algoritm 1": listens to a mix, finds technical problems and fixes the ones that can be fixed.
//
// Measures: integrated loudness + loudness range (ITU-R BS.1770-4 / EBU R128), sample and
// true peak (4x oversampled), clipping runs, DC offset, crest factor, stereo correlation
// (full band and below 150 Hz), side level, octave-band spectral balance against a
// modern-mix reference, sub rumble, noise floor, sibilance in vocal passages,
// leading / trailing silence.
//
// Fixes (all deterministic DSP): DC + rumble high-pass, corrective EQ, mono low end,
// de-esser, gentle glue compression when dynamics are very wide, loudness normalisation
// and a look-ahead true-peak limiter.

const db = (x) => 20 * Math.log10(Math.max(1e-12, x));
const pdb = (x) => 10 * Math.log10(Math.max(1e-20, x));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------------------------------------------------------------- biquads (RBJ cookbook)
function coeffs(type, fs, f0, q = 0.7071, gainDb = 0) {
  const A = 10 ** (gainDb / 40), w0 = (2 * Math.PI * f0) / fs, c = Math.cos(w0), s = Math.sin(w0), al = s / (2 * q);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
  else if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
  else if (type === 'ap') { b0 = 1 - al; b1 = -2 * c; b2 = 1 + al; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
  else if (type === 'bp') { b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
  else if (type === 'peak') { b0 = 1 + al * A; b1 = -2 * c; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * c; a2 = 1 - al / A; }
  else if (type === 'hshelf') {
    const sq = 2 * Math.sqrt(A) * al;
    b0 = A * ((A + 1) + (A - 1) * c + sq); b1 = -2 * A * ((A - 1) + (A + 1) * c); b2 = A * ((A + 1) + (A - 1) * c - sq);
    a0 = (A + 1) - (A - 1) * c + sq; a1 = 2 * ((A - 1) - (A + 1) * c); a2 = (A + 1) - (A - 1) * c - sq;
  } else if (type === 'lshelf') {
    const sq = 2 * Math.sqrt(A) * al;
    b0 = A * ((A + 1) - (A - 1) * c + sq); b1 = 2 * A * ((A - 1) - (A + 1) * c); b2 = A * ((A + 1) - (A - 1) * c - sq);
    a0 = (A + 1) + (A - 1) * c + sq; a1 = -2 * ((A - 1) + (A + 1) * c); a2 = (A + 1) + (A - 1) * c - sq;
  }
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}
function filt(x, k) {
  const [b0, b1, b2, a1, a2] = k;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

// ---------------------------------------------------------------- loudness (BS.1770-4)
function kWeight(x, fs) {
  // stage 1: +4 dB high shelf at 1681.97 Hz; stage 2: high-pass at 38.135 Hz
  return filt(filt(x, coeffs('hshelf', fs, 1681.974450955533, 0.7071752369554196, 3.999843853973347)), coeffs('hp', fs, 38.13547087602444, 0.5003270373238773));
}
function loudness(chs, fs) {
  const kw = chs.map((c) => kWeight(c, fs));
  const n = kw[0].length;
  const blk = (len, step) => {
    const out = [];
    for (let s = 0; s + len <= n; s += step) {
      let z = 0;
      for (const c of kw) { let a = 0; for (let i = s; i < s + len; i++) a += c[i] * c[i]; z += a / len; }
      out.push(z);
    }
    return out;
  };
  const toL = (z) => -0.691 + pdb(z);
  // integrated
  const b4 = blk(Math.round(0.4 * fs), Math.round(0.1 * fs));
  const abs = b4.filter((z) => toL(z) > -70);
  let I = -70;
  if (abs.length) {
    const rel = toL(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
    const g = abs.filter((z) => toL(z) > rel);
    if (g.length) I = toL(g.reduce((a, b) => a + b, 0) / g.length);
  }
  // loudness range from 3 s short-term blocks
  const st = blk(Math.round(3 * fs), Math.round(1 * fs)).filter((z) => toL(z) > -70);
  let LRA = 0;
  if (st.length > 2) {
    const rel = toL(st.reduce((a, b) => a + b, 0) / st.length) - 20;
    const L = st.filter((z) => toL(z) > rel).map(toL).sort((a, b) => a - b);
    if (L.length > 2) LRA = L[Math.floor(L.length * 0.95) - 1] - L[Math.floor(L.length * 0.1)];
  }
  return { I, LRA };
}

// 4x oversampled true peak, only around loud samples
const OS_TAPS = (() => {
  // value between samples i and i+1 at fraction p/4: sum x[i+o] * sinc(p/4 - o), windowed
  const L = 16, rows = [];
  for (let p = 0; p < 4; p++) {
    const row = [];
    for (let k = 0; k < L; k++) {
      const o = k - L / 2, x = p / 4 - o;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const w = 0.5 + 0.5 * Math.cos((Math.PI * x) / (L / 2 + 1));
      row.push(sinc * w);
    }
    rows.push(row);
  }
  return rows;
})();
function truePeak(c) {
  let sp = 0;
  for (let i = 0; i < c.length; i++) { const a = Math.abs(c[i]); if (a > sp) sp = a; }
  const thr = sp * 0.7;
  let tp = sp;
  const L = OS_TAPS[0].length;
  for (let i = L; i < c.length - L; i++) {
    if (Math.abs(c[i]) < thr) continue;
    for (let p = 1; p < 4; p++) {
      let v = 0;
      const row = OS_TAPS[p];
      for (let k = 0; k < L; k++) v += row[k] * c[i - (L >> 1) + k];
      if (Math.abs(v) > tp) tp = Math.abs(v);
    }
  }
  return { samplePeak: sp, truePeak: tp };
}

// ---------------------------------------------------------------- spectrum
const BANDS = [
  { id: 'sub', lo: 20, hi: 60, f: 40, ref: 3 },
  { id: 'bass', lo: 60, hi: 250, f: 120, ref: 4 },
  { id: 'lowmid', lo: 250, hi: 500, f: 350, ref: 0 },
  { id: 'mid', lo: 500, hi: 2000, f: 1000, ref: 0 },
  { id: 'himid', lo: 2000, hi: 5000, f: 3200, ref: -3 },
  { id: 'presence', lo: 5000, hi: 10000, f: 7000, ref: -7 },
  { id: 'air', lo: 10000, hi: 20000, f: 14000, ref: -12 },
];
function fftMag(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (-2 * Math.PI) / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const p = i + k, q = p + len / 2;
        const tr = re[q] * cr - im[q] * ci, ti = re[q] * ci + im[q] * cr;
        re[q] = re[p] - tr; im[q] = im[p] - ti; re[p] += tr; im[p] += ti;
        const nc = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nc;
      }
    }
  }
}
// octave-band centres and a reference "modern commercial mix" long-term balance (dB vs 1 kHz)
const OCT = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const OCT_REF = [2, 5, 4.5, 1.5, 0, 0, -2, -4.5, -8, -14];
const OCT_W = [0.4, 0.8, 1, 1, 1, 1, 1, 1, 0.8, 0.4];
function tonal(oct) {
  // deviation from the reference after removing the overall level (fit on 250 Hz - 4 kHz)
  const dev = oct.map((v, i) => v - OCT_REF[i]);
  const off = (dev[3] + dev[4] + dev[5] + dev[6] + dev[7]) / 5;
  const d = dev.map((v) => v - off);
  let e = 0, w = 0;
  d.forEach((v, i) => { e += OCT_W[i] * v * v; w += OCT_W[i]; });
  return { dev: d, error: Math.sqrt(e / w) };
}

function spectrum(mono, fs) {
  const N = 4096, hop = 4096;
  const pw = new Float64Array(N / 2);
  const win = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  let frames = 0;
  const re = new Float32Array(N), im = new Float32Array(N);
  // only frames that actually carry music
  let rmsAll = 0; for (let i = 0; i < mono.length; i += 64) rmsAll += mono[i] * mono[i]; rmsAll = Math.sqrt(rmsAll / (mono.length / 64));
  for (let s = 0; s + N <= mono.length; s += hop) {
    let e = 0;
    for (let i = 0; i < N; i++) { const v = mono[s + i]; re[i] = v * win[i]; im[i] = 0; e += v * v; }
    if (Math.sqrt(e / N) < rmsAll * 0.25) continue;
    fftMag(re, im);
    for (let k = 0; k < N / 2; k++) pw[k] += re[k] * re[k] + im[k] * im[k];
    frames++;
  }
  const bandDb = {};
  for (const b of BANDS) {
    let s = 0, n = 0;
    for (let k = Math.max(1, Math.round((b.lo * N) / fs)); k <= Math.min(N / 2 - 1, Math.round((b.hi * N) / fs)); k++) { s += pw[k]; n++; }
    // energy per octave, so bands of different width compare fairly
    const oct = Math.log2(b.hi / b.lo);
    bandDb[b.id] = pdb(s / Math.max(1, frames) / oct);
  }
  const mid = bandDb.mid;
  const rel = {};
  for (const b of BANDS) rel[b.id] = bandDb[b.id] - mid;
  // 10 octave bands for the tonal-balance match
  const oct = OCT.map((fc) => {
    let s2 = 0, n2 = 0;
    for (let k = Math.max(1, Math.round((fc / Math.SQRT2 * N) / fs)); k <= Math.min(N / 2 - 1, Math.round((fc * Math.SQRT2 * N) / fs)); k++) { s2 += pw[k]; n2++; }
    return pdb(s2 / Math.max(1, frames));
  });
  const o1k = oct[5];
  return { rel, frames, oct: oct.map((v) => v - o1k) };
}


// ---------------------------------------------------------------- clipping: detect + repair
function findClips(c) {
  let pk = 0; for (let i = 0; i < c.length; i++) { const a = Math.abs(c[i]); if (a > pk) pk = a; }
  const lvl = pk * 0.9, runs = [];
  if (pk < 0.05) return runs;
  // digital clipping = 3+ samples with exactly the same value at the ceiling; a smooth sub-bass
  // crest also has near-equal neighbours, so the tolerance is tiny and one pair is not enough
  const tol = pk * 1e-6;
  for (let i = 1; i < c.length; i++) {
    if (Math.abs(c[i]) >= lvl && Math.abs(c[i] - c[i - 1]) <= tol) {
      let j = i; while (j + 1 < c.length && Math.abs(c[j + 1] - c[i]) <= tol) j++;
      if (j - i + 2 >= 3) runs.push([i - 1, j]);
      i = j;
    }
  }
  return runs;
}
// Rebuild flat tops by AR interpolation (Janssen-style): learn a short linear-prediction model
// from the audio around each clipped run, then pick the missing samples that make the
// prediction error smallest, keeping them at least as loud as the clipped value.
function levinson(r, p) {
  const a = new Float64Array(p + 1); a[0] = 1;
  let e = r[0] || 1e-12;
  for (let i = 1; i <= p; i++) {
    let acc = r[i]; for (let j = 1; j < i; j++) acc += a[j] * r[i - j];
    const k = -acc / e;
    const prev = a.slice();
    for (let j = 1; j < i; j++) a[j] = prev[j] + k * prev[i - j];
    a[i] = k; e *= 1 - k * k;
    if (e <= 1e-12) break;
  }
  return a;
}
function solveN(M, v) {
  const n = v.length, A = M.map((r, i) => [...r, v[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-14) return null;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = c + 1; r < n; r++) { const k = A[r][c] / A[c][c]; if (k) for (let q = c; q <= n; q++) A[r][q] -= k * A[c][q]; }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let s2 = A[r][n]; for (let q = r + 1; q < n; q++) s2 -= A[r][q] * x[q]; x[r] = s2 / A[r][r]; }
  return x;
}
function declip(c, maxRun = 32) {
  const y = Float32Array.from(c), runs = findClips(c);
  const P = 24, CTX = 384;
  let repaired = 0;
  for (const [a, b] of runs) {
    const len = b - a + 1;
    if (len > maxRun || a < CTX || b > c.length - CTX - 1) continue;
    const sign = Math.sign(c[a]) || 1, flat = Math.abs(c[a]);
    // AR model from the context (autocorrelation with a Hann window)
    const s0 = a - CTX, s1 = b + CTX, W = s1 - s0 + 1;
    const r = new Float64Array(P + 1);
    for (let k = 0; k <= P; k++) {
      let acc = 0;
      for (let t = s0 + k; t <= s1; t++) {
        const w1 = 0.5 - 0.5 * Math.cos((2 * Math.PI * (t - s0)) / W), w2 = 0.5 - 0.5 * Math.cos((2 * Math.PI * (t - k - s0)) / W);
        acc += y[t] * w1 * y[t - k] * w2;
      }
      r[k] = acc;
    }
    r[0] *= 1.0001; // tiny ridge for stability
    const ar = levinson(r, P);
    // prediction-error rows covering the run: e[t] = sum_k ar[k] x[t-k], t in [a, b+P]
    const cols = len, M = Array.from({ length: cols }, () => new Array(cols).fill(0)), v = new Array(cols).fill(0);
    for (let t = a; t <= b + P; t++) {
      const rowU = new Array(cols).fill(0);
      let known = 0;
      for (let k = 0; k <= P; k++) {
        const idx = t - k;
        if (idx >= a && idx <= b) rowU[idx - a] += ar[k];
        else known += ar[k] * y[idx];
      }
      for (let i2 = 0; i2 < cols; i2++) { if (!rowU[i2]) continue; v[i2] -= rowU[i2] * known; for (let j2 = 0; j2 < cols; j2++) M[i2][j2] += rowU[i2] * rowU[j2]; }
    }
    const sol = solveN(M, v);
    if (!sol) continue;
    for (let i2 = 0; i2 < cols; i2++) y[a + i2] = sign * Math.min(flat * 3, Math.max(flat, sign * sol[i2]));
    repaired++;
  }
  return { y, repaired };
}
function solve4(A, b) {
  const m = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < 4; c++) {
    let p = c; for (let r = c + 1; r < 4; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    if (Math.abs(m[p][c]) < 1e-12) return null;
    [m[c], m[p]] = [m[p], m[c]];
    for (let r = 0; r < 4; r++) if (r !== c) { const k = m[r][c] / m[c][c]; for (let q = c; q < 5; q++) m[r][q] -= k * m[c][q]; }
  }
  return m.map((r, i) => r[4] / r[i]);
}

// ---------------------------------------------------------------- hiss: measure + spectral denoise
const DN = 2048, DH = 512;
const DWIN = new Float32Array(DN).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / DN));
// per-bin noise profile = 10th percentile of magnitude over time (music comes and goes, hiss stays)
function noiseProfile(mono, step = 4) {
  const re = new Float32Array(DN), im = new Float32Array(DN), rows = [];
  for (let s = 0, f = 0; s + DN <= mono.length; s += DH, f++) {
    if (f % step) continue;
    for (let i = 0; i < DN; i++) { re[i] = mono[s + i] * DWIN[i]; im[i] = 0; }
    fftMag(re, im);
    const m = new Float32Array(DN / 2); for (let k = 0; k < DN / 2; k++) m[k] = Math.hypot(re[k], im[k]); rows.push(m);
  }
  const p10 = new Float32Array(DN / 2), p50 = new Float32Array(DN / 2), col = new Float32Array(rows.length);
  for (let k = 0; k < DN / 2; k++) {
    for (let r = 0; r < rows.length; r++) col[r] = rows[r][k];
    col.sort();
    p10[k] = col[Math.floor(rows.length * 0.1)] || 0; p50[k] = col[Math.floor(rows.length * 0.5)] || 0;
  }
  return { p10, p50 };
}
// hiss: the quietest moments above 4 kHz are still close to the typical level, and flat across bins
function hissLevel(mono, fs) {
  const { p10, p50 } = noiseProfile(mono, 6);
  const k0 = Math.round((4000 * DN) / fs), k1 = Math.min(DN / 2 - 1, Math.round((14000 * DN) / fs));
  let r = 0, n = 0;
  for (let k = k0; k <= k1; k++) { r += 20 * Math.log10((p10[k] + 1e-9) / (p50[k] + 1e-9)); n++; }
  const lo = Math.round((5000 * DN) / fs), hi = Math.round((12000 * DN) / fs);
  const tilt = 20 * Math.log10((p10[hi] + 1e-9) / (p10[lo] + 1e-9));
  return { ratioDb: r / n, tiltDb: tilt };
}
function denoise(c, fs, prof) {
  const n = c.length, out = new Float32Array(n), norm = new Float32Array(n);
  const re = new Float32Array(DN), im = new Float32Array(DN);
  const prev = new Float32Array(DN / 2).fill(1);
  const kLo = Math.round((1000 * DN) / fs), kHi = Math.round((2000 * DN) / fs);
  for (let s = 0; s + DN <= n; s += DH) {
    for (let i = 0; i < DN; i++) { re[i] = c[s + i] * DWIN[i]; im[i] = 0; }
    fftMag(re, im);
    for (let k = 0; k <= DN / 2; k++) {
      const kk = Math.min(k, DN / 2 - 1);
      const mag = Math.hypot(re[k], im[k]) + 1e-12;
      // music below ~1 kHz masks hiss; fade the effect in between 1 and 2 kHz
      const w = kk <= kLo ? 0 : kk >= kHi ? 1 : (kk - kLo) / (kHi - kLo);
      // hiss magnitudes are Rayleigh distributed: mean power = 9.49 x (10th percentile)^2
      const np = 9.49 * prof.p10[kk] * prof.p10[kk];
      let g = Math.sqrt(Math.max(0.01, 1 - (1.3 * np) / (mag * mag)));
      g = g < prev[kk] ? g : 0.7 * prev[kk] + 0.3 * g; // slow release avoids "musical noise"
      prev[kk] = g;
      const G = 1 - w * (1 - g);
      re[k] *= G; im[k] *= G;
      if (k > 0 && k < DN / 2) { re[DN - k] *= G; im[DN - k] *= G; }
    }
    // inverse FFT via conjugate trick
    for (let i = 0; i < DN; i++) im[i] = -im[i];
    fftMag(re, im);
    for (let i = 0; i < DN; i++) { out[s + i] += (re[i] / DN) * DWIN[i]; norm[s + i] += DWIN[i] * DWIN[i]; }
  }
  for (let i = 0; i < n; i++) out[i] = norm[i] > 1e-3 ? out[i] / norm[i] : c[i];
  return out;
}

// ---------------------------------------------------------------- 1/3-octave tonal balance
const THIRD = Array.from({ length: 27 }, (_, i) => 1000 * 2 ** ((i - 15) / 3)).filter((f) => f >= 38 && f <= 16500);
function refAt(f) {
  const x = Math.log2(f);
  const xs = OCT.map((o) => Math.log2(o));
  if (x <= xs[0]) return OCT_REF[0];
  if (x >= xs[xs.length - 1]) return OCT_REF[OCT_REF.length - 1];
  let i = 0; while (x > xs[i + 1]) i++;
  const k = (x - xs[i]) / (xs[i + 1] - xs[i]);
  return OCT_REF[i] * (1 - k) + OCT_REF[i + 1] * k;
}
function thirdOctDev(mono, fs) {
  const N = 8192, hop = 8192, win = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  const pw = new Float64Array(N / 2), re = new Float32Array(N), im = new Float32Array(N);
  let rmsAll = 0; for (let i = 0; i < mono.length; i += 64) rmsAll += mono[i] * mono[i]; rmsAll = Math.sqrt(rmsAll / (mono.length / 64));
  for (let s = 0; s + N <= mono.length; s += hop) {
    let e = 0; for (let i = 0; i < N; i++) { const v = mono[s + i]; re[i] = v * win[i]; im[i] = 0; e += v * v; }
    if (Math.sqrt(e / N) < rmsAll * 0.25) continue;
    fftMag(re, im);
    for (let k = 0; k < N / 2; k++) pw[k] += re[k] * re[k] + im[k] * im[k];
  }
  // energy per octave (same scale as the octave reference)
  const lv = THIRD.map((fc) => {
    let s2 = 0;
    for (let k = Math.max(1, Math.round((fc / 2 ** (1 / 6) * N) / fs)); k <= Math.min(N / 2 - 1, Math.round((fc * 2 ** (1 / 6) * N) / fs)); k++) s2 += pw[k];
    return pdb(s2 * 3);
  });
  const i1k = THIRD.findIndex((f) => Math.abs(f - 1000) < 1);
  const dev = lv.map((v, i) => v - lv[i1k] - refAt(THIRD[i]));
  // remove overall level using the 250 Hz - 4 kHz region
  const mid = dev.filter((_, i) => THIRD[i] >= 250 && THIRD[i] <= 4000);
  const off = mid.reduce((a, b) => a + b, 0) / mid.length;
  return dev.map((v) => v - off);
}

// ---------------------------------------------------------------- analysis
export function analyseQuality(chs, fs, vocals = []) {
  const n = chs[0].length;
  const stereo = chs.length > 1;
  const L = chs[0], R = stereo ? chs[1] : chs[0];
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) mono[i] = (L[i] + R[i]) / 2;

  const peaks = chs.map(truePeak);
  const samplePeak = Math.max(...peaks.map((p) => p.samplePeak));
  const tp = Math.max(...peaks.map((p) => p.truePeak));
  // clipping: 3+ consecutive samples at the same near-full-scale value
  // clipping: flat tops (2+ equal samples) at the file's own ceiling, wherever that ceiling is
  let clips = 0;
  for (const c of chs) clips += findClips(c).length;
  let dc = 0; for (let i = 0; i < n; i++) dc += mono[i]; dc /= n;
  let ss = 0; for (let i = 0; i < n; i++) ss += mono[i] * mono[i];
  const rms = Math.sqrt(ss / n);
  const crest = db(samplePeak) - db(rms);
  const { I, LRA } = loudness(chs, fs);

  // stereo
  let corr = 1, corrLow = 1, side = 0;
  if (stereo) {
    const c = (a, b) => { let ab = 0, aa = 0, bb = 0; for (let i = 0; i < a.length; i += 2) { ab += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; } return ab / Math.sqrt(aa * bb + 1e-12); };
    corr = c(L, R);
    const lp = coeffs('lp', fs, 150);
    corrLow = c(filt(L, lp), filt(R, lp));
    let se = 0, me = 0; for (let i = 0; i < n; i += 2) { const m = (L[i] + R[i]) / 2, s = (L[i] - R[i]) / 2; se += s * s; me += m * m; }
    side = pdb(se / (me + 1e-12));
  }

  const spec = spectrum(mono, fs);
  // rumble below 30 Hz
  const k22 = coeffs('lp', fs, 22);
  const lp30 = filt(filt(filt(filt(mono, k22), k22), k22), k22);
  let rum = 0; for (let i = 0; i < n; i += 4) rum += lp30[i] * lp30[i];
  const rumbleDb = pdb(rum / (ss / 4 + 1e-12));

  // noise floor and silences from 50 ms windows
  const W = Math.round(0.05 * fs), win = [];
  for (let s = 0; s + W <= n; s += W) { let e = 0; for (let i = s; i < s + W; i++) e += mono[i] * mono[i]; win.push(db(Math.sqrt(e / W))); }
  let lead = 0; while (lead < win.length && win[lead] < -60) lead++;
  let trail = 0; while (trail < win.length && win[win.length - 1 - trail] < -60) trail++;
  const active = win.slice(lead, win.length - trail).sort((a, b) => a - b);
  const noiseFloor = active.length ? active[Math.floor(active.length * 0.03)] : -90;

  // sibilance: 5-9 kHz bursts inside vocal passages
  let sib = -99;
  if (vocals.length) {
    const bp = filt(filt(mono, coeffs('hp', fs, 5000)), coeffs('lp', fs, 9000));
    // typical (90th percentile) share of 5-9 kHz in vocal passages, not one worst moment,
    // so hats under the vocal do not count as sibilance
    const ratios = [];
    for (const v of vocals) {
      const a = Math.floor(v.t0 * fs), b = Math.min(n, Math.floor(v.t1 * fs));
      for (let s = a; s + 1024 <= b; s += 1024) {
        let e1 = 0, e2 = 0;
        for (let i = s; i < s + 1024; i++) { e1 += bp[i] * bp[i]; e2 += mono[i] * mono[i]; }
        ratios.push(e1 / (e2 + 1e-12));
      }
    }
    if (ratios.length) { ratios.sort((x, y) => x - y); sib = pdb(ratios[Math.floor(ratios.length * 0.9)]); }
  }

  return {
    sampleRate: fs, duration: n / fs, channels: chs.length,
    lufs: I, lra: LRA, samplePeakDb: db(samplePeak), truePeakDb: db(tp), clips, dc, crest,
    corr, corrLow, sideDb: side, spectrum: spec.rel, rumbleDb, noiseFloor, leadSilence: (lead * W) / fs, trailSilence: (trail * W) / fs,
    sibilanceDb: sib,
    tonal: tonal(spec.oct),
    hiss: hissLevel(mono, fs),
  };
}

// ---------------------------------------------------------------- problems -> plan
export function diagnose(m, target = -14) {
  const issues = [];
  const add = (id, level, value, fix) => issues.push({ id, level, value, fix });
  if (m.clips > 20) add('clipping', 'bad', m.clips, 'declip');
  if (m.hiss && m.hiss.ratioDb > -20 && m.hiss.tiltDb > -12) add('hiss', m.hiss.ratioDb > -12 ? 'bad' : 'warn', m.hiss.ratioDb, 'denoise');
  if (m.truePeakDb > -1) add('truePeak', m.truePeakDb > 0 ? 'bad' : 'warn', m.truePeakDb, 'limiter');
  if (m.lufs < target - 3) add('quiet', 'warn', m.lufs, 'loudness');
  if (m.lufs > -7) add('loud', 'warn', m.lufs, 'loudness');
  if (m.crest < 7) add('squashed', m.crest < 5 ? 'bad' : 'warn', m.crest, null);
  if (m.lra > 14) add('wideDynamics', 'warn', m.lra, 'glue');
  if (Math.abs(m.dc) > 0.003) add('dc', 'warn', m.dc, 'highpass');
  if (m.rumbleDb > -30) add('rumble', 'warn', m.rumbleDb, 'highpass');
  if (m.channels > 1) {
    if (m.corr < 0) add('phase', 'bad', m.corr, null);
    if (m.corrLow < 0.6) add('wideBass', 'warn', m.corrLow, 'monoBass');
    if (m.sideDb < -30) add('mono', 'info', m.sideDb, null);
  }
  for (const b of BANDS) {
    const dev = m.spectrum[b.id] - b.ref;
    if (Math.abs(dev) >= 5 && !(b.id === 'air' && dev < 0 && dev > -8))
      add(dev > 0 ? `too_${b.id}` : `lack_${b.id}`, Math.abs(dev) > 8 ? 'bad' : 'warn', dev, 'eq');
  }
  // tonal balance: gentle 10-band match with a 1.5 dB dead zone (keeps the genre's character)
  const td = m.tonal.dev;
  const eq = OCT.map((f, i) => {
    const d = td[i], mag = Math.max(0, Math.abs(d) - 1.5) * 0.6;
    return { f, gain: clamp(-Math.sign(d) * mag, i === 0 || i === 9 ? -3 : -4, 3) };
  }).filter((e) => Math.abs(e.gain) >= 0.3);
  if (m.tonal.error > 3) add('tonal', m.tonal.error > 5 ? 'bad' : 'warn', m.tonal.error, 'eq');
  if (td[3] + td[4] > 5) add('mud', 'warn', (td[3] + td[4]) / 2, 'dynEq');
  if (td[6] + td[7] > 5) add('harsh', 'warn', (td[6] + td[7]) / 2, 'dynEq');
  if (m.crest < 9 && m.crest >= 5) add('weakPunch', 'info', m.crest, 'punch');
  if (m.channels > 1 && m.sideDb < -16 && m.corr > 0.3) add('narrow', 'info', m.sideDb, 'width');
  const dull = td[8] < -2.5 || td[9] < -3.5;
  if (dull) add('dull', 'warn', Math.min(td[8], td[9]), 'exciter');
  if (m.sibilanceDb > -10) add('sibilance', 'warn', m.sibilanceDb, 'deess');
  if (m.leadSilence > 1) add('leadSilence', 'info', m.leadSilence, null);
  if (m.trailSilence > 2) add('trailSilence', 'info', m.trailSilence, null);

  const pen = { bad: 14, warn: 6, info: 1 };
  const score = clamp(Math.round(100 - issues.reduce((s, i) => s + pen[i.level], 0)), 0, 100);
  const plan = {
    target,
    highpass: issues.some((i) => i.fix === 'highpass') ? 30 : 20,
    eq,
    monoBass: m.channels > 1,
    deess: issues.some((i) => i.fix === 'deess'),
    glue: issues.some((i) => i.fix === 'glue'),
    dynEq: true,
    multiband: true,
    punch: m.crest < 10,
    width: m.channels > 1 && m.sideDb < -16 && m.corr > 0.3,
    exciter: dull,
    declip: m.clips > 20,
    denoise: !!(m.hiss && m.hiss.ratioDb > -20 && m.hiss.tiltDb > -12),
    bwe: td[8] < -6 || td[9] < -9,
    exciterAmount: dull ? clamp(-Math.min(td[8], td[9] / 2) / 6, 0.35, 1.6) : 0,
    pseudoStereo: m.channels > 1 && m.sideDb < -24,
  };
  return { issues, score, plan };
}

// ---------------------------------------------------------------- processing (v2)
const lr4 = (x, type, fs, f) => { const k = coeffs(type, fs, f, 0.7071); return filt(filt(x, k), k); };
function envelope(x, fs, attS, relS) {
  const at = Math.exp(-1 / (attS * fs)), rl = Math.exp(-1 / (relS * fs));
  const e = new Float32Array(x.length);
  let v = 0;
  for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); v = a > v ? at * v + (1 - at) * a : rl * v + (1 - rl) * a; e[i] = v; }
  return e;
}
function rmsOf(x) { let s = 0; for (let i = 0; i < x.length; i += 4) s += x[i] * x[i]; return Math.sqrt(s / (x.length / 4)) + 1e-9; }

// amount of one stage: 0 = off, 1 = automatic, up to 2 = stronger. plan.strength scales them all.
const blend = (a, b, k) => { if (k === 1) return b; const y = new Float32Array(a.length); for (let i = 0; i < a.length; i++) y[i] = a[i] + (b[i] - a[i]) * k; return y; };

export function enhance(chs, fs, plan, onProgress = () => {}) {
  let out = chs.map((c) => Float32Array.from(c));
  const stereo = out.length > 1;
  const stages = [];
  const n = out[0].length;
  const strength = clamp(plan.strength ?? 1, 0, 1);
  const A = (id) => (plan.off?.includes(id) ? 0 : clamp(plan.amt?.[id] ?? 1, 0, 2)) * strength;
  const high = plan.level === 'high';
  // where the tonal balance started: with strength < 100 % the loops only go part of the way
  const keep = 1 - Math.min(1, (plan.off?.includes('tonalLoop') ? 0 : clamp(plan.amt?.tonalLoop ?? 1, 0, 1)) * strength);
  let third0 = null, oct0 = null;
  if (keep > 0.001) {
    const mono = new Float32Array(n); for (let i = 0; i < n; i++) { let a = 0; for (const c of out) a += c[i]; mono[i] = a / out.length; }
    third0 = thirdOctDev(mono, fs); oct0 = tonal(spectrum(mono, fs).oct).dev;
  }
  const aim3 = (i) => (third0 ? third0[i] * keep : 0), aimO = (i) => (oct0 ? oct0[i] * keep : 0);

  // 0. repair: rebuild clipped peaks, then remove steady hiss
  if (plan.declip && A('declip') > 0) {
    let rep = 0;
    out = out.map((c) => { const r = declip(c); rep += r.repaired; return blend(c, r.y, Math.min(1, A('declip'))); });
    if (rep) stages.push('declip');
  }
  if (plan.denoise && A('denoise') > 0) {
    const mono0 = new Float32Array(n); for (let i = 0; i < n; i++) { let a = 0; for (const c of out) a += c[i]; mono0[i] = a / out.length; }
    const prof = noiseProfile(mono0, 2);
    out = out.map((c) => blend(c, denoise(c, fs, prof), Math.min(1, A('denoise'))));
    stages.push('denoise');
  }
  onProgress(0.04);

  // 1. DC + rumble: 4th-order high-pass
  if (A('highpass') > 0) {
    out = out.map((c) => lr4(c, 'hp', fs, plan.highpass));
    stages.push('highpass');
  }
  onProgress(0.06);

  // 2. tonal balance: 10-band match to a modern reference
  const aEq = A('tonalEq');
  for (const e of aEq > 0 ? plan.eq : []) {
    const g = e.gain * aEq;
    const k = e.f < 40 ? coeffs('lshelf', fs, 45, 0.7071, g) : e.f > 12000 ? coeffs('hshelf', fs, 12000, 0.7071, g) : coeffs('peak', fs, e.f, 1.0, g);
    out = out.map((c) => filt(c, k));
  }
  if (plan.eq.length && aEq > 0) stages.push('tonalEq');
  onProgress(0.14);

  // 3. dynamic EQ: tame mud (300 Hz) and harshness (3.5 kHz) only when they jump out.
  //    Detection on the mono sum, same gain on both channels (keeps the stereo image).
  if (plan.dynEq && A('dynEq') > 0) {
    const aD = A('dynEq');
    for (const [f, q, maxCut] of [[300, 1.1, 0.45], [3500, 1.3, 0.5]]) {
      const kb = coeffs('bp', fs, f, q);
      const mono = new Float32Array(n); for (let i = 0; i < n; i++) { let a = 0; for (const c of out) a += c[i]; mono[i] = a / out.length; }
      const bm = filt(mono, kb);
      const env = envelope(bm, fs, 0.005, 0.12), full = envelope(mono, fs, 0.005, 0.12);
      const ratios = []; for (let i = 0; i < n; i += 512) ratios.push(env[i] / (full[i] + 1e-9));
      ratios.sort((a2, b2) => a2 - b2);
      const typ = ratios[Math.floor(ratios.length * 0.6)] || 0.2;
      const red = new Float32Array(n);
      for (let i = 0; i < n; i++) { const r = env[i] / (full[i] + 1e-9) / (typ + 1e-9); red[i] = r > 1.4 ? Math.min(Math.min(0.9, maxCut * aD), (r - 1.4) * 0.5 * aD) : 0; }
      out = out.map((c) => { const b = filt(c, kb), y = new Float32Array(n); for (let i = 0; i < n; i++) y[i] = c[i] - b[i] * red[i]; return y; });
    }
    stages.push('dynEq');
  }
  onProgress(0.26);

  // 4. 3-band compressor (crossovers 150 Hz / 4 kHz), gentle 2:1 above each band's own level.
  //    Gains come from the mono sum and are shared by both channels.
  if (plan.multiband && A('multiband') > 0) {
    const aM = A('multiband');
    const split = (c) => { const low = lr4(c, 'lp', fs, 150), high = lr4(c, 'hp', fs, 4000), mid = new Float32Array(n); for (let i = 0; i < n; i++) mid[i] = c[i] - low[i] - high[i]; return [low, mid, high]; };
    const mono = new Float32Array(n); for (let i = 0; i < n; i++) { let a = 0; for (const c of out) a += c[i]; mono[i] = a / out.length; }
    const mb = split(mono);
    const times = [[0.012, 0.18], [0.006, 0.1], [0.002, 0.06]];
    const gains = mb.map((b, k) => {
      const env = envelope(b, fs, times[k][0], times[k][1]), thr = rmsOf(b) * 1.8, g = new Float32Array(n);
      for (let i = 0; i < n; i++) g[i] = env[i] > thr ? (thr / env[i]) ** (0.5 * aM) : 1;
      return g;
    });
    out = out.map((c) => { const bs = split(c), y = new Float32Array(n); for (let k = 0; k < 3; k++) for (let i = 0; i < n; i++) y[i] += bs[k][i] * gains[k][i]; return y; });
    stages.push('multiband');
  }
  onProgress(0.4);

  // 5. glue (only for very wide dynamics)
  if (plan.glue && A('glue') > 0) {
    const aG = A('glue');
    const mono = new Float32Array(n); for (let i = 0; i < n; i++) { let a = 0; for (const c of out) a = Math.max(a, Math.abs(c[i])); mono[i] = a; }
    const env = envelope(mono, fs, 0.03, 0.3), thr = rmsOf(mono) * 1.4;
    for (let i = 0; i < n; i++) { const g = env[i] > thr ? (thr / env[i]) ** (0.5 * aG) : 1; for (const c of out) c[i] *= g; }
    stages.push('glue');
  }

  // 6. punch: transient shaper (fast vs slow envelope), up to +3.5 dB on attacks
  if (plan.punch && A('punch') > 0) {
    const aP = A('punch');
    const mono = new Float32Array(n); for (let i = 0; i < n; i++) { let a = 0; for (const c of out) a += c[i]; mono[i] = a / out.length; }
    const fast = envelope(mono, fs, 0.0008, 0.03), slow = envelope(mono, fs, 0.02, 0.2);
    const g = new Float32Array(n);
    let sm = 1;
    const k = Math.exp(-1 / (0.002 * fs));
    for (let i = 0; i < n; i++) {
      const tgt = 1 + clamp((fast[i] / (slow[i] + 1e-9) - 1) * 0.5, 0, 0.5) * aP;
      sm = k * sm + (1 - k) * tgt; g[i] = sm;
    }
    for (const c of out) for (let i = 0; i < n; i++) c[i] *= g[i];
    stages.push('punch');
  }
  onProgress(0.5);

  // 7. stereo: mono low end, a little more width above 3 kHz when the mix is narrow
  if (stereo && A('stereo') > 0) {
    const aS = Math.min(1.5, A('stereo'));
    const [L, R] = out;
    const S = new Float32Array(n); for (let i = 0; i < n; i++) S[i] = (L[i] - R[i]) / 2;
    const sLow = lr4(S, 'lp', fs, 120);
    const sHigh = plan.width ? lr4(S, 'hp', fs, 3000) : null;
    for (let i = 0; i < n; i++) {
      const d = (-sLow[i] + (sHigh ? sHigh[i] * 0.3 : 0)) * Math.min(1, aS);
      L[i] += d; R[i] -= d;
    }
    stages.push(plan.width ? 'stereoWide' : 'monoBass');
    if (plan.pseudoStereo && A('pseudoStereo') > 0) {
      const M = new Float32Array(n); for (let i = 0; i < n; i++) M[i] = (L[i] + R[i]) / 2;
      let d = lr4(M, 'hp', fs, 1500);
      for (const f of [700, 1900, 4300, 9100]) d = filt(d, coeffs('ap', fs, f, 0.6));
      for (let i = 0; i < n; i++) { const v = d[i] * 0.28 * A('pseudoStereo'); L[i] += v; R[i] -= v; }
      stages.push('pseudoStereo');
    }
  }
  onProgress(0.58);

  // 8. exciter: soft harmonics above 5 kHz when the top end is dull, stronger the duller it is
  if (plan.exciter && A('exciter') > 0) {
    const amt = (plan.exciterAmount || 0.35) * A('exciter');
    const src = amt > 0.8 ? 2000 : 3000;
    out = out.map((c) => {
      const h = lr4(c, 'hp', fs, src);
      const sat = new Float32Array(n); for (let i = 0; i < n; i++) sat[i] = Math.tanh(h[i] * 5) / 5;
      const harm = lr4(sat, 'hp', fs, 5000);
      const y = new Float32Array(n); for (let i = 0; i < n; i++) y[i] = c[i] + harm[i] * amt;
      return y;
    });
    stages.push('exciter');
  }
  onProgress(0.64);

  // 8b. bandwidth extension: when the top was cut off, rebuild it from harmonics of 1.5-6 kHz
  if (plan.bwe && A('bwe') > 0) {
    const aB = A('bwe');
    out = out.map((c) => {
      const band = lr4(lr4(c, 'hp', fs, 1500), 'lp', fs, 6000);
      const rect = new Float32Array(n);
      let mean = 0; for (let i = 0; i < n; i++) mean += Math.abs(band[i]); mean /= n;
      for (let i = 0; i < n; i++) rect[i] = Math.abs(band[i]) - mean + Math.tanh(band[i] * 6) / 6;
      const hi = lr4(lr4(rect, 'hp', fs, 5000), 'hp', fs, 5000);
      const y = new Float32Array(n); for (let i = 0; i < n; i++) y[i] = c[i] + hi[i] * 0.9 * aB;
      return y;
    });
    stages.push('bwe');
  }

  // 9. de-esser
  if (plan.deess && A('deess') > 0) {
    const aDs = A('deess');
    const k1 = coeffs('hp', fs, 5000), k2 = coeffs('lp', fs, 9000);
    out = out.map((c) => {
      const b = filt(filt(c, k1), k2);
      const env = envelope(b, fs, 0.002, 0.06), full = envelope(c, fs, 0.002, 0.06);
      const y = new Float32Array(n);
      for (let i = 0; i < n; i++) { const r = env[i] / (full[i] + 1e-9); y[i] = c[i] - b[i] * (r > 0.35 ? Math.min(Math.min(0.9, 0.6 * aDs), (r - 0.35) * 1.5 * aDs) : 0); }
      return y;
    });
    stages.push('deess');
  }
  onProgress(0.7);

  // 9b. closed loop on 1/3-octave bands: measure, correct what is left, measure again (3 passes)
  const aL = A('tonalLoop');
  if ((plan.eq.length || plan.multiband || plan.forceLoop) && aL > 0) {
    const hiCap = plan.exciter || plan.bwe ? 6 : 2.5;
    // "high" quality: more passes, a smaller dead zone, finer filters
    const dead = high ? 0.15 : 0.5, step = high ? 0.9 : 0.85, passes = high ? 6 : 3;
    for (let pass = 0; pass < passes; pass++) {
      const mono = new Float32Array(n); for (let i = 0; i < n; i++) { let a = 0; for (const c of out) a += c[i]; mono[i] = a / out.length; }
      const dev = thirdOctDev(mono, fs).map((v, i) => v - aim3(i));
      // smooth across neighbours so we never carve narrow notches
      const sm = dev.map((v, i) => 0.25 * (dev[i - 1] ?? v) + 0.5 * v + 0.25 * (dev[i + 1] ?? v));
      const fix = THIRD.map((f, i) => ({ f, gain: clamp(-Math.sign(sm[i]) * Math.max(0, Math.abs(sm[i]) - dead) * step, -3, f >= 6000 ? hiCap : 2.5) }))
        .filter((e) => Math.abs(e.gain) >= (high ? 0.08 : 0.2));
      if (!fix.length) break;
      for (const e of fix) {
        const k = e.f < 45 ? coeffs('lshelf', fs, 50, 0.7071, e.gain) : e.f > 14000 ? coeffs('hshelf', fs, 13000, 0.7071, e.gain) : coeffs('peak', fs, e.f, 2.2, e.gain);
        out = out.map((c) => filt(c, k));
      }
    }
    // last pass on the octave bands the score is measured on
    for (let pass = 0; pass < (high ? 5 : 2); pass++) {
      const mono = new Float32Array(n); for (let i = 0; i < n; i++) { let a = 0; for (const c of out) a += c[i]; mono[i] = a / out.length; }
      const td = tonal(spectrum(mono, fs).oct).dev.map((v, i) => v - aimO(i));
      const fix = OCT.map((f, i) => ({ f, gain: clamp(-td[i] * step, -2, f >= 6000 ? hiCap : 2) })).filter((e) => Math.abs(e.gain) >= (high ? 0.05 : 0.2));
      if (!fix.length) break;
      for (const e of fix) {
        const k = e.f < 40 ? coeffs('lshelf', fs, 45, 0.7071, e.gain) : e.f > 12000 ? coeffs('hshelf', fs, 12000, 0.7071, e.gain) : coeffs('peak', fs, e.f, 1.0, e.gain);
        out = out.map((c) => filt(c, k));
      }
    }
    stages.push('tonalLoop');
  }
  onProgress(0.76);

  // 10. loudness + true-peak limiter (peaks measured with 4x oversampling)
  const club = plan.target >= -10;
  const limited = (src, gainDb) => {
    const gain = 10 ** (gainDb / 20);
    const res = src.map((c) => { const y = new Float32Array(n); for (let i = 0; i < n; i++) y[i] = c[i] * gain; return y; });
    if (club) {
      // soft clipper shaves the sharpest peaks before the limiter, so loud masters keep their punch
      const t = 10 ** (-3 / 20);
      // rational knee: the curve keeps rising (never flattens), so it rounds peaks instead of clipping them
      const kn = 0.35;
      for (const c of res) for (let i = 0; i < n; i++) { const v = c[i], a = Math.abs(v); if (a > t) { const o = a - t; c[i] = Math.sign(v) * (t + o / (1 + o / kn)); } }
    }
    const ceil = 10 ** (-1.02 / 20);
    const peak = new Float32Array(n);
    const L = OS_TAPS[0].length, h = L >> 1;
    for (const c of res) {
      for (let i = 0; i < n; i++) {
        let a = Math.abs(c[i]);
        if (a > ceil * 0.6 && i >= h && i < n - h) {
          for (let p = 1; p < 4; p++) { let v = 0; const row = OS_TAPS[p]; for (let k = 0; k < L; k++) v += row[k] * c[i - h + k]; if (Math.abs(v) > a) a = Math.abs(v); }
        }
        if (a > peak[i]) peak[i] = a;
      }
    }
    // look-ahead limiter without hard clipping:
    //   r = gain each sample needs; m = minimum of r over a window; g = average of m over the same
    //   window. Every value averaged comes from a window that contains sample i, so g[i] <= r[i]
    //   (the peak never exceeds the ceiling) while the gain curve stays smooth (no flat tops).
    const LW = Math.max(4, Math.round(0.003 * fs)), h2 = LW >> 1;
    const r = new Float32Array(n); for (let i = 0; i < n; i++) r[i] = peak[i] > ceil ? ceil / peak[i] : 1;
    const m = new Float32Array(n), dq = [];
    let head = 0;
    for (let i = 0; i < n + h2; i++) {
      if (i < n) { while (dq.length > head && r[dq[dq.length - 1]] >= r[i]) dq.pop(); dq.push(i); }
      const c = i - h2;
      if (c < 0) continue;
      while (dq[head] < c - h2) head++;
      m[c] = r[dq[head]];
    }
    const g = new Float32Array(n);
    let acc = 0;
    for (let i = 0; i < n + h2; i++) {
      if (i < n) acc += m[i];
      if (i - LW >= 0) acc -= m[i - LW];
      const c = i - h2;
      if (c >= 0 && c < n) g[c] = acc / Math.min(LW, i + 1);
    }
    // slow release, but never above what the window allows
    const rl = Math.exp(-1 / (0.08 * fs));
    let gs = 1;
    for (let i = 0; i < n; i++) {
      gs = g[i] < gs ? g[i] : Math.min(g[i], rl * gs + (1 - rl));
      for (const c of res) c[i] *= gs;
    }
    return res;
  };
  const before = loudness(out, fs).I;
  // the loudness moves toward the target as far as the strength says (0 % = keep the level)
  const aLd = Math.min(1, A('loudness'));
  const goal = before + (plan.target - before) * aLd;
  let gDb = goal - before;
  let res = limited(out, gDb);
  onProgress(0.85);
  const got = loudness(res, fs).I;
  // more passes until the loudness lands within 0.1 LU (0.05 LU in high quality) of the goal
  let lastGot = got;
  const tol = high ? 0.05 : 0.1;
  for (let pass = 0; pass < (high ? 4 : 2) && Math.abs(lastGot - goal) > tol; pass++) {
    gDb += clamp(goal - lastGot, -3, 3);
    res = limited(out, gDb);
    lastGot = loudness(res, fs).I;
  }
  // high quality: the limiter changes the balance a little; measure the result and correct what is
  // left on the pre-limiter signal, then limit again (closed loop through the whole tail)
  if (high && aL > 0 && (plan.eq.length || plan.multiband || plan.forceLoop)) {
    const hiCap2 = plan.exciter || plan.bwe ? 6 : 2.5;
    for (let it = 0; it < 3; it++) {
      const mono = new Float32Array(n); for (let i = 0; i < n; i++) { let a = 0; for (const c of res) a += c[i]; mono[i] = a / res.length; }
      const td = tonal(spectrum(mono, fs).oct).dev.map((v, i) => v - aimO(i));
      if (Math.max(...td.map(Math.abs)) < 0.12) break;
      const fix = OCT.map((f, i) => ({ f, q: 1.0, gain: clamp(-td[i] * 0.7, -1.5, f >= 6000 ? hiCap2 : 1.5) })).filter((e) => Math.abs(e.gain) >= 0.04);
      for (const e of fix) {
        const k = e.f < 40 ? coeffs('lshelf', fs, 45, 0.7071, e.gain) : e.f > 12000 ? coeffs('hshelf', fs, 12000, 0.7071, e.gain) : coeffs('peak', fs, e.f, e.q, e.gain);
        out = out.map((c) => filt(c, k));
      }
      res = limited(out, gDb);
      lastGot = loudness(res, fs).I;
      for (let pass = 0; pass < 3 && Math.abs(lastGot - goal) > tol; pass++) {
        gDb += clamp(goal - lastGot, -3, 3);
        res = limited(out, gDb);
        lastGot = loudness(res, fs).I;
      }
    }
  }
  out = res;
  if (aLd > 0) stages.push('loudness');
  onProgress(0.97);
  for (const c of out) for (let i = 0; i < n; i++) c[i] = clamp(c[i], -1, 1);
  return { chs: out, stages };
}

export { BANDS, STAGES };

// ---------------------------------------------------------------- re-check and refine
// The metric each stage is responsible for (lower = better).
export function stageMetric(id, m, target) {
  const top = (Math.abs(Math.min(0, m.tonal.dev[8])) + Math.abs(Math.min(0, m.tonal.dev[9]))) / 2;
  switch (id) {
    case 'declip': return m.clips;
    case 'denoise': return m.hiss ? m.hiss.ratioDb : -99;
    case 'tonalEq': case 'tonalLoop': case 'highpass': return m.tonal.error;
    case 'dynEq': return Math.max(0, m.tonal.dev[3] + m.tonal.dev[4]) + Math.max(0, m.tonal.dev[6] + m.tonal.dev[7]);
    case 'multiband': case 'glue': return m.lra;
    case 'punch': return -m.crest;
    case 'stereo': case 'pseudoStereo': return 1 - m.corrLow;
    case 'exciter': case 'bwe': return top;
    case 'deess': return m.sibilanceDb;
    case 'loudness': return Math.abs(m.lufs - target) + Math.max(0, m.truePeakDb + 1);
    default: return m.tonal.error;
  }
}

/**
 * Plan for a second look at audio that was already improved: only what is still wrong is fixed
 * (or only `only`, forced on). Loudness is always re-aimed so the level stays on target.
 */
export function refinePlan(m, target, only = null, level = 'standard') {
  const d = diagnose(m, target);
  const has = (id) => d.issues.some((i) => i.id === id);
  const want = new Set(['loudness']);
  if (m.clips > 20) want.add('declip');
  if (d.plan.denoise) want.add('denoise');
  if (m.tonal.error > 0.3) { want.add('tonalEq'); want.add('tonalLoop'); }
  if (has('mud') || has('harsh')) want.add('dynEq');
  if (has('sibilance')) want.add('deess');
  if (d.plan.exciter) want.add('exciter');
  if (d.plan.bwe) want.add('bwe');
  if (has('wideDynamics')) want.add('glue');
  if (has('wideBass')) want.add('stereo');
  const use = only ? new Set([only, 'loudness']) : want;
  const plan = {
    ...d.plan, target, level,
    declip: use.has('declip'), denoise: use.has('denoise'), dynEq: use.has('dynEq'), deess: use.has('deess'),
    exciter: use.has('exciter'), exciterAmount: d.plan.exciterAmount || 0.35, bwe: use.has('bwe'),
    glue: use.has('glue'), punch: use.has('punch'), multiband: use.has('multiband'),
    width: false, pseudoStereo: false, forceLoop: use.has('tonalLoop') || use.has('tonalEq'),
    eq: use.has('tonalEq') ? d.plan.eq : [],
  };
  plan.off = STAGES.filter((id) => !use.has(id) && !(id === 'tonalLoop' && use.has('tonalEq')));
  return { plan, stages: [...use], score: d.score };
}

export function refine(chs, fs, { target = -14, only = null, level = 'standard', vocals = [] } = {}, onProgress) {
  const m0 = analyseQuality(chs, fs, vocals);
  const { plan, score: s0 } = refinePlan(m0, target, only, level);
  const res = enhance(chs, fs, plan, onProgress);
  const m1 = analyseQuality(res.chs, fs, vocals);
  const d1 = diagnose(m1, target);
  const checks = only ? [only] : ['tonalEq', 'loudness', ...(plan.denoise ? ['denoise'] : []), ...(plan.declip ? ['declip'] : [])];
  const gains = checks.map((id) => stageMetric(id, m0, target) - stageMetric(id, m1, target));
  const improved = d1.score > s0 || (d1.score >= s0 && gains.some((g) => g > 0.05) && gains.every((g) => g > -0.05));
  return { chs: res.chs, stages: res.stages, before: m0, after: m1, scoreBefore: s0, ...d1, improved, gains: Object.fromEntries(checks.map((id, i) => [id, gains[i]])) };
}
// exposed for the measurement scripts
export const _dsp = { declip, denoise, noiseProfile };
