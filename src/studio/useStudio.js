// All studio state in one hook: mixer settings, stems, cleaned / pitch-corrected buffers,
// the live engine and the export render.
import { useEffect, useMemo, useRef, useState } from 'react';
import { StudioEngine, renderStudio } from './engine.js';
import { defaultStudio, isNeutral, smartPlan, CHANNELS } from './smart.js';
import { separateStems } from './separate.js';
import { trackJob, renderPitchJob, denoiseJob, statsJob } from './jobs.js';
import { autoCorrect, scaleOf } from './pitch.js';

export const AUTO_TUNE = { center: 0.9, drift: 0.3, tolerance: 5 };

export function useStudio({ audio, mixBuffer, audioRef, bpm, songKey }) {
  const engineRef = useRef(null);
  if (!engineRef.current) engineRef.current = new StudioEngine();
  const engine = engineRef.current;
  const [st, setSt] = useState(defaultStudio);
  const [stems, setStems] = useState(null);
  const [sep, setSep] = useState({ status: 'idle' });
  const [stats, setStats] = useState({});
  const [cleaned, setCleaned] = useState({}); // ch -> { from, strength, buffer } | { busy }
  const [pitch, setPitch] = useState(null); // { ch, from, track, notes, status, p, tuned, applied, opts }
  const sepJob = useRef(null);
  const songBuf = audio?.buffer || null;

  // new song: start from scratch
  useEffect(() => {
    sepJob.current?.cancel();
    setSt(defaultStudio()); setStems(null); setSep({ status: 'idle' }); setStats({}); setCleaned({}); setPitch(null);
  }, [songBuf]);

  const base = (k) => (k === 'mix' ? mixBuffer : stems?.[k]) || null;
  const cleanFx = (k) => st.ch[k]?.fx.find((f) => f.type === 'clean' && f.on && f.p.strength > 0.01);
  // source before pitch correction
  const preTune = (k) => {
    const b = base(k), cf = cleanFx(k), c = cleaned[k];
    if (b && cf && c?.buffer && c.from === b && c.strength === cf.p.strength) return c.buffer;
    return b;
  };
  const pitchCh = st.stems && stems ? 'vocals' : 'mix';
  const sources = useMemo(() => {
    const out = {};
    for (const k of st.stems && stems ? CHANNELS : ['mix']) {
      const b = preTune(k);
      out[k] = pitch?.applied && pitch.ch === k && pitch.tuned && pitch.from === b ? pitch.tuned : b;
    }
    return out;
  }, [st, stems, mixBuffer, cleaned, pitch]); // eslint-disable-line react-hooks/exhaustive-deps

  const anyClean = (st.stems && stems ? CHANNELS : ['mix']).some((k) => cleanFx(k));
  const active = !!songBuf && !isNeutral(st, { tuned: !!(pitch?.applied && pitch.tuned), cleaned: anyClean });
  const plan = useMemo(() => smartPlan(st, stats, bpm || 120), [st, stats, bpm]);

  // level statistics for the smart mixer
  useEffect(() => {
    let dead = false;
    const want = { mix: mixBuffer, ...(stems ? Object.fromEntries(CHANNELS.map((k) => [k, stems[k]])) : {}) };
    for (const [k, b] of Object.entries(want)) {
      if (!b || stats[k]?.from === b) continue;
      statsJob(b).then((s) => { if (!dead) setStats((x) => ({ ...x, [k]: { ...s, from: b } })); }).catch(() => {});
    }
    return () => { dead = true; };
  }, [mixBuffer, stems]); // eslint-disable-line react-hooks/exhaustive-deps

  // noise reduction runs on the buffer (debounced while the slider moves)
  useEffect(() => {
    const timers = [];
    for (const k of st.stems && stems ? CHANNELS : ['mix']) {
      const cf = cleanFx(k), b = base(k);
      if (!cf || !b) continue;
      const c = cleaned[k];
      if (c && c.from === b && c.strength === cf.p.strength) continue;
      if (c?.busy && c.from === b && c.strength === cf.p.strength) continue;
      timers.push(setTimeout(() => {
        c?.job?.cancel?.();
        const job = denoiseJob(b, cf.p.strength);
        setCleaned((x) => ({ ...x, [k]: { busy: true, from: b, strength: cf.p.strength, job, buffer: x[k]?.buffer, prevFrom: x[k]?.from } }));
        job.then((buffer) => setCleaned((x) => (x[k]?.job === job ? { ...x, [k]: { from: b, strength: cf.p.strength, buffer } } : x))).catch(() => {});
      }, 450));
    }
    return () => timers.forEach(clearTimeout);
  }, [st, stems, mixBuffer]); // eslint-disable-line react-hooks/exhaustive-deps

  // keep the pitch correction in step with its source (e.g. noise reduction changed)
  useEffect(() => {
    if (!pitch?.applied || !pitch.notes || pitch.status === 'rendering') return;
    const b = preTune(pitch.ch);
    if (b && pitch.from !== b) renderTune(pitch.notes, pitch.ch);
  }, [sources]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- engine wiring
  useEffect(() => { engine.attach(audioRef.current); }, [audio, audioRef.current]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { engine.set(st, plan, { bpm: bpm || 120 }); }, [st, plan, bpm]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { engine.setSources(sources); }, [sources]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { engine.enable(active); if (active) engine.set(st, plan, { bpm: bpm || 120 }); }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => engine.enable(false), []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- actions
  function separate(prefer) {
    if (!songBuf) return;
    sepJob.current?.cancel();
    setSep({ status: 'running', stage: 'runtime', p: 0 });
    const job = separateStems(songBuf, (m) => setSep((s) => (s.status === 'running' ? { ...s, ...(m.stage === 'ep' ? { ep: m.ep } : { stage: m.stage, p: m.p, eta: m.eta }) } : s)), { prefer });
    sepJob.current = job;
    const t0 = performance.now();
    job.promise.then((r) => {
      if (sepJob.current !== job) return;
      setStems(r);
      setSep({ status: 'done', ep: r.ep, secs: (performance.now() - t0) / 1000 });
      setSt((s) => ({ ...s, stems: true }));
    }).catch((e) => { if (sepJob.current === job) setSep({ status: e.message === 'ABORTED' ? 'idle' : 'error', msg: e.message }); });
  }
  function cancelSeparate() { sepJob.current?.cancel(); sepJob.current = null; setSep({ status: 'idle' }); }

  const scaleFor = (opts) => (opts.scale === 'chromatic' ? null : opts.scale === 'auto' ? scaleOf(songKey) : scaleOf({ name: opts.scale.split(' ')[0], mode: opts.scale.split(' ')[1] }));

  async function renderTune(notes, ch = pitch?.ch) {
    const src = preTune(ch);
    if (!src || !pitch?.track) return;
    setPitch((p) => ({ ...p, notes, status: 'rendering', p: 0 }));
    try {
      const tuned = await renderPitchJob(src, pitch.track, notes, (q) => setPitch((p) => (p ? { ...p, p: q } : p)));
      setPitch((p) => (p && p.notes === notes ? { ...p, tuned, from: src, status: 'ready', applied: true } : p));
    } catch (e) { setPitch((p) => (p ? { ...p, status: 'error', msg: e.message } : p)); }
  }
  async function detect(opts = { scale: 'auto', ...AUTO_TUNE }, autoFix = true) {
    const ch = pitchCh, src = preTune(ch);
    if (!src) return;
    setPitch({ ch, status: 'tracking', p: 0, opts });
    try {
      const { track, notes } = await trackJob(src, (q) => setPitch((p) => (p ? { ...p, p: q } : p)));
      const fixed = autoFix ? autoCorrect(notes, { scale: scaleFor(opts), ...opts }) : notes;
      setPitch({ ch, track, orig: notes, notes: fixed, status: autoFix ? 'rendering' : 'ready', p: 0, opts, applied: false, from: null });
      if (autoFix) {
        const tuned = await renderPitchJob(src, track, fixed, (q) => setPitch((p) => (p ? { ...p, p: q } : p)));
        setPitch((p) => (p && p.notes === fixed ? { ...p, tuned, from: src, status: 'ready', applied: true } : p));
      }
    } catch (e) { setPitch({ ch, status: 'error', msg: e.message }); }
  }
  function correctAll(opts, ids = null) {
    if (!pitch?.orig) return;
    const sc = scaleFor(opts);
    const fixed = autoCorrect(pitch.orig, { scale: sc, ...opts });
    const notes = pitch.notes.map((n) => (ids && !ids.includes(n.id) ? n : { ...fixed.find((f) => f.id === n.id), gain: n.gain }));
    setPitch((p) => ({ ...p, opts }));
    renderTune(notes);
  }
  function editNotes(notes) { renderTune(notes); }
  function setTuneApplied(v) { setPitch((p) => (p ? { ...p, applied: v } : p)); }

  async function render(onProgress) {
    return renderStudio(st, sources, stats, { bpm: bpm || 120 }, onProgress);
  }

  return {
    st, setSt, stems, sep, separate, cancelSeparate, stats, plan, active, sources, engine,
    cleaned, pitch, pitchCh, detect, correctAll, editNotes, setTuneApplied, render, scaleFor,
    resume: () => engine.resume(),
  };
}
