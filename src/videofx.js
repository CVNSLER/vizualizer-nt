// Music-driven effects for the background video / image.
// Everything is a pure function of time + audio analysis, so preview and export match.
import { ANALYSIS_FPS } from './audio.js';

export const FX_PRESETS = {
  none: { fxCut: 0, fxSpeed: 0, fxPunch: 0, fxDuotone: 0, fxGlitch: 0, fxVhs: 0 },
  calm: { fxCut: 0, fxSpeed: 0, fxPunch: 0.35, fxDuotone: 0.15, fxGlitch: 0, fxVhs: 0 },
  clip: { fxCut: 4, fxSpeed: 0, fxPunch: 0.8, fxDuotone: 0.2, fxGlitch: 0.2, fxVhs: 0 },
  drop: { fxCut: 8, fxSpeed: 0.8, fxPunch: 1, fxDuotone: 0, fxGlitch: 0.9, fxVhs: 0 },
  vhs: { fxCut: 0, fxSpeed: 0.3, fxPunch: 0.3, fxDuotone: 0.1, fxGlitch: 0.4, fxVhs: 0.9 },
  neon: { fxCut: 4, fxSpeed: 0, fxPunch: 0.7, fxDuotone: 0.85, fxGlitch: 0.2, fxVhs: 0 },
};
export const FX_KEYS = Object.keys(FX_PRESETS.none);

function rnd(seed) {
  let t = (seed * 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ---------------------------------------------------------------- time mapping (speed ramp + beat cuts)
const mapCache = new WeakMap();
function timeMap(an, o) {
  const key = `${o.fxSpeed || 0}|${o.fxCut || 0}`;
  let m = mapCache.get(an);
  if (!m) { m = new Map(); mapCache.set(an, m); }
  if (m.has(key)) return m.get(key);
  const n = an.frames;
  // slow energy curve 0..1
  const e = new Float32Array(n);
  let v = 0.5;
  for (let i = 0; i < n; i++) { v += (Math.min(1.3, an.rms[i]) - v) * 0.03; e[i] = v; }
  const sorted = Float32Array.from(e).sort();
  const lo = sorted[Math.floor(n * 0.1)] || 0, hi = sorted[Math.floor(n * 0.95)] || 1;
  const speed = new Float32Array(n);
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const k = hi > lo ? (e[i] - lo) / (hi - lo) : 0.5;
    speed[i] = o.fxSpeed > 0 ? Math.max(0.35, Math.min(2.5, 1 + o.fxSpeed * (k - 0.5) * 2.2)) : 1;
    cum[i + 1] = cum[i] + speed[i] / ANALYSIS_FPS;
  }
  const cuts = [];
  if (o.fxCut > 0) {
    const strong = an.beats.filter((b) => b.s >= 0.5);
    for (let i = o.fxCut; i < strong.length; i += o.fxCut) cuts.push(strong[i].t);
  }
  const data = { speed, cum, cuts };
  m.set(key, data);
  return data;
}

const cumAt = (d, t) => {
  const x = Math.max(0, t * ANALYSIS_FPS), i = Math.min(d.cum.length - 2, Math.floor(x));
  return d.cum[i] + (d.cum[i + 1] - d.cum[i]) * Math.min(1, x - i);
};

/** Where in the source video we should be at output time t. */
export function videoTimeAt(an, o, t, dur) {
  if (!dur || !isFinite(dur)) return 0;
  if (!an || (!(o.fxSpeed > 0) && !(o.fxCut > 0))) return t % dur;
  const d = timeMap(an, o);
  let k = 0;
  while (k < d.cuts.length && d.cuts[k] <= t) k++;
  const segStart = k ? d.cuts[k - 1] : 0;
  const offset = k ? rnd(k * 7919 + 13) * Math.max(0, dur - 1) : 0;
  const vt = offset + (cumAt(d, t) - cumAt(d, segStart));
  return ((vt % dur) + dur) % dur;
}

export function videoRateAt(an, o, t) {
  if (!an || !(o.fxSpeed > 0)) return 1;
  const d = timeMap(an, o);
  return d.speed[Math.max(0, Math.min(d.speed.length - 1, Math.floor(t * ANALYSIS_FPS)))];
}

// ---------------------------------------------------------------- per-frame looks
/** 0..~1.3 pulse right after a beat */
export function beatPulse(f) {
  if (!f.lastBeat) return 0;
  return Math.min(1.3, f.lastBeat.s) * Math.exp(-f.sinceBeat * 7);
}

let work = null, red = null, cyan = null, grain = null;
function sized(c, W, H) {
  if (!c) c = document.createElement('canvas');
  if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
  return c;
}

function hexRgb(h) {
  const n = parseInt(h.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Draw the colour / glitch / VHS layers over a background that is already on ctx. */
export function applyBgFx(ctx, W, H, o, f) {
  const u = Math.min(W, H) / 1080;
  const p = beatPulse(f);

  // duotone: palette colours take over the hue, the picture keeps its light and shade
  if (o.fxDuotone > 0) {
    ctx.save();
    ctx.globalCompositeOperation = 'color';
    ctx.globalAlpha = Math.min(1, o.fxDuotone);
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, o.color1); g.addColorStop(1, o.color2);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  // RGB split + slices on strong hits, constant light split for VHS
  const hit = o.fxGlitch > 0 && f.lastBeat && f.lastBeat.s > 0.7 ? Math.exp(-f.sinceBeat * 10) * o.fxGlitch : 0;
  const split = hit * 26 * u + (o.fxVhs || 0) * 4 * u;
  if (split > 0.6) {
    work = sized(work, W, H); red = sized(red, W, H); cyan = sized(cyan, W, H);
    const wc = work.getContext('2d');
    wc.globalCompositeOperation = 'copy'; wc.drawImage(ctx.canvas, 0, 0);
    for (const [c, col] of [[red, '#ff0000'], [cyan, '#00ffff']]) {
      const cc = c.getContext('2d');
      cc.globalCompositeOperation = 'copy'; cc.drawImage(work, 0, 0);
      cc.globalCompositeOperation = 'multiply'; cc.fillStyle = col; cc.fillRect(0, 0, W, H);
    }
    ctx.save();
    ctx.globalCompositeOperation = 'copy'; ctx.drawImage(cyan, split, 0);
    ctx.globalCompositeOperation = 'lighter'; ctx.drawImage(red, -split, 0);
    ctx.restore();
    if (hit > 0.15) {
      const seed = Math.floor(f.lastBeat.t * 1000);
      for (let i = 0; i < 7; i++) {
        const sy = rnd(seed + i * 3) * H, sh = (8 + rnd(seed + i * 3 + 1) * 70) * u;
        const off = (rnd(seed + i * 3 + 2) - 0.5) * 160 * u * hit;
        ctx.drawImage(ctx.canvas, 0, sy, W, sh, off, sy, W, sh);
      }
    }
  }

  // zoom-punch flash
  if (o.fxPunch > 0 && p > 0.02) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = `rgba(255,255,255,${Math.min(0.35, 0.22 * p * o.fxPunch)})`;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  // VHS: scanlines, grain, a little colour wash
  if (o.fxVhs > 0) {
    ctx.save();
    ctx.globalAlpha = 0.18 * o.fxVhs;
    ctx.fillStyle = '#000';
    const step = Math.max(2, Math.round(3 * u));
    for (let y = 0; y < H; y += step * 2) ctx.fillRect(0, y, W, step);
    if (!grain) {
      grain = document.createElement('canvas'); grain.width = grain.height = 256;
      const gc = grain.getContext('2d'), img = gc.createImageData(256, 256);
      for (let i = 0; i < img.data.length; i += 4) { const v = Math.random() * 255; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255; }
      gc.putImageData(img, 0, 0);
    }
    ctx.globalCompositeOperation = 'overlay';
    ctx.globalAlpha = 0.25 * o.fxVhs;
    const pat = ctx.createPattern(grain, 'repeat');
    const fr = Math.floor(f.t * 24);
    ctx.translate(rnd(fr) * 256, rnd(fr + 1) * 256);
    ctx.fillStyle = pat; ctx.fillRect(-256, -256, W + 512, H + 512);
    ctx.restore();
    // tracking band rolling down the screen
    const by = ((f.t * 0.15) % 1.2 - 0.1) * H;
    ctx.save();
    ctx.globalAlpha = 0.12 * o.fxVhs;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, by, W, 18 * u);
    ctx.restore();
    // warm wash
    const [r, g, b] = hexRgb('#ff9a3c');
    ctx.save(); ctx.globalCompositeOperation = 'soft-light'; ctx.fillStyle = `rgba(${r},${g},${b},${0.35 * o.fxVhs})`; ctx.fillRect(0, 0, W, H); ctx.restore();
  }
}
