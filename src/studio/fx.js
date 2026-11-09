// Effects for the studio. Every effect is a small Web Audio graph, so the same code runs live
// (AudioContext) and for the export (OfflineAudioContext) and both sound the same.

const dB = (x) => 10 ** (x / 20);
const set = (param, v, ctx) => {
  if (!Number.isFinite(v)) return;
  if (ctx instanceof OfflineAudioContext || ctx.state !== 'running') param.value = v;
  else param.setTargetAtTime(v, ctx.currentTime, 0.02);
};
// DynamicsCompressorNode adds its own make-up gain ((1/fullRangeGain)^0.6, Web Audio spec);
// this is the gain that cancels it, so a compressor only ever turns things down.
// Same maths as Chromium's DynamicsCompressorKernel (knee curve + full-range make-up).
const lin = (d) => 10 ** (d / 20), toDb = (x) => 20 * Math.log10(Math.max(1e-12, x));
const mkCache = new Map();
export function unMakeup(threshold, ratio, knee = 0) {
  const key = `${threshold.toFixed(2)}|${ratio.toFixed(3)}|${knee}`;
  if (mkCache.has(key)) return mkCache.get(key);
  const lt = lin(threshold), kneeDb = threshold + knee, kt = lin(kneeDb), slope = 1 / Math.max(1, ratio);
  const kneeCurve = (x, k) => (x < lt ? x : lt + (1 - Math.exp(-k * (x - lt))) / k);
  const slopeAt = (x, k) => { const x2 = x * 1.001; return (toDb(kneeCurve(x2, k)) - toDb(kneeCurve(x, k))) / (toDb(x2) - toDb(x)); };
  let minK = 0.1, maxK = 10000, k = 5;
  for (let i = 0; i < 15; i++) { if (slopeAt(kt, k) < slope) maxK = k; else minK = k; k = Math.sqrt(minK * maxK); }
  const yKneeDb = toDb(kneeCurve(kt, k));
  const sat = (x) => (x < kt ? kneeCurve(x, k) : lin(yKneeDb + slope * (toDb(x) - kneeDb)));
  const makeup = (1 / sat(1)) ** 0.6;
  const g = threshold >= 0 || ratio <= 1 ? 1 : 1 / makeup;
  if (mkCache.size > 500) mkCache.clear();
  mkCache.set(key, g);
  return g;
}
const stereo = (node) => { node.channelCount = 2; node.channelCountMode = 'explicit'; node.channelInterpretation = 'speakers'; return node; };

export const DELAY_SYNC = { '1/4': 1, '1/8': 0.5, '1/8.': 0.75, '1/16': 0.25, '1/4T': 2 / 3, '1/2': 2 };

// ---------------------------------------------------------------- reverb impulse responses
const IR_TYPES = {
  room: { er: 0.012, density: 1, bright: 0.5 },
  hall: { er: 0.025, density: 1, bright: 0.45 },
  plate: { er: 0.002, density: 1.6, bright: 0.8 },
  cathedral: { er: 0.04, density: 0.9, bright: 0.35 },
};
const irCache = new Map();
function impulse(ctx, type, decay, damp) {
  const key = `${ctx.sampleRate}|${type}|${decay.toFixed(2)}|${Math.round(damp)}`;
  if (irCache.has(key)) return irCache.get(key);
  const T = IR_TYPES[type] || IR_TYPES.hall, fs = ctx.sampleRate;
  const len = Math.max(1, Math.round(fs * Math.min(8, decay * 1.15 + 0.05)));
  const buf = ctx.createBuffer(2, len, fs);
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x3fffffff - 1; };
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    // diffuse tail: noise with an exponential (RT60) decay, getting darker over time
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / fs;
      const env = Math.exp((-6.9 * t) / Math.max(0.1, decay));
      const cutoff = damp * (1 - 0.6 * Math.min(1, t / decay)) * (0.6 + T.bright * 0.8);
      const a = Math.exp((-2 * Math.PI * Math.min(fs * 0.45, cutoff)) / fs);
      lp = (1 - a) * rnd() * T.density + a * lp;
      const fadeIn = Math.min(1, t / (T.er + 0.001));
      d[i] = lp * env * fadeIn;
    }
    // early reflections
    if (type !== 'plate') {
      for (let k = 0; k < 9; k++) {
        const at = Math.round(fs * (T.er * (0.4 + k * 0.33) + (c ? 0.0017 * k : 0)));
        if (at < len) d[at] += (0.6 - k * 0.05) * (k % 2 ? -1 : 1);
      }
    }
    // normalise energy so the wet level does not depend on the decay time
    let e = 0; for (let i = 0; i < len; i++) e += d[i] * d[i];
    const g = 0.5 / Math.sqrt(e + 1e-9);
    for (let i = 0; i < len; i++) d[i] *= g;
  }
  if (irCache.size > 12) irCache.delete(irCache.keys().next().value);
  irCache.set(key, buf);
  return buf;
}

// tanh saturation; louder drive = rounding starts earlier
function satCurve(drive) {
  // gain set so a typical level (0.3, about -10 dBFS) passes unchanged; louder parts get rounded
  const n = 4097, c = new Float32Array(n), k = Math.max(1, dB(drive)), g = 0.3 / Math.tanh(0.3 * k);
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(k * x) * g; }
  return c;
}

// ---------------------------------------------------------------- effect definitions
// p = parameters, env = { bpm, smart: { satScale, wetScale } }
export const FX = {
  eq: {
    defaults: { hp: 20, low: 0, lowMid: 0, mid: 0, presence: 0, air: 0 },
    build(ctx) {
      const input = stereo(ctx.createGain());
      const mk = (type, f, q) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; };
      const hp = mk('highpass', 20, -3.0103), low = mk('lowshelf', 100, 0.7), lowMid = mk('peaking', 300, 1), mid = mk('peaking', 1000, 1), pres = mk('peaking', 3500, 1), air = mk('highshelf', 10000, 0.7);
      input.connect(hp).connect(low).connect(lowMid).connect(mid).connect(pres).connect(air);
      return {
        input, output: air,
        update(p) {
          set(hp.frequency, p.hp, ctx); set(low.gain, p.low, ctx); set(lowMid.gain, p.lowMid, ctx);
          set(mid.gain, p.mid, ctx); set(pres.gain, p.presence, ctx); set(air.gain, p.air, ctx);
        },
      };
    },
  },
  comp: {
    defaults: { threshold: -18, ratio: 3, attack: 10, release: 150, makeup: true },
    build(ctx) {
      const input = stereo(ctx.createGain()), c = ctx.createDynamicsCompressor(), mk = ctx.createGain();
      c.knee.value = 6;
      input.connect(c).connect(mk);
      return {
        input, output: mk, node: c,
        update(p) {
          set(c.threshold, p.threshold, ctx); set(c.ratio, p.ratio, ctx);
          set(c.attack, p.attack / 1000, ctx); set(c.release, p.release / 1000, ctx);
          // auto make-up: give back about half of the reduction a typical peak gets
          set(mk.gain, unMakeup(p.threshold, p.ratio, 6) * (p.makeup ? dB(Math.min(12, (-p.threshold * (1 - 1 / p.ratio)) * 0.5)) : 1), ctx);
        },
      };
    },
  },
  deess: {
    // Linkwitz-Riley split: low + high sum back to a flat response, only the high band is compressed
    defaults: { freq: 6000, threshold: -30, amount: 6 },
    build(ctx) {
      const input = stereo(ctx.createGain()), out = ctx.createGain();
      // Web Audio lowpass/highpass Q is in dB: -3.01 dB = Butterworth (Q 0.707)
      const f = (type) => { const b = ctx.createBiquadFilter(); b.type = type; b.Q.value = -3.0103; return b; };
      const l1 = f('lowpass'), l2 = f('lowpass'), h1 = f('highpass'), h2 = f('highpass');
      const c = ctx.createDynamicsCompressor(); c.knee.value = 3; c.attack.value = 0.001; c.release.value = 0.06;
      const comp = ctx.createGain();
      input.connect(l1).connect(l2).connect(out);
      input.connect(h1).connect(h2).connect(c).connect(comp).connect(out);
      return {
        input, output: out, node: c,
        update(p, env) {
          for (const b of [l1, l2, h1, h2]) set(b.frequency, p.freq, ctx);
          const th = p.threshold - (env?.extraDeess || 0), ra = Math.max(1, 1 + p.amount);
          set(c.threshold, th, ctx); set(c.ratio, ra, ctx); set(comp.gain, unMakeup(th, ra, 3), ctx);
        },
      };
    },
  },
  saturate: {
    defaults: { drive: 6, tone: 9000, mix: 0.5 },
    build(ctx) {
      const input = stereo(ctx.createGain()), out = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain();
      const ws = ctx.createWaveShaper(); ws.oversample = '4x';
      // the dry path goes through a linear shaper with the same oversampling, so both paths have
      // the same small delay and mixing them does not comb-filter
      const lin = ctx.createWaveShaper(); lin.oversample = '4x'; lin.curve = new Float32Array([-1, 1]);
      const tone = ctx.createBiquadFilter(); tone.type = 'lowpass';
      input.connect(lin).connect(dry).connect(out);
      input.connect(ws).connect(tone).connect(wet).connect(out);
      let lastDrive = null;
      return {
        input, output: out,
        update(p, env) {
          const drive = p.drive * (env?.smart?.satScale ?? 1);
          if (drive !== lastDrive) { ws.curve = satCurve(drive); lastDrive = drive; }
          set(tone.frequency, p.tone, ctx);
          set(dry.gain, 1 - p.mix, ctx); set(wet.gain, p.mix, ctx);
        },
      };
    },
  },
  chorus: {
    defaults: { rate: 0.8, depth: 4, mix: 0.4 },
    build(ctx) {
      const input = stereo(ctx.createGain()), out = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain();
      const split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2);
      const voices = [0, 1].map((ch) => {
        const d = ctx.createDelay(0.1); d.delayTime.value = 0.018;
        const lfo = ctx.createOscillator(), depth = ctx.createGain();
        lfo.frequency.value = 0.8; lfo.connect(depth).connect(d.delayTime);
        lfo.start(ctx.currentTime + ch * 0.31); // phase offset between left and right
        split.connect(d, ch); d.connect(merge, 0, ch);
        return { d, lfo, depth };
      });
      input.connect(dry).connect(out);
      input.connect(split); merge.connect(wet).connect(out);
      return {
        input, output: out,
        update(p) {
          for (const v of voices) { set(v.lfo.frequency, p.rate, ctx); set(v.depth.gain, p.depth / 1000, ctx); }
          set(dry.gain, 1 - p.mix * 0.5, ctx); set(wet.gain, p.mix * 0.7, ctx);
        },
        dispose() { for (const v of voices) { try { v.lfo.stop(); } catch { /* already stopped */ } } },
      };
    },
  },
  delay: {
    defaults: { sync: '1/8.', ms: 350, feedback: 0.35, tone: 5000, pingpong: true, mix: 0.25 },
    build(ctx) {
      const input = stereo(ctx.createGain()), out = ctx.createGain(), wet = ctx.createGain();
      const mono = ctx.createGain(); mono.channelCount = 1; mono.channelCountMode = 'explicit';
      const dl = ctx.createDelay(4), dr = ctx.createDelay(4), fb = ctx.createGain(), cross = ctx.createGain();
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 150;
      const merge = ctx.createChannelMerger(2);
      input.connect(out);
      input.connect(mono).connect(hp).connect(dl);
      dl.connect(lp);
      lp.connect(merge, 0, 0);
      const drOut = ctx.createGain();
      lp.connect(dr); dr.connect(drOut).connect(merge, 0, 1);
      dr.connect(fb).connect(dl); // feedback loop through both taps
      lp.connect(cross); cross.connect(merge, 0, 1);
      merge.connect(wet).connect(out);
      return {
        input, output: out,
        update(p, env) {
          const t = p.sync && p.sync !== 'ms' ? (60 / (env?.bpm || 120)) * (DELAY_SYNC[p.sync] || 0.5) : p.ms / 1000;
          const tt = Math.max(0.01, Math.min(1.9, t));
          set(dl.delayTime, tt, ctx);
          set(dr.delayTime, p.pingpong ? tt : 0.0001, ctx);
          set(cross.gain, p.pingpong ? 0 : 1, ctx);
          set(drOut.gain, p.pingpong ? 1 : 0, ctx);
          set(fb.gain, Math.min(0.92, p.feedback), ctx);
          set(lp.frequency, p.tone, ctx);
          set(wet.gain, p.mix * (env?.smart?.wetScale ?? 1), ctx);
        },
      };
    },
  },
  reverb: {
    defaults: { type: 'hall', decay: 2.2, predelay: 20, damp: 7000, mix: 0.25 },
    build(ctx) {
      const input = stereo(ctx.createGain()), out = ctx.createGain(), wet = ctx.createGain();
      const pre = ctx.createDelay(0.5), conv = ctx.createConvolver();
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 180; // keep the low end dry and clear
      conv.normalize = false;
      input.connect(out);
      input.connect(hp).connect(pre).connect(conv).connect(wet).connect(out);
      let irKey = '';
      return {
        input, output: out,
        update(p, env) {
          const k = `${p.type}|${p.decay}|${p.damp}`;
          if (k !== irKey) { conv.buffer = impulse(ctx, p.type, p.decay, p.damp); irKey = k; }
          set(pre.delayTime, p.predelay / 1000, ctx);
          set(wet.gain, p.mix * (env?.smart?.wetScale ?? 1), ctx);
        },
      };
    },
  },
  width: {
    // mid/side: S_out = S*k + HP(S)*(w-k); the low side part is S - HP(S), so with w = k = 1 the
    // output equals the input exactly (no crossover notch). monoBass: k = 0 (side below 150 Hz removed)
    defaults: { width: 1.3, monoBass: true },
    build(ctx) {
      const input = stereo(ctx.createGain()), out = ctx.createGain();
      const split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2);
      const g = (v) => { const n = ctx.createGain(); n.gain.value = v; return n; };
      const mid = g(1), side = g(1);
      input.connect(split);
      split.connect(g(0.5), 0).connect(mid); split.connect(g(0.5), 1).connect(mid);
      split.connect(g(0.5), 0).connect(side); split.connect(g(-0.5), 1).connect(side);
      const hp = () => { const b = ctx.createBiquadFilter(); b.type = 'highpass'; b.frequency.value = 150; b.Q.value = -3.0103; return b; };
      const h1 = hp(), h2 = hp();
      side.connect(h1).connect(h2);
      const sK = g(1), sH = g(0), sOut = g(1), neg = g(-1);
      side.connect(sK).connect(sOut);
      h2.connect(sH).connect(sOut);
      mid.connect(merge, 0, 0); mid.connect(merge, 0, 1);
      sOut.connect(merge, 0, 0); sOut.connect(neg).connect(merge, 0, 1);
      merge.connect(out);
      return {
        input, output: out,
        update(p) {
          const k = p.monoBass ? 0 : 1;
          set(sK.gain, k, ctx); set(sH.gain, p.width - k, ctx);
        },
      };
    },
  },
  filter: {
    defaults: { type: 'lowpass', freq: 2000, q: 0.8 },
    build(ctx) {
      const input = stereo(ctx.createGain()), f = ctx.createBiquadFilter();
      input.connect(f);
      return { input, output: f, update(p) { f.type = p.type; set(f.frequency, p.freq, ctx); set(f.Q, p.q, ctx); } };
    },
  },
};

export const FX_ORDER = ['eq', 'deess', 'comp', 'saturate', 'chorus', 'delay', 'reverb', 'width', 'filter'];

// ready-made chains
// ready-made chains; clicking a preset again removes exactly the effects it added
export const FX_PRESETS = {
  bassboost: [
    { type: 'eq', p: { hp: 25, low: 6, lowMid: -1.5, mid: 0, presence: 0.5, air: 0 } },
    { type: 'saturate', p: { drive: 4, tone: 7000, mix: 0.18 } },
    { type: 'comp', p: { threshold: -12, ratio: 1.8, attack: 30, release: 120, makeup: true } },
  ],
  clarity: [
    { type: 'eq', p: { hp: 25, low: 0, lowMid: -1.5, mid: 0, presence: 1.5, air: 2 } },
    { type: 'comp', p: { threshold: -14, ratio: 1.6, attack: 20, release: 150, makeup: true } },
  ],
  bigHall: [{ type: 'reverb', p: { type: 'hall', decay: 3.2, predelay: 35, damp: 6500, mix: 0.3 } }],
  room: [{ type: 'reverb', p: { type: 'room', decay: 0.9, predelay: 10, damp: 8000, mix: 0.2 } }],
  echo: [{ type: 'delay', p: { sync: '1/8.', ms: 350, feedback: 0.35, tone: 4500, pingpong: true, mix: 0.22 } }],
  wide: [{ type: 'width', p: { width: 1.5, monoBass: true } }],
  warm: [{ type: 'saturate', p: { drive: 6, tone: 9000, mix: 0.3 } }, { type: 'eq', p: { hp: 20, low: 1, lowMid: 0.5, mid: 0, presence: -0.5, air: -1 } }],
  club: [{ type: 'eq', p: { hp: 25, low: 3, lowMid: -1.5, mid: 0, presence: 1, air: 2 } }, { type: 'comp', p: { threshold: -16, ratio: 2.5, attack: 25, release: 90, makeup: true } }, { type: 'width', p: { width: 1.3, monoBass: true } }],
  lofi: [{ type: 'filter', p: { type: 'lowpass', freq: 3800, q: 0.7 } }, { type: 'saturate', p: { drive: 10, tone: 4000, mix: 0.5 } }, { type: 'chorus', p: { rate: 0.4, depth: 6, mix: 0.35 } }],
  radio: [{ type: 'eq', p: { hp: 300, low: -6, lowMid: 0, mid: 4, presence: 3, air: -8 } }, { type: 'saturate', p: { drive: 8, tone: 5000, mix: 0.4 } }],
};

let uid = 0;
export function makeFx(type, p, preset = null) { return { id: `fx${Date.now().toString(36)}${uid++}`, type, on: true, preset, p: { ...FX[type].defaults, ...(p || {}) } }; }

/** Build a chain on ctx: input -> fx... -> output. Returns { input, output, update(list, env), nodes, dispose } */
export function buildChain(ctx, list, env) {
  const input = stereo(ctx.createGain()), output = ctx.createGain();
  const units = [];
  let last = input;
  for (const fx of list) {
    if (!fx.on || !FX[fx.type]) continue;
    const u = FX[fx.type].build(ctx);
    u.update(fx.p, env);
    last.connect(u.input);
    last = u.output;
    units.push({ id: fx.id, u });
  }
  last.connect(output);
  return {
    input, output, units,
    update(list2, env2) { for (const { id, u } of units) { const f = list2.find((x) => x.id === id); if (f) u.update(f.p, env2); } },
    dispose() { for (const { u } of units) u.dispose?.(); },
  };
}

export const chainKey = (list) => list.filter((f) => f.on && FX[f.type]).map((f) => f.id).join(',');

// controls for the UI: [key, kind, min, max, step, unit]  (kind: 'r' range, 'log' log range, 'b' bool, 's' select)
export const FX_PARAMS = {
  eq: [['hp', 'log', 20, 400, 1, 'Hz'], ['low', 'r', -12, 12, 0.5, 'dB'], ['lowMid', 'r', -12, 12, 0.5, 'dB'], ['mid', 'r', -12, 12, 0.5, 'dB'], ['presence', 'r', -12, 12, 0.5, 'dB'], ['air', 'r', -12, 12, 0.5, 'dB']],
  comp: [['threshold', 'r', -50, 0, 1, 'dB'], ['ratio', 'r', 1, 12, 0.1, ':1'], ['attack', 'log', 0.5, 100, 0.5, 'ms'], ['release', 'log', 20, 800, 5, 'ms'], ['makeup', 'b']],
  deess: [['freq', 'log', 3000, 10000, 50, 'Hz'], ['threshold', 'r', -50, 0, 1, 'dB'], ['amount', 'r', 0, 12, 0.5, '']],
  saturate: [['drive', 'r', 0, 24, 0.5, 'dB'], ['tone', 'log', 1000, 16000, 50, 'Hz'], ['mix', 'r', 0, 1, 0.05, '%']],
  chorus: [['rate', 'log', 0.05, 5, 0.01, 'Hz'], ['depth', 'r', 0.5, 12, 0.1, 'ms'], ['mix', 'r', 0, 1, 0.05, '%']],
  delay: [['sync', 's', ['1/4', '1/8', '1/8.', '1/16', '1/4T', '1/2', 'ms']], ['ms', 'log', 20, 1500, 5, 'ms'], ['feedback', 'r', 0, 0.9, 0.01, '%'], ['tone', 'log', 800, 16000, 50, 'Hz'], ['pingpong', 'b'], ['mix', 'r', 0, 1, 0.05, '%']],
  reverb: [['type', 's', ['room', 'hall', 'plate', 'cathedral']], ['decay', 'log', 0.2, 8, 0.05, 's'], ['predelay', 'r', 0, 200, 1, 'ms'], ['damp', 'log', 1500, 16000, 50, 'Hz'], ['mix', 'r', 0, 1, 0.05, '%']],
  width: [['width', 'r', 0, 2, 0.05, '%'], ['monoBass', 'b']],
  filter: [['type', 's', ['lowpass', 'highpass', 'bandpass']], ['freq', 'log', 40, 18000, 10, 'Hz'], ['q', 'log', 0.3, 12, 0.05, '']],
};
