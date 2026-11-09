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
