// Offline helpers for the studio: level statistics, spectral noise reduction, true-peak limiter.

/** Level statistics used by the smart mixer. */
export function levelStats(chs, fs) {
  const n = chs[0].length;
  let peak = 0;
  for (const c of chs) for (let i = 0; i < n; i++) { const a = Math.abs(c[i]); if (a > peak) peak = a; }
  // loudness of the loud parts: 95th percentile of 400 ms RMS windows
  const W = Math.round(0.4 * fs), wins = [];
  for (let s = 0; s + W <= n; s += W >> 1) {
    let e = 0;
    for (const c of chs) for (let i = s; i < s + W; i += 2) e += c[i] * c[i];
    wins.push(e / ((W / 2) * chs.length));
  }
  wins.sort((a, b) => a - b);
  const loud = wins.length ? wins[Math.floor(wins.length * 0.95)] : 0;
  // share of energy below 120 Hz (one-pole split on a decimated mono copy)
  let lo = 0, all = 0, y = 0;
  const a = Math.exp((-2 * Math.PI * 120) / fs);
  for (let i = 0; i < n; i += 1) {
    const x = (chs[0][i] + (chs[1] ? chs[1][i] : chs[0][i])) / 2;
    y = (1 - a) * x + a * y;
    lo += y * y; all += x * x;
  }
  return {
    peakDb: 20 * Math.log10(peak + 1e-9),
    loudDb: 10 * Math.log10(loud + 1e-12),
    lowFrac: all > 0 ? lo / all : 0,
  };
}

/**
 * Look-ahead true-peak limiter (4x oversampled peak detection).
 * Never clips: the gain curve is a moving minimum, smoothed by a box average of the same width.
 */
export function limit(chs, fs, ceilDb = -1, releaseS = 0.08) {
  const n = chs[0].length, ceil = 10 ** (ceilDb / 20);
  const peak = new Float32Array(n);
  for (const c of chs) {
    for (let i = 0; i < n; i++) {
      let a = Math.abs(c[i]);
      if (i > 0 && i < n - 2 && a > ceil * 0.5) {
        // 4-point cubic interpolation at 1/4, 1/2, 3/4 between samples
        const y0 = c[i - 1], y1 = c[i], y2 = c[i + 1], y3 = c[i + 2];
        for (const t of [0.25, 0.5, 0.75]) {
          const v = y1 + 0.5 * t * (y2 - y0 + t * (2 * y0 - 5 * y1 + 4 * y2 - y3 + t * (3 * (y1 - y2) + y3 - y0)));
          if (Math.abs(v) > a) a = Math.abs(v);
        }
      }
      if (a > peak[i]) peak[i] = a;
    }
  }
  const LW = Math.max(4, Math.round(0.003 * fs)), h = LW >> 1;
  const r = new Float32Array(n);
  let any = false;
  for (let i = 0; i < n; i++) { r[i] = peak[i] > ceil ? ceil / peak[i] : 1; if (r[i] < 1) any = true; }
  if (!any) return { chs, grDb: 0 };
  const m = new Float32Array(n), dq = new Int32Array(n + 1);
  let head = 0, tail = 0;
  for (let i = 0; i < n + h; i++) {
    if (i < n) { while (tail > head && r[dq[tail - 1]] >= r[i]) tail--; dq[tail++] = i; }
    const c = i - h;
    if (c < 0) continue;
    while (dq[head] < c - h) head++;
    m[c] = r[dq[head]];
  }
  const g = new Float32Array(n);
  let acc = 0;
  for (let i = 0; i < n + h; i++) {
    if (i < n) acc += m[i];
    if (i - LW >= 0) acc -= m[i - LW];
    const c = i - h;
    if (c >= 0 && c < n) g[c] = acc / Math.min(LW, i + 1);
  }
  const rl = Math.exp(-1 / (releaseS * fs));
  let gs = 1, maxGr = 0;
  for (let i = 0; i < n; i++) {
    gs = g[i] < gs ? g[i] : Math.min(g[i], rl * gs + (1 - rl));
    for (const c of chs) c[i] *= gs;
    if (gs < 1) maxGr = Math.max(maxGr, -20 * Math.log10(gs));
  }
  for (const c of chs) for (let i = 0; i < n; i++) c[i] = Math.max(-1, Math.min(1, c[i]));
  return { chs, grDb: maxGr };
}

// ---------------------------------------------------------------- unpleasant-sound finder
function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2, xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

/**
 * Finds resonances that stick out of the sound (ringing, harsh, boxy tones).
 * The spectrum is measured in 1/12-octave bands, so single harmonics of a melody are averaged
 * into their band, and every band is compared with its neighbours 1/6 - 5/12 octave away (not with
 * itself, so a resonance cannot hide in its own reference). A band counts only if it sticks out in
 * the long-term average AND in most loud moments. Below 1 kHz, where melody notes live, the rule
 * is stricter so that notes of the song are not taken for resonances.
 * Returns up to `max` cuts: [{ f, g, q, excess, persist }]
 */
export function findHarsh(chs, fs, max = 6) {
  const N = 8192, H = 4096, n = chs[0].length, K = N / 2;
  const win = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  const frames = Math.floor((n - N) / H) + 1;
  if (frames < 4) return [];
  // 1/12-octave bands, 120 Hz .. 14 kHz
  const fc = []; for (let f = 120; f <= 14000; f *= 2 ** (1 / 12)) fc.push(f);
  const B = fc.length;
  const bLo = fc.map((f) => Math.max(1, Math.floor((f * 2 ** (-1 / 24) * N) / fs))), bHi = fc.map((f) => Math.min(K - 1, Math.ceil((f * 2 ** (1 / 24) * N) / fs)));
  const energy = new Float32Array(frames);
  for (let f = 0; f < frames; f++) { let e = 0; const s = f * H; for (let i = 0; i < N; i += 8) { const v = chs[0][s + i] + (chs[1] ? chs[1][s + i] : 0); e += v * v; } energy[f] = e; }
  const sorted = Float32Array.from(energy).sort(), gate = sorted[Math.floor(frames * 0.25)];
  const re = new Float64Array(N), im = new Float64Array(N), pw = new Float64Array(K);
  const lt = new Float64Array(B), cnt = new Float64Array(B), bd = new Float64Array(B);
  let used = 0;
  const OFF = [-5, -4, -3, -2, 2, 3, 4, 5];
  const exOf = (arr, i) => { let s2 = 0, c = 0; for (const o of OFF) { const j = i + o; if (j >= 0 && j < B) { s2 += arr[j]; c++; } } return arr[i] - s2 / c; };
  for (let f = 0; f < frames; f++) {
    if (energy[f] < gate) continue; // quiet moments say little about resonances
    const s = f * H;
    for (let i = 0; i < N; i++) { re[i] = ((chs[0][s + i] + (chs[1] ? chs[1][s + i] : chs[0][s + i])) / 2) * win[i]; im[i] = 0; }
    fftInPlace(re, im);
    for (let k = 0; k < K; k++) pw[k] = re[k] * re[k] + im[k] * im[k];
    for (let b = 0; b < B; b++) { let e = 0; for (let k = bLo[b]; k <= bHi[b]; k++) e += pw[k]; e /= bHi[b] - bLo[b] + 1; lt[b] += e; bd[b] = 10 * Math.log10(e + 1e-20); }
    for (let b = 0; b < B; b++) if (exOf(bd, b) > 3) cnt[b]++;
    used++;
  }
  if (!used) return [];
  const L = Array.from(lt, (v) => 10 * Math.log10(v / used + 1e-20));
  const ex = L.map((_, b) => exOf(L, b)), per = Array.from(cnt, (c) => c / used);
  const peaks = [];
  for (let b = 1; b < B - 1; b++) {
    if (ex[b] < ex[b - 1] || ex[b] < ex[b + 1]) continue;
    const low = fc[b] < 1000;
    if (ex[b] < (low ? 5 : 3) || per[b] < (low ? 0.6 : 0.5)) continue;
    // width (in bands) where the excess stays above half
    let a = b, c = b;
    while (a > 0 && ex[a - 1] > ex[b] / 2) a--;
    while (c < B - 1 && ex[c + 1] > ex[b] / 2) c++;
    const bwOct = Math.max(1, c - a + 1) / 12, r = 2 ** bwOct;
    const q = Math.max(1.5, Math.min(10, Math.sqrt(r) / (r - 1)));
    const ear = fc[b] >= 1500 && fc[b] <= 8000 ? 1.4 : 1;
    peaks.push({ f: fc[b], e: ex[b], q, persist: per[b], s: ex[b] * per[b] * ear });
  }
  peaks.sort((x, y) => y.s - x.s);
  const out = [];
  for (const p of peaks) {
    if (out.length >= max) break;
    if (out.some((o) => Math.abs(Math.log2(o.f / p.f)) < 1 / 4)) continue;
    out.push({ f: Math.round(p.f), g: -Math.round(Math.min(6, Math.max(1.5, p.e * 0.8)) * 10) / 10, q: Math.round(p.q * 10) / 10, excess: Math.round(p.e * 10) / 10, persist: Math.round(p.persist * 100) / 100 });
  }
  return out.sort((x, y) => x.f - y.f);
}
