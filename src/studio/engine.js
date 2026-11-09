// Studio audio graph. Live: the <audio> element itself is routed through Web Audio (no second
// player to keep in sync). Offline: the same graph renders the export.
//   source -> [effects] -> pan -> fader -> EQ (8 bands) -> smart shelves -> master -> comp -> limiter
import { buildChain, chainKey, unMakeup } from './fx.js';
import { smartPlan, mixerNeutral, CEIL_DB, AUTO_EQ_MAX } from './smart.js';
import { limit } from './dsp.js';
import { LIMITER_SRC } from './limiter-worklet.js';

const dB = (x) => 10 ** (x / 20);
const setP = (param, v, ctx) => {
  if (!Number.isFinite(v)) return;
  if (ctx instanceof OfflineAudioContext || ctx.state !== 'running') param.value = v;
  else param.setTargetAtTime(v, ctx.currentTime, 0.03);
};
// lowpass/highpass Q is in dB in Web Audio (-3.01 dB = Butterworth)
function biquad(ctx, type, f, q = -3.0103) { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; }

// last safety net above -1 dBFS. The curve maps input -1..1 (WaveShaper's own range): it is the
// identity below 0.89 and only rounds the very top, so normal levels pass unchanged.
function softClip(ctx) {
  const ws = ctx.createWaveShaper(), n = 8193, c = new Float32Array(n), t = 0.89;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1, a = Math.abs(x);
    c[i] = a <= t ? x : Math.sign(x) * (t + (1 - t) * Math.tanh((a - t) / (1 - t)));
  }
  ws.curve = c; ws.oversample = '4x';
  return ws;
}

export function setEqBand(node, b, ctx) {
  const type = b.type;
  if (node.type !== type) node.type = type;
  if (type === 'highpass') {
    setP(node.frequency, b.on ? b.f : 10, ctx);
    setP(node.Q, 20 * Math.log10(Math.max(0.3, b.q)), ctx);
  } else {
    setP(node.frequency, b.f, ctx);
    setP(node.Q, b.q, ctx);
    setP(node.gain, b.on ? b.g : 0, ctx);
  }
}

/** Mixer + master section (everything after the effects). Returns { input, output, update(st, plan) } */
function buildMixer(ctx, st, plan, limNode = null) {
  const input = ctx.createGain();
  input.channelCount = 2; input.channelCountMode = 'explicit'; input.channelInterpretation = 'speakers';
  const pan = ctx.createStereoPanner(), fader = ctx.createGain();
  const eq = st.eq.map((b) => biquad(ctx, b.type, b.f));
  const auto = Array.from({ length: AUTO_EQ_MAX }, () => biquad(ctx, 'peaking', 1000, 1));
  const hp = biquad(ctx, 'highpass', 20), lowShelf = biquad(ctx, 'lowshelf', 120), highShelf = biquad(ctx, 'highshelf', 8000);
  const master = ctx.createGain();
  const comp = ctx.createDynamicsCompressor(), compMk = ctx.createGain();
  const lim = ctx.createDynamicsCompressor(), limMk = ctx.createGain();
  lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.001;
  const clip = softClip(ctx);
  let last = input.connect(pan).connect(fader);
  for (const b of [...eq, ...auto]) last = last.connect(b);
  last = last.connect(hp).connect(lowShelf).connect(highShelf).connect(master).connect(comp).connect(compMk);
  // live: a real look-ahead limiter (AudioWorklet) when available; otherwise a fast compressor
  if (limNode) last.connect(limNode).connect(clip);
  else last.connect(lim).connect(limMk).connect(clip);
  const m = {
    input, output: clip, comp, lim, eq,
    update(st2, plan2) {
      setP(pan.pan, st2.mix.pan, ctx);
      setP(fader.gain, dB(st2.mix.gain), ctx);
      st2.eq.forEach((b, i) => eq[i] && setEqBand(eq[i], b, ctx));
      auto.forEach((n, i) => { const b = st2.autoEq?.bands[i]; setEqBand(n, b ? { type: 'peaking', on: true, ...b } : { type: 'peaking', on: false, f: 1000, g: 0, q: 1 }, ctx); });
      setP(hp.frequency, plan2.hp, ctx);
      setP(lowShelf.gain, plan2.lowShelf, ctx);
      setP(highShelf.gain, plan2.highShelf, ctx);
      setP(master.gain, dB(st2.master.gain), ctx);
      const c = plan2.comp;
      setP(comp.threshold, c ? c.threshold : 0, ctx); setP(comp.ratio, c ? c.ratio : 1, ctx);
      setP(comp.knee, c ? 8 : 0, ctx);
      setP(comp.attack, c ? c.attack : 0.003, ctx); setP(comp.release, c ? c.release : 0.25, ctx);
      setP(compMk.gain, c ? unMakeup(c.threshold, c.ratio, 8) * dB(Math.min(4, (c.ratio - 1) * 1.2)) : 1, ctx);
      if (limNode) {
        setP(limNode.parameters.get('ceiling'), dB(plan2.limiter.threshold), ctx);
        setP(limNode.parameters.get('release'), plan2.limiter.release, ctx);
      }
      setP(lim.threshold, plan2.limiter.threshold, ctx); setP(lim.release, plan2.limiter.release, ctx);
      setP(limMk.gain, unMakeup(plan2.limiter.threshold, 20, 0), ctx);
    },
  };
  m.update(st, plan);
  return m;
}

// ---------------------------------------------------------------- live
const sources = new WeakMap(); // an <audio> element can be wired into Web Audio only once
export class StudioEngine {
  constructor() { this.ctx = null; this.el = null; this.chain = null; this.mixer = null; this.active = false; this.args = null; this.limGr = 0; this.limNode = null; }
  _ensure() {
    if (this.ctx) return this.ctx;
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.pre = ctx.createGain();
    this.dry = ctx.createGain(); this.wet = ctx.createGain(); this.wet.gain.value = 0;
    this.bus = ctx.createGain();
    this.post = ctx.createGain();
    this.pre.connect(this.dry).connect(this.bus);
    this.post.connect(this.wet).connect(this.bus);
    this.bus.connect(ctx.destination);
    this.split = ctx.createChannelSplitter(2);
    this.anL = ctx.createAnalyser(); this.anR = ctx.createAnalyser(); this.anL.fftSize = this.anR.fftSize = 1024;
    this.spec = ctx.createAnalyser(); this.spec.fftSize = 8192; this.spec.smoothingTimeConstant = 0.8;
    this.bus.connect(this.split); this.split.connect(this.anL, 0); this.split.connect(this.anR, 1);
    this.bus.connect(this.spec);
    // load the look-ahead limiter; until (or unless) it is ready the compressor limiter is used
    this.limReady = (async () => {
      try {
        // data: works from file:// pages (Windows app); blob: is the fallback for strict pages
        try { await ctx.audioWorklet.addModule('data:text/javascript;base64,' + btoa(LIMITER_SRC)); } catch {
          await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([LIMITER_SRC], { type: 'text/javascript' })));
        }
        const node = new AudioWorkletNode(ctx, 'viz-limiter', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
        node.port.onmessage = (e) => { this.limGr = 20 * Math.log10(Math.max(1e-6, e.data)); };
        this.limNode = node;
        if (this.mixer) { this.mixer.output.disconnect(); if (this.chain) { try { this.pre.disconnect(this.chain.input); } catch { /* gone */ } this.chain.dispose(); } this.mixer = null; this.chain = null; if (this.args) this.set(...this.args); }
      } catch (e) { this.limNode = null; this.limErr = String(e?.message || e); }
    })();
    return ctx;
  }
  /** Route the element through the studio. Call from a click (browsers start audio only then). */
  attach(el) {
    if (!el) return;
    const ctx = this._ensure();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    if (this.el === el) return;
    this.el = el;
    let src = sources.get(el);
    if (!src) { src = ctx.createMediaElementSource(el); sources.set(el, src); }
    src.connect(this.pre);
    // if the context ever gets suspended, playing must wake it, or the element would be silent
    el.addEventListener('play', () => { if (ctx.state !== 'running') ctx.resume().catch(() => {}); });
    if (this.args) this.set(...this.args);
  }
  resume() { if (this.ctx && this.ctx.state !== 'running') this.ctx.resume().catch(() => {}); }
  get attached() { return !!this.el; }
  /** st: studio state, fx: effects to run live, plan: smartPlan(), env: { bpm } */
  set(st, fx, plan, env, bypass = false) {
    this.args = [st, fx, plan, env, bypass];
    if (!this.ctx || !this.el) return;
    const ctx = this.ctx;
    const live = fx.filter((f) => f.on);
    // bypass: "Asl" / "Yaxshilangan" are listened to exactly as they are
    const neutral = bypass || (!live.length && mixerNeutral(st));
    setP(this.dry.gain, neutral ? 1 : 0, ctx);
    setP(this.wet.gain, neutral ? 0 : 1, ctx);
    const env2 = { ...env, smart: plan };
    const key = chainKey(fx);
    if (!this.chain || this.chain.key !== key) {
      const old = this.chain;
      const chain = buildChain(ctx, fx, env2);
      chain.key = key;
      if (!this.mixer) { this.mixer = buildMixer(ctx, st, plan, this.limNode); this.mixer.output.connect(this.post); }
      this.pre.connect(chain.input);
      chain.output.connect(this.mixer.input);
      if (old) { try { this.pre.disconnect(old.input); } catch { /* gone */ } try { old.output.disconnect(); } catch { /* gone */ } old.dispose(); }
      this.chain = chain;
    } else this.chain.update(fx, env2);
    this.mixer.update(st, plan);
  }
  meters() {
    if (!this.ctx || !this.el) return null;
    const a = new Float32Array(this.anL.fftSize), b = new Float32Array(this.anR.fftSize);
    this.anL.getFloatTimeDomainData(a); this.anR.getFloatTimeDomainData(b);
    let pl = 0, pr = 0;
    for (let i = 0; i < a.length; i++) { pl = Math.max(pl, Math.abs(a[i])); pr = Math.max(pr, Math.abs(b[i])); }
    const toDb = (x) => 20 * Math.log10(x + 1e-9);
    return { l: toDb(pl), r: toDb(pr), comp: this.mixer ? this.mixer.comp.reduction : 0, lim: this.limNode ? this.limGr : this.mixer ? this.mixer.lim.reduction : 0, worklet: !!this.limNode };
  }
  /** dB spectrum of the output (Float32Array, bins up to Nyquist) */
  spectrum() {
    if (!this.ctx || !this.el) return null;
    const d = new Float32Array(this.spec.frequencyBinCount);
    this.spec.getFloatFrequencyData(d);
    return { data: d, fs: this.ctx.sampleRate };
  }
  /** frequency response of the EQ (for drawing the curve) */
  eqResponse(st, freqs) {
    const ctx = this._ensure();
    const mag = new Float32Array(freqs.length).fill(1), m = new Float32Array(freqs.length), ph = new Float32Array(freqs.length);
    for (const b of [...st.eq, ...(st.autoEq?.bands || []).map((x) => ({ type: 'peaking', on: true, ...x }))]) {
      const n = biquad(ctx, b.type, b.f);
      setEqBand(n, b, { state: 'suspended' });
      n.getFrequencyResponse(freqs, m, ph);
      for (let i = 0; i < freqs.length; i++) mag[i] *= m[i];
    }
    return mag;
  }
}

// ---------------------------------------------------------------- export
/** Render source buffer through effects + mixer offline. Returns an AudioBuffer (2 ch). */
export async function renderStudio(buffer, st, fx, stats, env, onProgress = () => {}) {
  const fs = buffer.sampleRate, n = buffer.length;
  const ctx = new OfflineAudioContext(2, n, fs);
  const plan = smartPlan(st, stats, env.bpm, fx);
  const chain = buildChain(ctx, fx, { ...env, smart: plan });
  const mixer = buildMixer(ctx, st, plan);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(chain.input); chain.output.connect(mixer.input); mixer.output.connect(ctx.destination);
  src.start(0);
  onProgress(0.1);
  const out = await ctx.startRendering();
  onProgress(0.8);
  // final true-peak safety (the live limiter is a fast compressor; here it is exact)
  const chs = [0, 1].map((c) => Float32Array.from(out.getChannelData(c)));
  limit(chs, fs, CEIL_DB, plan.limiter.release);
  chs.forEach((c, i) => out.copyToChannel(c, i));
  onProgress(1);
  return out;
}

/** Effects only (no mixer, no limiter): used before an enhancement pass. */
export async function renderFx(buffer, fx, env) {
  const ctx = new OfflineAudioContext(2, buffer.length, buffer.sampleRate);
  const chain = buildChain(ctx, fx, { ...env, smart: { satScale: 1, wetScale: 1 } });
  const src = ctx.createBufferSource();
  src.buffer = buffer; src.connect(chain.input); chain.output.connect(ctx.destination); src.start(0);
  return ctx.startRendering();
}
