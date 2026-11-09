// Note detection and correction for a monophonic voice, built like Melodyne:
//   1. pitch track: YIN difference function -> pitch candidates -> HMM/Viterbi (pYIN style)
//   2. "blobs": the pitch track is cut into notes; every note gets a pitch centre
//   3. correction moves each note's centre (keeping vibrato and slides) and can flatten drift
//   4. rendering: TD-PSOLA (pitch marks + overlap-add of two-period grains), which keeps the
//      formants of the voice, so it does not sound like a chipmunk when shifted.
import { fft, nextPow2 } from './fft.js';

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const MIDI_LO = 33, MIDI_HI = 88; // A1 .. E6
const BIN = 0.2; // HMM pitch grid: 20 cents
const NB = Math.round((MIDI_HI - MIDI_LO) / BIN) + 1;
export const hz2midi = (f) => 69 + 12 * Math.log2(f / 440);
export const midi2hz = (m) => 440 * 2 ** ((m - 69) / 12);
export const noteName = (m) => NOTE_NAMES[((Math.round(m) % 12) + 12) % 12] + (Math.floor(Math.round(m) / 12) - 1);

// ---------------------------------------------------------------- 1. pitch track
function decimate(x, fs) {
  const k = Math.max(1, Math.round(fs / 16000));
  if (k === 1) return { y: x, fs };
  // windowed-sinc low-pass at 0.45 x the new Nyquist, then keep every k-th sample
  const taps = 8 * k + 1, h = new Float32Array(taps), fc = 0.45 / k, mid = (taps - 1) / 2;
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const t = i - mid;
    h[i] = (t === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * t) / (Math.PI * t)) * (0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (taps - 1)));
    sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;
  const n = Math.floor(x.length / k), y = new Float32Array(n);
  for (let j = 0; j < n; j++) {
    const c = j * k;
    let v = 0;
    for (let i = 0; i < taps; i++) { const s = c + i - mid; if (s >= 0 && s < x.length) v += h[i] * x[s]; }
    y[j] = v;
  }
  return { y, fs: fs / k };
}

// pYIN-style threshold prior: Beta(2, 18)-ish weights over thresholds 0.01 .. 0.5
const THR = Array.from({ length: 50 }, (_, i) => 0.01 * (i + 1));
const THR_W = (() => {
  const w = THR.map((t) => t * (1 - t) ** 17);
  const s = w.reduce((a, b) => a + b, 0);
  return w.map((v) => v / s);
})();

/**
 * Pitch track of a mono signal.
 * Returns { hop (seconds per frame), midi: Float32Array (NaN = unvoiced), conf, rmsDb }
 */
export function trackPitch(mono, fsIn, onProgress = () => {}) {
  const { y: x, fs } = decimate(mono, fsIn);
  const hop = Math.round(0.005 * fs);
  const tauMin = Math.floor(fs / midi2hz(MIDI_HI)), tauMax = Math.ceil(fs / midi2hz(MIDI_LO));
  const W = tauMax + 2; // integration window: a bit more than the longest period
  const N = nextPow2(W + tauMax + 1);
  const frames = Math.max(1, Math.floor((x.length - W - tauMax) / hop) + 1);
  const rmsDb = new Float32Array(frames);
  const cands = new Array(frames);
  const ra = new Float64Array(N), ia = new Float64Array(N), rb = new Float64Array(N), ib = new Float64Array(N);
  const d = new Float64Array(tauMax + 2), dn = new Float64Array(tauMax + 2);
  // prefix sums of x^2 for the energy terms of the difference function
  const sq = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) sq[i + 1] = sq[i] + x[i] * x[i];
  for (let f = 0; f < frames; f++) {
    const s = f * hop;
    const e0 = sq[s + W] - sq[s];
    rmsDb[f] = 10 * Math.log10(e0 / W + 1e-12);
    // r(tau) = sum_j x[s+j] x[s+j+tau], j < W   (cross-correlation through the FFT)
    ra.fill(0); ia.fill(0); rb.fill(0); ib.fill(0);
    for (let j = 0; j < W; j++) ra[j] = x[s + j];
    for (let j = 0; j < W + tauMax; j++) rb[j] = x[s + j];
    fft(ra, ia); fft(rb, ib);
    for (let k = 0; k < N; k++) {
      const r = ra[k] * rb[k] + ia[k] * ib[k], i = ra[k] * ib[k] - ia[k] * rb[k];
      ra[k] = r; ia[k] = i;
    }
    fft(ra, ia, true);
    // d(tau) = e(s) + e(s+tau) - 2 r(tau); cumulative-mean normalised
    let run = 0;
    dn[0] = 1;
    for (let t = 1; t <= tauMax + 1; t++) {
      const et = sq[s + t + W] - sq[s + t];
      d[t] = Math.max(0, e0 + et - (2 * ra[t]) / N);
      run += d[t];
      dn[t] = run > 0 ? (d[t] * t) / run : 1;
    }
    // candidates: local minima of the normalised difference
    const list = [];
    for (let t = tauMin; t <= tauMax; t++) {
      if (dn[t] < dn[t - 1] && dn[t] <= dn[t + 1] && dn[t] < 0.6) {
        const a = dn[t - 1], b = dn[t], c = dn[t + 1];
        const den = a - 2 * b + c;
        const off = den > 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
        list.push({ tau: t + off, v: b - 0.25 * (a - c) * off });
      }
    }
    // probability of each candidate = prior mass of thresholds for which it is the first dip below
    const probs = new Float32Array(list.length);
    for (let ti = 0; ti < THR.length; ti++) {
      let hit = -1;
      for (let c = 0; c < list.length; c++) if (list[c].v < THR[ti]) { hit = c; break; }
      if (hit < 0 && list.length) {
        // no dip below the threshold: a little mass on the deepest one (as pYIN does)
        let best = 0; for (let c = 1; c < list.length; c++) if (list[c].v < list[best].v) best = c;
        probs[best] += THR_W[ti] * 0.01;
      } else if (hit >= 0) probs[hit] += THR_W[ti];
    }
    cands[f] = list.map((c, i) => ({ m: hz2midi(fs / c.tau), p: probs[i], v: c.v })).filter((c) => c.p > 1e-4 && c.m >= MIDI_LO && c.m <= MIDI_HI);
    if ((f & 1023) === 0) onProgress(0.7 * (f / frames));
  }

  // silence gate relative to the loud parts of the track
  const sorted = Float32Array.from(rmsDb).sort();
  const loud = sorted[Math.floor(frames * 0.95)] ?? -20;
  const gate = Math.max(-70, loud - 40);

  // ---- Viterbi over (pitch bin x voiced/unvoiced); states 0..NB-1 voiced, NB..2NB-1 unvoiced
  const S = 2 * NB, MAXJ = 12; // up to 2.4 semitones per 5 ms frame
  const transW = new Float32Array(MAXJ + 1);
  { let s = 0; for (let j = 0; j <= MAXJ; j++) { transW[j] = MAXJ + 1 - j; s += j ? 2 * transW[j] : transW[j]; } for (let j = 0; j <= MAXJ; j++) transW[j] = Math.log(transW[j] / s); }
  const pStay = Math.log(0.99), pSwitch = Math.log(0.01);
  let prev = new Float32Array(S).fill(-Math.log(S));
  let cur = new Float32Array(S);
  const back = new Int16Array(frames * S);
  const obs = new Float32Array(S);
  for (let f = 0; f < frames; f++) {
    obs.fill(0);
    let vsum = 0;
    for (const c of cands[f]) {
      const b = Math.round((c.m - MIDI_LO) / BIN);
      if (b >= 0 && b < NB) { obs[b] += c.p; vsum += c.p; }
    }
    vsum = Math.min(1, vsum);
    const gateK = rmsDb[f] < gate ? 0.02 : 1;
    const vprob = vsum * gateK;
    for (let b = 0; b < NB; b++) {
      obs[b] = Math.log(Math.max(1e-9, obs[b] * gateK * 0.99 + 1e-6 / NB));
      obs[NB + b] = Math.log(Math.max(1e-9, (1 - vprob) / NB));
    }
    // best unvoiced/voiced predecessor regardless of pitch is not allowed: pitch is kept in both
    for (let b = 0; b < NB; b++) {
      let bv = -Infinity, bvi = 0, bu = -Infinity, bui = 0;
      const lo = Math.max(0, b - MAXJ), hi = Math.min(NB - 1, b + MAXJ);
      for (let a = lo; a <= hi; a++) {
        const tw = transW[Math.abs(a - b)];
        const fromV = prev[a] + tw, fromU = prev[NB + a] + tw;
        // to voiced b
        const v1 = fromV + pStay, v2 = fromU + pSwitch;
        if (v1 > bv) { bv = v1; bvi = a; } if (v2 > bv) { bv = v2; bvi = NB + a; }
        // to unvoiced b
        const u1 = fromU + pStay, u2 = fromV + pSwitch;
        if (u1 > bu) { bu = u1; bui = NB + a; } if (u2 > bu) { bu = u2; bui = a; }
      }
      cur[b] = bv + obs[b]; back[f * S + b] = bvi;
      cur[NB + b] = bu + obs[NB + b]; back[f * S + NB + b] = bui;
    }
    // normalise to keep numbers small
    let mx = -Infinity; for (let i = 0; i < S; i++) if (cur[i] > mx) mx = cur[i];
    for (let i = 0; i < S; i++) cur[i] -= mx;
    [prev, cur] = [cur, prev];
    if ((f & 1023) === 0) onProgress(0.7 + 0.28 * (f / frames));
  }
  let st = 0; for (let i = 1; i < S; i++) if (prev[i] > prev[st]) st = i;
  const path = new Int16Array(frames);
  for (let f = frames - 1; f >= 0; f--) { path[f] = st; st = back[f * S + st]; }

  const midi = new Float32Array(frames).fill(NaN), conf = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const s = path[f];
    if (s >= NB) continue;
    const m0 = MIDI_LO + s * BIN;
    // refine with the exact candidate that the path went through
    let best = null;
    for (const c of cands[f]) if (Math.abs(c.m - m0) <= BIN * 1.5 && (!best || c.p > best.p)) best = c;
    midi[f] = best ? best.m : m0;
    conf[f] = best ? Math.min(1, best.p * 1.2) : 0.2;
  }
  // drop voiced islands shorter than 30 ms (clicks, breaths)
  for (let f = 0; f < frames;) {
    if (Number.isNaN(midi[f])) { f++; continue; }
    let e = f; while (e < frames && !Number.isNaN(midi[e])) e++;
    if (e - f < 6) for (let i = f; i < e; i++) midi[i] = NaN;
    f = e;
  }
  // frame centre time: the analysis window starts at f*hop and is W long
  return { hop: hop / fs, offset: W / 2 / fs, midi, conf, rmsDb, gate };
}

// ---------------------------------------------------------------- 2. notes ("blobs")
/**
 * Cut the pitch track into notes. Each note: { id, i0, i1 (frames, end exclusive), center, target, keep, gain }
 */
export function findNotes(track) {
  const { midi, rmsDb, hop } = track;
  const n = midi.length;
  const notes = [];
  // smoothed pitch: 150 ms average removes vibrato (5-7 Hz) but keeps steps between notes
  const half = Math.max(1, Math.round(0.075 / hop));
  const sm = new Float32Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(midi[i])) continue;
    let s = 0, c = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) if (!Number.isNaN(midi[j])) { s += midi[j]; c++; }
    sm[i] = s / c;
  }
  const minLen = Math.round(0.06 / hop), hold = Math.round(0.04 / hop), onsetWin = Math.round(0.03 / hop);
  let f = 0;
  while (f < n) {
    if (Number.isNaN(midi[f])) { f++; continue; }
    let e = f; while (e < n && (!Number.isNaN(midi[e]) || (e + 3 < n && !Number.isNaN(midi[e + 3]) && Number.isNaN(midi[e])))) e++; // bridge 15 ms gaps
    // split the voiced run [f, e)
    const cuts = [f];
    let center = sm[f], out = 0, outStart = -1;
    for (let i = f + 1; i < e; i++) {
      if (Number.isNaN(sm[i])) continue;
      const dev = sm[i] - center;
      if (Math.abs(dev) > 0.6) { if (outStart < 0) outStart = i; out++; } else { out = 0; outStart = -1; if (Math.abs(dev) < 0.3) center += (sm[i] - center) * 0.05; }
      // energy onset on a steady pitch = repeated note
      const onset = i - onsetWin > f && rmsDb[i] - rmsDb[i - onsetWin] > 7 && i - cuts[cuts.length - 1] > minLen;
      if (out >= hold || onset) {
        let at = onset && out < hold ? i : outStart;
        // cut where the smoothed pitch crosses half-way between the old and the new note
        if (!onset || out >= hold) {
          const target = center + Math.sign(dev) * 0.5;
          for (let k = outStart; k > cuts[cuts.length - 1] + 1; k--) { if (!Number.isNaN(sm[k]) && Math.sign(sm[k] - target) !== Math.sign(dev)) { at = k + 1; break; } }
        }
        if (at - cuts[cuts.length - 1] >= minLen / 2) cuts.push(at);
        center = sm[i]; out = 0; outStart = -1;
      }
    }
    cuts.push(e);
    for (let k = 0; k + 1 < cuts.length; k++) notes.push({ i0: cuts[k], i1: cuts[k + 1] });
    f = e;
  }
  // merge too-short notes into the closer neighbour
  for (let changed = true; changed;) {
    changed = false;
    for (let k = 0; k < notes.length; k++) {
      const a = notes[k];
      if (a.i1 - a.i0 >= minLen) continue;
      const L = notes[k - 1], R = notes[k + 1];
      const touchL = L && L.i1 === a.i0, touchR = R && R.i0 === a.i1;
      if (!touchL && !touchR) { notes.splice(k, 1); changed = true; break; }
      const mc = centerOf(midi, a.i0, a.i1);
      const dl = touchL ? Math.abs(centerOf(midi, L.i0, L.i1) - mc) : Infinity;
      const dr = touchR ? Math.abs(centerOf(midi, R.i0, R.i1) - mc) : Infinity;
      if (dl <= dr) L.i1 = a.i1; else R.i0 = a.i0;
      notes.splice(k, 1); changed = true; break;
    }
  }
  // glides into a note (scoops) and falls out of it belong to that note, as in Melodyne:
  // a short piece whose pitch lies between its neighbours is joined to the next (or previous) note
  const glideLen = Math.round(0.13 / hop);
  for (let k = 0; k < notes.length; k++) {
    const a = notes[k];
    if (a.i1 - a.i0 >= glideLen) continue;
    const L = notes[k - 1], R = notes[k + 1];
    const touchL = L && L.i1 === a.i0, touchR = R && R.i0 === a.i1;
    const mc = centerOf(midi, a.i0, a.i1);
    const cl = touchL ? centerOf(midi, L.i0, L.i1) : NaN, cr = touchR ? centerOf(midi, R.i0, R.i1) : NaN;
    const between = touchL && touchR && (mc - cl) * (cr - mc) > 0;
    if (touchR && (between || !touchL || Math.abs(cr - mc) < 1)) { R.i0 = a.i0; notes.splice(k--, 1); }
    else if (touchL && Math.abs(cl - mc) < 1) { L.i1 = a.i1; notes.splice(k--, 1); }
  }
  return notes.map((x, id) => {
    const c = centerOf(midi, x.i0, x.i1);
    return { id, i0: x.i0, i1: x.i1, center: c, target: c, keep: 1, gain: 0 };
  }).filter((x) => Number.isFinite(x.center));
}

// pitch centre: median of the middle 70 % of the note (attack scoops and release falls left out)
function centerOf(midi, i0, i1) {
  const a = i0 + Math.floor((i1 - i0) * 0.15), b = Math.max(a + 1, i1 - Math.floor((i1 - i0) * 0.15));
  const v = [];
  for (let i = a; i < b; i++) if (!Number.isNaN(midi[i])) v.push(midi[i]);
  if (!v.length) for (let i = i0; i < i1; i++) if (!Number.isNaN(midi[i])) v.push(midi[i]);
  if (!v.length) return NaN;
  v.sort((p, q) => p - q);
  return v[v.length >> 1];
}

// ---------------------------------------------------------------- 3. correction
const MAJOR = [0, 2, 4, 5, 7, 9, 11], MINOR = [0, 2, 3, 5, 7, 8, 10];
export function scaleOf(key) {
  if (!key) return null;
  const tonic = typeof key.name === 'string' ? NOTE_NAMES.indexOf(key.name) : key.tonic;
  if (tonic < 0) return null;
  return (key.mode === 'minor' ? MINOR : MAJOR).map((x) => (x + tonic) % 12);
}
export function snap(m, scale) {
  if (!scale) return Math.round(m);
  let best = Math.round(m), bd = Infinity;
  for (let k = Math.floor(m) - 2; k <= Math.ceil(m) + 2; k++) {
    if (!scale.includes(((k % 12) + 12) % 12)) continue;
    const dd = Math.abs(k - m);
    if (dd < bd) { bd = dd; best = k; }
  }
  return best;
}

/** Melodyne-style "Correct pitch" macro: centre amount 0..1, drift amount 0..1, tolerance in cents. */
export function autoCorrect(notes, { scale = null, center = 1, drift = 0.3, tolerance = 0 } = {}) {
  return notes.map((n) => {
    const s = snap(n.center, scale);
    const dev = s - n.center;
    const move = Math.abs(dev) * 100 <= tolerance ? 0 : dev * center;
    return { ...n, target: n.center + move, keep: 1 - drift };
  });
}

/** Semitone shift for every pitch frame, smoothed at note edges. */
export function shiftCurve(track, notes) {
  const { midi, hop } = track;
  const n = midi.length;
  const sh = new Float32Array(n), gain = new Float32Array(n), own = new Int8Array(n);
  for (const no of notes) {
    const base = no.target - no.center;
    for (let i = no.i0; i < no.i1 && i < n; i++) {
      const m = midi[i];
      sh[i] = Number.isNaN(m) ? base : base - (m - no.center) * (1 - no.keep);
      gain[i] = no.gain || 0;
      own[i] = 1;
    }
  }
  // gaps between notes: glide between the neighbours (short gaps) or fall back to 0
  const glide = Math.round(0.1 / hop);
  for (let i = 0; i < n;) {
    if (own[i]) { i++; continue; }
    let e = i; while (e < n && !own[e]) e++;
    const a = i > 0 ? sh[i - 1] : 0, b = e < n ? sh[e] : 0;
    const ga = i > 0 ? gain[i - 1] : 0, gb = e < n ? gain[e] : 0;
    const len = e - i;
    for (let k = i; k < e; k++) {
      const t = (k - i + 1) / (len + 1);
      if (len <= glide) { sh[k] = a + (b - a) * t; gain[k] = ga + (gb - ga) * t; }
      else {
        const r = Math.round(0.03 / hop);
        const fa = Math.max(0, 1 - (k - i + 1) / r), fb = Math.max(0, 1 - (e - k) / r);
        sh[k] = a * fa + b * fb; gain[k] = ga * fa + gb * fb;
      }
    }
    i = e;
  }
  // 20 ms smoothing so note-to-note jumps do not click
  const w = Math.max(1, Math.round(0.01 / hop));
  const out = new Float32Array(n), og = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, g = 0, c = 0;
    for (let j = Math.max(0, i - w); j <= Math.min(n - 1, i + w); j++) { s += sh[j]; g += gain[j]; c++; }
    out[i] = s / c; og[i] = g / c;
  }
  return { shift: out, gain: og };
}

// ---------------------------------------------------------------- 4. TD-PSOLA rendering
/**
 * Apply the shift curve to the audio. chs: Float32Array[] (same length), fs sample rate.
 * Only the parts that change are processed; everything else stays bit-identical.
 */
export function renderPitch(chs, fs, track, curve, onProgress = () => {}) {
  const n = chs[0].length, { hop, offset, midi } = track;
  const frames = midi.length;
  const frameAt = (s) => Math.max(0, Math.min(frames - 1, (s / fs - offset) / hop));
  const lerp = (arr, s) => { const x = frameAt(s), i = Math.floor(x), t = x - i; const a = arr[i], b = arr[Math.min(frames - 1, i + 1)]; return a + (b - a) * t; };
  const f0At = (s) => {
    const x = frameAt(s), i = Math.round(x);
    const m = midi[i];
    if (Number.isNaN(m)) return 0;
    const j = Math.min(frames - 1, Math.floor(x) + 1), i0 = Math.floor(x);
    const a = midi[i0], b = midi[j];
    const mm = !Number.isNaN(a) && !Number.isNaN(b) ? a + (b - a) * (x - i0) : m;
    return midi2hz(mm);
  };
  const out = chs.map((c) => Float32Array.from(c));
  // regions where something changes
  const active = (i) => Math.abs(curve.shift[i]) > 0.005 || Math.abs(curve.gain[i]) > 0.05;
  const regions = [];
  const pad = Math.round(0.04 / hop), join = Math.round(0.1 / hop);
  for (let i = 0; i < frames; i++) {
    if (!active(i)) continue;
    let e = i; while (e < frames && (active(e) || (e + join < frames && [...Array(join)].some((_, k) => active(e + k))))) e++;
    const a = Math.max(0, i - pad), b = Math.min(frames, e + pad);
    if (regions.length && a <= regions[regions.length - 1][1]) regions[regions.length - 1][1] = b; else regions.push([a, b]);
    i = e;
  }
  // mono low-passed signal for pitch marks
  const mono = new Float32Array(n);
  for (const c of chs) for (let i = 0; i < n; i++) mono[i] += c[i] / chs.length;
  const lp = new Float32Array(n);
  {
    // 2nd-order Butterworth low-pass at 1 kHz, run forwards and backwards (no phase shift)
    const w0 = (2 * Math.PI * 1000) / fs, al = Math.sin(w0) / Math.SQRT2, cs = Math.cos(w0), a0 = 1 + al;
    const b0 = (1 - cs) / 2 / a0, b1 = (1 - cs) / a0, b2 = b0, a1 = (-2 * cs) / a0, a2 = (1 - al) / a0;
    const run = (src, dst, dir) => {
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let k = 0; k < n; k++) {
        const i = dir > 0 ? k : n - 1 - k;
        const y = b0 * src[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = src[i]; y2 = y1; y1 = y; dst[i] = y;
      }
    };
    const tmp = new Float32Array(n);
    run(mono, tmp, 1); run(tmp, lp, -1);
  }
  const UNV = Math.round(0.005 * fs); // pseudo period in unvoiced parts
  let done = 0;
  const total = regions.reduce((s, r) => s + r[1] - r[0], 0) || 1;
  for (const [fa, fb] of regions) {
    const A = Math.max(0, Math.floor((fa * hop + offset) * fs)), B = Math.min(n, Math.ceil((fb * hop + offset) * fs));
    if (B - A < 4 * UNV) continue;
    // ---- analysis marks: one per period, on the biggest positive peak of the low-passed voice
    const marks = [], per = [];
    let t = A;
    {
      const f = f0At(t), P = f ? Math.round(fs / f) : UNV;
      let best = t; for (let k = t; k < Math.min(B, t + P); k++) if (lp[k] > lp[best]) best = k;
      t = f ? best : t;
    }
    while (t < B) {
      const f = f0At(t);
      const P = f ? Math.max(16, Math.round(fs / f)) : UNV;
      marks.push(t); per.push(P);
      let nx = t + P;
      if (f && nx < B) {
        const r = Math.round(P * 0.2);
        let best = nx; for (let k = Math.max(t + 1, nx - r); k <= Math.min(n - 1, nx + r); k++) if (lp[k] > lp[best]) best = k;
        nx = best;
      }
      t = Math.max(t + 1, nx);
    }
    if (marks.length < 3) continue;
    // ---- synthesis: walk through the region with the new period, copy the nearest grain
    const len = B - A, acc = chs.map(() => new Float32Array(len)), wsum = new Float32Array(len);
    let ts = marks[0], k = 0;
    while (ts < B) {
      while (k + 1 < marks.length && Math.abs(marks[k + 1] - ts) <= Math.abs(marks[k] - ts)) k++;
      const m = marks[k];
      const Pl = k > 0 ? m - marks[k - 1] : per[k], Pr = k + 1 < marks.length ? marks[k + 1] - m : per[k];
      const voiced = f0At(m) > 0;
      const ratio = voiced ? 2 ** (lerp(curve.shift, m) / 12) : 1;
      const g = 10 ** (lerp(curve.gain, m) / 20);
      for (let j = -Pl; j < Pr; j++) {
        const src = m + j, dst = ts + j - A;
        if (src < 0 || src >= n || dst < 0 || dst >= len) continue;
        const w = j < 0 ? 0.5 + 0.5 * Math.cos((Math.PI * j) / Pl) : 0.5 + 0.5 * Math.cos((Math.PI * j) / Pr);
        for (let c = 0; c < chs.length; c++) acc[c][dst] += chs[c][src] * w * g;
        wsum[dst] += w;
      }
      const step = voiced ? Math.max(8, Math.round((Pr + Pl) / 2 / ratio)) : Math.round((Pr + Pl) / 2);
      ts += step;
    }
    // ---- keep the power constant: the window sum averaged over ~8 ms is about the pitch ratio,
    // so dividing by its square root keeps the loudness while gaps between sparse grains stay gaps
    const fade = Math.min(Math.round(0.01 * fs), len >> 2);
    const half = Math.round(0.004 * fs), pre = new Float64Array(len + 1);
    for (let i = 0; i < len; i++) pre[i + 1] = pre[i] + wsum[i];
    for (let i = 0; i < len; i++) {
      const x = A + i;
      const wf = Math.min(1, i / fade, (len - 1 - i) / fade);
      const a = Math.max(0, i - half), b = Math.min(len, i + half + 1);
      const avg = (pre[b] - pre[a]) / (b - a);
      if (avg < 0.05) continue;
      const norm = 1 / Math.sqrt(avg);
      for (let c = 0; c < chs.length; c++) out[c][x] = chs[c][x] * (1 - wf) + acc[c][i] * norm * wf;
    }
    done += fb - fa;
    onProgress(done / total);
  }
  return out;
}
