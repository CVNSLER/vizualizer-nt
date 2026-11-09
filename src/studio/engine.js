// Studio audio graph: channel strips -> master (smart EQ, user effects, fader, glue compressor,
// limiter). The same builder runs live and offline, so what you hear is what gets exported.
import { buildChain, chainKey, unMakeup } from './fx.js';
import { smartPlan, activeChannels, CEIL_DB } from './smart.js';
import { limit } from './dsp.js';

const dB = (x) => 10 ** (x / 20);
const setP = (param, v, ctx) => {
  if (!Number.isFinite(v)) return;
  if (ctx instanceof OfflineAudioContext || ctx.state !== 'running') param.value = v;
  else param.setTargetAtTime(v, ctx.currentTime, 0.03);
};

// lowpass/highpass Q is in dB in Web Audio (-3.01 dB = Butterworth)
function biquad(ctx, type, f, q = -3.0103) { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; }

function softClip(ctx) {
  const ws = ctx.createWaveShaper(), n = 4096, c = new Float32Array(n), t = 0.89;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 4 - 2, a = Math.abs(x);
    c[i] = a <= t ? x : Math.sign(x) * (t + (1 - t) * Math.tanh((a - t) / (1 - t)));
  }
  ws.curve = c; ws.oversample = '4x';
  return ws;
}

/** Build the whole graph on ctx. Returns { inputs: {channel: node}, update(st, plan, env), key, ... } */
export function buildGraph(ctx, st, plan, env, dest) {
  const strips = {};
  const masterIn = ctx.createGain();
  masterIn.channelCount = 2; masterIn.channelCountMode = 'explicit';
  for (const { k } of activeChannels(st)) {
    const ch = st.ch[k];
    const input = ctx.createGain();
    input.channelCount = 2; input.channelCountMode = 'explicit'; input.channelInterpretation = 'speakers';
    const unmask = biquad(ctx, 'peaking', 3000, 0.9), lowTrim = biquad(ctx, 'lowshelf', 110);
    const chain = buildChain(ctx, ch.fx, { ...env, smart: plan, extraDeess: plan.ch[k]?.extraDeess || 0 });
    const pan = ctx.createStereoPanner(), fader = ctx.createGain();
    input.connect(unmask).connect(lowTrim).connect(chain.input);
    chain.output.connect(pan).connect(fader).connect(masterIn);
    strips[k] = { input, unmask, lowTrim, chain, pan, fader };
  }
  const hp = biquad(ctx, 'highpass', 20), lowShelf = biquad(ctx, 'lowshelf', 120), highShelf = biquad(ctx, 'highshelf', 8000);
  const mchain = buildChain(ctx, st.master.fx, { ...env, smart: plan });
  const fader = ctx.createGain();
  const comp = ctx.createDynamicsCompressor(), compMk = ctx.createGain();
  const lim = ctx.createDynamicsCompressor(), limMk = ctx.createGain();
  lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.001;
  const clip = softClip(ctx);
  const out = ctx.createGain();
  masterIn.connect(hp).connect(lowShelf).connect(highShelf).connect(mchain.input);
  mchain.output.connect(fader).connect(comp).connect(compMk).connect(lim).connect(limMk).connect(clip).connect(out);
  out.connect(dest);

  const g = {
    strips, masterIn, out, comp, lim, fader,
    key: graphKey(st),
    update(st2, plan2, env2) {
      for (const { k, on, gain } of activeChannels(st2)) {
        const s = strips[k]; if (!s) continue;
        const ch = st2.ch[k];
        s.chain.update(ch.fx, { ...env2, smart: plan2, extraDeess: plan2.ch[k]?.extraDeess || 0 });
        setP(s.unmask.gain, plan2.ch[k]?.unmask || 0, ctx);
        setP(s.lowTrim.gain, plan2.ch[k]?.lowTrim || 0, ctx);
        setP(s.pan.pan, ch.pan, ctx);
        setP(s.fader.gain, on ? dB(gain) : 0, ctx);
      }
      setP(hp.frequency, plan2.hp, ctx);
      setP(lowShelf.gain, plan2.lowShelf, ctx);
      setP(highShelf.gain, plan2.highShelf, ctx);
      mchain.update(st2.master.fx, { ...env2, smart: plan2 });
      setP(fader.gain, dB(st2.master.gain), ctx);
      const c = plan2.comp;
      setP(comp.threshold, c ? c.threshold : 0, ctx); setP(comp.ratio, c ? c.ratio : 1, ctx);
      setP(comp.knee, c ? 8 : 0, ctx);
      setP(comp.attack, c ? c.attack : 0.003, ctx); setP(comp.release, c ? c.release : 0.25, ctx);
      setP(compMk.gain, c ? unMakeup(c.threshold, c.ratio, 8) * dB(Math.min(4, (c.ratio - 1) * 1.2)) : 1, ctx);
      setP(lim.threshold, plan2.limiter.threshold, ctx); setP(lim.release, plan2.limiter.release, ctx);
      setP(limMk.gain, unMakeup(plan2.limiter.threshold, 20, 0), ctx);
    },
    dispose() {
      for (const s of Object.values(strips)) { s.chain.dispose(); try { s.fader.disconnect(); } catch { /* ignore */ } }
      mchain.dispose();
      try { out.disconnect(); } catch { /* ignore */ }
    },
  };
  g.update(st, plan, env);
  return g;
}

export const graphKey = (st) => [st.stems ? 's' : 'm', ...activeChannels(st).map((c) => c.k + ':' + chainKey(st.ch[c.k].fx)), 'M:' + chainKey(st.master.fx)].join('|');

// ---------------------------------------------------------------- live playback
/**
 * Plays the studio mix in sync with an <audio> element (the element keeps the clock for the
 * visuals and is muted while the studio is on).
 */
export class StudioEngine {
  constructor() {
    this.ctx = null; this.graph = null; this.players = []; this.el = null; this.on = false;
    this.sources = {}; this.st = null; this.plan = null; this.env = { bpm: 120 };
    this._sync = this._sync.bind(this);
  }
  _ensure() {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'playback' });
      this.analyser = this.ctx.createAnalyser(); this.analyser.fftSize = 2048;
      this.split = this.ctx.createChannelSplitter(2);
      this.anL = this.ctx.createAnalyser(); this.anR = this.ctx.createAnalyser(); this.anL.fftSize = this.anR.fftSize = 1024;
      this.bus = this.ctx.createGain();
      this.bus.connect(this.ctx.destination);
      this.bus.connect(this.split); this.split.connect(this.anL, 0); this.split.connect(this.anR, 1);
    }
    return this.ctx;
  }
  attach(el) {
    if (this.el === el) return;
    if (this.el) for (const ev of ['play', 'pause', 'seeked', 'ended']) this.el.removeEventListener(ev, this._sync);
    this.el = el;
    if (el) for (const ev of ['play', 'pause', 'seeked', 'ended']) el.addEventListener(ev, this._sync);
    this._sync();
  }
  /** sources: { mix } or { vocals, drums, bass, other } AudioBuffers */
  setSources(sources) { this.sources = sources; this._restart(); }
  set(st, plan, env) {
    this.st = st; this.plan = plan; this.env = env;
    if (!this.on) return;
    this._ensure();
    if (!this.graph || this.graph.key !== graphKey(st)) {
      this.graph?.dispose();
      this.graph = buildGraph(this.ctx, st, plan, env, this.bus);
      this._restart();
    } else this.graph.update(st, plan, env);
  }
  enable(on) {
    if (on === this.on) return;
    this.on = on;
    if (on) {
      this._ensure();
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      if (this.el) this.el.muted = true;
      if (this.st) this.set(this.st, this.plan, this.env);
      this._restart();
      this._timer = setInterval(() => this._checkDrift(), 500);
    } else {
      this._stop();
      clearInterval(this._timer);
      this.graph?.dispose(); this.graph = null;
      if (this.el) this.el.muted = false;
    }
  }
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {}); }
  _stop() { for (const p of this.players) { try { p.stop(); } catch { /* not started */ } p.disconnect(); } this.players = []; }
  _restart() {
    this._stop();
    const el = this.el;
    if (!this.on || !this.graph || !el || el.paused) return;
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    const at = el.currentTime;
    const when = this.ctx.currentTime + 0.02;
    for (const [k, s] of Object.entries(this.graph.strips)) {
      const buf = this.sources[k];
      if (!buf) continue;
      const p = this.ctx.createBufferSource();
      p.buffer = buf; p.loop = true;
      p.connect(s.input);
      p.start(when, Math.min(buf.duration - 0.001, at + 0.02));
      this.players.push(p);
    }
    this._t0 = when; this._pos0 = at + 0.02;
  }
  _sync() { if (this.on) this._restart(); }
  _checkDrift() {
    const el = this.el;
    if (!this.on || !el || el.paused || !this.players.length) return;
    const dur = this.players[0].buffer.duration;
    const pos = (this._pos0 + (this.ctx.currentTime - this._t0)) % dur;
    let d = Math.abs(pos - el.currentTime);
    d = Math.min(d, dur - d);
    if (d > 0.06) this._restart();
  }
  meters() {
    if (!this.ctx || !this.on) return null;
    const a = new Float32Array(this.anL.fftSize), b = new Float32Array(this.anR.fftSize);
    this.anL.getFloatTimeDomainData(a); this.anR.getFloatTimeDomainData(b);
    let pl = 0, pr = 0, s = 0;
    for (let i = 0; i < a.length; i++) { pl = Math.max(pl, Math.abs(a[i])); pr = Math.max(pr, Math.abs(b[i])); s += a[i] * a[i] + b[i] * b[i]; }
    const toDb = (x) => 20 * Math.log10(x + 1e-9);
    return {
      l: toDb(pl), r: toDb(pr), rms: 10 * Math.log10(s / (2 * a.length) + 1e-12),
      comp: this.graph ? this.graph.comp.reduction : 0, lim: this.graph ? this.graph.lim.reduction : 0,
    };
  }
}

// ---------------------------------------------------------------- export
/** Render the studio mix offline. Returns an AudioBuffer (2 ch, sample rate of the sources). */
export async function renderStudio(st, sources, stats, env, onProgress = () => {}) {
  const any = Object.values(sources).find(Boolean);
  const fs = any.sampleRate, n = any.length;
  const ctx = new OfflineAudioContext(2, n, fs);
  const plan = smartPlan(st, stats, env.bpm);
  const g = buildGraph(ctx, st, plan, env, ctx.destination);
  for (const [k, s] of Object.entries(g.strips)) {
    const buf = sources[k];
    if (!buf) continue;
    const p = ctx.createBufferSource();
    p.buffer = buf; p.connect(s.input); p.start(0);
  }
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
