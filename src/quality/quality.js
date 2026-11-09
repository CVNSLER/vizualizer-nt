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
  return { rel, frames };
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
  let clips = 0;
  for (const c of chs) {
    let run = 0;
    for (let i = 1; i < n; i++) {
      if (Math.abs(c[i]) > 0.989 && Math.abs(c[i] - c[i - 1]) < 1e-4) { run++; if (run === 2) clips++; } else run = 0;
    }
  }
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
  };
}

// ---------------------------------------------------------------- problems -> plan
export function diagnose(m, target = -14) {
  const issues = [];
  const add = (id, level, value, fix) => issues.push({ id, level, value, fix });
  if (m.clips > 0) add('clipping', 'bad', m.clips, 'limiter');
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
  const eq = [];
  for (const b of BANDS) {
    const dev = m.spectrum[b.id] - b.ref;
    if (Math.abs(dev) >= 5 && !(b.id === 'air' && dev < 0 && dev > -8)) {
      add(dev > 0 ? `too_${b.id}` : `lack_${b.id}`, Math.abs(dev) > 8 ? 'bad' : 'warn', dev, 'eq');
      eq.push({ band: b.id, f: b.f, gain: clamp(-dev * 0.4, -4, 3), q: b.id === 'sub' || b.id === 'air' ? 0.7 : 0.9 });
    }
  }
  if (m.sibilanceDb > -10) add('sibilance', 'warn', m.sibilanceDb, 'deess');
  if (m.leadSilence > 1) add('leadSilence', 'info', m.leadSilence, null);
  if (m.trailSilence > 2) add('trailSilence', 'info', m.trailSilence, null);

  const pen = { bad: 14, warn: 6, info: 1 };
  const score = clamp(Math.round(100 - issues.reduce((s, i) => s + pen[i.level], 0)), 0, 100);
  const plan = {
    target,
    highpass: issues.some((i) => i.fix === 'highpass') ? 30 : 20,
    eq,
    monoBass: issues.some((i) => i.fix === 'monoBass'),
    deess: issues.some((i) => i.fix === 'deess'),
    glue: issues.some((i) => i.fix === 'glue'),
  };
  return { issues, score, plan };
}

// ---------------------------------------------------------------- processing
export function enhance(chs, fs, plan, onProgress = () => {}) {
  let out = chs.map((c) => Float32Array.from(c));
  const stereo = out.length > 1;
  // 1. DC + rumble
  const hp = coeffs('hp', fs, plan.highpass, 0.7071);
  out = out.map((c) => filt(filt(c, hp), hp));
  onProgress(0.15);
  // 2. corrective EQ
  for (const e of plan.eq) {
    const k = e.band === 'sub' ? coeffs('lshelf', fs, 60, 0.7071, e.gain) : e.band === 'air' ? coeffs('hshelf', fs, 10000, 0.7071, e.gain) : coeffs('peak', fs, e.f, e.q, e.gain);
    out = out.map((c) => filt(c, k));
  }
  onProgress(0.35);
  // 3. mono low end: remove the side signal below 120 Hz
  if (stereo && plan.monoBass) {
    const [L, R] = out, n = L.length;
    const S = new Float32Array(n); for (let i = 0; i < n; i++) S[i] = (L[i] - R[i]) / 2;
    const lp = coeffs('lp', fs, 120);
    const Slow = filt(filt(S, lp), lp);
    for (let i = 0; i < n; i++) { L[i] -= Slow[i]; R[i] += Slow[i]; }
  }
  onProgress(0.45);
  // 4. de-esser: duck the 5-9 kHz band when it jumps out
  if (plan.deess) {
    const k1 = coeffs('hp', fs, 5000), k2 = coeffs('lp', fs, 9000);
    out = out.map((c) => {
      const b = filt(filt(c, k1), k2);
      const y = Float32Array.from(c);
      let env = 0, envAll = 0;
      const at = Math.exp(-1 / (0.002 * fs)), rl = Math.exp(-1 / (0.06 * fs));
      for (let i = 0; i < c.length; i++) {
        const a = Math.abs(b[i]), aa = Math.abs(c[i]);
        env = a > env ? at * env + (1 - at) * a : rl * env + (1 - rl) * a;
        envAll = aa > envAll ? at * envAll + (1 - at) * aa : rl * envAll + (1 - rl) * aa;
        const ratio = env / (envAll + 1e-9);
        const red = ratio > 0.35 ? Math.min(0.6, (ratio - 0.35) * 1.5) : 0;
        y[i] = c[i] - b[i] * red;
      }
      return y;
    });
  }
  onProgress(0.55);
  // 5. glue compressor (2:1, slow) only when the dynamics are very wide
  if (plan.glue) {
    const n = out[0].length;
    const at = Math.exp(-1 / (0.03 * fs)), rl = Math.exp(-1 / (0.3 * fs));
    let env = 0;
    let ms = 0; for (let i = 0; i < n; i += 8) { const v = out[0][i]; ms += v * v; }
    const thr = Math.sqrt(ms / (n / 8)) * 1.4;
    for (let i = 0; i < n; i++) {
      let a = 0; for (const c of out) a = Math.max(a, Math.abs(c[i]));
      env = a > env ? at * env + (1 - at) * a : rl * env + (1 - rl) * a;
      const g = env > thr ? (thr / env) ** 0.5 : 1;
      for (const c of out) c[i] *= g;
    }
  }
  onProgress(0.7);
  // 6 + 7. loudness normalisation and look-ahead limiter; the second pass corrects
  // the loudness the limiter took away
  const limited = (src, gainDb) => {
    const gain = 10 ** (gainDb / 20);
    const res = src.map((c) => { const y = new Float32Array(c.length); for (let i = 0; i < c.length; i++) y[i] = c[i] * gain; return y; });
    const ceil = 10 ** (-2 / 20);
    const n = res[0].length, look = Math.round(0.004 * fs);
    const peak = new Float32Array(n);
    for (let i = 0; i < n; i++) { let a = 0; for (const c of res) a = Math.max(a, Math.abs(c[i])); peak[i] = a; }
    const need = new Float32Array(n);
    const dq = [];
    let head = 0;
    for (let i = n - 1; i >= 0; i--) {
      while (dq.length > head && peak[dq[dq.length - 1]] <= peak[i]) dq.pop();
      dq.push(i);
      while (dq[head] > i + look) head++;
      const m = peak[dq[head]];
      need[i] = m > ceil ? ceil / m : 1;
    }
    const rl = Math.exp(-1 / (0.08 * fs)), at = Math.exp(-1 / (0.0015 * fs));
    let g = 1;
    for (let i = 0; i < n; i++) {
      g = need[i] < g ? Math.max(need[i], at * g + (1 - at) * need[i]) : rl * g + (1 - rl) * need[i];
      if (g > need[i] && peak[i] * g > ceil) g = need[i];
      for (const c of res) c[i] *= g;
    }
    return res;
  };
  const before = loudness(out, fs).I;
  let gDb = plan.target - before;
  let res = limited(out, gDb);
  onProgress(0.85);
  const got = loudness(res, fs).I;
  if (Math.abs(got - plan.target) > 0.3) { gDb += Math.min(3, plan.target - got); res = limited(out, gDb); }
  out = res;
  onProgress(0.95);
  for (const c of out) for (let i = 0; i < c.length; i++) c[i] = clamp(c[i], -1, 1);
  return out;
}

export { BANDS };
