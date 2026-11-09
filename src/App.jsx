import { useEffect, useMemo, useRef, useState } from 'react';
import { STRINGS } from './i18n.js';
import { CATEGORIES, PALETTES, SHAPED, renderFrame } from './catalog.js';
import { analyse, decodeFile, sample } from './audio.js';
import { exportVideo, saveVideo } from './exporter.js';
import { FONTS, loadFont, previewFont } from './fonts.js';
import { FX_PRESETS, videoTimeAt, videoRateAt } from './videofx.js';
import { runDeepAnalysis } from './deep/index.js';
import AlgoPanel from './AlgoPanel.jsx';
import OnePanel from './OnePanel.jsx';
import { wavBytes, mp3Bytes, saveAudio } from './audioexport.js';
import { checkQuality, improveQuality, refineQuality, toWavUrl } from './quality/index.js';
import { useStudio } from './studio/useStudio.js';
import StudioPanel from './studio/StudioPanel.jsx';
import TplSettings from './TplSettings.jsx';
import { THEMES, THEME_KEYS, loadTheme, applyTheme } from './theme.js';

const FORMATS = { '9:16': [9, 16], '1:1': [1, 1], '4:5': [4, 5], '16:9': [16, 9] };
const QUALITIES = { '720p': 720, '1080p': 1080, '4K': 2160 };

const DEFAULTS = {
  template: 'ring', format: '9:16',
  bgType: 'gradient', bgColor1: '#07070d', bgColor2: '#1b1240', bgDim: 0.35, bgBlur: 0,
  color1: '#7c5cff', color2: '#22d3c5',
  title: '', subtitle: '', textColor: '#ffffff', titleSize: 64, showProgress: false,
  logoPos: 'tr', logoScale: 1, sens: 1,
  showTimer: false, textPos: 'bottom', shapeSides: 6,
  titleFont: 'Montserrat', subFont: 'Montserrat', titleWeight: 700, bgFit: 'cover', bgMotion: 'none',
  fxPreset: 'none', ...FX_PRESETS.none,
};

function dims(format, short) {
  const [a, b] = FORMATS[format];
  const w = a <= b ? short : Math.round((short * a) / b);
  const h = a <= b ? Math.round((short * b) / a) : short;
  return [w - (w % 2), h - (h % 2)];
}

function loadSettings() {
  try {
    const v = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('viz-settings') || '{}') };
    if (v.template === 'one') v.template = 'zero'; // template "1" was removed
    delete v.layers; delete v.oneSeed; delete v.oneMood; delete v.oneMoodPick;
    return v;
  } catch { return DEFAULTS; }
}

function fileToImage(file) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = URL.createObjectURL(file);
  });
}

const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export default function App() {
  const [lang, setLang] = useState(() => { try { return localStorage.getItem('viz-lang') || 'uz'; } catch { return 'uz'; } });
  const T = STRINGS[lang];
  const [s, setS] = useState(loadSettings);
  const set = (k, v) => setS((p) => ({ ...p, [k]: v }));
  const [images, setImages] = useState({ bgImage: null, bgVideo: null, centerImage: null, logo: null });
  const [audio, setAudio] = useState(null); // { name, url, buffer, analysis }
  const [busy, setBusy] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [exp, setExp] = useState(null); // export dialog state
  const [notice, setNotice] = useState(null);
  const canvasRef = useRef(null);
  const audioRef = useRef(null);
  const abortRef = useRef(null);
  const deepJob = useRef(null);
  const [deepStatus, setDeepStatus] = useState({ status: 'idle', p: 0 });
  const [algoOpen, setAlgoOpen] = useState(false);
  const [oneOpen, setOneOpen] = useState(false);
  const [folderOpen, setFolderOpenRaw] = useState(() => { try { return localStorage.getItem('viz-folder') === '1'; } catch { return false; } });
  const setFolderOpen = (f) => setFolderOpenRaw((v) => { const nv = typeof f === 'function' ? f(v) : f; try { localStorage.setItem('viz-folder', nv ? '1' : '0'); } catch { /* ignore */ } return nv; });
  // quality: check result + history of enhanced versions (the active one is what "Yaxshilangan" plays)
  const [quality, setQuality] = useState({ status: 'idle', history: [], active: -1 });
  const enhanced = quality.history[quality.active] || null;
  const [qTarget, setQTarget] = useState(-14);
  const [qSet, setQSetRaw] = useState(() => { try { return { strength: 1, level: 'standard', amt: {}, off: [], ...JSON.parse(localStorage.getItem('viz-quality') || '{}') }; } catch { return { strength: 1, level: 'standard', amt: {}, off: [] }; } });
  const qDirty = useRef(false);
  const [qPending, setQPending] = useState(0); // when the manual quality change will be applied
  const setQSet = (fn) => { qDirty.current = true; setQPending(Date.now() + 3000); setQSetRaw(fn); };
  useEffect(() => { try { localStorage.setItem('viz-quality', JSON.stringify(qSet)); } catch { /* ignore */ } }, [qSet]);
  // what is heard: 'orig' (always the untouched original), 'enh' (the enhanced version as it is), 'studio'
  const [listen, setListen] = useState('orig');
  const useEnhanced = listen === 'enh';
  const setUseEnhanced = (v) => setListen(v ? 'enh' : 'orig');
  const [studioOpen, setStudioOpen] = useState(false);
  const [theme, setTheme] = useState(loadTheme);
  useEffect(() => applyTheme(theme), [theme]);
  const vocalsOf = () => audio?.analysis.deep?.vocals || [];
  const studio = useStudio({
    audio, audioRef, origBuf: audio?.buffer || null, enh: enhanced, listen,
    bpm: audio?.analysis.deep?.bpm ?? audio?.analysis.bpm,
    qKey: JSON.stringify([qTarget, qSet]),
    enhanceFx: async (buffer, kind, onP) => {
      let plan;
      if (kind === 'fresh') plan = (await checkQuality(buffer, vocalsOf(), qTarget)).plan;
      else plan = (quality.result || await checkQuality(audio.buffer, vocalsOf(), qTarget)).plan;
      return improveQuality(buffer, { ...plan, target: qTarget, ...qSet }, vocalsOf(), onP);
    },
  });
  const audioSrc = !audio ? null : listen === 'studio' ? studio.srcUrl : listen === 'enh' && enhanced ? enhanced.url : audio.url;
  // switching what plays (original / enhanced / studio result) keeps the position and play state
  useEffect(() => {
    const el = audioRef.current;
    if (!el || !audioSrc || el.src === audioSrc) return;
    const t = el.currentTime, wasPlaying = !el.paused;
    el.src = audioSrc;
    el.addEventListener('loadedmetadata', () => { el.currentTime = Math.min(t, el.duration || t); if (wasPlaying) el.play().catch(() => {}); }, { once: true });
  }, [audioSrc, audio]);

  useEffect(() => { try { localStorage.setItem('viz-settings', JSON.stringify(s)); } catch { /* ignore */ } }, [s]);
  useEffect(() => { try { localStorage.setItem('viz-lang', lang); } catch { /* ignore */ } }, [lang]);
  useEffect(() => { window.__vizAudio = audio; }, [audio]); // read by automated checks

  const options = useMemo(() => ({ ...s, ...images }), [s, images]);
  useEffect(() => { loadFont(s.titleFont); loadFont(s.subFont); }, [s.titleFont, s.subFont]);
  const [pw, ph] = dims(s.format, 540);

  // render loop for the preview
  useEffect(() => {
    let raf;
    const ctx = canvasRef.current.getContext('2d');
    const loop = () => {
      if (window.__vizExporting) { raf = requestAnimationFrame(loop); return; } // free the GPU for the export
      const el = audioRef.current;
      const t = el ? el.currentTime : 0;
      const v = options.bgType === 'video' ? options.bgVideo : null;
      if (v && v.duration) {
        const an = audio?.analysis;
        const target = videoTimeAt(an, options, t, v.duration);
        const running = el && !el.paused;
        const rate = Math.max(0.25, Math.min(4, videoRateAt(an, options, t)));
        if (Math.abs(v.playbackRate - rate) > 0.04) v.playbackRate = rate;
        if (running && v.paused) v.play().catch(() => {});
        if (!running && !v.paused) v.pause();
        if (Math.abs(v.currentTime - target) > (running ? 0.3 : 0.04)) v.currentTime = target;
      }
      try {
        if (audio?.analysis) renderFrame(ctx, pw, ph, options, sample(audio.analysis, t), audio.analysis.duration);
        else renderFrame(ctx, pw, ph, options, idleFeatures(performance.now() / 1000), 0);
      } catch (err) {
        if (!loop.warned) { loop.warned = true; console.error('render', err); }
      }
      setTime(t);
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [audio, options, pw, ph]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.code !== 'Space' && e.key !== ' ') return;
      const tg = e.target;
      const typing = tg && (tg.tagName === 'TEXTAREA' || (tg.tagName === 'INPUT' && !['checkbox', 'radio', 'range', 'color', 'file'].includes(tg.type)) || tg.isContentEditable);
      if (typing) return;
      e.preventDefault();
      togglePlayRef.current?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  async function onAudioFile(file) {
    if (!file) return;
    setNotice(null);
    audioRef.current?.pause();
    setPlaying(false);
    setBusy(T.analysing);
    try {
      const buffer = await decodeFile(file);
      await new Promise((r) => setTimeout(r, 30));
      const analysis = analyse(buffer);
      const url = URL.createObjectURL(file);
      setAudio({ name: file.name, url, buffer, analysis });
      // deep "Algoritm" analysis runs in the background
      setQuality((q) => { q.history.forEach((h) => URL.revokeObjectURL(h.url)); return { status: 'idle', history: [], active: -1 }; }); vers.current = 0; setListen('orig');
      deepJob.current?.cancel();
      setDeepStatus({ status: 'running', p: 0, stage: 'stft' });
      const job = runDeepAnalysis(buffer, (p, stage) => setDeepStatus((d) => (d.status === 'running' ? { ...d, p, stage } : d)));
      deepJob.current = job;
      job.promise.then((res) => {
        if (deepJob.current !== job) return;
        analysis.deep = res;
        setDeepStatus({ status: 'done', p: 1 });
        setAudio((a) => (a && a.analysis === analysis ? { ...a } : a));
      }).catch((e) => { if (deepJob.current === job) setDeepStatus({ status: 'error', p: 0, msg: e.message }); });
    } catch (e) {
      setNotice(`${T.error} ${e.message}`);
    }
    setBusy(null);
  }

  function onDropFile(file) {
    if (!file) return;
    if (file.type.startsWith('image/')) onImage('bgImage', file);
    else if (file.type.startsWith('video/')) onVideo(file);
    else if (file.type.startsWith('audio/') || /\.(mp3|wav|m4a|ogg|flac|aac)$/i.test(file.name)) onAudioFile(file);
  }

  async function onVideo(file) {
    if (!file) return;
    const v = document.createElement('video');
    v.muted = true; v.loop = true; v.playsInline = true; v.preload = 'auto';
    v.src = URL.createObjectURL(file);
    await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = rej; });
    setImages((p) => ({ ...p, bgVideo: v }));
    set('bgType', 'video');
  }

  async function onImage(key, file) {
    if (!file) return;
    const img = await fileToImage(file);
    setImages((p) => ({ ...p, [key]: img }));
    if (key === 'bgImage') set('bgType', 'image');
  }

  // ---- quality: check, enhance, re-check single stages, history
  const vers = useRef(0);
  function runQualityCheck() {
    if (!audio) return;
    setQuality((q) => ({ ...q, status: 'running' }));
    checkQuality(audio.buffer, vocalsOf(), qTarget)
      .then((result) => setQuality((q) => ({ ...q, status: 'done', result })))
      .catch((e) => setQuality((q) => ({ ...q, status: 'error', msg: e.message })));
  }
  // keep at most 8 versions; the newest becomes active
  function pushVersion(v, keepListen = false) {
    setQuality((q) => {
      let h = [...q.history, { ...v, id: ++vers.current, url: toWavUrl(v.buffer), at: Date.now() }];
      while (h.length > 8) { URL.revokeObjectURL(h[0].url); h = h.slice(1); }
      return { ...q, status: 'done', history: h, active: h.length - 1, enhancing: false, refining: null, note: null };
    });
    if (!keepListen) setUseEnhanced(true);
  }
  async function ensureResult() {
    if (quality.result) return quality.result;
    setQuality((q) => ({ ...q, status: 'running' }));
    const result = await checkQuality(audio.buffer, vocalsOf(), qTarget);
    setQuality((q) => ({ ...q, status: 'done', result }));
    return result;
  }
  async function improve(settings = qSet, label = 'base', keepListen = false) {
    if (!audio) return;
    try {
      const result = await ensureResult();
      setQuality((q) => ({ ...q, enhancing: true, p: 0, note: null }));
      const r = await improveQuality(audio.buffer, { ...result.plan, target: qTarget, ...settings }, vocalsOf(), (p) => setQuality((q) => ({ ...q, p })));
      pushVersion({ ...r, kind: label, settings }, keepListen);
    } catch (e) { setQuality((q) => ({ ...q, enhancing: false, status: 'error', msg: e.message })); }
  }
  async function pickEnhanced() {
    if (!audio) return;
    if (enhanced) { setUseEnhanced(true); return; }
    await improve();
  }
  // look again at the active version: only `only` (one stage), or everything that is still off
  async function refineActive(only = null) {
    if (!enhanced) return;
    try {
      setQuality((q) => ({ ...q, enhancing: true, p: 0, note: null, refining: only || 'all' }));
      const r = await refineQuality(enhanced.buffer, { target: qTarget, only, level: qSet.level }, vocalsOf(), (p) => setQuality((q) => ({ ...q, p })));
      if (r.improved) pushVersion({ ...r, kind: only ? `restart:${only}` : 'again', settings: qSet });
      else setQuality((q) => ({ ...q, enhancing: false, refining: null, note: { kind: 'same', only } }));
    } catch (e) { setQuality((q) => ({ ...q, enhancing: false, refining: null, status: 'error', msg: e.message })); }
  }
  function setActiveVersion(i) { setQuality((q) => ({ ...q, active: i })); setUseEnhanced(true); }
  // stage switches, amounts, strength and level re-run the enhancement 1.5 s after the last change
  useEffect(() => {
    if (!qDirty.current || !quality.history.length) return undefined;
    const t = setTimeout(() => { qDirty.current = false; setQPending(0); improve(qSet, 'base'); }, 3000);
    return () => clearTimeout(t);
  }, [qSet]); // eslint-disable-line react-hooks/exhaustive-deps

  // the music exactly as it is heard in each mode
  async function bufferOf(which) {
    if (which === 'studio') return (await studio.render()) || studio.baseBuffer || audio.buffer;
    if (which === 'enh' && enhanced) return enhanced.buffer;
    return audio.buffer;
  }
  async function saveMusic(fmt) {
    const which = exp.musicWhich || listen;
    if (which === 'studio') setExp((x) => ({ ...x, musicBusy: T.preparing, musicDone: null, error: null }));
    const buf = await bufferOf(which);
    const start = exp.whole ? 0 : Math.max(0, +exp.from);
    const end = exp.whole ? buf.duration : Math.min(buf.duration, Math.max(start + 1, +exp.to));
    const base = audio.name.replace(/\.[^.]+$/, '') + (which === 'studio' ? '_studiya' : which === 'enh' && enhanced ? '_yaxshilangan' : '');
    try {
      setExp((x) => ({ ...x, musicBusy: T.preparing, musicDone: null, error: null }));
      const bytes = fmt === 'wav' ? wavBytes(buf, start, end)
        : await mp3Bytes(buf, start, end, 320, (p) => setExp((x) => x && ({ ...x, musicBusy: `${T.preparing} ${Math.round(p * 100)}%` })));
      const saved = await saveAudio(bytes, `${base}.${fmt}`, T.saveAs);
      setExp((x) => x && ({ ...x, musicBusy: null, musicDone: saved }));
    } catch (e) {
      setExp((x) => x && ({ ...x, musicBusy: null, error: String(e.message || e) }));
    }
  }

  const togglePlayRef = useRef(null);
  togglePlayRef.current = () => togglePlay();
  function togglePlay() {
    const el = audioRef.current;
    if (!el || !audio) return;
    studio.resume();
    if (el.paused) { el.play(); setPlaying(true); } else { el.pause(); setPlaying(false); }
  }

  function openExport() {
    if (!audio) { setNotice(T.noAudio); return; }
    audioRef.current?.pause(); setPlaying(false);
    setExp({ quality: '1080p', fps: 30, whole: true, from: 0, to: Math.min(60, Math.floor(audio.analysis.duration)), progress: null, result: null, error: null });
  }

  async function startExport() {
    const [w, h] = dims(s.format, QUALITIES[exp.quality]);
    const start = exp.whole ? 0 : Math.max(0, +exp.from);
    const end = exp.whole ? audio.analysis.duration : Math.min(audio.analysis.duration, Math.max(start + 1, +exp.to));
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const t0 = performance.now();
    setExp((p) => ({ ...p, progress: 0, error: null, result: null }));
    const base = audio.name.replace(/\.[^.]+$/, '');
    const fileName = `${base}_${s.template}_${s.format.replace(':', 'x')}.mp4`;
    // Desktop app: pick the file first, then stream the video straight into it.
    let diskPath = null;
    if (window.desktop?.writeAt) {
      diskPath = await window.desktop.chooseSavePath(fileName, T.saveAs);
      if (!diskPath) { setExp((p) => p && ({ ...p, progress: null })); return; }
    }
    window.__vizExporting = true;
    try {
      await Promise.all([loadFont(s.titleFont), loadFont(s.subFont)]);
      const audioBuffer = await bufferOf(listen);
      const { data } = await exportVideo({
        width: w, height: h, fps: +exp.fps, start, end, options, analysis: audio.analysis, audioBuffer,
        signal: ctrl.signal,
        toDisk: diskPath ? (chunk, position) => window.desktop.writeAt(chunk, position) : null,
        onProgress: (p) => setExp((x) => x && ({ ...x, progress: p, eta: p > 0.02 ? ((performance.now() - t0) / p) * (1 - p) / 1000 : null })),
      });
      let saved;
      if (diskPath) { await window.desktop.finishSave(true); saved = diskPath; }
      else saved = await saveVideo(data, fileName, T.saveAs);
      setExp((p) => p && ({ ...p, progress: null, result: saved || '—' }));
    } catch (e) {
      if (diskPath) await window.desktop.abortSave().catch(() => {});
      if (e.message === 'ABORTED') setExp((p) => p && ({ ...p, progress: null }));
      else setExp((p) => p && ({ ...p, progress: null, error: e.message === 'NO_VIDEO_CODEC' ? T.noCodec : String(e.message || e) }));
    } finally {
      window.__vizExporting = false;
    }
  }

  const dur = audio?.analysis.duration || 0;

  return (
    <div className="app">
      <aside className="panel">
        <header className="brand">
          <div className="logo-mark" />
          <h1>{T.appName}</h1>
          <select className="lang" value={lang} onChange={(e) => setLang(e.target.value)} aria-label={T.language}>
            <option value="uz">O‘zbekcha</option>
            <option value="ru">Русский</option>
          </select>
        </header>

        <Section id="music" title={T.music}>
          <label className="drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); onAudioFile(e.dataTransfer.files[0]); }}>
            <input type="file" accept="audio/*" hidden onChange={(e) => { onAudioFile(e.target.files[0]); e.target.value = ''; }} />
            <strong>{audio ? audio.name : T.chooseAudio}</strong>
            <span>{audio ? `${fmtTime(dur)} · ${T.bpm} ${audio.analysis.deep?.bpm ?? audio.analysis.bpm} BPM · ${audio.analysis.beats.length} ${T.beats}` : T.dropHint}</span>
          </label>
          {audio && (
            <div className="ab-main">
              <span className="sub">{T.soundVersion}</span>
              <div className="seg">
                <button id="listen-orig" className={listen === 'orig' ? 'on' : ''} onClick={() => setListen('orig')} title={T.origHint}>{T.original}</button>
                <button id="listen-enh" className={listen === 'enh' && enhanced ? 'on' : ''} onClick={pickEnhanced} disabled={!!quality.enhancing || quality.status === 'running'}>
                  {T.enhanced}{enhanced ? ` · ${quality.result?.score ?? ''}→${enhanced.score}` : ''}
                </button>
                {(studio.active || listen === 'studio') && (
                  <button id="listen-studio" className={listen === 'studio' ? 'on' : ''} onClick={() => setListen('studio')}>{T.studioBtn}</button>
                )}
              </div>
              {(quality.enhancing || quality.status === 'running') && (
                <div className="ab-progress"><div className="bar"><div style={{ width: `${Math.round((quality.p || 0) * 100)}%` }} /></div><small>{quality.status === 'running' ? T.qualityRunning : `${T.improving} ${Math.round((quality.p || 0) * 100)}%`}</small></div>
              )}
            </div>
          )}
          <button id="algo-btn" className="algo-btn" onClick={() => setAlgoOpen(true)} disabled={!audio}>
            <b>{T.algo}</b>
            <small>{deepStatus.status === 'running' ? `${T.algoRunning} ${Math.round(deepStatus.p * 100)}%`
              : deepStatus.status === 'done' ? T.algoReady : deepStatus.status === 'error' ? T.error : T.algoHint}</small>
          </button>
          <button id="one-btn" className="algo-btn" onClick={() => { setOneOpen(true); if (quality.status === 'idle') runQualityCheck(); }} disabled={!audio}>
            <b>{T.oneBtn}</b>
            <small>{quality.status === 'running' ? T.qualityRunning : quality.result ? `${T.scoreLabel}: ${enhanced ? `${quality.result.score} → ${enhanced.score}` : quality.result.score}` : T.oneHint}{useEnhanced && enhanced ? ` · ${T.enhanced}` : ''}</small>
          </button>
          <button id="studio-btn" className="algo-btn" onClick={() => {
            // the studio starts from what was being listened to: "Yaxshilangan" -> the enhanced music
            if (listen === 'enh' && enhanced) studio.setSource('enh');
            setListen('studio'); studio.resume(); setStudioOpen(true);
          }} disabled={!audio}>
            <b>{T.studioBtn}</b>
            <small>{studio.active ? T.st.active : T.studioHint}</small>
          </button>
        </Section>

        <Section id="template" title={T.template}>
          <button className={`tpl tpl-none ${s.template === 'none' ? 'on' : ''}`} onClick={() => set('template', 'none')}>{T.tplNone}</button>
          <p className="hint">{T.tplOffHint}</p>
          {(() => {
            const pickTpl = (k) => set('template', s.template === k ? 'none' : k);
            const tplBtn = (k) => (
              <button key={k} className={`tpl ${s.template === k ? 'on' : ''}`} onClick={() => pickTpl(k)} title={s.template === k ? T.tplOffHint : ''}>{T.tpl[k]}</button>
            );
            const base = CATEGORIES.find((c) => c.id === 'base');
            const rest = CATEGORIES.filter((c) => c.id !== 'base');
            const inFolder = rest.some((c) => c.items.includes(s.template));
            const count = rest.reduce((n, c) => n + c.items.length, 0);
            return (
              <>
                <div className="tpl-grid">{base.items.map(tplBtn)}</div>
                <button className={`folder ${folderOpen ? 'open' : ''} ${inFolder ? 'has-on' : ''}`} onClick={() => setFolderOpen((v) => !v)} aria-expanded={folderOpen}>
                  <span className="folder-ico" aria-hidden="true">{folderOpen ? '▾' : '▸'}</span>
                  <span>{T.tplFolder} ({count})</span>
                  {inFolder && !folderOpen && <em>{T.tpl[s.template]}</em>}
                </button>
                {folderOpen && (
                  <div className="folder-body">
                    {rest.map((c) => (
                      <div key={c.id} className="cat">
                        <div className="cat-name">{T.cat[c.id]}</div>
                        <div className="tpl-grid">{c.items.map(tplBtn)}</div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            );
          })()}
          <TplSettings T={T} s={s} setS={setS} />
          {SHAPED.includes(s.template) && (
            <div className="seg" style={{ marginTop: 10 }}>
              {[0, 3, 4, 6].map((n) => (
                <button key={n} className={s.shapeSides === n ? 'on' : ''} onClick={() => set('shapeSides', n)}>{T.shapes[n]}</button>
              ))}
            </div>
          )}
        </Section>

        <Section id="background" title={T.background}>
          <div className="bg-pick">
            <label className="btn primary-soft">
              <input id="bg-image-input" type="file" accept="image/*" hidden onChange={(e) => onImage('bgImage', e.target.files[0])} />
              {images.bgImage ? T.changeBgImage : T.addBgImage}
            </label>
            {images.bgImage && <img src={images.bgImage.src} alt="" />}
          </div>
          <div className="seg">
            {[['gradient', T.bgGradient], ['color', T.bgColor], ['image', T.bgImage], ['video', T.bgVideo]].map(([k, l]) => (
              <button key={k} className={s.bgType === k ? 'on' : ''} onClick={() => set('bgType', k)}>{l}</button>
            ))}
          </div>
          {(s.bgType === 'gradient' || s.bgType === 'color') && <Color label={T.bgColor1} value={s.bgColor1} onChange={(v) => set('bgColor1', v)} />}
          {s.bgType === 'gradient' && <Color label={T.bgColor2} value={s.bgColor2} onChange={(v) => set('bgColor2', v)} />}
          {s.bgType === 'image' && !images.bgImage && <p className="hint">{T.noBgImage}</p>}
          {s.bgType === 'image' && images.bgImage && (
            <button onClick={() => { setImages((p) => ({ ...p, bgImage: null })); set('bgType', 'gradient'); }}>{T.remove}</button>
          )}
          {s.bgType === 'video' && (
            <div className="imgpick">
              <label className="btn">
                <input type="file" accept="video/*" hidden onChange={(e) => onVideo(e.target.files[0])} />
                {T.chooseVideo}
              </label>
              {images.bgVideo && <button onClick={() => { images.bgVideo.pause(); setImages((p) => ({ ...p, bgVideo: null })); }}>{T.remove}</button>}
            </div>
          )}
          {(s.bgType === 'image' || s.bgType === 'video') && (
            <>
              <div className="seg">
                {[['cover', T.fit.cover], ['contain', T.fit.contain]].map(([k, l]) => (
                  <button key={k} className={s.bgFit === k ? 'on' : ''} onClick={() => set('bgFit', k)}>{l}</button>
                ))}
              </div>
              <label className="row">{T.bgMotion}
                <select id="bg-motion" value={s.bgMotion} onChange={(e) => set('bgMotion', e.target.value)}>
                  {Object.entries(T.motion).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </label>
              <Range label={T.dim} min={0} max={0.9} step={0.05} value={s.bgDim} onChange={(v) => set('bgDim', v)} />
              <Range label={T.blur} min={0} max={30} step={1} value={s.bgBlur} onChange={(v) => set('bgBlur', v)} />
              <div className="fx">
                <div className="sub">{T.fxTitle}</div>
                <div className="chips">
                  {Object.keys(FX_PRESETS).map((k) => (
                    <button key={k} className={s.fxPreset === k ? 'on' : ''}
                      onClick={() => setS((p) => ({ ...p, ...FX_PRESETS[k], fxPreset: k }))}>{T.fxPresets[k]}</button>
                  ))}
                </div>
                {s.bgType === 'video' && (
                  <label className="row">{T.fxCut}
                    <select id="fx-cut" value={s.fxCut} onChange={(e) => setS((p) => ({ ...p, fxCut: +e.target.value, fxPreset: 'custom' }))}>
                      {[0, 2, 4, 8, 16].map((n) => <option key={n} value={n}>{n ? T.fxCutEvery(n) : T.off}</option>)}
                    </select>
                  </label>
                )}
                {s.bgType === 'video' && <FxRange label={T.fxSpeed} k="fxSpeed" s={s} setS={setS} />}
                <FxRange label={T.fxPunch} k="fxPunch" s={s} setS={setS} />
                <FxRange label={T.fxDuotone} k="fxDuotone" s={s} setS={setS} />
                <FxRange label={T.fxGlitch} k="fxGlitch" s={s} setS={setS} />
                <FxRange label={T.fxVhs} k="fxVhs" s={s} setS={setS} />
              </div>
            </>
          )}
          <div className="sub">{T.cover}</div>
          <ImagePick label={T.chooseImage} img={images.centerImage} T={T} onPick={(f) => onImage('centerImage', f)} onClear={() => setImages((p) => ({ ...p, centerImage: null }))} />
          <p className="hint">{T.dropAnything}</p>
        </Section>

        <Section id="format" title={T.format}>
          <div className="seg">
            {Object.keys(FORMATS).map((f) => (
              <button key={f} className={s.format === f ? 'on' : ''} onClick={() => set('format', f)}>{f}</button>
            ))}
          </div>
        </Section>

        <Section id="text" title={T.text}>
          <input className="txt" placeholder={T.title} value={s.title} onChange={(e) => set('title', e.target.value)} />
          <input className="txt" placeholder={T.subtitle} value={s.subtitle} onChange={(e) => set('subtitle', e.target.value)} />
          <FontPicker id="title-font" label={T.titleFont} value={s.titleFont} onChange={(v) => set('titleFont', v)} T={T} sample={s.title || T.title} />
          <FontPicker id="sub-font" label={T.subFont} value={s.subFont} onChange={(v) => set('subFont', v)} T={T} sample={s.subtitle || T.subtitle} />
          <label className="row">{T.weight}
            <select id="title-weight" value={s.titleWeight} onChange={(e) => set('titleWeight', +e.target.value)}>
              {[300, 400, 500, 600, 700, 800, 900].map((w) => <option key={w} value={w}>{w}</option>)}
            </select>
          </label>
          <Color label={T.textColor} value={s.textColor} onChange={(v) => set('textColor', v)} />
          <Range label={T.textSize} min={30} max={120} step={1} value={s.titleSize} onChange={(v) => set('titleSize', v)} />
          <div className="seg">
            {[['bottom', T.posBottom], ['center', T.posCenter], ['top', T.posTop]].map(([k, l]) => (
              <button key={k} className={s.textPos === k ? 'on' : ''} onClick={() => set('textPos', k)}>{l}</button>
            ))}
          </div>
          <label className="check"><input type="checkbox" checked={s.showTimer} onChange={(e) => set('showTimer', e.target.checked)} /> {T.showTimer}</label>
          <label className="check"><input type="checkbox" checked={s.showProgress} onChange={(e) => set('showProgress', e.target.checked)} /> {T.showProgress}</label>
        </Section>

        <Section id="logo" title={T.logo}>
          <ImagePick label={T.chooseImage} img={images.logo} T={T} onPick={(f) => onImage('logo', f)} onClear={() => setImages((p) => ({ ...p, logo: null }))} />
          {images.logo && (
            <>
              <label className="row">{T.logoPos}
                <select value={s.logoPos} onChange={(e) => set('logoPos', e.target.value)}>
                  {Object.entries(T.pos).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </label>
              <Range label={T.logoScale} min={0.4} max={2.5} step={0.05} value={s.logoScale} onChange={(v) => set('logoScale', v)} />
            </>
          )}
        </Section>
        <Section id="design" title={T.design}>
          <div className="chips theme-chips">
            {Object.entries(THEMES).map(([k, v]) => (
              <button key={k} id={`theme-${k}`} className={theme.preset === k ? 'on' : ''} onClick={() => setTheme({ ...v, preset: k })}>
                <i style={{ background: `linear-gradient(135deg, ${v.accent} 50%, ${v.accent2} 50%)`, borderColor: v.bg }} /> {T.themes[k]}
              </button>
            ))}
          </div>
          {THEME_KEYS.map((k) => (
            <label key={k} className="row">{T.themeKeys[k]}<input id={`theme-c-${k}`} type="color" value={theme[k]} onChange={(e) => setTheme((t) => ({ ...t, [k]: e.target.value, preset: 'custom' }))} /></label>
          ))}
          <button onClick={() => setTheme({ ...THEMES.violet, preset: 'violet' })}>{T.st.resetAll}</button>
        </Section>
      </aside>

      <main className="stage">
        <div className="canvas-wrap" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); onDropFile(e.dataTransfer.files[0]); }} style={{ aspectRatio: `${pw} / ${ph}`, width: `min(100%, calc((100vh - 110px) * ${pw / ph}))`, '--ar': pw / ph }}>
          <canvas ref={canvasRef} width={pw} height={ph} />
          {busy && <div className="busy"><div className="spinner" />{busy}</div>}
          {notice && <button className="notice" onClick={() => setNotice(null)}>{notice}</button>}
        </div>
        <div className="transport">
          <button className="play" onClick={togglePlay} disabled={!audio} aria-label={playing ? T.pause : T.play}>{playing ? '❚❚' : '▶'}</button>
          <span className="time">{fmtTime(time)}</span>
          <input type="range" className="seek" min={0} max={dur || 1} step={0.01} value={time}
            onChange={(e) => { if (audioRef.current) audioRef.current.currentTime = +e.target.value; }} disabled={!audio} />
          <span className="time">{fmtTime(dur)}</span>
          <button className="primary" onClick={openExport}>{T.export}</button>
        </div>
        {audio && <audio ref={audioRef} loop />}
      </main>

      {oneOpen && (
        <OnePanel T={T} hasAudio={!!audio} quality={quality} enhanced={enhanced}
          onCheck={runQualityCheck} onImprove={() => improve()} onRefine={refineActive} onPickVersion={setActiveVersion}
          target={qTarget} setTarget={setQTarget} qSet={qSet} setQSet={setQSet}
          useEnhanced={useEnhanced} setUseEnhanced={setUseEnhanced} qPending={qPending}
          onClose={() => setOneOpen(false)} />
      )}
      {studioOpen && audio && (
        <StudioPanel T={T} studio={studio} playing={playing} onTogglePlay={togglePlay}
          hasEnhanced={!!enhanced} enhancing={!!quality.enhancing} onEnhance={() => improve(qSet, 'base', true)}
          listen={listen} setListen={setListen} onClose={() => setStudioOpen(false)} />
      )}
      {algoOpen && (
        <AlgoPanel T={T} deep={audio?.analysis?.deep} status={deepStatus} audioRef={audioRef} onClose={() => setAlgoOpen(false)} />
      )}
      {exp && (
        <div className="modal-bg">
          <div className="modal">
            <h2>{T.exportTitle}</h2>
            {exp.progress === null && !exp.result && (
              <>
                <label className="row">{T.quality}
                  <select value={exp.quality} onChange={(e) => setExp({ ...exp, quality: e.target.value })}>
                    {Object.keys(QUALITIES).map((q) => { const [w, h] = dims(s.format, QUALITIES[q]); return <option key={q} value={q}>{q} ({w}×{h})</option>; })}
                  </select>
                </label>
                <label className="row">{T.fps}
                  <select value={exp.fps} onChange={(e) => setExp({ ...exp, fps: +e.target.value })}>
                    <option value={30}>30</option><option value={60}>60</option>
                  </select>
                </label>
                <label className="check"><input type="checkbox" checked={exp.whole} onChange={(e) => setExp({ ...exp, whole: e.target.checked })} /> {T.whole} ({fmtTime(dur)})</label>
                {!exp.whole && (
                  <div className="two">
                    <label>{T.from}<input type="number" min={0} max={dur} value={exp.from} onChange={(e) => setExp({ ...exp, from: e.target.value })} /></label>
                    <label>{T.to}<input type="number" min={0} max={dur} value={exp.to} onChange={(e) => setExp({ ...exp, to: e.target.value })} /></label>
                  </div>
                )}
                {exp.error && <p className="err">{T.error} {exp.error}</p>}
                <div className="actions">
                  <button onClick={() => setExp(null)}>{T.close}</button>
                  <button className="primary" onClick={startExport}>{T.start}</button>
                </div>
                <div className="music-dl">
                  <div className="sub">{T.musicOnly}</div>
                  {(enhanced || studio.active) && (
                    <div className="seg">
                      {[['orig', T.original], ...(enhanced ? [['enh', T.enhanced]] : []), ...(studio.active ? [['studio', T.studioBtn]] : [])].map(([k, l]) => (
                        <button key={k} className={(exp.musicWhich || listen) === k ? 'on' : ''} onClick={() => setExp({ ...exp, musicWhich: k })}>{l}</button>
                      ))}
                    </div>
                  )}
                  <div className="q-actions">
                    <button onClick={() => saveMusic('mp3')} disabled={!!exp.musicBusy}>MP3 · 320 kbps</button>
                    <button onClick={() => saveMusic('wav')} disabled={!!exp.musicBusy}>WAV · 16-bit</button>
                    {exp.musicBusy && <span className="hint">{exp.musicBusy}</span>}
                  </div>
                  {exp.musicDone && <p className="ok">{T.done}<br /><code>{exp.musicDone}</code></p>}
                  {!window.desktop && <p className="hint">{T.musicZipNote}</p>}
                </div>
              </>
            )}
            {exp.progress !== null && (
              <>
                <p>{T.rendering} {Math.round(exp.progress * 100)}%{exp.eta ? ` · ${T.eta} ${fmtTime(exp.eta)}` : ''}</p>
                <div className="bar"><div style={{ width: `${exp.progress * 100}%` }} /></div>
                <div className="actions"><button onClick={() => abortRef.current?.abort()}>{T.cancel}</button></div>
              </>
            )}
            {exp.result && (
              <>
                <p className="ok">{T.done}<br /><code>{exp.result}</code></p>
                <div className="actions"><button className="primary" onClick={() => setExp(null)}>{T.close}</button></div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// gentle fake motion while no audio is loaded
function idleFeatures(t) {
  const bands = new Float32Array(64).map((_, i) => 0.25 + 0.2 * Math.sin(t * 2 + i * 0.3) * Math.exp(-i / 50));
  return {
    t, bands, raw: bands, bass: 0.3 + 0.2 * Math.sin(t * 3), bassRaw: 0.3, mid: 0.3, high: 0.2, rms: 0.3, flux: 0,
    lastBeat: null, sinceBeat: 99, bpm: 120, bassWave: () => 0, beatsBetween: () => [], wave: (dt) => 0.3 * Math.sin((t + dt) * 40),
    bandsAt: () => bands, bassAt: () => 0.3, duration: 0,
    deep: false, section: null, recent: () => [],
    kick: Math.max(0, Math.sin(t * 4)) ** 8, snare: Math.max(0, Math.sin(t * 4 + 1.6)) ** 8, hat: 0.3, hatc: 0.3, ohat: 0,
    vocal: 0.3 + 0.2 * Math.sin(t * 0.7), sfx: 0, bassLine: 0.4 + 0.2 * Math.sin(t * 2),
  };
}

// every block of the side panel opens and closes like the template folder; the state is remembered
const OPEN_DEFAULT = { music: true, template: true };
function Section({ id, title, children }) {
  const [open, setOpen] = useState(() => { try { const v = JSON.parse(localStorage.getItem('viz-sections') || '{}'); return v[id] ?? OPEN_DEFAULT[id] ?? false; } catch { return OPEN_DEFAULT[id] ?? false; } });
  const toggle = () => setOpen((o) => {
    try { const v = JSON.parse(localStorage.getItem('viz-sections') || '{}'); v[id] = !o; localStorage.setItem('viz-sections', JSON.stringify(v)); } catch { /* ignore */ }
    return !o;
  });
  return (
    <section className={`sec ${open ? 'open' : ''}`}>
      <h3><button id={`sec-${id}`} className="sec-head" onClick={toggle} aria-expanded={open}><span className="folder-ico" aria-hidden="true">{open ? '▾' : '▸'}</span>{title}</button></h3>
      {open && children}
    </section>
  );
}
function Color({ label, value, onChange }) {
  return <label className="row">{label}<input type="color" value={value} onChange={(e) => onChange(e.target.value)} /></label>;
}
function Range({ label, value, onChange, ...rest }) {
  return (
    <label className="row">{label}
      <span className="rng"><input type="range" value={value} onChange={(e) => onChange(+e.target.value)} {...rest} /><em>{(+value).toFixed(2).replace(/\.?0+$/, '')}</em></span>
    </label>
  );
}
function ImagePick({ label, img, onPick, onClear, T }) {
  return (
    <div className="imgpick">
      <label className="btn">
        <input type="file" accept="image/*" hidden onChange={(e) => onPick(e.target.files[0])} />
        {label}
      </label>
      {img && <><img src={img.src} alt="" /><button onClick={onClear}>{T.remove}</button></>}
    </div>
  );
}

const FCATS = ['s', 'f', 'd', 'h', 'm'];
function FontPicker({ id, label, value, onChange, T, sample }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [cyr, setCyr] = useState(false);
  const [limit, setLimit] = useState(60);
  const list = useMemo(() => {
    const qq = q.trim().toLowerCase();
    return FONTS.filter((f) => (!cat || f[1] === cat) && (!cyr || f[3]) && (!qq || f[0].toLowerCase().includes(qq)));
  }, [q, cat, cyr]);
  const shown = list.slice(0, limit);
  useEffect(() => { if (open) shown.forEach((f) => previewFont(f[0])); }, [open, shown]);
  useEffect(() => { if (value) previewFont(value); }, [value]);
  return (
    <div className="fontpick">
      <div className="row">{label}
        <button id={id} className="font-btn" style={{ fontFamily: `"${value}", sans-serif` }} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {value || '—'} ▾
        </button>
      </div>
      {open && (
        <div className="font-pop">
          <input id={`${id}-search`} className="txt" placeholder={T.search} value={q} onChange={(e) => { setQ(e.target.value); setLimit(60); }} autoFocus />
          <div className="chips">
            <button className={!cat ? 'on' : ''} onClick={() => { setCat(''); setLimit(60); }}>{T.all}</button>
            {FCATS.map((c) => <button key={c} className={cat === c ? 'on' : ''} onClick={() => { setCat(c); setLimit(60); }}>{T.fcat[c]}</button>)}
          </div>
          <label className="check"><input id={`${id}-cyr`} type="checkbox" checked={cyr} onChange={(e) => { setCyr(e.target.checked); setLimit(60); }} /> {T.cyrOnly}</label>
          <div className="font-count">{T.fontsFound} {list.length}</div>
          <div className="font-list">
            {shown.map((f) => (
              <button key={f[0]} className={`font-item ${value === f[0] ? 'on' : ''}`} onClick={() => { onChange(f[0]); setOpen(false); }}>
                <span style={{ fontFamily: `"${f[0]}", sans-serif` }}>{f[0]}</span>
                <small>{T.fcat[f[1]]}{f[3] ? ' · Кир' : ''}</small>
              </button>
            ))}
            {list.length > limit && <button className="more" onClick={() => setLimit((l) => l + 60)}>{T.more} ({list.length - limit})</button>}
          </div>
          <div className="font-sample" style={{ fontFamily: `"${value}", sans-serif` }}>{sample}</div>
        </div>
      )}
    </div>
  );
}

function FxRange({ label, k, s, setS }) {
  return <Range label={label} min={0} max={1} step={0.05} value={s[k]} onChange={(v) => setS((p) => ({ ...p, [k]: v, fxPreset: 'custom' }))} />;
}
