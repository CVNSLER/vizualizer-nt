// Packs the Vite build into one self-contained HTML fragment for a claude.ai artifact.
import fs from 'node:fs';
import path from 'node:path';

const dist = 'dist';
const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
const css = [...html.matchAll(/href="\.\/(assets\/[^"]+\.css)"/g)].map((m) => fs.readFileSync(path.join(dist, m[1]), 'utf8')).join('\n');
const js = [...html.matchAll(/src="\.\/(assets\/[^"]+\.js)"/g)].map((m) => fs.readFileSync(path.join(dist, m[1]), 'utf8')).join('\n');
const safeJs = js.replace(/<\/script/gi, '<\\/script');
// Classic script that runs before the app: if the app never starts (or crashes at startup),
// it prints the reason on the page instead of leaving a blank screen.
const guard = `<script>
(function(){
  function show(msg){var r=document.getElementById('root');if(!r||r.childElementCount)return;
    var d=document.createElement('pre');d.style.cssText='white-space:pre-wrap;color:#ffb4b4;background:#1a0f12;padding:16px;margin:16px;border:1px solid #ff6b6b;border-radius:8px;font:13px/1.5 monospace';
    d.textContent='Vizualizator ochilmadi / не запустился. Shu matnni Claude ga yuboring:\\n\\n'+msg;r.appendChild(d);}
  window.addEventListener('error',function(e){show((e.message||'error')+' @ '+(e.filename||'')+':'+(e.lineno||'')+':'+(e.colno||''));});
  window.addEventListener('unhandledrejection',function(e){var r=e.reason;show('Promise: '+(r&&(r.stack||r.message)||r));});
  setTimeout(function(){var r=document.getElementById('root');if(r&&!r.childElementCount)show('Ilova 8 soniyada ishga tushmadi (skript yuklanmagan yoki bloklangan).');},8000);
})();
</script>`;
const out = `<title>Vizualizator v1.0</title>
<style>
${css}
</style>
<div id="root"></div>
${guard}
<script type="module">
${safeJs}
</script>
`;
fs.mkdirSync('dist-artifact', { recursive: true });
fs.writeFileSync('dist-artifact/vizualizator.html', out);
console.log('dist-artifact/vizualizator.html', (out.length / 1024).toFixed(0), 'KB');

// CPU build of ONNX Runtime served next to the page (the artifact sandbox may not fetch from CDNs)
const ortDir = path.join('dist-artifact', 'ort');
fs.mkdirSync(ortDir, { recursive: true });
for (const f of ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs', 'ort.wasm.min.js']) fs.copyFileSync(path.join('node_modules/onnxruntime-web/dist', f), path.join(ortDir, f));
