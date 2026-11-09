import { draw, drawOverlay, drawBackground } from './templates.js';
import './templates2.js';

// Template gallery, grouped by style
export const CATEGORIES = [
  { id: 'base', items: ['zero'] },
  { id: 'circle', items: ['ring', 'dots', 'blob', 'ripples', 'hud', 'glitter'] },
  { id: 'line', items: ['wave', 'line', 'mountain', 'bars', 'led', 'surface'] },
  { id: 'space', items: ['warp', 'tunnel', 'shape', 'vortex', 'sphere', 'bubbles', 'kaleido'] },
  { id: 'retro', items: ['synthwave', 'vinyl', 'cassette', 'heartbeat', 'radar'] },
  { id: 'promo', items: ['album', 'podcast', 'glitch', 'shake'] },
];
// templates that use the shape option
export const SHAPED = ['tunnel', 'shape'];

export const PALETTES = [
  ['#7c5cff', '#22d3c5'], ['#ff2e88', '#ffb800'], ['#00e5ff', '#2962ff'], ['#39ff14', '#00b8d4'],
  ['#ff3d00', '#ffd600'], ['#e040fb', '#00e676'], ['#ffffff', '#9e9e9e'], ['#ff1744', '#651fff'],
];

// Settings every template understands (stored per template in o.tplCfg[id]):
//   [key, min, max, step, default]
export const TPL_PARAMS = [
  ['size', 0.4, 2, 0.01, 1], ['glow', 0, 3, 0.05, 1], ['line', 0.3, 3, 0.05, 1], ['speed', 0, 3, 0.05, 1],
  ['sens', 0.2, 2.5, 0.05, 1], ['beat', 0, 1, 0.01, 0], ['x', -0.5, 0.5, 0.01, 0], ['y', -0.5, 0.5, 0.01, 0],
  ['rot', -180, 180, 1, 0], ['spin', -30, 30, 0.5, 0],
];
const TPL_DEF = Object.fromEntries(TPL_PARAMS.map((p) => [p[0], p[4]]));
export function tplCfg(o, id = o.template) {
  return { ...TPL_DEF, mirror: false, color1: o.color1, color2: o.color2, ...(o.tplCfg?.[id] || {}) };
}

// scale shadowBlur / lineWidth of everything a template draws (instance-level override, removed after)
function scaleProp(ctx, name, k) {
  if (k === 1) return () => {};
  const proto = Object.getPrototypeOf(ctx), d = Object.getOwnPropertyDescriptor(proto, name);
  Object.defineProperty(ctx, name, { configurable: true, get() { return d.get.call(ctx) / k; }, set(v) { d.set.call(ctx, v * k); } });
  return () => { delete ctx[name]; };
}

export function renderFrame(ctx, W, H, o, f, duration) {
  ctx.save();
  ctx.clearRect(0, 0, W, H);
  if (o.template === 'none') drawBackground(ctx, W, H, o, f); // background + its effects only
  else {
    const c = tplCfg(o);
    const oo = { ...o, color1: c.color1, color2: c.color2, sens: (o.sens ?? 1) * c.sens };
    const ff = c.speed !== 1 ? { ...f, t: f.t * c.speed, realT: f.t } : f;
    // transform around the centre; drawBackground() resets it, so the background always fills the frame
    const pulse = 1 + c.beat * 0.25 * Math.min(1.3, f.kick ?? f.bass ?? 0);
    const ang = ((c.rot + c.spin * 6 * f.t) * Math.PI) / 180; // spin: turns per minute
    ctx.translate(W / 2 + c.x * W, H / 2 + c.y * H);
    if (ang) ctx.rotate(ang);
    ctx.scale(c.size * pulse * (c.mirror ? -1 : 1), c.size * pulse);
    ctx.translate(-W / 2, -H / 2);
    const u1 = scaleProp(ctx, 'shadowBlur', c.glow), u2 = scaleProp(ctx, 'lineWidth', c.line);
    try { (draw[o.template] || draw.ring)(ctx, W, H, oo, ff); } finally { u1(); u2(); }
  }
  ctx.restore();
  ctx.save();
  // album template draws its own title block
  drawOverlay(ctx, W, H, o.template === 'album' ? { ...o, title: '', subtitle: '' } : o, f, duration);
  ctx.restore();
}
