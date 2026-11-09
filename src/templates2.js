// Additional visualiser styles. Each one is an original, procedural take on a
// popular music-visualiser genre (circular spectrum, tunnel, synthwave, vinyl…).
import { NUM_BANDS } from './audio.js';
import { fontStack } from './fonts.js';
import { draw, drawBackground, drawCover, mediaOf, beatParticles, rng, mix, rgba, TAU, blurredCopy } from './templates.js';

const unit = (W, H) => Math.min(W, H) / 1080;
const centre = (W, H) => [W / 2, H > W * 1.2 ? H * 0.42 : H / 2];
const band = (f, x) => f.bands[Math.max(0, Math.min(NUM_BANDS - 1, Math.floor(x * NUM_BANDS)))];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// cover art in a circle (or a soft gradient disc when there is none)
function coverDisc(ctx, cx, cy, r, o, f, u) {
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU);
  ctx.fillStyle = '#05060a'; ctx.fill();
  ctx.clip();
  if (o.centerImage) drawCover(ctx, o.centerImage, cx - r, cy - r, r * 2, r * 2, 1 + 0.04 * f.bass);
  else {
    const g = ctx.createRadialGradient(cx, cy - r * 0.3, 0, cx, cy, r);
    g.addColorStop(0, rgba(o.color2, 0.9)); g.addColorStop(1, rgba(o.color1, 0.55));
    ctx.fillStyle = g; ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  }
  ctx.restore();
}

function glowStroke(ctx, col, w, blur) {
  ctx.strokeStyle = col; ctx.lineWidth = w; ctx.shadowColor = col; ctx.shadowBlur = blur;
}

function polygon(ctx, cx, cy, r, sides, rot) {
  ctx.beginPath();
  if (sides < 3) { ctx.arc(cx, cy, r, 0, TAU); return; }
  for (let i = 0; i <= sides; i++) {
    const a = rot + (i / sides) * TAU - Math.PI / 2;
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.closePath();
}

// smooth closed curve through points
function smoothClosed(ctx, pts) {
  const n = pts.length;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    if (i === 0) ctx.moveTo(p1[0], p1[1]);
    ctx.bezierCurveTo(p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6,
      p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1]);
  }
  ctx.closePath();
}
function smoothOpen(ctx, pts, move = true) {
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    if (i === 0) move ? ctx.moveTo(p1[0], p1[1]) : ctx.lineTo(p1[0], p1[1]);
    ctx.bezierCurveTo(p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6,
      p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1]);
  }
}

// ---------------------------------------------------------------- 1. dotted circle spectrum
draw.dots = (ctx, W, H, o, f) => {
  const u = unit(W, H); drawBackground(ctx, W, H, o, f);
  const [cx, cy] = centre(W, H);
  const R = 300 * u * (1 + 0.04 * f.bass);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  glowStroke(ctx, rgba(o.color1, 0.9), 2.5 * u, 14 * u);
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.stroke();
  const N = 96;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * TAU - Math.PI / 2;
    const v = band(f, (i < N / 2 ? i : N - i) / (N / 2) * 0.8) * o.sens;
    const len = v * v * 140 * u;
    const col = mix(o.color1, o.color2, i / N);
    glowStroke(ctx, col, 3 * u, 10 * u);
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
    ctx.lineTo(cx + Math.cos(a) * (R + len), cy + Math.sin(a) * (R + len));
    ctx.stroke();
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(cx + Math.cos(a) * (R + len + 8 * u), cy + Math.sin(a) * (R + len + 8 * u), 3 * u, 0, TAU); ctx.fill();
  }
  // inner faint rays
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * TAU + f.t * 0.05;
    ctx.strokeStyle = rgba(o.color2, 0.06 + 0.1 * f.bass); ctx.lineWidth = 30 * u; ctx.shadowBlur = 0;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * R * 0.95, cy + Math.sin(a) * R * 0.95); ctx.stroke();
  }
  ctx.restore();
};

// ---------------------------------------------------------------- 2. closed waveform blob around a disc
draw.blob = (ctx, W, H, o, f) => {
  const u = unit(W, H); drawBackground(ctx, W, H, o, f);
  const [cx, cy] = centre(W, H);
  const R = 210 * u * (1 + 0.06 * f.bass * o.sens);
  ctx.save();
  for (let L = 2; L >= 0; L--) {
    const pts = [], N = 72;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * TAU - Math.PI / 2 + L * 0.2 + f.t * (0.2 + L * 0.1);
      const k = (i < N / 2 ? i : N - i) / (N / 2);
      const v = band(f, 0.05 + k * 0.7 + L * 0.04) * o.sens;
      const r = R + 16 * u + v * v * (150 - L * 30) * u;
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
    smoothClosed(ctx, pts);
    const col = L === 0 ? o.color1 : L === 1 ? o.color2 : mix(o.color1, o.color2, 0.5);
    ctx.fillStyle = rgba(col, 0.35 + 0.15 * (2 - L));
    ctx.shadowColor = col; ctx.shadowBlur = 30 * u;
    ctx.fill();
  }
  ctx.restore();
  coverDisc(ctx, cx, cy, R, o, f, u);
  ctx.save(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 3 * u;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.stroke(); ctx.restore();
};

// ---------------------------------------------------------------- 3. neon ripples on every beat
draw.ripples = (ctx, W, H, o, f) => {
  const u = unit(W, H); drawBackground(ctx, W, H, o, f);
  const [cx, cy] = centre(W, H);
  const maxR = Math.hypot(W, H) * 0.6;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  // static concentric guides that wobble slightly
  for (let i = 1; i <= 14; i++) {
    const r = i * 48 * u * (1 + 0.03 * Math.sin(f.t * 2 + i));
    ctx.strokeStyle = rgba(i % 2 ? o.color1 : o.color2, 0.08 + 0.12 * band(f, i / 16));
    ctx.lineWidth = 2 * u;
    ctx.beginPath(); ctx.ellipse(cx, cy, r * 1.4, r, 0, 0, TAU); ctx.stroke();
  }
  for (const b of f.beatsBetween(f.t - 2.4, f.t)) {
    const age = f.t - b.t, k = age / 2.4;
    const r = 120 * u + Math.pow(k, 0.7) * maxR;
    glowStroke(ctx, rgba(b.reg === 0 ? o.color1 : o.color2, (1 - k) * 0.9), (3 + 8 * (1 - k)) * u * Math.min(1.3, b.s), 22 * u);
    ctx.beginPath(); ctx.ellipse(cx, cy, r * 1.4, r, 0, 0, TAU); ctx.stroke();
  }
  ctx.restore();
  // centre neon triangle
  ctx.save();
  const s = 110 * u * (1 + 0.15 * f.bass * o.sens);
  glowStroke(ctx, o.color1, 10 * u, 40 * u);
  polygon(ctx, cx, cy, s, 3, Math.PI / 2 + Math.PI / 2);
  ctx.lineJoin = 'round'; ctx.stroke();
  ctx.restore();
};

// ---------------------------------------------------------------- 4. HUD rings
draw.hud = (ctx, W, H, o, f) => {
  const u = unit(W, H); drawBackground(ctx, W, H, o, f);
  const [cx, cy] = centre(W, H);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const rings = [
    { r: 150, w: 6, seg: 3, sp: 0.6, c: o.color1 }, { r: 200, w: 2, seg: 60, sp: -0.2, c: o.color2 },
    { r: 250, w: 14, seg: 8, sp: 0.35, c: o.color1 }, { r: 310, w: 3, seg: 1, sp: 0, c: o.color2 },
    { r: 350, w: 8, seg: 24, sp: -0.4, c: o.color2 }, { r: 400, w: 2, seg: 120, sp: 0.1, c: o.color1 },
  ];
  rings.forEach((g, i) => {
    const v = band(f, i / rings.length * 0.8) * o.sens;
    const r = g.r * u * (1 + 0.05 * v);
    const rot = f.t * g.sp + (f.sinceBeat < 0.15 ? 0.05 : 0);
    glowStroke(ctx, rgba(g.c, 0.35 + 0.65 * v), g.w * u, 12 * u);
    if (g.seg === 1) { ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.stroke(); return; }
    const gap = g.seg > 40 ? 0.5 : 0.25;
    for (let k = 0; k < g.seg; k++) {
      const a0 = rot + (k / g.seg) * TAU, a1 = a0 + (TAU / g.seg) * (1 - gap) * (g.seg > 40 ? 1 : 0.6 + 0.4 * v);
      ctx.beginPath(); ctx.arc(cx, cy, r, a0, a1); ctx.stroke();
    }
  });
  // spectrum ring
  for (let i = 0; i < 64; i++) {
    const a = (i / 64) * TAU - f.t * 0.3;
    const v = band(f, i / 64) * o.sens;
    const r0 = 430 * u, r1 = r0 + v * v * 90 * u;
    glowStroke(ctx, rgba(o.color1, 0.8), 5 * u, 8 * u);
    ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); ctx.stroke();
  }
  // crosshair ticks
  ctx.shadowBlur = 0; ctx.strokeStyle = rgba('#ffffff', 0.4); ctx.lineWidth = 2 * u;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU;
    ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * 520 * u, cy + Math.sin(a) * 520 * u); ctx.lineTo(cx + Math.cos(a) * 560 * u, cy + Math.sin(a) * 560 * u); ctx.stroke();
  }
  ctx.restore();
  coverDisc(ctx, cx, cy, 120 * u * (1 + 0.05 * f.bass), o, f, u);
};

// ---------------------------------------------------------------- 5. glowing electric line (time-domain)
draw.line = (ctx, W, H, o, f) => {
  const u = unit(W, H); drawBackground(ctx, W, H, o, f);
  const cy = H > W * 1.2 ? H * 0.45 : H * 0.55;
  const N = 220;
  const pts = [];
  for (let i = 0; i <= N; i++) {
    const x = (i / N) * W;
    const env = Math.pow(Math.sin((i / N) * Math.PI), 0.8);
    const v = f.wave((i / N - 0.5) * 0.12) * 0.7 + (band(f, Math.abs(i / N - 0.5) * 1.6) - 0.3) * 0.5;
    pts.push([x, cy + v * env * 230 * u * o.sens]);
  }
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const g = ctx.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, o.color1); g.addColorStop(0.5, o.color2); g.addColorStop(1, o.color1);
  for (const [w, a, b] of [[14, 0.15, 40], [6, 0.4, 20], [2.5, 1, 6]]) {
    ctx.strokeStyle = g; ctx.globalAlpha = a; ctx.lineWidth = w * u; ctx.shadowColor = o.color2; ctx.shadowBlur = b * u;
    ctx.beginPath(); smoothOpen(ctx, pts); ctx.stroke();
  }
  // reflection
  ctx.globalAlpha = 0.18; ctx.lineWidth = 3 * u; ctx.shadowBlur = 0;
  ctx.beginPath(); smoothOpen(ctx, pts.map(([x, y]) => [x, cy + (cy - y) * 0.5 + 140 * u])); ctx.stroke();
  ctx.restore();
};

// ---------------------------------------------------------------- 6. filled spectrum "mountain"
draw.mountain = (ctx, W, H, o, f) => {
  const u = unit(W, H); drawBackground(ctx, W, H, o, f);
  const base = H > W * 1.2 ? H * 0.62 : H * 0.72;
  const maxH = H * 0.35;
  ctx.save();
  for (let L = 2; L >= 0; L--) {
    const pts = [];
    const N = 48;
    for (let i = 0; i <= N; i++) {
      const v = (L === 0 ? f.bands : f.bandsAt(L * 0.12))[Math.min(NUM_BANDS - 1, Math.floor((i / N) * NUM_BANDS * 0.9))] * o.sens;
      pts.push([(i / N) * W, base - Math.pow(Math.max(0, v), 1.6) * maxH * (1 - L * 0.15)]);
    }
    ctx.beginPath(); ctx.moveTo(0, base); smoothOpen(ctx, pts, false); ctx.lineTo(W, base); ctx.closePath();
    const g = ctx.createLinearGradient(0, base - maxH, 0, base);
    g.addColorStop(0, rgba(L === 0 ? o.color2 : o.color1, 0.95 - L * 0.25));
    g.addColorStop(1, rgba(o.color1, 0.25));
    ctx.fillStyle = g;
    ctx.shadowColor = o.color2; ctx.shadowBlur = L === 0 ? 30 * u : 0;
    ctx.fill();
  }
  // mirrored reflection
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 0.25;
  ctx.translate(0, base * 2); ctx.scale(1, -1);
  const pts = [];
  for (let i = 0; i <= 48; i++) pts.push([(i / 48) * W, base - Math.pow(f.bands[Math.floor((i / 48) * NUM_BANDS * 0.9)] * o.sens, 1.6) * maxH * 0.6]);
  ctx.beginPath(); ctx.moveTo(0, base); smoothOpen(ctx, pts, false); ctx.lineTo(W, base); ctx.closePath();
  ctx.fillStyle = o.color1; ctx.fill();
  ctx.restore();
  ctx.fillStyle = rgba('#ffffff', 0.6); ctx.fillRect(0, base, W, 1.5 * u);
};

// ---------------------------------------------------------------- 7. LED / dot-matrix spectrum
draw.led = (ctx, W, H, o, f) => {
  const u = unit(W, H); drawBackground(ctx, W, H, o, f);
  const cols = 40, rows = 24;
  const gw = W * 0.86, gx = (W - gw) / 2;
  const cell = gw / cols;
  const gh = cell * rows;
  const gy = (H > W * 1.2 ? H * 0.45 : H * 0.5) - gh / 2;
  ctx.save();
  for (let c = 0; c < cols; c++) {
    const mirror = Math.abs(c - (cols - 1) / 2) / (cols / 2);
    const v = clamp(band(f, mirror * 0.85) * o.sens, 0, 1.1);
    const lit = v * rows / 2;
    for (let r = 0; r < rows; r++) {
      const d = Math.abs(r - (rows - 1) / 2);
      const on = d < lit;
      const x = gx + c * cell + cell / 2, y = gy + r * cell + cell / 2;
      const col = mix(o.color1, o.color2, d / (rows / 2));
      ctx.fillStyle = on ? col : 'rgba(255,255,255,0.05)';
      ctx.shadowColor = col; ctx.shadowBlur = on ? 10 * u : 0;
      ctx.beginPath(); ctx.arc(x, y, cell * 0.32, 0, TAU); ctx.fill();
    }
  }
  ctx.restore();
};

// ---------------------------------------------------------------- 8. 3D dotted wave surface (spectrum history)
draw.surface = (ctx, W, H, o, f) => {
  const u = unit(W, H); drawBackground(ctx, W, H, o, f);
  const rowsN = 34, colsN = 70;
  const horizon = H * (H > W * 1.2 ? 0.38 : 0.32);
  const fov = H * 0.9;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let r = rowsN - 1; r >= 0; r--) {
    const z = 1 + r * 0.35;                // depth
    const hist = f.bandsAt(r * 0.05);
    const yBase = horizon + fov / z * 0.75;
    const alpha = clamp(1.1 - r / rowsN, 0.05, 1);
    for (let c = 0; c < colsN; c++) {
      const xn = c / (colsN - 1) - 0.5;
      const bi = Math.min(NUM_BANDS - 1, Math.floor(Math.abs(xn) * 2 * NUM_BANDS * 0.85));
      const v = hist[bi] * o.sens;
      const wob = Math.sin(c * 0.25 + f.t * 1.5 + r * 0.3) * 0.15;
      const h = (v * v * 1.2 + wob) * 180 * u / z;
      const x = W / 2 + xn * W * 2.2 / z;
      if (x < -10 || x > W + 10) continue;
      ctx.fillStyle = `${mix(o.color2, o.color1, r / rowsN).replace('rgb', 'rgba').replace(')', `,${alpha})`)}`;
      ctx.beginPath(); ctx.arc(x, yBase - h, (2.6 / Math.sqrt(z)) * u * 1.6, 0, TAU); ctx.fill();
    }
  }
  ctx.restore();
};

// ---------------------------------------------------------------- 9. neon shape tunnel
draw.tunnel = (ctx, W, H, o, f) => {
  const u = unit(W, H); drawBackground(ctx, W, H, o, f);
  const cx = W / 2, cy = H / 2;
  const sides = o.shapeSides ?? 6;
  const N = 18, speed = 0.45;
  const travel = f.t * speed;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineJoin = 'round';
  for (let i = N - 1; i >= 0; i--) {
    const z = ((i + 1 - (travel % 1)) / N); // 0 near .. 1 far
    if (z <= 0.02) continue;
    const r = (Math.hypot(W, H) * 0.08) / z * (1 + 0.06 * f.bass * o.sens);
    const idx = Math.floor(i + travel);
    const col = idx % 2 ? o.color1 : o.color2;
    const v = band(f, (i / N) * 0.8) * o.sens;
    glowStroke(ctx, rgba(col, clamp(1.2 - z, 0.05, 1) * (0.5 + 0.5 * v)), (2 + 10 * (1 - z)) * u, 25 * u * (1 - z));
    polygon(ctx, cx + Math.sin(f.t * 0.7 + i * 0.2) * 20 * u * z, cy + Math.cos(f.t * 0.5 + i * 0.2) * 20 * u * z, r, sides, f.t * 0.15 + i * 0.05);
    ctx.stroke();
  }
  ctx.restore();
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 200 * u);
  g.addColorStop(0, rgba('#ffffff', 0.25 + 0.5 * f.bass)); g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
};

// ---------------------------------------------------------------- 10. pulsing neon shape with floor reflection
draw.shape = (ctx, W, H, o, f) => {
  const u = unit(W, H); drawBackground(ctx, W, H, o, f);
  const cx = W / 2, cy = H > W * 1.2 ? H * 0.42 : H * 0.44;
  const sides = o.shapeSides ?? 3;
  const s = 230 * u * (1 + 0.12 * f.bass * o.sens);
  const floorY = cy + s * 1.05;
  const drawShape = (alpha) => {
    for (let k = 3; k >= 0; k--) {
      const col = k % 2 ? o.color2 : o.color1;
      glowStroke(ctx, rgba(col, alpha * (1 - k * 0.2)), (12 - k * 2.5) * u, 40 * u);
      polygon(ctx, cx, cy, s * (1 - k * 0.12), sides, 0);
      ctx.stroke();
    }
  };
  ctx.save();
  ctx.globalCompositeOperation = 'lighter'; ctx.lineJoin = 'round';
  // light beams
  for (let i = 0; i < 6; i++) {
    const x = W * (0.1 + i * 0.16);
    const gl = ctx.createLinearGradient(0, 0, 0, floorY);
    gl.addColorStop(0, rgba(i % 2 ? o.color1 : o.color2, 0.0)); gl.addColorStop(1, rgba(i % 2 ? o.color1 : o.color2, 0.12 * f.rms));
    ctx.fillStyle = gl; ctx.fillRect(x - 2 * u, 0, 4 * u, floorY);
  }
  drawShape(1);
  // particles inside
  const R = rng(7);
  for (let i = 0; i < 30; i++) {
    const a = R() * TAU, d = R() * s * 0.5 * (0.6 + 0.4 * Math.sin(f.t + i));
    ctx.fillStyle = rgba('#ffffff', 0.4 + 0.6 * f.high);
    ctx.beginPath(); ctx.arc(cx + Math.cos(a + f.t * 0.3) * d, cy + Math.sin(a + f.t * 0.3) * d, 2.5 * u, 0, TAU); ctx.fill();
  }
  // reflection
  ctx.save();
  ctx.translate(0, floorY * 2); ctx.scale(1, -1);
  drawShape(0.18);
  ctx.restore();
  ctx.restore();
  const fg = ctx.createLinearGradient(0, floorY, 0, H);
  fg.addColorStop(0, 'rgba(0,0,0,0.2)'); fg.addColorStop(1, 'rgba(0,0,0,0.85)');
  ctx.fillStyle = fg; ctx.fillRect(0, floorY, W, H - floorY);
};

// ---------------------------------------------------------------- 11. synthwave sun + grid road
draw.synthwave = (ctx, W, H, o, f) => {
  const u = unit(W, H);
  const hz = H * (H > W * 1.2 ? 0.5 : 0.58);
  // sky
  const sky = ctx.createLinearGradient(0, 0, 0, hz);
  sky.addColorStop(0, '#0a0420'); sky.addColorStop(1, mix('#2a0a4a', o.color1, 0.35));
  ctx.fillStyle = sky; ctx.fillRect(0, 0, W, hz);
  const media = mediaOf(o);
  if (media) { ctx.save(); ctx.globalAlpha = 0.5; drawCover(ctx, media, 0, 0, W, hz); ctx.restore(); }
  // stars
  const R = rng(3);
  for (let i = 0; i < 120; i++) { ctx.fillStyle = `rgba(255,255,255,${0.2 + R() * 0.6})`; ctx.fillRect(R() * W, R() * hz * 0.8, 1.5 * u, 1.5 * u); }
  // sun with stripes, spectrum on top edge
  const sr = Math.min(W, H) * 0.26 * (1 + 0.04 * f.bass * o.sens), sx = W / 2, sy = hz - sr * 0.25;
  ctx.save();
  ctx.beginPath(); ctx.arc(sx, sy, sr, 0, TAU); ctx.clip();
  const sg = ctx.createLinearGradient(0, sy - sr, 0, sy + sr);
  sg.addColorStop(0, '#ffd36b'); sg.addColorStop(0.55, o.color2); sg.addColorStop(1, o.color1);
  ctx.fillStyle = sg; ctx.fillRect(sx - sr, sy - sr, sr * 2, sr * 2);
  ctx.fillStyle = '#0a0420';
  for (let i = 0; i < 8; i++) { const y = sy + sr * (0.1 + i * 0.12); ctx.fillRect(sx - sr, y, sr * 2, (2 + i * 2.2) * u); }
  ctx.restore();
  ctx.save(); ctx.shadowColor = o.color2; ctx.shadowBlur = 60 * u * (0.4 + f.bass);
  ctx.strokeStyle = rgba(o.color2, 0.3); ctx.lineWidth = 2 * u; ctx.beginPath(); ctx.arc(sx, sy, sr, Math.PI, TAU); ctx.stroke(); ctx.restore();
  // mountains (spectrum shaped)
  ctx.save();
  ctx.beginPath(); ctx.moveTo(0, hz);
  for (let i = 0; i <= 40; i++) {
    const x = (i / 40) * W, d = Math.abs(i / 40 - 0.5) * 2;
    const v = band(f, d * 0.9) * o.sens;
    const hgt = (0.25 + 0.75 * d) * (40 + v * 120) * u;
    ctx.lineTo(x, hz - hgt);
  }
  ctx.lineTo(W, hz); ctx.closePath();
  ctx.fillStyle = '#12052a'; ctx.fill();
  ctx.strokeStyle = o.color1; ctx.lineWidth = 2.5 * u; ctx.shadowColor = o.color1; ctx.shadowBlur = 14 * u; ctx.stroke();
  ctx.restore();
  // ground + grid
  ctx.fillStyle = '#0a0216'; ctx.fillRect(0, hz, W, H - hz);
  ctx.save();
  ctx.strokeStyle = rgba(o.color1, 0.85); ctx.shadowColor = o.color1; ctx.shadowBlur = 10 * u;
  const scroll = (f.t * 0.8) % 1;
  for (let i = 0; i < 18; i++) {
    const z = (i + 1 - scroll) / 3; const y = hz + (H - hz) * (0.08 / z) * 3;
    if (y > H || y < hz) continue;
    ctx.lineWidth = Math.max(1, 3 / z) * u; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }
  for (let i = -14; i <= 14; i++) {
    ctx.lineWidth = 1.8 * u; ctx.beginPath(); ctx.moveTo(W / 2 + i * 12 * u, hz); ctx.lineTo(W / 2 + i * W * 0.22, H); ctx.stroke();
  }
  ctx.restore();
  const hg = ctx.createLinearGradient(0, hz - 30 * u, 0, hz + 60 * u);
  hg.addColorStop(0, 'rgba(0,0,0,0)'); hg.addColorStop(0.5, rgba(o.color2, 0.35 + 0.3 * f.bass)); hg.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = hg; ctx.fillRect(0, hz - 30 * u, W, 90 * u);
};

// ---------------------------------------------------------------- 12. vinyl record
draw.vinyl = (ctx, W, H, o, f) => {
  const u = unit(W, H); drawBackground(ctx, W, H, o, f);
  const [cx, cy] = centre(W, H);
  const R = 330 * u;
  const rot = f.t * (33.3 / 60) * TAU;
  ctx.save();
  // spectrum halo
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 90; i++) {
    const a = (i / 90) * TAU - Math.PI / 2;
    const v = band(f, (i < 45 ? i : 90 - i) / 45 * 0.8) * o.sens;
    glowStroke(ctx, mix(o.color1, o.color2, i / 90), 6 * u, 12 * u);
    ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * (R + 14 * u), cy + Math.sin(a) * (R + 14 * u));
    ctx.lineTo(cx + Math.cos(a) * (R + 14 * u + v * v * 110 * u), cy + Math.sin(a) * (R + 14 * u + v * v * 110 * u)); ctx.stroke();
  }
  ctx.restore();
  ctx.save();
  ctx.translate(cx, cy); ctx.rotate(rot);
  ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 40 * u;
  ctx.fillStyle = '#0b0b0d'; ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.fill();
  ctx.shadowBlur = 0;
  for (let r = R * 0.38; r < R * 0.97; r += 5 * u) {
    ctx.strokeStyle = `rgba(255,255,255,${0.03 + 0.03 * Math.sin(r)})`; ctx.lineWidth = 1 * u;
    ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.stroke();
  }
  // sheen
  const sh = ctx.createConicGradient(0, 0, 0);
  sh.addColorStop(0, 'rgba(255,255,255,0)'); sh.addColorStop(0.1, 'rgba(255,255,255,0.12)'); sh.addColorStop(0.2, 'rgba(255,255,255,0)');
  sh.addColorStop(0.5, 'rgba(255,255,255,0)'); sh.addColorStop(0.6, 'rgba(255,255,255,0.12)'); sh.addColorStop(0.7, 'rgba(255,255,255,0)');
  ctx.rotate(-rot);
  ctx.fillStyle = sh; ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.fill();
  ctx.rotate(rot);
  ctx.restore();
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(rot);
  coverDisc(ctx, 0, 0, R * 0.34, o, f, u);
  ctx.fillStyle = '#ddd'; ctx.beginPath(); ctx.arc(0, 0, 7 * u, 0, TAU); ctx.fill();
  ctx.restore();
  // tonearm
  ctx.save();
  const px = cx + R * 1.05, py = cy - R * 0.95;
  ctx.fillStyle = '#c9ccd3'; ctx.beginPath(); ctx.arc(px, py, 26 * u, 0, TAU); ctx.fill();
  ctx.strokeStyle = '#c9ccd3'; ctx.lineWidth = 9 * u; ctx.lineCap = 'round';
  const ang = 2.05 + Math.sin(f.t * 0.3) * 0.01;
  const ex = px + Math.cos(ang) * R * 1.05, ey = py + Math.sin(ang) * R * 1.05;
  ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(ex, ey); ctx.stroke();
  ctx.fillStyle = '#8d9099'; ctx.fillRect(ex - 16 * u, ey - 10 * u, 32 * u, 26 * u);
  ctx.restore();
};

// ---------------------------------------------------------------- 13. cassette tape
draw.cassette = (ctx, W, H, o, f) => {
  const u = unit(W, H); drawBackground(ctx, W, H, o, f);
  const [cx, cy] = centre(W, H);
  const w = 760 * u, h = 480 * u, x = cx - w / 2, y = cy - h / 2;
  const bump = 1 + 0.03 * f.bass * o.sens;
  ctx.save();
  ctx.translate(cx, cy); ctx.scale(bump, bump); ctx.translate(-cx, -cy);
  ctx.shadowColor = rgba(o.color1, 0.6); ctx.shadowBlur = 40 * u * (0.3 + f.bass);
  ctx.fillStyle = '#1a1c24'; ctx.beginPath(); ctx.roundRect(x, y, w, h, 28 * u); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = o.color1; ctx.lineWidth = 4 * u; ctx.stroke();
  // label
  const lg = ctx.createLinearGradient(x, 0, x + w, 0); lg.addColorStop(0, o.color1); lg.addColorStop(1, o.color2);
  ctx.fillStyle = lg; ctx.beginPath(); ctx.roundRect(x + 40 * u, y + 34 * u, w - 80 * u, 260 * u, 14 * u); ctx.fill();
  ctx.fillStyle = '#f2f2f2'; ctx.fillRect(x + 40 * u, y + 34 * u, w - 80 * u, 54 * u);
  ctx.fillStyle = '#111'; ctx.font = `700 ${30 * u}px ${fontStack(o.titleFont)}`; ctx.textAlign = 'left';
  ctx.fillText((o.title || 'MIXTAPE').slice(0, 32), x + 60 * u, y + 72 * u);
  // window
  const wx = x + 170 * u, wy = y + 120 * u, ww = w - 340 * u, wh = 140 * u;
  ctx.fillStyle = '#0a0b0f'; ctx.beginPath(); ctx.roundRect(wx, wy, ww, wh, 70 * u); ctx.fill();
  // tape amount moves from left reel to right
  const prog = f.duration ? clamp(f.t / f.duration, 0, 1) : 0.5;
  const reels = [[wx + 75 * u, 1 - prog], [wx + ww - 75 * u, prog]];
  for (const [rx, amt] of reels) {
    const ry = wy + wh / 2;
    ctx.fillStyle = '#3b2a20'; ctx.beginPath(); ctx.arc(rx, ry, (40 + 26 * amt) * u, 0, TAU); ctx.fill();
    ctx.save(); ctx.translate(rx, ry); ctx.rotate(f.t * 3);
    ctx.fillStyle = '#e8e8e8'; ctx.beginPath(); ctx.arc(0, 0, 34 * u, 0, TAU); ctx.fill();
    ctx.fillStyle = '#0a0b0f';
    for (let k = 0; k < 6; k++) { ctx.rotate(TAU / 6); ctx.fillRect(-4 * u, 10 * u, 8 * u, 18 * u); }
    ctx.beginPath(); ctx.arc(0, 0, 10 * u, 0, TAU); ctx.fill();
    ctx.restore();
  }
  // tape below as a waveform
  ctx.strokeStyle = '#3b2a20'; ctx.lineWidth = 6 * u; ctx.lineJoin = 'round';
  ctx.beginPath();
  for (let i = 0; i <= 60; i++) {
    const tx = x + 60 * u + (i / 60) * (w - 120 * u);
    const ty = y + h + 40 * u + f.wave((i / 60) * 0.08) * 70 * u * o.sens;
    i ? ctx.lineTo(tx, ty) : ctx.moveTo(tx, ty);
  }
  ctx.stroke();
  // screws
  ctx.fillStyle = '#555a66';
  for (const [sx, sy] of [[x + 24, y + 24], [x + w - 24, y + 24], [x + 24, y + h - 24], [x + w - 24, y + h - 24]].map(([a, b]) => [a, b]))
    { ctx.beginPath(); ctx.arc(sx, sy, 7 * u, 0, TAU); ctx.fill(); }
  ctx.restore();
};

// ---------------------------------------------------------------- 14. album promo card
draw.album = (ctx, W, H, o, f) => {
  const u = unit(W, H);
  // blurred cover as background when available
  if (o.centerImage && !mediaOf(o)) {
    ctx.drawImage(blurredCopy(o.centerImage, W, H, 40 * u), 0, 0);
    ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillRect(0, 0, W, H);
  } else drawBackground(ctx, W, H, o, f);
  const portrait = H > W * 1.2;
  const cs = (portrait ? 620 : 520) * u * (1 + 0.02 * f.bass);
  const cx = portrait ? W / 2 : W * 0.3, cy = portrait ? H * 0.36 : H * 0.48;
  ctx.save();
  ctx.shadowColor = rgba(o.color1, 0.7); ctx.shadowBlur = 50 * u * (0.4 + f.bass);
  ctx.beginPath(); ctx.roundRect(cx - cs / 2, cy - cs / 2, cs, cs, 22 * u); ctx.fillStyle = '#111'; ctx.fill();
  ctx.clip();
  if (o.centerImage) drawCover(ctx, o.centerImage, cx - cs / 2, cy - cs / 2, cs, cs);
  else { const g = ctx.createLinearGradient(cx - cs / 2, cy - cs / 2, cx + cs / 2, cy + cs / 2); g.addColorStop(0, o.color1); g.addColorStop(1, o.color2); ctx.fillStyle = g; ctx.fillRect(cx - cs / 2, cy - cs / 2, cs, cs); }
  ctx.restore();
  // info block
  const ix = portrait ? W * 0.12 : W * 0.55, iy = portrait ? cy + cs / 2 + 90 * u : H * 0.36;
  const iw = portrait ? W * 0.76 : W * 0.38;
  ctx.save();
  ctx.textAlign = 'left'; ctx.fillStyle = o.textColor;
  ctx.font = `${o.titleWeight || 800} ${Math.round(o.titleSize * 1.05 * u)}px ${fontStack(o.titleFont)}`;
  ctx.fillText(o.title || 'Track name', ix, iy);
  ctx.globalAlpha = 0.75; ctx.font = `400 ${Math.round(o.titleSize * 0.6 * u)}px ${fontStack(o.subFont)}`;
  ctx.fillText(o.subtitle || 'Artist', ix, iy + o.titleSize * 0.95 * u);
  ctx.globalAlpha = 1;
  // bars
  const by = iy + o.titleSize * 2.4 * u, bh = 110 * u, n = 40, bw = iw / n;
  for (let i = 0; i < n; i++) {
    const v = clamp(band(f, i / n * 0.9) * o.sens, 0.04, 1.1);
    ctx.fillStyle = mix(o.color1, o.color2, i / n);
    ctx.beginPath(); ctx.roundRect(ix + i * bw + bw * 0.2, by + bh / 2 - (v * bh) / 2, bw * 0.6, v * bh, bw * 0.3); ctx.fill();
  }
  // progress
  const py = by + bh + 50 * u, prog = f.duration ? clamp(f.t / f.duration, 0, 1) : 0;
  ctx.fillStyle = 'rgba(255,255,255,0.2)'; ctx.fillRect(ix, py, iw, 5 * u);
  ctx.fillStyle = o.color2; ctx.fillRect(ix, py, iw * prog, 5 * u);
  ctx.beginPath(); ctx.arc(ix + iw * prog, py + 2.5 * u, 10 * u, 0, TAU); ctx.fillStyle = '#fff'; ctx.fill();
  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  ctx.font = `500 ${24 * u}px ${fontStack(o.subFont)}`; ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.fillText(fmt(f.t), ix, py + 46 * u);
  ctx.textAlign = 'right'; ctx.fillText(fmt(f.duration || 0), ix + iw, py + 46 * u);
  ctx.restore();
};

// ---------------------------------------------------------------- 15. podcast
draw.podcast = (ctx, W, H, o, f) => {
  const u = unit(W, H); drawBackground(ctx, W, H, o, f);
  const portrait = H > W * 1.2;
  const cx = portrait ? W / 2 : W * 0.3, cy = portrait ? H * 0.34 : H * 0.45;
  const r = 230 * u;
  ctx.save();
  for (let k = 3; k >= 1; k--) {
    ctx.fillStyle = rgba(o.color1, 0.12 * (4 - k) * (0.3 + f.rms));
    ctx.beginPath(); ctx.arc(cx, cy, r + k * 30 * u * (0.5 + f.rms * o.sens), 0, TAU); ctx.fill();
  }
  ctx.restore();
  coverDisc(ctx, cx, cy, r, o, f, u);
  // waveform bar
  const wx = portrait ? W * 0.08 : W * 0.55, wy = portrait ? H * 0.62 : H * 0.62;
  const ww = portrait ? W * 0.84 : W * 0.38, n = 70;
  ctx.save();
  for (let i = 0; i < n; i++) {
    const v = Math.abs(f.wave((i - n) * 0.012)) * 0.8 + band(f, (i % 20) / 20 * 0.5) * 0.3;
    const h = clamp(v * o.sens, 0.05, 1.2) * 120 * u;
    ctx.fillStyle = i > n - 6 ? o.color2 : rgba(o.color1, 0.4 + 0.6 * (i / n));
    ctx.beginPath(); ctx.roundRect(wx + (i / n) * ww, wy - h / 2, (ww / n) * 0.55, h, 4 * u); ctx.fill();
  }
  // mic icon
  const mx = portrait ? W / 2 : W * 0.55 + 30 * u, my = portrait ? H * 0.53 : H * 0.36;
  ctx.fillStyle = o.color2;
  ctx.beginPath(); ctx.roundRect(mx - 14 * u, my - 40 * u, 28 * u, 52 * u, 14 * u); ctx.fill();
  ctx.strokeStyle = o.color2; ctx.lineWidth = 5 * u;
  ctx.beginPath(); ctx.arc(mx, my, 26 * u, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(mx, my + 26 * u); ctx.lineTo(mx, my + 40 * u); ctx.stroke();
  ctx.restore();
};

// ---------------------------------------------------------------- 16. wireframe sphere
draw.sphere = (ctx, W, H, o, f) => {
  const u = unit(W, H); drawBackground(ctx, W, H, o, f);
  const [cx, cy] = centre(W, H);
  const R = 300 * u;
  const ry = f.t * 0.4, rx = 0.35 + Math.sin(f.t * 0.2) * 0.1;
  const proj = (lat, lon) => {
    const bi = Math.floor(((lat / Math.PI) + 0.5) * NUM_BANDS * 0.8);
    const disp = 1 + band(f, clamp(bi / NUM_BANDS, 0, 1)) * band(f, 0.02) * 0.25 * o.sens * (0.6 + 0.4 * Math.sin(lon * 4 + f.t * 2));
    let x = Math.cos(lat) * Math.cos(lon), y = Math.sin(lat), z = Math.cos(lat) * Math.sin(lon);
    [x, z] = [x * Math.cos(ry) - z * Math.sin(ry), x * Math.sin(ry) + z * Math.cos(ry)];
    [y, z] = [y * Math.cos(rx) - z * Math.sin(rx), y * Math.sin(rx) + z * Math.cos(rx)];
    const p = 1.8 / (2.6 - z);
    return [cx + x * R * disp * p, cy + y * R * disp * p, z];
  };
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineWidth = 1.6 * u;
  for (let i = 1; i < 18; i++) {
    const lat = -Math.PI / 2 + (i / 18) * Math.PI;
    ctx.beginPath();
    for (let j = 0; j <= 64; j++) { const [x, y] = proj(lat, (j / 64) * TAU); j ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    ctx.strokeStyle = mix(o.color1, o.color2, i / 18).replace('rgb', 'rgba').replace(')', ',0.6)');
    ctx.stroke();
  }
  for (let j = 0; j < 24; j++) {
    const lon = (j / 24) * TAU;
    ctx.beginPath();
    for (let i = 0; i <= 40; i++) { const [x, y] = proj(-Math.PI / 2 + (i / 40) * Math.PI, lon); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    ctx.strokeStyle = rgba(o.color2, 0.25); ctx.stroke();
  }
  // orbit ring
  ctx.strokeStyle = rgba('#ffffff', 0.25 + 0.4 * f.bass); ctx.lineWidth = 2 * u;
  ctx.beginPath(); ctx.ellipse(cx, cy, R * 1.6, R * 0.35, -0.2, 0, TAU); ctx.stroke();
  ctx.restore();
};

// ---------------------------------------------------------------- 17. liquid bubbles
draw.bubbles = (ctx, W, H, o, f) => {
  const u = unit(W, H); drawBackground(ctx, W, H, o, f);
  const R = rng(11);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 16; i++) {
    const bx = R() * W, by = R() * H, br = (60 + R() * 140) * u, sp = 0.1 + R() * 0.25, ph = R() * TAU;
    const x = bx + Math.sin(f.t * sp + ph) * 120 * u, y = by + Math.cos(f.t * sp * 0.8 + ph) * 120 * u;
    const r = br * (1 + 0.25 * band(f, (i / 16) * 0.8) * o.sens);
    const col = i % 2 ? o.color1 : o.color2;
    const g = ctx.createRadialGradient(x, y, r * 0.2, x, y, r);
    g.addColorStop(0, rgba(col, 0.05)); g.addColorStop(0.75, rgba(col, 0.25)); g.addColorStop(0.95, rgba(col, 0.75)); g.addColorStop(1, rgba(col, 0));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
  }
  ctx.restore();
  const [cx, cy] = centre(W, H);
  const r = 200 * u * (1 + 0.1 * f.bass * o.sens);
  ctx.save();
  ctx.shadowColor = o.color1; ctx.shadowBlur = 60 * u;
  const g = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, 0, cx, cy, r);
  g.addColorStop(0, rgba('#ffffff', 0.9)); g.addColorStop(0.3, rgba(o.color2, 0.8)); g.addColorStop(1, rgba(o.color1, 0.9));
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.fill();
  ctx.restore();
};

// ---------------------------------------------------------------- 18. vortex / spiral rays
draw.vortex = (ctx, W, H, o, f) => {
  const u = unit(W, H); drawBackground(ctx, W, H, o, f);
  const [cx, cy] = centre(W, H);
  const R = rng(5);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  const arms = 220;
  for (let i = 0; i < arms; i++) {
    const a0 = R() * TAU, rr = 40 + R() * 560, len = 0.5 + R() * 1.4;
    const col = R() > 0.5 ? o.color1 : o.color2;
    const spin = f.t * (0.35 + 0.25 * f.rms) + a0;
    const r = rr * u * (1 + 0.15 * f.bass * o.sens);
    ctx.strokeStyle = rgba(col, 0.15 + 0.5 * (1 - rr / 600));
    ctx.lineWidth = (1 + R() * 4) * u;
    ctx.beginPath();
    for (let k = 0; k <= 12; k++) {
      const a = spin + (k / 12) * len, rk = r * (1 - k / 12 * 0.25);
      const x = cx + Math.cos(a) * rk, y = cy + Math.sin(a) * rk;
      k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
  }
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 160 * u);
  g.addColorStop(0, rgba('#ffffff', 0.7 * f.bass + 0.2)); g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.restore();
};

// ---------------------------------------------------------------- 19. glitch
draw.glitch = (ctx, W, H, o, f) => {
  const u = unit(W, H);
  const hit = f.sinceBeat < 0.18 ? (1 - f.sinceBeat / 0.18) * (f.lastBeat?.s || 1) : 0;
  drawBackground(ctx, W, H, o, f, { zoom: 0.03 * hit });
  const [cx, cy] = centre(W, H);
  const media = o.centerImage || mediaOf(o);
  const cs = 520 * u;
  // main square cover
  const drawMain = (dx, dy, alpha, comp) => {
    ctx.save(); ctx.globalAlpha = alpha; if (comp) ctx.globalCompositeOperation = comp;
    ctx.beginPath(); ctx.rect(cx - cs / 2 + dx, cy - cs / 2 + dy, cs, cs); ctx.clip();
    if (media) drawCover(ctx, media, cx - cs / 2 + dx, cy - cs / 2 + dy, cs, cs);
    else { ctx.fillStyle = o.color1; ctx.fillRect(cx - cs / 2 + dx, cy - cs / 2 + dy, cs, cs); }
    ctx.restore();
  };
  drawMain(0, 0, 1);
  if (hit > 0) {
    drawMain(-16 * u * hit, 0, 0.5, 'screen');
    ctx.save(); ctx.globalCompositeOperation = 'multiply'; ctx.fillStyle = rgba(o.color2, 0.4 * hit); ctx.fillRect(cx - cs / 2, cy - cs / 2, cs, cs); ctx.restore();
    // slices
    const R = rng(Math.floor(f.t * 30));
    for (let i = 0; i < 8; i++) {
      const sy = cy - cs / 2 + R() * cs, sh = (6 + R() * 40) * u, off = (R() - 0.5) * 120 * u * hit;
      ctx.drawImage(ctx.canvas, cx - cs / 2, sy, cs, sh, cx - cs / 2 + off, sy, cs, sh);
    }
  }
  // side bars
  ctx.save();
  for (let i = 0; i < 40; i++) {
    const v = band(f, (i / 40) * 0.9) * o.sens;
    const h = clamp(v, 0.03, 1.2) * 60 * u;
    const x1 = cx - cs / 2 - 30 * u - i * 12 * u, x2 = cx + cs / 2 + 30 * u + i * 12 * u;
    ctx.fillStyle = rgba(o.textColor, 0.8 - i / 60);
    ctx.fillRect(x1, cy - h / 2, 4 * u, h); ctx.fillRect(x2, cy - h / 2, 4 * u, h);
  }
  ctx.restore();
  // scanlines
  ctx.fillStyle = 'rgba(0,0,0,0.12)';
  for (let y = 0; y < H; y += 4 * u) ctx.fillRect(0, y, W, 1.5 * u);
};

// ---------------------------------------------------------------- 20. heartbeat monitor
draw.heartbeat = (ctx, W, H, o, f) => {
  const u = unit(W, H);
  ctx.fillStyle = '#05080a'; ctx.fillRect(0, 0, W, H);
  const media = mediaOf(o);
  if (media) { ctx.save(); ctx.globalAlpha = 0.25; drawCover(ctx, media, 0, 0, W, H); ctx.restore(); }
  // grid
  ctx.strokeStyle = rgba(o.color1, 0.08); ctx.lineWidth = 1;
  for (let x = 0; x < W; x += 40 * u) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y < H; y += 40 * u) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  const lanes = [0.3, 0.5, 0.7];
  const span = 3.0; // seconds visible
  ctx.save();
  ctx.lineJoin = 'round';
  lanes.forEach((ly, li) => {
    const y0 = H * ly;
    const col = li === 1 ? o.color2 : o.color1;
    glowStroke(ctx, col, 3 * u, 14 * u);
    ctx.beginPath();
    const N = 260;
    for (let i = 0; i <= N; i++) {
      const dt = (i / N - 1) * span;
      let v = 0;
      if (li === 0) v = (f.bassAt(-dt) - 0.2) * 1.2;
      else if (li === 1) {
        // ECG-like spikes on beats
        const tt = f.t + dt;
        for (const b of f.beatsBetween(tt - 0.25, tt)) {
          const k = (tt - b.t) / 0.25;
          v += (k < 0.2 ? -k * 2 : k < 0.4 ? (k - 0.2) * 12 - 0.4 : k < 0.6 ? 2 - (k - 0.4) * 14 : 0) * b.s;
        }
      } else v = f.wave(dt * 0.05) * 0.6;
      const x = (i / N) * W;
      const y = y0 - v * 90 * u * o.sens;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.shadowBlur = 20 * u;
    ctx.beginPath(); ctx.arc(W - 4 * u, y0, 5 * u, 0, TAU); ctx.fill();
  });
  ctx.restore();
  ctx.save(); ctx.fillStyle = rgba(o.color2, 0.9); ctx.font = `700 ${46 * u}px ${fontStack(o.subFont)}`;
  ctx.textAlign = 'right'; ctx.fillText(`♥ ${f.bpm}`, W - 50 * u, H * 0.12); ctx.restore();
};

// ---------------------------------------------------------------- 21. kaleidoscope
draw.kaleido = (ctx, W, H, o, f) => {
  const u = unit(W, H);
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  const cx = W / 2, cy = H / 2;
  const seg = 8, R = Math.hypot(W, H) / 2;
  const src = mediaOf(o) || o.centerImage;
  // build one wedge texture each frame
  for (let s = 0; s < seg; s++) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((s / seg) * TAU + f.t * 0.1);
    if (s % 2) ctx.scale(1, -1);
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, R, 0, TAU / seg + 0.01); ctx.closePath(); ctx.clip();
    const z = 1.2 + 0.25 * f.bass * o.sens;
    ctx.rotate(f.t * 0.2);
    if (src) { drawCover(ctx, src, -R * 0.2, -R * 0.2, R * 1.2, R * 1.2, z); }
    else {
      // generated neon curves
      ctx.globalCompositeOperation = 'lighter';
      for (let k = 0; k < 9; k++) {
        const v = band(f, k / 9 * 0.8) * o.sens;
        glowStroke(ctx, rgba(k % 2 ? o.color1 : o.color2, 0.8), (2 + v * 6) * u, 14 * u);
        ctx.beginPath();
        for (let j = 0; j <= 30; j++) {
          const rr = (j / 30) * R * 0.9, a = Math.sin(j * 0.3 + f.t + k) * (0.2 + v * 0.3) + k * 0.06;
          const x = Math.cos(a) * rr, y = Math.sin(a) * rr;
          j ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        }
        ctx.stroke();
      }
    }
    ctx.restore();
  }
  ctx.fillStyle = `rgba(0,0,0,${0.25 - 0.2 * f.bass})`; ctx.fillRect(0, 0, W, H);
};

// ---------------------------------------------------------------- 22. glitter burst around a title ring
draw.glitter = (ctx, W, H, o, f) => {
  const u = unit(W, H); drawBackground(ctx, W, H, o, f);
  const [cx, cy] = centre(W, H);
  beatParticles(ctx, W, H, o, f, cx, cy, 160 * u, u, 60, 2.2);
  const R = rng(9);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 260; i++) {
    const a = R() * TAU, d = (200 + R() * 700) * u, tw = 0.5 + 0.5 * Math.sin(f.t * (2 + R() * 4) + i);
    const x = cx + Math.cos(a + f.t * 0.05) * d, y = cy + Math.sin(a + f.t * 0.05) * d;
    ctx.fillStyle = rgba(R() > 0.5 ? o.color1 : o.color2, tw * (0.3 + 0.7 * f.high));
    ctx.beginPath(); ctx.arc(x, y, (1 + R() * 3) * u, 0, TAU); ctx.fill();
  }
  // ring with ticks
  const r = 170 * u * (1 + 0.05 * f.bass);
  glowStroke(ctx, rgba('#ffffff', 0.9), 4 * u, 20 * u);
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.stroke();
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * TAU, v = band(f, (i % 24) / 24 * 0.8) * o.sens;
    ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * (r + 10 * u), cy + Math.sin(a) * (r + 10 * u));
    ctx.lineTo(cx + Math.cos(a) * (r + (14 + v * 40) * u), cy + Math.sin(a) * (r + (14 + v * 40) * u)); ctx.stroke();
  }
  ctx.restore();
  coverDisc(ctx, cx, cy, r - 12 * u, o, f, u);
};
