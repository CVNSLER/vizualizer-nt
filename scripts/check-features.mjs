// Guards the per-frame feature contract: every field a template reads as `f.<name>` must be
// produced both by sample() (audio.js, real music) and by idleFeatures() (App.jsx, no music yet).
// A missing field once crashed the app at start-up (NaN colour), so the build fails on a gap.
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const consumers = ['src/templates.js', 'src/templates2.js', 'src/videofx.js', 'src/catalog.js'];
const used = new Set();
for (const file of consumers) for (const m of read(file).matchAll(/\bf\.([a-zA-Z_]+)/g)) used.add(m[1]);

const block = (src, start) => { const i = src.indexOf(start); if (i < 0) throw new Error('missing ' + start); return src.slice(i, src.indexOf('\n}\n', i)); };
const app = read('src/App.jsx'), audio = read('src/audio.js');
const producers = {
  'idleFeatures() in App.jsx': block(app, 'function idleFeatures'),
  'sample() + deepAt() in audio.js': block(audio, 'export function sample') + block(audio, 'function deepAt'),
};
const has = (src, k) => new RegExp(`(^|[\\s{,])${k}\\s*[:,}]|\\.\\.\\.`).test(src) && new RegExp(`(^|[\\s{,])${k}(\\s*:|\\s*,|\\s*}|\\s*$)`, 'm').test(src);

let bad = 0;
// optional fields: set only by renderFrame for template settings, read with a fallback
const OPTIONAL = new Set(['realT']);
for (const k of [...used].sort().filter((x) => !OPTIONAL.has(x))) for (const [name, src] of Object.entries(producers)) {
  if (!has(src, k)) { console.error(`missing feature "${k}" in ${name}`); bad++; }
}
console.log(`feature contract: ${used.size} fields checked, ${bad} missing`);
process.exit(bad ? 1 : 0);
