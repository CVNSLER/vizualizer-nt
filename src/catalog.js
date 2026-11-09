import { draw, drawOverlay, drawBackground } from './templates.js';
import './templates2.js';

// Template gallery, grouped by style
export const CATEGORIES = [
  { id: 'circle', items: ['ring', 'dots', 'blob', 'ripples', 'hud', 'glitter'] },
  { id: 'line', items: ['wave', 'line', 'mountain', 'bars', 'led', 'surface'] },
  { id: 'space', items: ['warp', 'tunnel', 'shape', 'vortex', 'sphere', 'bubbles', 'kaleido'] },
  { id: 'retro', items: ['synthwave', 'vinyl', 'cassette', 'heartbeat', 'radar'] },
  { id: 'promo', items: ['album', 'podcast', 'glitch', 'shake'] },
];
export const TEMPLATES = CATEGORIES.flatMap((c) => c.items);
// templates that use the shape option
export const SHAPED = ['tunnel', 'shape'];

export const PALETTES = [
  ['#7c5cff', '#22d3c5'], ['#ff2e88', '#ffb800'], ['#00e5ff', '#2962ff'], ['#39ff14', '#00b8d4'],
  ['#ff3d00', '#ffd600'], ['#e040fb', '#00e676'], ['#ffffff', '#9e9e9e'], ['#ff1744', '#651fff'],
];

export function renderFrame(ctx, W, H, o, f, duration) {
  ctx.save();
  ctx.clearRect(0, 0, W, H);
  if (o.template === 'none') drawBackground(ctx, W, H, o, f); // background + its effects only
  else (draw[o.template] || draw.ring)(ctx, W, H, o, f);
  ctx.restore();
  ctx.save();
  // album template draws its own title block
  drawOverlay(ctx, W, H, o.template === 'album' ? { ...o, title: '', subtitle: '' } : o, f, duration);
  ctx.restore();
}
