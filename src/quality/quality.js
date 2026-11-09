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
    tonal: tonal(spec.oct),
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

export function enhance(chs, fs, plan, onProgress = () => {}) {
  let out = chs.map((c) => Float32Array.from(c));
  const stereo = out.length > 1;
  const stages = [];
  const n = out[0].length;

  // 1. DC + rumble: 4th-order high-pass
  out = out.map((c) => lr4(c, 'hp', fs, plan.highpass));
  stages.push('highpass');
  onProgress(0.06);

  // 2. tonal balance: 10-band match to a modern reference
  for (const e of plan.eq) {
    const k = e.f < 40 ? coeffs('lshelf', fs, 45, 0.7071, e.gain) : e.f > 12000 ? coeffs('hshelf', fs, 12000, 0.7071, e.gain) : coeffs('peak', fs, e.f, 1.0, e.gain);
    out = out.map((c) => filt(c, k));
  }
  if (plan.eq.length) stages.push('tonalEq');
  onProgress(0.14);

  // 3. dynamic EQ: tame mud (300 Hz) and harshness (3.5 kHz) only when they jump out.
  //    Detection on the mono sum, same gain on both channels (keeps the stereo image).
  if (plan.dynEq) {
    for (const [f, q, maxCut] of [[300, 1.1, 0.45], [3500, 1.3, 0.5]]) {
      const kb = coeffs('bp', fs, f, q);
      const mono = new Float32Array(n); for (let i = 0; i < n; i++) { let a = 0; for (const c of out) a += c[i]; mono[i] = a / out.length; }
      const bm = filt(mono, kb);
      const env = envelope(bm, fs, 0.005, 0.12), full = envelope(mono, fs, 0.005, 0.12);
      const ratios = []; for (let i = 0; i < n; i += 512) ratios.push(env[i] / (full[i] + 1e-9));
      ratios.sort((a2, b2) => a2 - b2);
      const typ = ratios[Math.floor(ratios.length * 0.6)] || 0.2;
      const red = new Float32Array(n);
      for (let i = 0; i < n; i++) { const r = env[i] / (full[i] + 1e-9) / (typ + 1e-9); red[i] = r > 1.4 ? Math.min(maxCut, (r - 1.4) * 0.5) : 0; }
      out = out.map((c) => { const b = filt(c, kb), y = new Float32Array(n); for (let i = 0; i < n; i++) y[i] = c[i] - b[i] * red[i]; return y; });
    }
    stages.push('dynEq');
  }
  onProgress(0.26);

  // 4. 3-band compressor (crossovers 150 Hz / 4 kHz), gentle 2:1 above each band's own level.
  //    Gains come from the mono sum and are shared by both channels.
  if (plan.multiband) {
    const split = (c) => { const low = lr4(c, 'lp', fs, 150), high = lr4(c, 'hp', fs, 4000), mid = new Float32Array(n); for (let i = 0; i < n; i++) mid[i] = c[i] - low[i] - high[i]; return [low, mid, high]; };
    const mono = new Float32Array(n); for (let i = 0; i < n; i++) { let a = 0; for (const c of out) a += c[i]; mono[i] = a / out.length; }
    const mb = split(mono);
    const times = [[0.012, 0.18], [0.006, 0.1], [0.002, 0.06]];
    const gains = mb.map((b, k) => {
      const env = envelope(b, fs, times[k][0], times[k][1]), thr = rmsOf(b) * 1.8, g = new Float32Array(n);
      for (let i = 0; i < n; i++) g[i] = env[i] > thr ? Math.sqrt(thr / env[i]) : 1;
      return g;
    });
    out = out.map((c) => { const bs = split(c), y = new Float32Array(n); for (let k = 0; k < 3; k++) for (let i = 0; i < n; i++) y[i] += bs[k][i] * gains[k][i]; return y; });
    stages.push('multiband');
  }
  onProgress(0.4);

  // 5. glue (only for very wide dynamics)
  if (plan.glue) {
    const mono = new Float32Array(n); for (let i = 0; i < n; i++) { let a = 0; for (const c of out) a = Math.max(a, Math.abs(c[i])); mono[i] = a; }
    const env = envelope(mono, fs, 0.03, 0.3), thr = rmsOf(mono) * 1.4;
    for (let i = 0; i < n; i++) { const g = env[i] > thr ? (thr / env[i]) ** 0.5 : 1; for (const c of out) c[i] *= g; }
    stages.push('glue');
  }

  // 6. punch: transient shaper (fast vs slow envelope), up to +3.5 dB on attacks
  if (plan.punch) {
    const mono = new Float32Array(n); for (let i = 0; i < n; i++) { let a = 0; for (const c of out) a += c[i]; mono[i] = a / out.length; }
    const fast = envelope(mono, fs, 0.0008, 0.03), slow = envelope(mono, fs, 0.02, 0.2);
    const g = new Float32Array(n);
    let sm = 1;
    const k = Math.exp(-1 / (0.002 * fs));
    for (let i = 0; i < n; i++) {
      const tgt = 1 + clamp((fast[i] / (slow[i] + 1e-9) - 1) * 0.5, 0, 0.5);
      sm = k * sm + (1 - k) * tgt; g[i] = sm;
    }
    for (const c of out) for (let i = 0; i < n; i++) c[i] *= g[i];
    stages.push('punch');
  }
  onProgress(0.5);

  // 7. stereo: mono low end, a little more width above 3 kHz when the mix is narrow
  if (stereo) {
    const [L, R] = out;
    const S = new Float32Array(n); for (let i = 0; i < n; i++) S[i] = (L[i] - R[i]) / 2;
    const sLow = lr4(S, 'lp', fs, 120);
    const sHigh = plan.width ? lr4(S, 'hp', fs, 3000) : null;
    for (let i = 0; i < n; i++) {
      const d = -sLow[i] + (sHigh ? sHigh[i] * 0.3 : 0);
      L[i] += d; R[i] -= d;
    }
    stages.push(plan.width ? 'stereoWide' : 'monoBass');
    if (plan.pseudoStereo) {
      const M = new Float32Array(n); for (let i = 0; i < n; i++) M[i] = (L[i] + R[i]) / 2;
      let d = lr4(M, 'hp', fs, 1500);
      for (const f of [700, 1900, 4300, 9100]) d = filt(d, coeffs('ap', fs, f, 0.6));
      for (let i = 0; i < n; i++) { const v = d[i] * 0.28; L[i] += v; R[i] -= v; }
      stages.push('pseudoStereo');
    }
  }
  onProgress(0.58);

  // 8. exciter: soft harmonics above 5 kHz when the top end is dull, stronger the duller it is
  if (plan.exciter) {
    const amt = plan.exciterAmount || 0.35;
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

  // 9. de-esser
  if (plan.deess) {
    const k1 = coeffs('hp', fs, 5000), k2 = coeffs('lp', fs, 9000);
    out = out.map((c) => {
      const b = filt(filt(c, k1), k2);
      const env = envelope(b, fs, 0.002, 0.06), full = envelope(c, fs, 0.002, 0.06);
      const y = new Float32Array(n);
      for (let i = 0; i < n; i++) { const r = env[i] / (full[i] + 1e-9); y[i] = c[i] - b[i] * (r > 0.35 ? Math.min(0.6, (r - 0.35) * 1.5) : 0); }
      return y;
    });
    stages.push('deess');
  }
  onProgress(0.7);

  // 9b. closed loop: measure the tonal balance again and correct what is left (2 passes)
  if (plan.eq.length || plan.multiband) {
    for (let pass = 0; pass < 2; pass++) {
      const mono = new Float32Array(n); for (let i = 0; i < n; i++) { let a = 0; for (const c of out) a += c[i]; mono[i] = a / out.length; }
      const td = tonal(spectrum(mono, fs).oct).dev;
      const fix = OCT.map((f, i) => ({ f, gain: clamp(-Math.sign(td[i]) * Math.max(0, Math.abs(td[i]) - 0.8) * 0.75, -3, i >= 8 && plan.exciter ? 4 : 2.5) })).filter((e) => Math.abs(e.gain) >= 0.25);
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
      for (const c of res) for (let i = 0; i < n; i++) { const v = c[i], a = Math.abs(v); if (a > t) c[i] = Math.sign(v) * (t + (1 - t) * Math.tanh((a - t) / (1 - t))); }
    }
    const ceil = 10 ** (-1.2 / 20);
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
    const look = Math.round(0.004 * fs), need = new Float32Array(n), dq = [];
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
      if (peak[i] * g > ceil) g = Math.min(g, ceil / peak[i]);
      for (const c of res) c[i] *= g;
    }
    return res;
  };
  const before = loudness(out, fs).I;
  let gDb = plan.target - before;
  let res = limited(out, gDb);
  onProgress(0.85);
  const got = loudness(res, fs).I;
  if (Math.abs(got - plan.target) > 0.25) { gDb += clamp(plan.target - got, -3, 3); res = limited(out, gDb); }
  out = res;
  stages.push('loudness');
  onProgress(0.97);
  for (const c of out) for (let i = 0; i < n; i++) c[i] = clamp(c[i], -1, 1);
  return { chs: out, stages };
}

export { BANDS };
