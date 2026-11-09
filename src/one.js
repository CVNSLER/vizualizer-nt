// Template "1": a template *builder*. Every sound (kick, snare, closed hat, open hi-hat, bass, vocal)
// gets its own animated layer. autoLayers() designs the layers from the "Algoritm" analysis.
import { draw, drawBackground, rng, rgba, TAU, hexToRgb } from './templates.js';

export const SOUNDS = ['bass', 'vocal', 'kick', 'snare', 'hat', 'ohat'];
export const EFFECTS = ['ring', 'bloom', 'orb', 'bars', 'particles', 'flash', 'wave', 'sparkle', 'streaks', 'zoom', 'shake'];
export const POSITIONS = ['center', 'top', 'bottom', 'left', 'right', 'full'];

// which effects suit which sound (first = most typical)
const FIT = {
  kick: ['ring', 'zoom', 'orb', 'bloom', 'shake'],
  snare: ['flash', 'particles', 'streaks', 'ring'],
  hat: ['sparkle', 'bars', 'particles'],
  ohat: ['streaks', 'sparkle', 'bloom'],
  bass: ['wave', 'orb', 'bars', 'shake'],
  vocal: ['bloom', 'wave', 'particles'],
};
const DEFAULT_POS = { kick: 'center', snare: 'full', hat: 'top', ohat: 'full', bass: 'bottom', vocal: 'top' };

// ---------------------------------------------------------------- colour helpers
function hsl(h, s, l) {
  h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return '#' + [f(0), f(8), f(4)].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
}
function hexHue(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (!d) return 0;
  let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return h * 60;
}
const KEY_HUE = { C: 0, G: 30, D: 60, A: 90, E: 120, B: 150, 'F#': 180, 'C#': 210, 'G#': 240, 'D#': 270, 'A#': 300, F: 330 };

/** Design the layers from the deep analysis. `seed` gives a different variant each time. */
export function autoLayers(deep, o, seed = 1) {
  const R = rng(seed * 7919 + 17);
  const pick = (arr, bias = 0.6) => (R() < bias ? arr[0] : arr[1 + Math.floor(R() * (arr.length - 1))]);
  const dur = deep?.duration || 60;
  const bars = Math.max(1, deep?.downbeats?.length || dur / 2);
  const per = (k) => (deep?.events?.[k]?.length || 0) / bars;
  const vocalCover = deep ? deep.vocals.reduce((s, v) => s + v.t1 - v.t0, 0) / dur : 0;
  const presence = {
    kick: Math.min(1, per('kick') / 3), snare: Math.min(1, per('snare') / 2), hat: Math.min(1, per('hat') / 6),
    ohat: Math.min(1, per('ohat') / 2), bass: Math.min(1, per('bass') / 2 + 0.3), vocal: Math.min(1, vocalCover * 2),
  };
  // palette: user colours, nudged by the musical key (minor keys darker / cooler)
  const baseHue = deep ? (KEY_HUE[deep.key.name] ?? hexHue(o.color1)) : hexHue(o.color1);
  const minor = deep?.key?.mode === 'minor';
  const spread = 35 + R() * 50;
  const hues = { kick: baseHue, snare: baseHue + spread * 2, hat: baseHue + spread * 3, ohat: baseHue + spread * 2.5, bass: baseHue - spread, vocal: baseHue + 180 };
  const sat = minor ? 75 : 85, lit = minor ? 58 : 62;
  const useUser = R() < 0.5;
  const layers = SOUNDS.map((k) => {
    const color = useUser ? (k === 'kick' || k === 'bass' ? o.color1 : k === 'vocal' ? '#ffd2a1' : o.color2) : hsl(hues[k], sat, lit);
    return {
      sound: k,
      on: presence[k] > 0.08,
      effect: pick(FIT[k]),
      color,
      amount: Math.round((0.45 + 0.55 * presence[k]) * 100) / 100,
      pos: DEFAULT_POS[k],
    };
  });
  // at most one camera effect, and only on the strongest low-end sound
  let camera = false;
  for (const l of layers) {
    if (l.effect === 'zoom' || l.effect === 'shake') {
      if (camera || !(l.sound === 'kick' || l.sound === 'bass')) l.effect = FIT[l.sound].find((e) => e !== 'zoom' && e !== 'shake');
      else camera = true;
    }
  }
  return layers;
}

// ---------------------------------------------------------------- drawing
function anchor(pos, W, H) {
  return {
    center: [W / 2, H / 2], top: [W / 2, H * 0.25], bottom: [W / 2, H * 0.78], left: [W * 0.25, H / 2], right: [W * 0.75, H / 2], full: [W / 2, H / 2],
  }[pos] || [W / 2, H / 2];
}
function valueOf(f, sound) {
  switch (sound) {
    case 'kick': return f.kick;
    case 'snare': return f.snare;
    case 'hat': return f.hatc ?? f.hat;
    case 'ohat': return f.ohat;
    case 'bass': return f.bassLine ?? f.bass;
    case 'vocal': return f.vocal;
    default: return 0;
  }
}
const BAND_RANGE = { kick: [0, 0.18], bass: [0, 0.25], snare: [0.3, 0.6], vocal: [0.35, 0.7], hat: [0.75, 1], ohat: [0.7, 1] };

function drawLayer(ctx, W, H, o, f, L, u) {
  const v = Math.min(1.4, valueOf(f, L.sound) * L.amount * o.sens);
  const [cx, cy] = anchor(L.pos, W, H);
  const full = L.pos === 'full';
  const size = Math.min(W, H);
  const col = L.color;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  switch (L.effect) {
    case 'ring': {
      // one ring per event, expanding and fading
      const list = f.recent ? f.recent(L.sound, 1.2) : [];
      for (const e of list) {
        const age = f.t - e.t, k = age / 1.2;
        const r = size * (0.08 + 0.45 * Math.pow(k, 0.6)) * (full ? 1.4 : 1);
        ctx.strokeStyle = rgba(col, (1 - k) * Math.min(1, e.s) * L.amount);
        ctx.lineWidth = (2 + 10 * (1 - k)) * u;
        ctx.shadowColor = col; ctx.shadowBlur = 20 * u;
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.stroke();
      }
      break;
    }
    case 'bloom': {
      if (v < 0.01) break;
      const r = (full ? Math.hypot(W, H) * 0.6 : size * 0.45) * (0.7 + 0.5 * v);
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, rgba(col, Math.min(0.85, 0.6 * v))); g.addColorStop(1, rgba(col, 0));
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      break;
    }
    case 'orb': {
      const r = size * (0.06 + 0.1 * v);
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 2.2);
      g.addColorStop(0, rgba('#ffffff', 0.9 * Math.min(1, 0.3 + v)));
      g.addColorStop(0.35, rgba(col, 0.8 * Math.min(1, 0.3 + v)));
      g.addColorStop(1, rgba(col, 0));
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, r * 2.2, 0, TAU); ctx.fill();
      break;
    }
    case 'bars': {
      const [a, b] = BAND_RANGE[L.sound] || [0, 1];
      const n = 24, w = (full ? W * 0.9 : size * 0.7), x0 = cx - w / 2, bw = w / n;
      for (let i = 0; i < n; i++) {
        const bi = Math.floor((a + (b - a) * (i / n)) * (f.bands.length - 1));
        const h = Math.max(2 * u, f.bands[bi] * (0.4 + 0.6 * v) * size * 0.22);
        ctx.fillStyle = rgba(col, 0.55 + 0.45 * Math.min(1, v));
        ctx.fillRect(x0 + i * bw + bw * 0.2, cy - h / 2, bw * 0.6, h);
      }
      break;
    }
    case 'particles': {
      const list = f.recent ? f.recent(L.sound, 1.4) : [];
      for (const e of list) {
        const R = rng(Math.floor(e.t * 1000) + L.sound.length);
        const age = f.t - e.t, k = age / 1.4;
        const cnt = Math.round(14 + 20 * Math.min(1.2, e.s) * L.amount);
        for (let i = 0; i < cnt; i++) {
          const a = R() * TAU, sp = (0.15 + R() * 0.45) * size * (full ? 1.3 : 1);
          const d = sp * (1 - Math.pow(1 - Math.min(1, k), 2));
          const sx = full ? R() * W : cx, sy = full ? R() * H : cy;
          ctx.fillStyle = rgba(col, (1 - k) * 0.9);
          ctx.beginPath(); ctx.arc(sx + Math.cos(a) * d, sy + Math.sin(a) * d, (1.5 + R() * 3.5) * u * (1 - k * 0.6), 0, TAU); ctx.fill();
        }
      }
      break;
    }
    case 'flash': {
      if (v < 0.01) break;
      if (full) {
        const g = ctx.createRadialGradient(W / 2, H / 2, Math.hypot(W, H) * 0.15, W / 2, H / 2, Math.hypot(W, H) * 0.6);
        g.addColorStop(0, rgba(col, 0.08 * v)); g.addColorStop(1, rgba(col, Math.min(0.9, 0.65 * v)));
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      } else {
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 0.5);
        g.addColorStop(0, rgba(col, Math.min(0.9, 0.7 * v))); g.addColorStop(1, rgba(col, 0));
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      }
      break;
    }
    case 'wave': {
      const amp = size * 0.12 * (0.25 + v);
      const span = full ? W : size * 0.85, x0 = cx - span / 2;
      ctx.strokeStyle = rgba(col, 0.5 + 0.5 * Math.min(1, v + 0.2));
      ctx.lineWidth = 3 * u; ctx.shadowColor = col; ctx.shadowBlur = 16 * u;
      ctx.beginPath();
      for (let i = 0; i <= 120; i++) {
        const k = i / 120, env = Math.sin(k * Math.PI);
        const s = L.sound === 'bass' ? f.bassWave((k - 0.5) * 0.06) : f.wave((k - 0.5) * 0.03);
        const y = cy + s * amp * env;
        i ? ctx.lineTo(x0 + k * span, y) : ctx.moveTo(x0, y);
      }
      ctx.stroke();
      break;
    }
    case 'sparkle': {
      if (v < 0.02) break;
      const R = rng(Math.floor(f.t * 20) * 31 + L.sound.length);
      const cnt = Math.round(30 + 60 * v);
      const area = full ? [0, 0, W, H] : [cx - size * 0.45, cy - size * 0.2, size * 0.9, size * 0.4];
      for (let i = 0; i < cnt; i++) {
        const x = area[0] + R() * area[2], y = area[1] + R() * area[3], s = (1 + R() * 2.5) * u;
        ctx.fillStyle = rgba(R() > 0.7 ? '#ffffff' : col, Math.min(1, v) * (0.4 + 0.6 * R()));
        ctx.fillRect(x - s / 2, y - s / 2, s, s);
      }
      break;
    }
    case 'streaks': {
      const list = f.recent ? f.recent(L.sound, 0.5) : [];
      for (const e of list) {
        const R = rng(Math.floor(e.t * 1000) + 3);
        const k = (f.t - e.t) / 0.5;
        for (let i = 0; i < 6; i++) {
          const x = full ? R() * W : cx + (R() - 0.5) * size * 0.8;
          const g = ctx.createLinearGradient(0, 0, 0, H);
          g.addColorStop(0, rgba(col, 0)); g.addColorStop(0.5, rgba(col, (1 - k) * 0.7 * Math.min(1, e.s))); g.addColorStop(1, rgba(col, 0));
          ctx.fillStyle = g; ctx.fillRect(x - 3 * u, 0, 6 * u, H);
        }
      }
      break;
    }
    default: break;
  }
  ctx.restore();
}

draw.one = (ctx, W, H, o, f) => {
  const u = Math.min(W, H) / 1080;
  const layers = Array.isArray(o.layers) && o.layers.length ? o.layers : autoLayers(null, o, 1);
  // camera layers move the whole picture
  let zoom = 1, dx = 0, dy = 0;
  for (const L of layers) {
    if (!L.on) continue;
    const v = Math.min(1.4, valueOf(f, L.sound) * L.amount * o.sens);
    if (L.effect === 'zoom') zoom += 0.06 * v;
    if (L.effect === 'shake') { const a = 18 * u * v; dx += a * f.bassWave(0); dy += a * f.bassWave(0.004); }
  }
  ctx.save();
  if (zoom !== 1 || dx || dy) { ctx.translate(W / 2 + dx, H / 2 + dy); ctx.scale(zoom, zoom); ctx.translate(-W / 2, -H / 2); }
  drawBackground(ctx, W, H, o, f);
  for (const L of layers) if (L.on && L.effect !== 'zoom' && L.effect !== 'shake') drawLayer(ctx, W, H, o, f, L, u);
  ctx.restore();
};
