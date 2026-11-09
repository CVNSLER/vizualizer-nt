// Studio state: mixer + EQ, effects in three modes, the live engine and the export render.
//   orig: effects on the original, then the enhancement on top (with the plan made for the original)
//   enh:  effects on the already enhanced music (live)
//   post: effects first, then a fresh enhancement that analyses the music *with* the effects
import { useEffect, useMemo, useRef, useState } from 'react';
import { StudioEngine, renderStudio, renderFx } from './engine.js';
import { defaultStudio, mixerNeutral, smartPlan } from './smart.js';
import { statsJob } from './jobs.js';
import { toWavUrl } from '../quality/index.js';

const fxKey = (list) => JSON.stringify(list.filter((f) => f.on).map((f) => [f.type, f.p]));

export function useStudio({ audio, audioRef, origBuf, enh, useEnhanced, bpm, enhanceFx, qKey }) {
  const engineRef = useRef(null);
  if (!engineRef.current) { engineRef.current = new StudioEngine(); window.__vizEngine = engineRef.current; } // read by automated checks
  const engine = engineRef.current;
  const [st, setSt] = useState(defaultStudio);
  const [result, setResult] = useState(null); // { mode, key, buffer, url } | { mode, key, busy, p }
  const [stats, setStats] = useState(null);
  const statsFor = useRef(null);
  const songBuf = audio?.buffer || null;

  useEffect(() => { setSt((s) => ({ ...defaultStudio(), master: s.master })); setResult(null); }, [songBuf]);

  const mode = st.fxMode;
  const list = st.fx[mode];
  const hasFx = list.some((f) => f.on);
  const key = `${mode}|${fxKey(list)}|${mode === 'enh' ? '' : qKey}`;
  const fresh = !!(result && !result.busy && result.key === key);
  const liveFx = useMemo(() => (hasFx && (mode === 'enh' || !fresh) ? list : []), [hasFx, mode, fresh, list]);

  const srcUrl = !audio || !hasFx ? null
    : mode === 'enh' ? (enh ? enh.url : audio.url)
      : fresh ? result.url : audio.url;
  const baseBuffer = !origBuf ? null
    : !hasFx ? (useEnhanced && enh ? enh.buffer : origBuf)
      : mode === 'enh' ? (enh ? enh.buffer : origBuf)
        : fresh ? result.buffer : origBuf;
  const active = !!audio && (hasFx || !mixerNeutral(st));

  // level statistics of what is playing, for the smart mixer
  useEffect(() => {
    if (!baseBuffer || statsFor.current === baseBuffer) return;
    statsFor.current = baseBuffer;
    statsJob(baseBuffer).then((s) => { if (statsFor.current === baseBuffer) setStats(s); }).catch(() => {});
  }, [baseBuffer]);

  const plan = useMemo(() => smartPlan(st, stats, bpm || 120, liveFx), [st, stats, bpm, liveFx]);

  useEffect(() => {
    if (active && !engine.attached) engine.attach(audioRef.current);
    engine.set(st, liveFx, plan, { bpm: bpm || 120 });
  }, [active, st, plan, liveFx, bpm, audio]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- effects + enhancement (panels 1 and 3)
  const jobRef = useRef(0);
  async function apply() {
    if (!origBuf || mode === 'enh' || !hasFx) return null;
    const id = ++jobRef.current;
    const myKey = key;
    setResult({ mode, key: myKey, busy: true, p: 0 });
    try {
      const fxBuf = await renderFx(origBuf, list, { bpm: bpm || 120 });
      if (id !== jobRef.current) return null;
      setResult((r) => r && { ...r, p: 0.1 });
      const r = await enhanceFx(fxBuf, mode === 'post' ? 'fresh' : 'reuse', (p) => setResult((x) => (x && x.busy ? { ...x, p: 0.1 + p * 0.9 } : x)));
      if (id !== jobRef.current) return null;
      const res = { mode, key: myKey, buffer: r.buffer, url: toWavUrl(r.buffer), score: r.score };
      setResult((old) => { if (old?.url) URL.revokeObjectURL(old.url); return res; });
      return res;
    } catch (e) {
      if (id === jobRef.current) setResult({ mode, key: myKey, error: e.message });
      return null;
    }
  }

  /** What the user hears, rendered offline for the export (null = use the plain music). */
  async function render(onProgress) {
    if (!active) return null;
    let base = baseBuffer, fx = liveFx;
    if (hasFx && mode !== 'enh' && !fresh) {
      const r = await apply();
      if (r) { base = r.buffer; fx = []; }
    }
    const s = base === baseBuffer && stats ? stats : await statsJob(base);
    return renderStudio(base, st, fx, s, { bpm: bpm || 120 }, onProgress);
  }

  return {
    st, setSt, stats, plan, active, engine, srcUrl, hasFx, mode, fresh, result, apply, render,
    resume: () => { if (active && !engine.attached) engine.attach(audioRef.current); engine.resume(); },
  };
}
