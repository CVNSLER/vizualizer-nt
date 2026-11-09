// "Smart" mixer: when the user pushes a fader, everything that would make the louder sound
// distort or get muddy is adjusted with it. Pure function of the mixer state + level statistics.

export const CEIL_DB = -1; // true-peak ceiling of the output
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// parametric EQ: 8 bands, flat by default
export const EQ_DEFAULT = [
  { type: 'highpass', f: 20, g: 0, q: 0.7, on: false },
  { type: 'lowshelf', f: 80, g: 0, q: 0.7, on: true },
  { type: 'peaking', f: 200, g: 0, q: 1.0, on: true },
  { type: 'peaking', f: 500, g: 0, q: 1.0, on: true },
  { type: 'peaking', f: 1500, g: 0, q: 1.0, on: true },
  { type: 'peaking', f: 3500, g: 0, q: 1.0, on: true },
  { type: 'peaking', f: 7000, g: 0, q: 1.0, on: true },
  { type: 'highshelf', f: 12000, g: 0, q: 0.7, on: true },
];

export const FX_MODES = ['orig', 'enh', 'post'];

export function defaultStudio() {
  return {
    master: { gain: 0, smart: true },
    mix: { gain: 0, pan: 0 },
    eq: EQ_DEFAULT.map((b) => ({ ...b })),
    fxMode: 'orig',
    fx: { orig: [], enh: [], post: [] },
  };
}

export const eqActive = (eq) => eq.some((b) => b.on && (b.type === 'highpass' ? b.f > 21 : Math.abs(b.g) > 0.05));
export const mixerNeutral = (st) => st.master.gain === 0 && st.mix.gain === 0 && st.mix.pan === 0 && !eqActive(st.eq);

/**
 * stats: { peakDb, loudDb, lowFrac } of the source that is playing
 * Returns the derived settings and a list of explanations for the UI.
 */
export function smartPlan(st, stats, bpm = 120, fxList = []) {
  const G = st.master.gain + st.mix.gain;
  const base = stats || { peakDb: -1, loudDb: -12, lowFrac: 0.3 };
  // effects and EQ boosts that add level push the peaks too
  const fxBoost = fxList.filter((f) => f.on).reduce((s, f) => {
    if (f.type === 'eq') return s + Math.max(0, f.p.low, f.p.lowMid, f.p.mid, f.p.presence, f.p.air) * 0.6;
    if (f.type === 'saturate') return s + f.p.mix * 1.5;
    return s;
  }, 0) + Math.max(0, ...st.eq.filter((b) => b.on && b.type !== 'highpass').map((b) => b.g)) * 0.6;
  const peakPred = base.peakDb + G + fxBoost;
  const over = peakPred - CEIL_DB; // dB the peaks would go above the ceiling
  const notes = [];
  const out = {
    over, peakPred, loudOut: base.loudDb + G,
    hp: 20, lowShelf: 0, highShelf: 0, comp: null,
    limiter: { threshold: CEIL_DB - 0.3, release: clamp(60 / bpm / 4, 0.04, 0.25) },
    satScale: 1, wetScale: 1,
    risk: over <= 0 ? 'safe' : over <= 3 ? 'ok' : over <= 8 ? 'busy' : 'hot',
  };
  if (!st.master.smart) {
    out.limiter = { threshold: CEIL_DB - 0.3, release: 0.1 };
    return { ...out, notes: ['manual'] };
  }
  if (over > 0) notes.push('limiter');
  // 1. glue compressor before the limiter, so the limiter never has to take more than ~3 dB
  if (over > 3) {
    const take = (over - 3) * 0.7;
    const ratio = clamp(1.6 + take / 4, 1.6, 4);
    out.comp = { threshold: clamp(base.loudDb + G - 2 - take * 0.3, -40, -3), ratio, attack: 0.02, release: clamp(60 / bpm / 2, 0.08, 0.4) };
    notes.push('comp');
  }
  // 2. low end eats the headroom first: tame it as the gain goes up (more if the song is bass-heavy)
  if (over > 2) {
    out.lowShelf = -clamp((over - 2) * 0.35 * (0.6 + base.lowFrac * 1.5), 0, 4.5);
    out.hp = 28;
    notes.push('bass');
  }
  // 3. equal-loudness: louder sounds harsher and boomier, quieter sounds thin
  if (G > 2) { out.highShelf = -clamp((G - 2) * 0.18, 0, 2); out.lowShelf -= clamp((G - 2) * 0.1, 0, 1); notes.push('loudness'); }
  if (G < -6) { const k = clamp((-G - 6) * 0.25, 0, 3); out.lowShelf += k; out.highShelf += k * 0.5; notes.push('quiet'); }
  // 4. distortion effects get less drive, reverb/delay tails get less send (compression brings them up)
  if (over > 0) {
    out.satScale = clamp(1 - over / 14, 0.35, 1);
    const gr = Math.min(over, 3) + (out.comp ? (over - 3) * 0.5 : 0);
    out.wetScale = clamp(10 ** (-(gr * 0.5) / 20), 0.5, 1);
    if (fxList.some((f) => f.on && ['saturate', 'reverb', 'delay'].includes(f.type))) notes.push('fx');
  }
  return { ...out, notes };
}
