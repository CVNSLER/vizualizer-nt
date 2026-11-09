// Colour analysis of the background picture / video for the "1" template's auto colours.
// k-means (k = 6) on a 48x48 thumbnail, then each sound gets a role-appropriate colour.
import { mediaOf } from './templates.js';

// ---------------------------------------------------------------- colour maths
export function rgb2hsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (!d) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
export function hsl2hex(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return '#' + [f(0), f(8), f(4)].map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0')).join('');
}
const hexRgb = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const hueDist = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

// ---------------------------------------------------------------- palette extraction
let thumb = null;
export function extractPalette(src) {
  if (!src) return null;
  const w0 = src.videoWidth || src.width, h0 = src.videoHeight || src.height;
  if (!w0 || !h0) return null;
  if (!thumb) { thumb = document.createElement('canvas'); thumb.width = thumb.height = 48; }
  const c = thumb.getContext('2d', { willReadFrequently: true });
  c.drawImage(src, 0, 0, 48, 48);
  let px;
  try { px = c.getImageData(0, 0, 48, 48).data; } catch { return null; }
  const pts = [];
  for (let i = 0; i < px.length; i += 4) pts.push([px[i], px[i + 1], px[i + 2]]);
  return kmeans(pts, 6);
}

function kmeans(pts, k) {
  // deterministic k-means++ style seeding: start from the most saturated pixel, then farthest points
  const sat = (p) => Math.max(...p) - Math.min(...p);
  const cents = [pts.reduce((a, b) => (sat(b) > sat(a) ? b : a)).slice()];
  const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  while (cents.length < k) {
    let best = null, bd = -1;
    for (const p of pts) { const d = Math.min(...cents.map((c) => d2(p, c))); if (d > bd) { bd = d; best = p; } }
    cents.push(best.slice());
  }
  const lab = new Int8Array(pts.length);
  for (let it = 0; it < 8; it++) {
    for (let i = 0; i < pts.length; i++) {
      let bi = 0, bd = Infinity;
      for (let j = 0; j < k; j++) { const d = d2(pts[i], cents[j]); if (d < bd) { bd = d; bi = j; } }
      lab[i] = bi;
    }
    const acc = Array.from({ length: k }, () => [0, 0, 0, 0]);
    for (let i = 0; i < pts.length; i++) { const a = acc[lab[i]]; a[0] += pts[i][0]; a[1] += pts[i][1]; a[2] += pts[i][2]; a[3]++; }
    acc.forEach((a, j) => { if (a[3]) cents[j] = [a[0] / a[3], a[1] / a[3], a[2] / a[3]]; });
  }
  const cnt = new Array(k).fill(0); for (let i = 0; i < pts.length; i++) cnt[lab[i]]++;
  return cents.map((c, j) => { const [h, s, l] = rgb2hsl(...c); return { rgb: c, h, s, l, w: cnt[j] / pts.length }; }).filter((c) => c.w > 0.005).sort((a, b) => b.w - a.w);
}

// mood colour temperature when the picture has no usable colour
const MOOD_HUE = { aggressive: 350, euphoric: 45, dark: 255, chill: 190, epic: 25, romantic: 330 };

/** Pick one colour per sound from a palette (light enough to glow over the picture). */
export function assignColors(pal, mood = 'chill') {
  let vivid = (pal || []).filter((c) => c.l > 0.08 && c.l < 0.95 && c.s > 0.18).sort((a, b) => b.s * Math.sqrt(b.w) - a.s * Math.sqrt(a.w));
  const dominant = pal?.[0];
  if (!vivid.length) {
    // grey picture: build a harmony from the mood around the picture's own tone
    const h = MOOD_HUE[mood] ?? 200;
    vivid = [{ h, s: 0.8, l: 0.6 }, { h: h + 40, s: 0.75, l: 0.6 }, { h: h - 40, s: 0.7, l: 0.6 }];
  }
  const a = vivid[0];
  const b = vivid.find((c) => hueDist(c.h, a.h) > 40) || { h: a.h + 150, s: a.s, l: a.l };
  const c3 = vivid.find((c) => hueDist(c.h, a.h) > 25 && hueDist(c.h, b.h) > 25) || { h: (a.h + b.h) / 2 + 180, s: 0.7, l: 0.6 };
  const light = (pal || []).slice().sort((x, y) => y.l - x.l)[0] || { h: a.h, s: 0.3, l: 0.85 };
  const warm = vivid.slice().sort((x, y) => hueDist(x.h, 35) - hueDist(y.h, 35))[0] || a;
  const glow = (c, s, l) => hsl2hex(c.h, Math.max(s, Math.min(1, c.s + 0.2)), l);
  // keep the strongest accents away from the dominant background hue when they collide
  const shift = dominant && hueDist(a.h, dominant.h) < 15 && dominant.w > 0.5 ? 25 : 0;
  return {
    kick: hsl2hex(a.h + shift, Math.max(0.75, a.s), 0.6),
    bass: hsl2hex(a.h + shift - 20, Math.max(0.7, a.s), 0.5),
    snare: glow(b, 0.7, 0.66),
    hat: hsl2hex(light.h, Math.min(0.4, light.s + 0.1), 0.86),
    ohat: glow(c3, 0.6, 0.72),
    vocal: hsl2hex(warm.h, Math.max(0.55, Math.min(0.8, warm.s)), 0.74),
  };
}

// ---------------------------------------------------------------- live auto colours (smoothed)
const state = { key: null, target: null, cur: null };
/**
 * Colours for the current frame. Pictures are analysed once; videos are re-analysed twice a
 * second and the colours glide towards the new ones, following the video's own gradients.
 */
export function autoColors(o, f, mood) {
  const media = mediaOf(o) || o.centerImage;
  let key, pal;
  if (media && media.videoWidth) {
    // while the video is still seeking its picture is the old frame: wait for the new one
    if (media.seeking || media.readyState < 2) { state.dirty = true; if (state.cur) return state.cur; }
    key = `v${Math.floor((media.currentTime || 0) * 2)}${state.dirty && !media.seeking ? '*' : ''}`;
    if (!media.seeking) state.dirty = false;
  } else if (media) {
    key = `i${media.src?.length || 0}${media.width}x${media.height}`;
  } else {
    key = `g${o.bgType}${o.bgColor1}${o.bgColor2}${o.color1}${o.color2}`;
  }
  if (key !== state.key) {
    if (media) pal = extractPalette(media);
    if (!pal) {
      // no picture: the gradient / theme colours act as the palette
      pal = [o.color1, o.color2, o.bgColor2, o.bgColor1].map((hx, i) => { const [h, s, l] = rgb2hsl(...hexRgb(hx)); return { h, s, l, w: [0.3, 0.3, 0.2, 0.2][i] }; });
    }
    state.target = assignColors(pal, mood);
    const jump = !state.cur || !key.startsWith(state.key?.[0] || '') || !media?.videoWidth;
    if (jump) state.cur = { ...state.target };
    state.key = key;
  }
  // glide (videos only; pictures snap)
  const out = {};
  for (const k of Object.keys(state.target)) {
    const a = hexRgb(state.cur[k]), b = hexRgb(state.target[k]);
    const m = a.map((v, i) => Math.round(v + (b[i] - v) * 0.08));
    out[k] = '#' + m.map((v) => v.toString(16).padStart(2, '0')).join('');
  }
  state.cur = out;
  return out;
}
export function peekAutoColors() { return state.cur; }
