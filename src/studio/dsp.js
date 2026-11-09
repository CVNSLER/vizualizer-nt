// Offline helpers for the studio: level statistics, spectral noise reduction, true-peak limiter.
import { fft } from './fft.js';

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
 * Spectral noise reduction (for a voice or a noisy recording).
 * Noise is learned from the quietest 10 % of frames, then removed with a smoothed Wiener gain.
 * strength 0..1
 */
export function denoise(c, fs, strength = 0.5) {
  const N = 2048, H = 512, n = c.length;
  const win = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  const frames = Math.max(0, Math.floor((n - N) / H) + 1);
  if (frames < 8) return Float32Array.from(c);
  const K = N / 2 + 1;
  // pass 1: frame energies + spectra of all frames (magnitudes only)
  const energy = new Float32Array(frames);
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let f = 0; f < frames; f++) {
    let e = 0; const s = f * H;
    for (let i = 0; i < N; i += 4) e += c[s + i] * c[s + i];
    energy[f] = e;
  }
  const order = Array.from(energy.keys()).sort((a, b) => energy[a] - energy[b]);
  const quiet = order.slice(0, Math.max(4, Math.floor(frames * 0.1))).filter((f) => energy[f] > 0 || true);
  const noise = new Float64Array(K);
  for (const f of quiet) {
    const s = f * H;
    for (let i = 0; i < N; i++) { re[i] = c[s + i] * win[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k < K; k++) noise[k] += re[k] * re[k] + im[k] * im[k];
  }
  for (let k = 0; k < K; k++) noise[k] /= quiet.length;
  // pass 2: Wiener gain with over-subtraction, gain floor and decision-directed smoothing
  const over = 1 + 2.5 * strength, floor = 10 ** (-(6 + 18 * strength) / 20);
  const out = new Float32Array(n), norm = new Float32Array(n);
  const prevS = new Float64Array(K);
  const gPrev = new Float64Array(K).fill(1);
  for (let f = 0; f < frames; f++) {
    const s = f * H;
    for (let i = 0; i < N; i++) { re[i] = c[s + i] * win[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k < K; k++) {
      const P = re[k] * re[k] + im[k] * im[k];
      const post = P / (noise[k] * over + 1e-20);
      const prio = 0.96 * (prevS[k] / (noise[k] * over + 1e-20)) + 0.04 * Math.max(0, post - 1);
      let g = prio / (1 + prio);
      g = Math.max(floor, g);
      // smooth the gain over time (less "musical noise")
      g = g > gPrev[k] ? 0.6 * g + 0.4 * gPrev[k] : 0.85 * g + 0.15 * gPrev[k];
      gPrev[k] = g;
      prevS[k] = g * g * P;
      re[k] *= g; im[k] *= g;
      if (k > 0 && k < N / 2) { re[N - k] *= g; im[N - k] *= g; }
    }
    fft(re, im, true);
    for (let i = 0; i < N; i++) { out[s + i] += (re[i] / N) * win[i]; norm[s + i] += win[i] * win[i]; }
  }
  for (let i = 0; i < n; i++) out[i] = norm[i] > 1e-3 ? out[i] / norm[i] : c[i] * floor;
  return out;
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
