// "Smart" mixer: when the user pushes a fader, everything that would make the louder sound
// distort or get muddy is adjusted with it. Pure function of the mixer state + level statistics.

export const CEIL_DB = -1; // true-peak ceiling of the output
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const pow = (db) => 10 ** (db / 10);

export const CHANNELS = ['vocals', 'drums', 'bass', 'other'];

export function defaultStudio() {
  const strip = () => ({ gain: 0, pan: 0, mute: false, solo: false, fx: [] });
  return {
    stems: false,
    master: { gain: 0, smart: true, fx: [] },
    ch: { mix: strip(), vocals: strip(), drums: strip(), bass: strip(), other: strip() },
  };
}

export function isNeutral(st, extra = {}) {
  if (!st) return true;
  if (st.stems || extra.tuned || extra.cleaned) return false;
  const m = st.master;
  if (m.gain !== 0 || m.fx.some((f) => f.on)) return false;
  const c = st.ch.mix;
  return c.gain === 0 && c.pan === 0 && !c.mute && !c.fx.some((f) => f.on);
}

/** Which channels are playing and their fader gains (solo/mute applied). */
export function activeChannels(st) {
  const names = st.stems ? CHANNELS : ['mix'];
  const solo = names.some((k) => st.ch[k].solo);
  return names.map((k) => ({ k, on: !st.ch[k].mute && (!solo || st.ch[k].solo), gain: st.ch[k].gain }));
}

/**
 * stats: { mix: {peakDb, loudDb, lowFrac}, vocals: ..., ... } (whatever is available)
 * Returns the derived settings and a list of explanations for the UI.
 */
export function smartPlan(st, stats, bpm = 120) {
  const G = st.master.gain;
  const chans = activeChannels(st);
  const base = stats.mix || { peakDb: -1, loudDb: -12, lowFrac: 0.3 };
  // loudness of the sum: stems are roughly uncorrelated, so their powers add
  let loudNew = base.loudDb, loudOrig = base.loudDb, low = base.lowFrac;
  if (st.stems && CHANNELS.every((k) => stats[k])) {
    let pNew = 0, pOrig = 0, lowW = 0;
    for (const c of chans) {
      const s = stats[c.k];
      pOrig += pow(s.loudDb);
      if (!c.on) continue;
      pNew += pow(s.loudDb + c.gain);
      lowW += pow(s.loudDb + c.gain) * s.lowFrac;
    }
    loudOrig = 10 * Math.log10(pOrig + 1e-12);
    loudNew = 10 * Math.log10(pNew + 1e-12);
    low = pNew > 0 ? lowW / pNew : 0;
  } else {
    const c = chans[0];
    loudNew = c.on ? base.loudDb + c.gain : -90;
  }
  // effects that add level (EQ boosts, make-up) push the peaks too
  const fxBoost = (list) => list.filter((f) => f.on).reduce((s, f) => {
    if (f.type === 'eq') return s + Math.max(0, f.p.low, f.p.lowMid, f.p.mid, f.p.presence, f.p.air) * 0.6;
    if (f.type === 'saturate') return s + f.p.mix * 1.5;
    return s;
  }, 0);
  const boost = fxBoost(st.master.fx) + (st.stems ? 0 : fxBoost(st.ch.mix.fx));
  const peakPred = base.peakDb + (loudNew - loudOrig) + G + boost;
  const over = peakPred - CEIL_DB; // dB the peaks would go above the ceiling
  const notes = [];
  const out = {
    over, peakPred, loudOut: loudNew + G,
    hp: 20, lowShelf: 0, highShelf: 0, comp: null,
    limiter: { threshold: CEIL_DB - 0.3, release: clamp(60 / bpm / 4, 0.04, 0.25) },
    satScale: 1, wetScale: 1, ch: {},
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
    out.comp = { threshold: clamp(loudNew + G - 2 - take * 0.3, -40, -3), ratio, attack: 0.02, release: clamp(60 / bpm / 2, 0.08, 0.4) };
    notes.push('comp');
  }
  // 2. low end eats the headroom first: tame it as the gain goes up (more if the song is bass-heavy)
  if (over > 2) {
    out.lowShelf = -clamp((over - 2) * 0.35 * (0.6 + low * 1.5), 0, 4.5);
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
    if (st.master.fx.some((f) => f.on && ['saturate', 'reverb', 'delay'].includes(f.type))) notes.push('fx');
  }
  // 5. vocal riding: a louder vocal gets more de-essing, the music makes room around 2-4 kHz
  if (st.stems) {
    const v = st.ch.vocals.gain, music = Math.max(st.ch.other.gain, st.ch.drums.gain);
    const lift = v - music;
    if (lift > 2) {
      out.ch.vocals = { extraDeess: clamp((lift - 2) * 1.2, 0, 8) };
      out.ch.other = { unmask: -clamp((lift - 2) * 0.5, 0, 3) };
      notes.push('vocal');
    }
    // a bass pushed up gets its own low-end trimmed a little to stay clean
    if (st.ch.bass.gain > 3) { out.ch.bass = { lowTrim: -clamp((st.ch.bass.gain - 3) * 0.3, 0, 3) }; notes.push('bassch'); }
  }
  return { ...out, notes };
}
