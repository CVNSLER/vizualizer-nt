// Packs the Vite build into one self-contained HTML fragment for a claude.ai artifact.
import fs from 'node:fs';
import path from 'node:path';

const dist = 'dist';
const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
const css = [...html.matchAll(/href="\.\/(assets\/[^"]+\.css)"/g)].map((m) => fs.readFileSync(path.join(dist, m[1]), 'utf8')).join('\n');
const js = [...html.matchAll(/src="\.\/(assets\/[^"]+\.js)"/g)].map((m) => fs.readFileSync(path.join(dist, m[1]), 'utf8')).join('\n');
const safeJs = js.replace(/<\/script/gi, '<\\/script');
const out = `<title>Vizualizator</title>
<style>
${css}
</style>
<div id="root"></div>
<script type="module">
${safeJs}
</script>
`;
fs.mkdirSync('dist-artifact', { recursive: true });
fs.writeFileSync('dist-artifact/vizualizator.html', out);
console.log('dist-artifact/vizualizator.html', (out.length / 1024).toFixed(0), 'KB');
