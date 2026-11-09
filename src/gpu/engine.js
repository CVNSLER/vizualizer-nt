// Small WebGL engine for template "1": uploads the frame, runs filter passes (glfx-style) and
// beat-triggered gl-transitions on it, and hands the result back to the 2D canvas.
import { FILTERS } from './filters.js';
import { TRANSITIONS } from './transitions-data.js';

export const TRANSITION_BY_NAME = new Map(TRANSITIONS.map((t) => [t.n, t]));

const VS = 'attribute vec2 p; varying vec2 texCoord; void main(){ texCoord = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }';
const COPY = 'precision highp float; uniform sampler2D texture; varying vec2 texCoord; void main(){ gl_FragColor = texture2D(texture, texCoord); }';

let gl = null, canvas = null, buf = null, failed = false;
const progs = new Map();
export const broken = new Set();

function init() {
  if (gl || failed) return !!gl;
  try {
    canvas = document.createElement('canvas');
    gl = canvas.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false, alpha: false });
  } catch { gl = null; }
  if (!gl) { failed = true; return false; }
  buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); gl = null; progs.clear(); targets.length = 0; snaps.clear(); });
  return true;
}

function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { const log = gl.getShaderInfoLog(s); gl.deleteShader(s); throw new Error(log); }
  return s;
}
function program(key, fs) {
  if (progs.has(key)) return progs.get(key);
  if (broken.has(key)) return null;
  try {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'p');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const uniforms = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      uniforms[info.name.replace(/\[0\]$/, '')] = { loc: gl.getUniformLocation(p, info.name), type: info.type };
    }
    const entry = { p, uniforms };
    progs.set(key, entry);
    return entry;
  } catch (e) {
    broken.add(key);
    if (typeof console !== 'undefined') console.warn('shader', key, String(e).slice(0, 200));
    return null;
  }
}

function setUniform(u, v) {
  const L = u.loc;
  switch (u.type) {
    case gl.FLOAT: gl.uniform1f(L, +v); break;
    case gl.FLOAT_VEC2: gl.uniform2fv(L, v); break;
    case gl.FLOAT_VEC3: gl.uniform3fv(L, v); break;
    case gl.FLOAT_VEC4: gl.uniform4fv(L, v); break;
    case gl.INT: case gl.BOOL: gl.uniform1i(L, typeof v === 'boolean' ? (v ? 1 : 0) : Math.round(v)); break;
    case gl.INT_VEC2: case gl.BOOL_VEC2: gl.uniform2iv(L, v.map((x) => Math.round(+x))); break;
    case gl.INT_VEC3: gl.uniform3iv(L, v.map((x) => Math.round(+x))); break;
    case gl.INT_VEC4: gl.uniform4iv(L, v.map((x) => Math.round(+x))); break;
    default: break;
  }
}

// ---------------------------------------------------------------- render targets
const targets = [];
function makeTarget(w, h) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { tex, fbo, w, h };
}
function freeTarget(t) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); }

let W = 0, H = 0;
let src = null, prevSrc = null; // this frame's and last frame's input picture
const pool = [];
const snaps = new Map(); // transition snapshots per layer
let lastT = -1;

function resize(w, h) {
  if (w === W && h === H && src) return;
  for (const t of [src, prevSrc, ...pool]) if (t) freeTarget(t);
  for (const s of snaps.values()) if (s.target) freeTarget(s.target);
  snaps.clear();
  pool.length = 0;
  W = w; H = h;
  canvas.width = w; canvas.height = h;
  src = makeTarget(w, h); prevSrc = makeTarget(w, h);
  for (let i = 0; i < 3; i++) pool.push(makeTarget(w, h));
}

function draw(entry, inputs, uniforms, out) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, out ? out.fbo : null);
  gl.viewport(0, 0, W, H);
  gl.useProgram(entry.p);
  let unit = 0;
  for (const [name, tex] of Object.entries(inputs)) {
    const u = entry.uniforms[name];
    if (!u) continue;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(u.loc, unit++);
  }
  for (const [name, val] of Object.entries(uniforms)) {
    const u = entry.uniforms[name];
    if (u && val !== undefined && val !== null) setUniform(u, val);
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

function transitionShader(t) {
  return `precision highp float;
varying vec2 texCoord;
uniform sampler2D _from; uniform sampler2D _to; uniform float progress; uniform float ratio;
vec4 getFromColor(vec2 uv){ return texture2D(_from, uv); }
vec4 getToColor(vec2 uv){ return texture2D(_to, uv); }
${t.g}
void main(){ gl_FragColor = transition(texCoord); }`;
}

/**
 * Process the frame on `source` (a canvas of size w x h).
 * steps: [{ kind: 'filter'|'transition', id, key, v, color:[r,g,b], age, event }]
 *   - filter: always applied (skipped when v is ~0)
 *   - transition: `event` = { t } of the latest trigger; it plays for `dur` seconds after it
 * Returns the WebGL canvas holding the result, or null if WebGL is not available.
 */
export function processFrame(source, w, h, t, steps) {
  if (!init()) return null;
  resize(w, h);
  // time going backwards (seek / new export): forget running transitions
  if (t < lastT - 0.05) { for (const s of snaps.values()) s.te = -1; }
  lastT = t;

  // upload this frame
  [src, prevSrc] = [prevSrc, src];
  gl.bindTexture(gl.TEXTURE_2D, src.tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);

  let cur = src.tex;
  let pi = 0;
  const next = () => pool[pi++ % pool.length];
  const saved = {};

  for (const st of steps) {
    if (st.kind === 'filter') {
      const F = FILTERS[st.id];
      if (!F || st.v < 0.02) continue;
      for (const pass of F.passes) {
        const entry = program('f:' + st.id + ':' + F.passes.indexOf(pass), pass.fs);
        if (!entry) break;
        if (pass.save) {
          // keep this pass's input safe from the ping-pong buffers
          const keep = saved[pass.save] || (saved[pass.save] = makeTarget(W, H));
          draw(program('copy', COPY), { texture: cur }, {}, keep);
        }
        const out = next();
        const inputs = { texture: cur };
        if (pass.base) inputs.base = saved[pass.base].tex;
        draw(entry, inputs, { texSize: [W, H], time: t, ...pass.u({ v: st.v, W, H, t, color: st.color, age: st.age ?? 0 }) }, out);
        cur = out.tex;
      }
    } else if (st.kind === 'transition') {
      const T = TRANSITION_BY_NAME.get(st.id);
      if (!T) continue;
      let s = snaps.get(st.key);
      if (!s) { s = { te: -1, target: makeTarget(W, H) }; snaps.set(st.key, s); }
      if (st.event && st.event.t !== s.te && t - st.event.t < st.dur) {
        // a new hit: freeze the frame just before it as the "from" picture
        s.te = st.event.t;
        draw(program('copy', COPY), { texture: prevSrc.tex }, {}, s.target);
      }
      const p = (t - s.te) / st.dur;
      if (s.te < 0 || p < 0 || p > 1) continue;
      const entry = program('t:' + T.n, transitionShader(T));
      if (!entry) continue;
      const out = next();
      draw(entry, { _from: s.target.tex, _to: cur }, { ...T.p, progress: p, ratio: W / H }, out);
      cur = out.tex;
    }
  }
  for (const k of Object.keys(saved)) freeTarget(saved[k]);
  // final copy to the visible WebGL canvas
  draw(program('copy', COPY), { texture: cur }, {}, null);
  return canvas;
}

/** Compile every transition once (used by tests); returns the names that failed. */
export function compileAll() {
  if (!init()) return null;
  for (const T of TRANSITIONS) program('t:' + T.n, transitionShader(T));
  for (const [id, F] of Object.entries(FILTERS)) F.passes.forEach((p, i) => program('f:' + id + ':' + i, p.fs));
  return [...broken];
}

// test hook: lets automated checks compile every shader in a real browser
if (typeof window !== 'undefined') window.__vizGpu = { compileAll, broken };
