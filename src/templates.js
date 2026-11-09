// Visual templates. Each draw() is a pure function of time + audio features,
// so it can be rendered at any frame in any order (preview seek == export).

import { NUM_BANDS } from './audio.js';
import { fontStack } from './fonts.js';

export const TAU = Math.PI * 2;

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hexToRgb(h) {
  const v = h.replace('#', '');
  const n = parseInt(v.length === 3 ? v.split('').map((c) => c + c).join('') : v, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function mix(c1, c2, k) {
  const a = hexToRgb(c1), b = hexToRgb(c2);
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * k)).join(',')})`;
}
export function rgba(c, a) {
  const [r, g, b] = hexToRgb(c);
  return `rgba(${r},${g},${b},${a})`;
}

// cover-fit an image into a rect
export function mediaOf(o) {
  if (o.bgType === 'video' && o.bgVideo && o.bgVideo.videoWidth) return o.bgVideo;
  if (o.bgType === 'image' && o.bgImage) return o.bgImage;
  return null;
}

// Big photos (4000-6000 px) are expensive to draw every frame, especially at 4K.
// Keep a downscaled copy per size bucket and draw that instead.
const scaledCache = new WeakMap();
export function fitSource(img, needW, needH) {
  if (!img || img.videoWidth || !img.width) return img;
  const want = Math.max(needW, needH) * 1.15;
  const big = Math.max(img.width, img.height);
  if (big <= want * 1.3) return img;
  const bucket = Math.ceil(want / 256) * 256;
  let m = scaledCache.get(img);
  if (!m) { m = new Map(); scaledCache.set(img, m); }
  if (!m.has(bucket)) {
    const k = bucket / big;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
    const cx = c.getContext('2d');
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(img, 0, 0, c.width, c.height);
    m.set(bucket, c);
  }
  return m.get(bucket);
}

// The blurred / fitted background is identical every frame: render it once per size.
const bgCache = new WeakMap();
function preparedBackground(media, W, H, o, cache = bgCache) {
  if (media.videoWidth) return null; // videos change every frame
  const key = `${W}x${H}|${o.bgBlur}|${o.bgFit}`;
  const hit = cache.get(media);
  if (hit && hit.key === key) return hit.canvas;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const cx = c.getContext('2d');
  const blur = o.bgBlur > 0 ? `blur(${o.bgBlur * Math.min(W, H) / 1080}px)` : 'none';
  if (o.bgFit === 'contain') {
    cx.filter = `blur(${30 * Math.min(W, H) / 1080}px) brightness(0.6)`;
    drawCover(cx, media, -40, -40, W + 80, H + 80, 1);
    cx.filter = blur;
    drawContain(cx, media, 0, 0, W, H, 1);
  } else {
    cx.filter = blur;
    // draw a little larger so blurred edges stay filled
    const pad = o.bgBlur > 0 ? o.bgBlur * 2 * Math.min(W, H) / 1080 : 0;
    drawCover(cx, media, -pad, -pad, W + pad * 2, H + pad * 2, 1);
  }
  cache.set(media, { key, canvas: c });
  return c;
}
const blurCache = new WeakMap();
export function blurredCopy(img, W, H, px) {
  const fake = { bgBlur: px * 1080 / Math.min(W, H), bgFit: 'cover' };
  return preparedBackground(img, W, H, fake, blurCache);
}

export function drawContain(ctx, img, x, y, w, h, zoom = 1) {
  img = fitSource(img, w * zoom, h * zoom);
  const iw = img.videoWidth || img.width, ih = img.videoHeight || img.height;
  const k = Math.min(w / iw, h / ih) * zoom;
  ctx.drawImage(img, x + (w - iw * k) / 2, y + (h - ih * k) / 2, iw * k, ih * k);
}

export function drawCover(ctx, img, x, y, w, h, zoom = 1) {
  img = fitSource(img, w * zoom, h * zoom);
  const iw = img.videoWidth || img.width, ih = img.videoHeight || img.height;
  const ir = iw / ih, r = w / h;
  let dw, dh;
  if (ir > r) { dh = h * zoom; dw = dh * ir; } else { dw = w * zoom; dh = dw / ir; }
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

// ---------------------------------------------------------------- background
export function drawBackground(ctx, W, H, o, f, extra = {}) {
  ctx.save();
  const media = mediaOf(o);
  if (media) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    let zoom = 1.04 + (extra.zoom || 0);
    if (o.bgMotion === 'zoom') zoom += 0.12 * (0.5 - 0.5 * Math.cos((f.t / 24) * Math.PI * 2));
    if (o.bgMotion === 'pulse') zoom += 0.07 * f.bass * o.sens;
    const blur = o.bgBlur > 0 ? `blur(${o.bgBlur * Math.min(W, H) / 1080}px)` : 'none';
    ctx.save();
    if (extra.dx || extra.dy) ctx.translate(extra.dx || 0, extra.dy || 0);
    const pre = preparedBackground(media, W, H, o);
    if (pre) {
      const z = zoom; // prepared at zoom 1, scale up around the centre
      ctx.drawImage(pre, (W - W * z) / 2, (H - H * z) / 2, W * z, H * z);
    } else if (o.bgFit === 'contain') {
      // blurred copy fills the frame, the full picture sits on top
      ctx.filter = `blur(${30 * Math.min(W, H) / 1080}px) brightness(0.6)`;
      drawCover(ctx, media, -40, -40, W + 80, H + 80, 1);
      ctx.filter = blur;
      drawContain(ctx, media, 0, 0, W, H, zoom - 0.04);
    } else {
      ctx.filter = blur;
      drawCover(ctx, media, 0, 0, W, H, zoom);
    }
    ctx.restore();
    ctx.fillStyle = `rgba(0,0,0,${o.bgDim})`;
    ctx.fillRect(0, 0, W, H);
  } else if (o.bgType === 'color') {
    ctx.fillStyle = o.bgColor1;
    ctx.fillRect(0, 0, W, H);
  } else {
    const g = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.hypot(W, H) / 1.6);
    g.addColorStop(0, o.bgColor2);
    g.addColorStop(1, o.bgColor1);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
  ctx.restore();
}

// ---------------------------------------------------------------- overlay
export function drawOverlay(ctx, W, H, o, f, duration) {
  const u = Math.min(W, H) / 1080;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const portrait = H > W * 1.2;
  let ty = portrait ? H * 0.82 : H * 0.88;
  if (o.textPos === 'top') ty = H * (portrait ? 0.12 : 0.14);
  if (o.textPos === 'center') ty = H * 0.5;
  if (o.showTimer) {
    const sec = Math.max(0, f.t);
    const txt = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
    ctx.save();
    ctx.font = `600 ${Math.round(34 * u)}px ${fontStack(o.subFont)}`;
    ctx.textAlign = 'right';
    ctx.fillStyle = rgba(o.textColor, 0.85);
    ctx.fillText(txt, W - 44 * u, o.textPos === 'top' ? H - 44 * u : 70 * u);
    ctx.restore();
  }
  if (o.title) {
    ctx.font = `${o.titleWeight || 700} ${Math.round(o.titleSize * u)}px ${fontStack(o.titleFont)}`;
    ctx.fillStyle = o.textColor;
    ctx.shadowColor = rgba(o.color1, 0.6);
    ctx.shadowBlur = 20 * u * (0.5 + f.bass * 0.8);
    ctx.fillText(o.title, W / 2, ty);
  }
  if (o.subtitle) {
    ctx.shadowBlur = 0;
    ctx.font = `400 ${Math.round(o.titleSize * 0.55 * u)}px ${fontStack(o.subFont)}`;
    ctx.fillStyle = rgba(o.textColor === '#ffffff' ? '#cccccc' : o.textColor, 0.85);
    ctx.fillText(o.subtitle, W / 2, ty + o.titleSize * 0.85 * u);
  }
  if (o.showProgress && duration > 0) {
    const pw = W * 0.6, px = (W - pw) / 2, py = ty + o.titleSize * 1.6 * u;
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.fillRect(px, py, pw, 4 * u);
    ctx.fillStyle = o.color1;
    ctx.fillRect(px, py, pw * Math.min(1, f.t / duration), 4 * u);
  }
  if (o.logo) {
    const s = 140 * u * o.logoScale;
    const r = o.logo.width / o.logo.height;
    const lw = r >= 1 ? s : s * r, lh = r >= 1 ? s / r : s;
    const m = 40 * u;
    const pos = {
      tl: [m, m], tr: [W - lw - m, m], bl: [m, H - lh - m], br: [W - lw - m, H - lh - m], tc: [(W - lw) / 2, m * 1.5],
    }[o.logoPos] || [m, m];
    ctx.globalAlpha = 0.95;
    ctx.drawImage(o.logo, pos[0], pos[1], lw, lh);
  }
  ctx.restore();
}

// ---------------------------------------------------------------- particles from beats (deterministic)
export function beatParticles(ctx, W, H, o, f, cx, cy, r0, u, count = 26, life = 1.6) {
  const beats = f.beatsBetween(f.t - life, f.t);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const b of beats) {
    const R = rng(Math.floor(b.t * 1000));
    const age = f.t - b.t;
    const k = age / life;
    const n = Math.round(count * Math.min(1.3, b.s));
    for (let i = 0; i < n; i++) {
      const a = R() * TAU, sp = (180 + R() * 520) * u * o.sens;
      const d = r0 + sp * (1 - Math.pow(1 - Math.min(1, age / life), 2)) * life * 0.6;
      const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d;
      const sz = (2 + R() * 4) * u * (1 - k);
      ctx.fillStyle = rgba(R() > 0.5 ? o.color1 : o.color2, (1 - k) * 0.9);
      ctx.beginPath(); ctx.arc(x, y, sz, 0, TAU); ctx.fill();
    }
  }
  ctx.restore();
}

// ================================================================ templates
export const draw = {};

// 1) Circular spectrum around a centre image / disc
draw.ring = (ctx, W, H, o, f) => {
  const u = Math.min(W, H) / 1080;
  drawBackground(ctx, W, H, o, f);
  const cx = W / 2, cy = H > W * 1.2 ? H * 0.42 : H / 2;
  const pulse = 1 + 0.08 * f.bass * o.sens;
  const R0 = 230 * u * pulse;
  const rot = f.t * 0.15;
  const N = 128;
  beatParticles(ctx, W, H, o, f, cx, cy, R0, u);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rot);
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  for (let i = 0; i < N; i++) {
    // mirror the spectrum so the ring is symmetric
    const bi = Math.floor((i < N / 2 ? i : N - 1 - i) / (N / 2) * NUM_BANDS * 0.85);
    const v = Math.min(1.3, f.bands[bi] * o.sens);
    const len = (10 + v * v * 190) * u;
    const a = (i / N) * TAU;
    const col = mix(o.color1, o.color2, i < N / 2 ? i / (N / 2) : (N - i) / (N / 2));
    ctx.strokeStyle = col;
    ctx.lineWidth = 7 * u;
    ctx.shadowColor = col;
    ctx.shadowBlur = 14 * u;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * (R0 + 14 * u), Math.sin(a) * (R0 + 14 * u));
    ctx.lineTo(Math.cos(a) * (R0 + 14 * u + len), Math.sin(a) * (R0 + 14 * u + len));
    ctx.stroke();
  }
  ctx.restore();
  // inner disc
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, R0, 0, TAU);
  ctx.shadowColor = o.color1; ctx.shadowBlur = 40 * u * (0.4 + f.bass);
  ctx.fillStyle = '#05060a'; ctx.fill();
  ctx.clip();
  if (o.centerImage) drawCover(ctx, o.centerImage, cx - R0, cy - R0, R0 * 2, R0 * 2, 1 + 0.03 * f.bass);
  else {
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R0);
    g.addColorStop(0, rgba(o.color2, 0.55)); g.addColorStop(1, rgba(o.color1, 0.15));
    ctx.fillStyle = g; ctx.fillRect(cx - R0, cy - R0, R0 * 2, R0 * 2);
  }
  ctx.restore();
  ctx.save();
  ctx.strokeStyle = rgba('#ffffff', 0.85); ctx.lineWidth = 4 * u;
  ctx.beginPath(); ctx.arc(cx, cy, R0, 0, TAU); ctx.stroke();
  ctx.restore();
};

// 2) Layered neon waves
draw.wave = (ctx, W, H, o, f) => {
  const u = Math.min(W, H) / 1080;
  drawBackground(ctx, W, H, o, f);
  const cy = H > W * 1.2 ? H * 0.45 : H / 2;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const layers = 4;
  for (let L = layers - 1; L >= 0; L--) {
    const col = mix(o.color1, o.color2, L / (layers - 1));
    const amp = (620 - L * 90) * u * o.sens;
    const pts = 96;
    ctx.beginPath();
    for (let side = 0; side < 2; side++) {
      const sign = side === 0 ? -1 : 1;
      for (let j = 0; j <= pts; j++) {
        const i = side === 0 ? j : pts - j;
        const x = (i / pts) * W;
        // fold spectrum: centre = bass, edges = treble
        const d = Math.abs(i / pts - 0.5) * 2;
        const bi = Math.min(NUM_BANDS - 1, Math.floor((d * 0.8 + L * 0.03) * NUM_BANDS));
        const env = Math.pow(Math.sin((i / pts) * Math.PI), 1.5);
        const wob = Math.sin(i * 0.35 + f.t * (2 + L) + L) * 0.08;
        const v = (f.bands[bi] * (1 - L * 0.12) + wob) * env;
        const y = cy + sign * Math.max(1.5 * u, v * amp * 0.5);
        if (j === 0 && side === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
    }
    ctx.closePath();
    const g = ctx.createLinearGradient(0, cy - amp / 2, 0, cy + amp / 2);
    g.addColorStop(0, rgba(col === undefined ? o.color1 : o.color1, 0.0));
    g.addColorStop(0.5, col.replace('rgb', 'rgba').replace(')', ',0.35)'));
    g.addColorStop(1, rgba(o.color2, 0.0));
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = col; ctx.lineWidth = (3 - L * 0.5) * u;
    ctx.shadowColor = col; ctx.shadowBlur = 18 * u;
    ctx.stroke();
  }
  // centre line
  ctx.shadowBlur = 0;
  ctx.fillStyle = rgba('#ffffff', 0.5 + 0.5 * f.bass);
  ctx.fillRect(0, cy - 1 * u, W, 2 * u);
  ctx.restore();
};

// 3) Classic equaliser bars with reflection
draw.bars = (ctx, W, H, o, f) => {
  const u = Math.min(W, H) / 1080;
  drawBackground(ctx, W, H, o, f);
  const N = 48;
  const margin = W * 0.08;
  const bw = (W - margin * 2) / N;
  const base = H > W * 1.2 ? H * 0.6 : H * 0.68;
  const maxH = H * (H > W * 1.2 ? 0.32 : 0.45);
  ctx.save();
  for (let i = 0; i < N; i++) {
    const bi = Math.floor((i / N) * NUM_BANDS * 0.92);
    const v = Math.min(1.15, f.bands[bi] * o.sens);
    const h = Math.max(4 * u, v * v * maxH);
    const x = margin + i * bw + bw * 0.15;
    const w = bw * 0.7;
    const col = mix(o.color1, o.color2, i / (N - 1));
    const g = ctx.createLinearGradient(0, base - h, 0, base);
    g.addColorStop(0, col); g.addColorStop(1, rgba(o.color1, 0.6));
    ctx.fillStyle = g;
    ctx.shadowColor = col; ctx.shadowBlur = 16 * u;
    ctx.beginPath(); ctx.roundRect(x, base - h, w, h, w / 2); ctx.fill();
    // peak cap (raw value, so it jumps faster)
    const pv = Math.min(1.15, f.raw[bi] * o.sens);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x, base - Math.max(h, pv * pv * maxH) - 10 * u, w, 3 * u);
    // reflection
    ctx.shadowBlur = 0;
    const rg = ctx.createLinearGradient(0, base, 0, base + h * 0.5);
    rg.addColorStop(0, rgba(o.color2, 0.3)); rg.addColorStop(1, rgba(o.color2, 0));
    ctx.fillStyle = rg;
    ctx.fillRect(x, base + 6 * u, w, h * 0.5);
  }
  ctx.restore();
};

// 4) Radar: a sweeping hand paints each hit as an arc on its ring
draw.radar = (ctx, W, H, o, f) => {
  const u = Math.min(W, H) / 1080;
  drawBackground(ctx, W, H, o, f);
  const cx = W / 2, cy = H > W * 1.2 ? H * 0.43 : H / 2;
  const R = 400 * u;
  const period = (60 / f.bpm) * 8; // one revolution = two bars
  const ang = (t) => (t / period) * TAU - Math.PI / 2;
  ctx.save();
  // guide rings
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1.5 * u;
  for (let i = 1; i <= 6; i++) { ctx.beginPath(); ctx.arc(cx, cy, R * i / 6, 0, TAU); ctx.stroke(); }
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU;
    ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * R * 1.02, cy + Math.sin(a) * R * 1.02);
    ctx.lineTo(cx + Math.cos(a) * R * 1.07, cy + Math.sin(a) * R * 1.07); ctx.stroke();
  }
  // arcs for hits in the last 3 revolutions
  const hits = f.beatsBetween(f.t - period * 3, f.t);
  ctx.lineCap = 'round';
  ctx.globalCompositeOperation = 'lighter';
  for (const b of hits) {
    const age = f.t - b.t;
    const rev = Math.floor(age / period);
    const fade = Math.max(0, 1 - age / (period * 3));
    const ringIdx = b.reg === 0 ? 2 : b.reg === 1 ? 4 : 5;
    const r = (R * (ringIdx + 0.5 * (rev % 2))) / 6;
    const a0 = ang(b.t);
    const span = (0.06 + 0.12 * Math.min(1, b.s)) * Math.min(1, age * 8);
    const col = b.reg === 0 ? o.color2 : o.color1;
    ctx.strokeStyle = rgba(col, 0.25 + 0.75 * fade);
    ctx.lineWidth = (6 + 6 * Math.min(1, b.s)) * u;
    ctx.shadowColor = col; ctx.shadowBlur = age < 0.2 ? 30 * u : 8 * u;
    ctx.beginPath(); ctx.arc(cx, cy, r, a0, a0 + span); ctx.stroke();
  }
  // sweep trail
  const a = ang(f.t);
  ctx.globalCompositeOperation = 'source-over';
  ctx.shadowBlur = 0;
  for (let k = 0; k < 24; k++) {
    const aa = a - k * 0.02;
    ctx.strokeStyle = rgba(o.color1, 0.12 * (1 - k / 24));
    ctx.lineWidth = 3 * u;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(aa) * R, cy + Math.sin(aa) * R); ctx.stroke();
  }
  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2.5 * u;
  ctx.shadowColor = '#ffffff'; ctx.shadowBlur = 12 * u;
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * R * 1.1, cy + Math.sin(a) * R * 1.1); ctx.stroke();
  // centre
  ctx.fillStyle = rgba(o.color2, 0.4 + 0.6 * f.bass);
  ctx.beginPath(); ctx.arc(cx, cy, (10 + 14 * f.bass) * u, 0, TAU); ctx.fill();
  ctx.font = `600 ${Math.round(22 * u)}px ${fontStack(o.subFont)}`;
  ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.textAlign = 'center';
  ctx.shadowBlur = 0;
  ctx.fillText(`${f.bpm} BPM`, cx, cy + R + 60 * u);
  ctx.restore();
};

// 5) Image shake: the picture vibrates with the bass waveform
draw.shake = (ctx, W, H, o, f) => {
  const u = Math.min(W, H) / 1080;
  const drive = Math.max(0, (f.bassRaw * o.sens - 0.3) / 0.7);
  const d = Math.pow(drive, 1.3);
  const amp = 22 * u * d;
  const dx = amp * f.bassWave(0), dy = amp * f.bassWave(0.004);
  const zoom = 0.05 * f.bass * o.sens;
  const media = mediaOf(o);
  if (media) {
    drawBackground(ctx, W, H, o, f, { dx, dy, zoom });
    // RGB split on strong hits
    if (d > 0.35) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = Math.min(0.35, (d - 0.35) * 0.6);
      const pre = preparedBackground(media, W, H, o);
      if (pre) ctx.drawImage(pre, dx * 1.8 - W * zoom / 2, dy * -1.5 - H * zoom / 2, W * (1 + zoom), H * (1 + zoom));
      else drawCover(ctx, media, dx * 1.8, dy * -1.5, W, H, 1.04 + zoom);
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = rgba(o.color2, 0.5);
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
  } else {
    drawBackground(ctx, W, H, o, f);
    // no image: a glowing logo-disc shakes instead
    const cx = W / 2 + dx, cy = H / 2 + dy, r = 220 * u * (1 + zoom);
    ctx.save();
    ctx.shadowColor = o.color1; ctx.shadowBlur = 60 * u * (0.3 + d);
    ctx.fillStyle = o.color1; ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.fill();
    if (o.centerImage) { ctx.clip(); drawCover(ctx, o.centerImage, cx - r, cy - r, r * 2, r * 2); }
    ctx.restore();
  }
  // flash vignette
  ctx.save();
  const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.hypot(W, H) / 1.7);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, rgba(o.color1, 0.12 + 0.35 * d));
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.restore();
};

// 6) Warp starfield that speeds up with the music
draw.warp = (ctx, W, H, o, f) => {
  const u = Math.min(W, H) / 1080;
  drawBackground(ctx, W, H, o, f);
  const cx = W / 2, cy = H / 2;
  const R = rng(42);
  const N = 420;
  // distance travelled = integral of speed; approximate with t + energy-driven term
  const speedBase = 0.18, travel = f.t * speedBase;
  const boost = f.rms * 0.5 + f.bass * 0.6;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  for (let i = 0; i < N; i++) {
    const a = R() * TAU, z0 = R(), sp = 0.6 + R() * 0.8;
    const col = R() > 0.5 ? o.color1 : o.color2;
    let z = (z0 + travel * sp) % 1; // 0 far .. 1 near
    const p = Math.pow(z, 3);
    const dist = p * Math.hypot(W, H) * 0.7 + 10 * u;
    const tail = (0.01 + boost * 0.05 * o.sens) * sp;
    const zt = Math.max(0, z - tail);
    const dist2 = Math.pow(zt, 3) * Math.hypot(W, H) * 0.7 + 10 * u;
    ctx.strokeStyle = rgba(col, Math.min(1, z * 1.4));
    ctx.lineWidth = (0.6 + z * 3.5) * u;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * dist2, cy + Math.sin(a) * dist2);
    ctx.lineTo(cx + Math.cos(a) * dist, cy + Math.sin(a) * dist);
    ctx.stroke();
  }
  // core glow
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 300 * u * (0.6 + f.bass * o.sens));
  g.addColorStop(0, rgba('#ffffff', 0.5 * f.bass));
  g.addColorStop(0.3, rgba(o.color1, 0.25 * f.bass));
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.restore();
  beatParticles(ctx, W, H, o, f, cx, cy, 40 * u, u, 18, 1.0);
};

