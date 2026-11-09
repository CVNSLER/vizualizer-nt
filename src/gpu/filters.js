// GPU image filters for template "1". Each filter is driven by one sound's value `v` (0..~1.4).
//
// Filters marked "glfx" are ported from glfx.js by Evan Wallace (MIT licence,
// https://github.com/evanw/glfx.js); the GLSL is unchanged apart from the precision header
// and uniform values being fed from the music. The others are written for this app.

const RANDOM = `float random(vec3 scale, float seed){return fract(sin(dot(gl_FragCoord.xyz + seed, scale)) * 43758.5453 + seed);}`;
const HEAD = 'precision highp float;\nuniform sampler2D texture;\nuniform vec2 texSize;\nvarying vec2 texCoord;\nuniform float time;\n';

const warp = (uniforms, body) => `${HEAD}${uniforms}
void main(){
  vec2 coord = texCoord * texSize;
  ${body}
  gl_FragColor = texture2D(texture, coord / texSize);
  vec2 clampedCoord = clamp(coord, vec2(0.0), texSize);
  if (coord != clampedCoord) gl_FragColor.a *= max(0.0, 1.0 - length(coord - clampedCoord));
}`;

// ---------------------------------------------------------------- glfx.js filters
const BULGE = warp('uniform float radius; uniform float strength; uniform vec2 center;', `
  coord -= center;
  float distance = length(coord);
  if (distance < radius) {
    float percent = distance / radius;
    if (strength > 0.0) coord *= mix(1.0, smoothstep(0.0, radius / distance, percent), strength * 0.75);
    else coord *= mix(1.0, pow(percent, 1.0 + strength * 0.75) * radius / distance, 1.0 - percent);
  }
  coord += center;`);

const SWIRL = warp('uniform float radius; uniform float angle; uniform vec2 center;', `
  coord -= center;
  float distance = length(coord);
  if (distance < radius) {
    float percent = (radius - distance) / radius;
    float theta = percent * percent * angle;
    float s = sin(theta); float c = cos(theta);
    coord = vec2(coord.x * c - coord.y * s, coord.x * s + coord.y * c);
  }
  coord += center;`);

const ZOOMBLUR = `${HEAD}uniform vec2 center; uniform float strength;
${RANDOM}
void main(){
  vec4 color = vec4(0.0); float total = 0.0;
  vec2 toCenter = center - texCoord * texSize;
  float offset = random(vec3(12.9898, 78.233, 151.7182), 0.0);
  for (float t = 0.0; t <= 40.0; t++) {
    float percent = (t + offset) / 40.0;
    float weight = 4.0 * (percent - percent * percent);
    vec4 s = texture2D(texture, texCoord + toCenter * percent * strength / texSize);
    s.rgb *= s.a; color += s * weight; total += weight;
  }
  gl_FragColor = color / total; gl_FragColor.rgb /= gl_FragColor.a + 0.00001;
}`;

const TRIBLUR = `${HEAD}uniform vec2 delta;
${RANDOM}
void main(){
  vec4 color = vec4(0.0); float total = 0.0;
  float offset = random(vec3(12.9898, 78.233, 151.7182), 0.0);
  for (float t = -30.0; t <= 30.0; t++) {
    float percent = (t + offset - 0.5) / 30.0;
    float weight = 1.0 - abs(percent);
    vec4 s = texture2D(texture, texCoord + delta * percent);
    s.rgb *= s.a; color += s * weight; total += weight;
  }
  gl_FragColor = color / total; gl_FragColor.rgb /= gl_FragColor.a + 0.00001;
}`;

const HEXPIXEL = `${HEAD}uniform vec2 center; uniform float scale;
void main(){
  vec2 tex = (texCoord * texSize - center) / scale;
  tex.y /= 0.866025404; tex.x -= tex.y * 0.5;
  vec2 a;
  if (tex.x + tex.y - floor(tex.x) - floor(tex.y) < 1.0) a = vec2(floor(tex.x), floor(tex.y));
  else a = vec2(ceil(tex.x), ceil(tex.y));
  vec2 b = vec2(ceil(tex.x), floor(tex.y)); vec2 c = vec2(floor(tex.x), ceil(tex.y));
  vec3 TEX = vec3(tex.x, tex.y, 1.0 - tex.x - tex.y);
  vec3 A = vec3(a.x, a.y, 1.0 - a.x - a.y); vec3 B = vec3(b.x, b.y, 1.0 - b.x - b.y); vec3 C = vec3(c.x, c.y, 1.0 - c.x - c.y);
  float alen = length(TEX - A); float blen = length(TEX - B); float clen = length(TEX - C);
  vec2 choice;
  if (alen < blen) { if (alen < clen) choice = a; else choice = c; } else { if (blen < clen) choice = b; else choice = c; }
  choice.x += choice.y * 0.5; choice.y *= 0.866025404; choice *= scale / texSize;
  gl_FragColor = texture2D(texture, choice + center / texSize);
}`;

const HALFTONE = `${HEAD}uniform vec2 center; uniform float angle; uniform float scale; uniform float mixAmt;
float pattern(float angle){
  float s = sin(angle), c = cos(angle);
  vec2 tex = texCoord * texSize - center;
  vec2 point = vec2(c * tex.x - s * tex.y, s * tex.x + c * tex.y) * scale;
  return (sin(point.x) * sin(point.y)) * 4.0;
}
void main(){
  vec4 color = texture2D(texture, texCoord);
  vec3 cmy = 1.0 - color.rgb;
  float k = min(cmy.x, min(cmy.y, cmy.z));
  cmy = (cmy - k) / (1.0 - k);
  cmy = clamp(cmy * 10.0 - 3.0 + vec3(pattern(angle + 0.26179), pattern(angle + 1.30899), pattern(angle)), 0.0, 1.0);
  k = clamp(k * 10.0 - 5.0 + pattern(angle + 0.78539), 0.0, 1.0);
  gl_FragColor = vec4(mix(color.rgb, 1.0 - cmy - k, mixAmt), color.a);
}`;

const DOTSCREEN = `${HEAD}uniform vec2 center; uniform float angle; uniform float scale; uniform float mixAmt;
float pattern(){
  float s = sin(angle), c = cos(angle);
  vec2 tex = texCoord * texSize - center;
  vec2 point = vec2(c * tex.x - s * tex.y, s * tex.x + c * tex.y) * scale;
  return (sin(point.x) * sin(point.y)) * 4.0;
}
void main(){
  vec4 color = texture2D(texture, texCoord);
  float average = (color.r + color.g + color.b) / 3.0;
  gl_FragColor = vec4(mix(color.rgb, vec3(average * 10.0 - 5.0 + pattern()), mixAmt), color.a);
}`;

const EDGE1 = `${HEAD}uniform vec2 delta;
${RANDOM}
void main(){
  vec2 color = vec2(0.0); vec2 total = vec2(0.0);
  float offset = random(vec3(12.9898, 78.233, 151.7182), 0.0);
  for (float t = -30.0; t <= 30.0; t++) {
    float percent = (t + offset - 0.5) / 30.0;
    float weight = 1.0 - abs(percent);
    vec3 s = texture2D(texture, texCoord + delta * percent).rgb;
    float average = (s.r + s.g + s.b) / 3.0;
    color.x += average * weight; total.x += weight;
    if (abs(t) < 15.0) { weight = weight * 2.0 - 1.0; color.y += average * weight; total.y += weight; }
  }
  gl_FragColor = vec4(color / total, 0.0, 1.0);
}`;
const EDGE2 = `${HEAD}uniform vec2 delta;
${RANDOM}
void main(){
  vec2 color = vec2(0.0); vec2 total = vec2(0.0);
  float offset = random(vec3(12.9898, 78.233, 151.7182), 0.0);
  for (float t = -30.0; t <= 30.0; t++) {
    float percent = (t + offset - 0.5) / 30.0;
    float weight = 1.0 - abs(percent);
    vec2 s = texture2D(texture, texCoord + delta * percent).xy;
    color.x += s.x * weight; total.x += weight;
    if (abs(t) < 15.0) { weight = weight * 2.0 - 1.0; color.y += s.y * weight; total.y += weight; }
  }
  float c = clamp(10000.0 * (color.y / total.y - color.x / total.x) + 0.5, 0.0, 1.0);
  gl_FragColor = vec4(c, c, c, 1.0);
}`;

const INK = `${HEAD}uniform float strength;
void main(){
  vec2 dx = vec2(1.0 / texSize.x, 0.0); vec2 dy = vec2(0.0, 1.0 / texSize.y);
  vec4 color = texture2D(texture, texCoord);
  float bigTotal = 0.0; float smallTotal = 0.0; vec3 bigAverage = vec3(0.0); vec3 smallAverage = vec3(0.0);
  for (float x = -2.0; x <= 2.0; x += 1.0) for (float y = -2.0; y <= 2.0; y += 1.0) {
    vec3 s = texture2D(texture, texCoord + dx * x + dy * y).rgb;
    bigAverage += s; bigTotal += 1.0;
    if (abs(x) + abs(y) < 2.0) { smallAverage += s; smallTotal += 1.0; }
  }
  vec3 edge = max(vec3(0.0), bigAverage / bigTotal - smallAverage / smallTotal);
  gl_FragColor = vec4(color.rgb - dot(edge, edge) * strength * 100000.0, color.a);
}`;

const NOISE = `${HEAD}uniform float amount;
float rand(vec2 co){ return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453); }
void main(){
  vec4 color = texture2D(texture, texCoord);
  float diff = (rand(texCoord + fract(time)) - 0.5) * amount;
  color.rgb += diff;
  gl_FragColor = color;
}`;

const VIGNETTE = `${HEAD}uniform float size; uniform float amount;
void main(){
  vec4 color = texture2D(texture, texCoord);
  float dist = distance(texCoord, vec2(0.5, 0.5));
  color.rgb *= smoothstep(0.8, size * 0.799, dist * (amount + size));
  gl_FragColor = color;
}`;

const HUESAT = `${HEAD}uniform float hue; uniform float saturation;
void main(){
  vec4 color = texture2D(texture, texCoord);
  float angle = hue * 3.14159265;
  float s = sin(angle), c = cos(angle);
  vec3 weights = (vec3(2.0 * c, -sqrt(3.0) * s - c, sqrt(3.0) * s - c) + 1.0) / 3.0;
  color.rgb = vec3(dot(color.rgb, weights.xyz), dot(color.rgb, weights.zxy), dot(color.rgb, weights.yzx));
  float average = (color.r + color.g + color.b) / 3.0;
  if (saturation > 0.0) color.rgb += (average - color.rgb) * (1.0 - 1.0 / (1.001 - saturation));
  else color.rgb += (average - color.rgb) * (-saturation);
  gl_FragColor = color;
}`;

const SEPIA = `${HEAD}uniform float amount;
void main(){
  vec4 color = texture2D(texture, texCoord);
  float r = color.r, g = color.g, b = color.b;
  color.r = min(1.0, (r * (1.0 - (0.607 * amount))) + (g * (0.769 * amount)) + (b * (0.189 * amount)));
  color.g = min(1.0, (r * 0.349 * amount) + (g * (1.0 - (0.314 * amount))) + (b * 0.168 * amount));
  color.b = min(1.0, (r * 0.272 * amount) + (g * 0.534 * amount) + (b * (1.0 - (0.869 * amount))));
  gl_FragColor = color;
}`;

const VIBRANCE = `${HEAD}uniform float amount;
void main(){
  vec4 color = texture2D(texture, texCoord);
  float average = (color.r + color.g + color.b) / 3.0;
  float mx = max(color.r, max(color.g, color.b));
  float amt = (mx - average) * (-amount * 3.0);
  color.rgb = mix(color.rgb, vec3(mx), amt);
  gl_FragColor = color;
}`;

// ---------------------------------------------------------------- filters written for this app
const RGBSPLIT = `${HEAD}uniform float amount;
void main(){
  vec2 d = (texCoord - 0.5) * amount;
  vec4 c = texture2D(texture, texCoord);
  gl_FragColor = vec4(texture2D(texture, texCoord + d).r, c.g, texture2D(texture, texCoord - d).b, c.a);
}`;
const RGBWAVE = `${HEAD}uniform float amount;
void main(){
  float w = sin(texCoord.y * 40.0 + time * 6.0) * amount;
  gl_FragColor = vec4(texture2D(texture, texCoord + vec2(w, 0.0)).r, texture2D(texture, texCoord).g, texture2D(texture, texCoord - vec2(w, 0.0)).b, 1.0);
}`;
const SHOCKWAVE = `${HEAD}uniform float radius; uniform float amount; uniform float aspect;
void main(){
  vec2 p = texCoord - 0.5; p.x *= aspect;
  float d = length(p);
  float w = 0.08;
  float k = smoothstep(radius - w, radius, d) - smoothstep(radius, radius + w, d);
  vec2 dir = d > 0.0 ? p / d : vec2(0.0); dir.x /= aspect;
  gl_FragColor = texture2D(texture, texCoord - dir * k * amount * 0.06) + vec4(vec3(k * amount * 0.25), 0.0);
}`;
const GLITCH = `${HEAD}uniform float amount; uniform float seed;
float h(float n){ return fract(sin(n) * 43758.5453); }
void main(){
  float band = floor(texCoord.y * 24.0);
  float r = h(band + seed);
  float shift = r > 1.0 - amount * 0.6 ? (h(band * 7.0 + seed) - 0.5) * amount * 0.25 : 0.0;
  vec2 uv = vec2(fract(texCoord.x + shift), texCoord.y);
  vec4 c = texture2D(texture, uv);
  float sp = amount * 0.012;
  gl_FragColor = vec4(texture2D(texture, uv + vec2(sp, 0.0)).r, c.g, texture2D(texture, uv - vec2(sp, 0.0)).b, 1.0);
}`;
const LIQUID = `${HEAD}uniform float amount;
float n(vec2 p){ return sin(p.x * 3.1 + time * 1.3) * cos(p.y * 2.7 - time * 1.1) + sin((p.x + p.y) * 4.3 + time * 0.7) * 0.5; }
void main(){
  vec2 p = texCoord * 3.0;
  vec2 off = vec2(n(p), n(p + 7.3)) * amount * 0.03;
  gl_FragColor = texture2D(texture, texCoord + off);
}`;
const POSTER = `${HEAD}uniform float levels; uniform float mixAmt;
void main(){
  vec4 c = texture2D(texture, texCoord);
  gl_FragColor = vec4(mix(c.rgb, floor(c.rgb * levels + 0.5) / levels, mixAmt), c.a);
}`;
const INVERT = `${HEAD}uniform float amount;
void main(){ vec4 c = texture2D(texture, texCoord); gl_FragColor = vec4(mix(c.rgb, 1.0 - c.rgb, amount), c.a); }`;
const EXPOSURE = `${HEAD}uniform float amount;
void main(){ vec4 c = texture2D(texture, texCoord); vec3 e = 1.0 - exp(-c.rgb * (1.0 + amount * 3.0)); gl_FragColor = vec4(mix(c.rgb, e * 1.1, min(1.0, amount)), c.a); }`;
const MIRROR = `${HEAD}uniform float amount; uniform float segs;
void main(){
  vec2 p = texCoord - 0.5;
  float a = atan(p.y, p.x), r = length(p);
  float s = 6.2831853 / segs;
  a = mod(a, s); a = abs(a - s * 0.5);
  vec2 k = vec2(cos(a), sin(a)) * r + 0.5;
  gl_FragColor = mix(texture2D(texture, texCoord), texture2D(texture, k), amount);
}`;
const GRADE = `${HEAD}uniform float amount;
void main(){
  vec4 c = texture2D(texture, texCoord);
  float l = dot(c.rgb, vec3(0.299, 0.587, 0.114));
  vec3 teal = vec3(0.0, 0.45, 0.55), orange = vec3(1.0, 0.55, 0.2);
  vec3 g = mix(c.rgb * mix(vec3(1.0), teal * 1.6, 0.5), c.rgb * mix(vec3(1.0), orange * 1.3, 0.5), smoothstep(0.2, 0.8, l));
  gl_FragColor = vec4(mix(c.rgb, g, amount), c.a);
}`;
const CRT = `${HEAD}uniform float amount;
void main(){
  vec2 p = texCoord * 2.0 - 1.0;
  p *= 1.0 + dot(p, p) * 0.08 * amount;
  vec2 uv = p * 0.5 + 0.5;
  vec4 c = texture2D(texture, uv);
  float scan = 0.85 + 0.15 * sin(uv.y * texSize.y * 1.5);
  float edge = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
  gl_FragColor = vec4(mix(texture2D(texture, texCoord).rgb, c.rgb * scan * edge, amount), 1.0);
}`;
const LEAK = `${HEAD}uniform float amount; uniform vec3 tint;
void main(){
  vec4 c = texture2D(texture, texCoord);
  vec2 p = texCoord - vec2(0.15 + 0.7 * fract(time * 0.05), 0.2);
  float g = exp(-dot(p, p) * 3.0);
  gl_FragColor = vec4(c.rgb + tint * g * amount * 0.8, c.a);
}`;
const BRIGHT = `${HEAD}uniform float threshold;
void main(){ vec4 c = texture2D(texture, texCoord); float l = max(c.r, max(c.g, c.b)); gl_FragColor = vec4(c.rgb * smoothstep(threshold, threshold + 0.2, l), 1.0); }`;
const ADD = `${HEAD}uniform sampler2D base; uniform float amount;
void main(){ gl_FragColor = vec4(texture2D(base, texCoord).rgb + texture2D(texture, texCoord).rgb * amount, 1.0); }`;
const MIXF = `${HEAD}uniform sampler2D base; uniform float amount;
void main(){ gl_FragColor = vec4(mix(texture2D(base, texCoord).rgb, texture2D(texture, texCoord).rgb, amount), 1.0); }`;
// Sobel edge magnitude, glowing in the layer's colour
const NEONEDGE = `${HEAD}uniform float amount; uniform vec3 tint; uniform float px;
float L(vec2 o){ return dot(texture2D(texture, texCoord + o * px / texSize).rgb, vec3(0.299, 0.587, 0.114)); }
void main(){
  float gx = -L(vec2(-1.0,-1.0)) - 2.0*L(vec2(-1.0,0.0)) - L(vec2(-1.0,1.0)) + L(vec2(1.0,-1.0)) + 2.0*L(vec2(1.0,0.0)) + L(vec2(1.0,1.0));
  float gy = -L(vec2(-1.0,-1.0)) - 2.0*L(vec2(0.0,-1.0)) - L(vec2(1.0,-1.0)) + L(vec2(-1.0,1.0)) + 2.0*L(vec2(0.0,1.0)) + L(vec2(1.0,1.0));
  float e = smoothstep(0.12, 0.55, length(vec2(gx, gy)));
  vec3 base = texture2D(texture, texCoord).rgb;
  float a = min(1.0, amount);
  gl_FragColor = vec4(base * (1.0 - 0.45 * a) + tint * e * amount * 1.6, 1.0);
}`;
const STROBE = `${HEAD}uniform float amount; uniform vec3 tint;
void main(){ vec4 c = texture2D(texture, texCoord); gl_FragColor = vec4(mix(c.rgb, tint, amount * 0.7), c.a); }`;

// ---------------------------------------------------------------- catalogue
// passes: [{ fs, uniforms(ctx) }]; ctx = { v, W, H, t, color: [r,g,b], age }
// `save: name` keeps a pass's INPUT for a later pass; `base: name` binds it as the `base` sampler.
export const FILTERS = {
  bulge: { src: 'glfx', passes: [{ fs: BULGE, u: ({ v, W, H }) => ({ radius: Math.min(W, H) * 0.55, strength: Math.min(1, v * 0.8), center: [W / 2, H / 2] }) }] },
  pinch: { src: 'glfx', passes: [{ fs: BULGE, u: ({ v, W, H }) => ({ radius: Math.min(W, H) * 0.55, strength: -Math.min(1, v * 0.8), center: [W / 2, H / 2] }) }] },
  swirl: { src: 'glfx', passes: [{ fs: SWIRL, u: ({ v, W, H }) => ({ radius: Math.min(W, H) * 0.6, angle: v * 2.5, center: [W / 2, H / 2] }) }] },
  zoomBlur: { src: 'glfx', passes: [{ fs: ZOOMBLUR, u: ({ v, W, H }) => ({ center: [W / 2, H / 2], strength: Math.min(0.6, v * 0.45) }) }] },
  blur: { src: 'glfx', passes: [{ fs: TRIBLUR, u: ({ v, W }) => ({ delta: [(v * 14) / W, 0] }) }, { fs: TRIBLUR, u: ({ v, H }) => ({ delta: [0, (v * 14) / H] }) }] },
  hexPixel: { src: 'glfx', passes: [{ fs: HEXPIXEL, u: ({ v, W, H }) => ({ center: [W / 2, H / 2], scale: 2 + v * Math.min(W, H) * 0.035 }) }] },
  halftone: { src: 'glfx', passes: [{ fs: HALFTONE, u: ({ v, W, H }) => ({ center: [W / 2, H / 2], angle: 0.25, scale: Math.PI / (3 + 3 * Math.min(W, H) / 1080), mixAmt: Math.min(1, v) }) }] },
  dotScreen: { src: 'glfx', passes: [{ fs: DOTSCREEN, u: ({ v, W, H }) => ({ center: [W / 2, H / 2], angle: 1.1, scale: Math.PI / (3 * Math.min(W, H) / 1080 + 1), mixAmt: Math.min(1, v) }) }] },
  sketch: { src: 'glfx', passes: [{ fs: EDGE1, u: ({ W }) => ({ delta: [6 / W, 0] }), save: 'pre' }, { fs: EDGE2, u: ({ H }) => ({ delta: [0, 6 / H] }) }, { fs: MIXF, base: 'pre', u: ({ v }) => ({ amount: Math.min(1, v) }) }] },
  neonEdge: { src: 'app', passes: [{ fs: NEONEDGE, u: ({ v, color, W, H }) => ({ amount: Math.min(1.4, v), tint: color, px: Math.max(1, Math.min(W, H) / 900) }) }] },
  ink: { src: 'glfx', passes: [{ fs: INK, u: ({ v }) => ({ strength: Math.min(1, 0.3 + v * 0.5) ** 5 }) }] },
  noise: { src: 'glfx', passes: [{ fs: NOISE, u: ({ v }) => ({ amount: Math.min(1, v * 0.5) }) }] },
  vignette: { src: 'glfx', passes: [{ fs: VIGNETTE, u: ({ v }) => ({ size: 0.25 + 0.2 * (1 - Math.min(1, v)), amount: Math.min(1, 0.3 + v * 0.6) }) }] },
  hueShift: { src: 'glfx', passes: [{ fs: HUESAT, u: ({ v, t }) => ({ hue: ((t * 0.05 + v * 0.4) % 2) - 1, saturation: Math.min(0.6, v * 0.4) }) }] },
  sepia: { src: 'glfx', passes: [{ fs: SEPIA, u: ({ v }) => ({ amount: Math.min(1, v) }) }] },
  vibrance: { src: 'glfx', passes: [{ fs: VIBRANCE, u: ({ v }) => ({ amount: Math.min(1, v) }) }] },
  rgbSplit: { src: 'app', passes: [{ fs: RGBSPLIT, u: ({ v }) => ({ amount: Math.min(0.08, v * 0.05) }) }] },
  rgbWave: { src: 'app', passes: [{ fs: RGBWAVE, u: ({ v }) => ({ amount: Math.min(0.03, v * 0.015) }) }] },
  shockwave: { src: 'app', event: true, passes: [{ fs: SHOCKWAVE, u: ({ v, W, H, age }) => ({ radius: age * 1.2, amount: Math.max(0, 1 - age * 1.4) * Math.min(1.3, v + 0.5), aspect: W / H }) }] },
  glitch: { src: 'app', passes: [{ fs: GLITCH, u: ({ v, t }) => ({ amount: Math.min(1, v), seed: Math.floor(t * 24) }) }] },
  liquid: { src: 'app', passes: [{ fs: LIQUID, u: ({ v }) => ({ amount: Math.min(1.5, v) }) }] },
  posterize: { src: 'app', passes: [{ fs: POSTER, u: ({ v }) => ({ levels: 4, mixAmt: Math.min(1, v) }) }] },
  invert: { src: 'app', passes: [{ fs: INVERT, u: ({ v }) => ({ amount: Math.min(1, Math.max(0, v - 0.35) * 1.6) }) }] },
  exposure: { src: 'app', passes: [{ fs: EXPOSURE, u: ({ v }) => ({ amount: Math.min(1.2, v) }) }] },
  kaleido: { src: 'app', passes: [{ fs: MIRROR, u: ({ v }) => ({ amount: Math.min(1, v), segs: 8 }) }] },
  grade: { src: 'app', passes: [{ fs: GRADE, u: ({ v }) => ({ amount: Math.min(1, 0.4 + v * 0.6) }) }] },
  crt: { src: 'app', passes: [{ fs: CRT, u: ({ v }) => ({ amount: Math.min(1, 0.3 + v * 0.7) }) }] },
  lightLeak: { src: 'app', passes: [{ fs: LEAK, u: ({ v, color }) => ({ amount: Math.min(1.2, v), tint: color }) }] },
  bloom: { src: 'app', passes: [{ fs: BRIGHT, u: () => ({ threshold: 0.6 }), save: 'pre' }, { fs: TRIBLUR, u: ({ W }) => ({ delta: [18 / W, 0] }) }, { fs: TRIBLUR, u: ({ H }) => ({ delta: [0, 18 / H] }) }, { fs: ADD, base: 'pre', u: ({ v }) => ({ amount: Math.min(2, v * 1.6) }) }] },
  strobe: { src: 'app', passes: [{ fs: STROBE, u: ({ v, color }) => ({ amount: Math.min(1, Math.max(0, v - 0.3) * 1.5), tint: color }) }] },
};
export const FILTER_IDS = Object.keys(FILTERS);
