// Google Fonts loading for canvas text. All families are free to use (OFL / Apache / UFL).
import { FONTS } from './fonts-data.js';

export { FONTS };
export const FONT_BY_NAME = new Map(FONTS.map((f) => [f[0], f]));
const FALLBACK = '"Segoe UI", Inter, Arial, sans-serif';

export function fontStack(family) {
  return family ? `"${family}", ${FALLBACK}` : FALLBACK;
}

const cssLoaded = new Set();
function addCss(href) {
  if (cssLoaded.has(href)) return;
  cssLoaded.add(href);
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = href;
  document.head.appendChild(l);
}

const enc = (family) => encodeURIComponent(family).replace(/%20/g, '+');

// Only the glyphs of the font's own name: cheap previews in the picker.
export function previewFont(family) {
  addCss(`https://fonts.googleapis.com/css2?family=${enc(family)}&text=${encodeURIComponent(family)}&display=swap`);
}

const fullLoads = new Map();
// Load the complete font (all its weights) and wait until the canvas can use it.
export function loadFont(family) {
  if (!family || !FONT_BY_NAME.has(family)) return Promise.resolve(false);
  if (fullLoads.has(family)) return fullLoads.get(family);
  const weights = FONT_BY_NAME.get(family)[2].split('').map((d) => +d * 100).filter((w) => w >= 100);
  const ws = weights.length ? weights : [400];
  addCss(`https://fonts.googleapis.com/css2?family=${enc(family)}:wght@${ws.join(';')}&display=swap`);
  const p = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 8000);
    // the stylesheet must arrive before document.fonts knows the faces
    const tryLoad = async (n) => {
      try {
        const want = [400, 700].map((w) => ws.reduce((a, b) => (Math.abs(b - w) < Math.abs(a - w) ? b : a)));
        const res = await Promise.all(want.map((w) => document.fonts.load(`${w} 40px "${family}"`, 'AaБбЎўҚқ')));
        if (res.some((r) => r.length)) { clearTimeout(timer); resolve(true); return; }
      } catch { /* retry */ }
      if (n < 30) setTimeout(() => tryLoad(n + 1), 250); else { clearTimeout(timer); resolve(false); }
    };
    tryLoad(0);
  });
  fullLoads.set(family, p);
  return p;
}
