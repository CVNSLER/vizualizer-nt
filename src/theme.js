// App colour themes. Five colours define the whole look; the rest is derived in styles.css.
export const THEMES = {
  violet: { bg: '#0d0f14', panel: '#151821', text: '#e8eaf0', accent: '#7c5cff', accent2: '#22d3c5' },
  ocean: { bg: '#08121a', panel: '#0e1b26', text: '#e6f1f8', accent: '#2f9bff', accent2: '#2de1c2' },
  sunset: { bg: '#140c0c', panel: '#1d1213', text: '#f6e9e6', accent: '#ff6a3d', accent2: '#ffc145' },
  forest: { bg: '#0b120d', panel: '#111b14', text: '#e7f2ea', accent: '#3ecf6b', accent2: '#b6f05a' },
  rose: { bg: '#120b12', panel: '#1b111b', text: '#f6e8f4', accent: '#ff4fb3', accent2: '#8a7dff' },
  mono: { bg: '#0e0e0e', panel: '#171717', text: '#ececec', accent: '#9a9a9a', accent2: '#7aa7ff' },
  light: { bg: '#e9ecf2', panel: '#ffffff', text: '#1a1d26', accent: '#6a4cff', accent2: '#0f9e90' },
};
export const THEME_KEYS = ['bg', 'panel', 'text', 'accent', 'accent2'];

// relative luminance, to switch the browser's own controls to light/dark
function lum(hex) {
  const n = parseInt(hex.slice(1), 16), c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

export function loadTheme() {
  try { return { ...THEMES.violet, preset: 'violet', ...JSON.parse(localStorage.getItem('viz-theme') || '{}') }; } catch { return { ...THEMES.violet, preset: 'violet' }; }
}
export function applyTheme(t) {
  const r = document.documentElement;
  for (const k of THEME_KEYS) if (/^#[0-9a-f]{6}$/i.test(t[k] || '')) r.style.setProperty(`--${k}`, t[k]);
  r.classList.toggle('light', lum(t.bg) > 0.4);
  try { localStorage.setItem('viz-theme', JSON.stringify(t)); } catch { /* ignore */ }
}
