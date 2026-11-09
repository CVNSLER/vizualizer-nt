// Look-ahead limiter for live playback (AudioWorklet). Same idea as the offline limiter:
//   r = gain each sample needs; m = minimum of r over L+1 samples; g = average of m over L samples.
//   The output is delayed by L samples, so every averaged value covers the output sample and
//   g never lets it pass the ceiling - without the flat tops a clipper would make.
export const LIMITER_SRC = `
class VizLimiter extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [{ name: 'ceiling', defaultValue: 0.86 }, { name: 'release', defaultValue: 0.08 }]; }
  constructor() {
    super();
    const L = this.L = Math.max(16, Math.round(sampleRate * 0.005));
    this.N = L + 1;
    this.delay = [new Float32Array(L + 1), new Float32Array(L + 1)];
    this.r = new Float32Array(L + 1);          // ring of needed gains
    this.dq = new Int32Array(L + 2); this.dqv = new Float32Array(L + 2); this.h = 0; this.t = 0; // monotonic deque (min)
    this.box = new Float32Array(L); this.sum = L; this.box.fill(1);
    this.i = 0; this.gs = 1; this.minG = 1; this.frames = 0;
  }
  process(inputs, outputs, params) {
    const inp = inputs[0], out = outputs[0];
    if (!inp || !inp.length) return true;
    const ceil = params.ceiling[0], rl = Math.exp(-1 / (Math.max(0.01, params.release[0]) * sampleRate));
    const n = inp[0].length, chs = Math.min(2, inp.length), L = this.L, N = this.N;
    for (let k = 0; k < n; k++) {
      const i = this.i++;
      let a = 0;
      for (let c = 0; c < chs; c++) { const v = inp[c][k]; const x = v < 0 ? -v : v; if (x > a) a = x; }
      const need = a > ceil ? ceil / a : 1;
      // push into the min-deque, drop what left the window of L+1 samples
      while (this.t > this.h && this.dqv[(this.t - 1) % (L + 2)] >= need) this.t--;
      this.dq[this.t % (L + 2)] = i; this.dqv[this.t % (L + 2)] = need; this.t++;
      while (this.dq[this.h % (L + 2)] <= i - N) this.h++;
      const m = this.dqv[this.h % (L + 2)];
      // box average of m over the last L values
      const bi = i % L; this.sum += m - this.box[bi]; this.box[bi] = m;
      const g = Math.min(1, this.sum / L);
      this.gs = g < this.gs ? g : Math.min(g, rl * this.gs + (1 - rl));
      if (this.gs < this.minG) this.minG = this.gs;
      const di = i % (L + 1);
      for (let c = 0; c < out.length; c++) {
        const src = inp[Math.min(c, chs - 1)];
        const d = this.delay[c] || (this.delay[c] = new Float32Array(L + 1));
        const old = d[di]; d[di] = src[k];
        out[c][k] = i >= L ? old * this.gs : 0;
      }
    }
    if ((this.frames += n) > sampleRate / 15) { this.port.postMessage(this.minG); this.minG = 1; this.frames = 0; }
    return true;
  }
}
registerProcessor('viz-limiter', VizLimiter);
`;
