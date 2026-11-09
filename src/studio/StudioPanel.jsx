import { useEffect, useRef, useState } from 'react';
import { FX, FX_ORDER, FX_PARAMS, FX_PRESETS, makeFx } from './fx.js';
import { CHANNELS, defaultStudio } from './smart.js';
import { NOTE_NAMES, noteName, scaleOf, shiftCurve } from './pitch.js';
import { AUTO_TUNE } from './useStudio.js';
import { MODEL_URL, MODEL_BYTES, modelSaved } from './separate.js';

const fmtDb = (v) => `${v > 0 ? '+' : ''}${(Math.round(v * 10) / 10).toFixed(1)} dB`;
const fmtT = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export default function StudioPanel({ T, studio, audioRef, songKey, playing, onTogglePlay, onSaveStem, onClose }) {
  const S = T.st;
  const [tab, setTab] = useState('mixer');
  const [fxTarget, setFxTarget] = useState('master');
  return (
    <div className="modal-bg studio-bg">
      <div className="modal studio" role="dialog" aria-label={S.title}>
        <div className="algo-head">
          <h2>{S.title}</h2>
          <div className="studio-head-r">
            <button className="play small" onClick={onTogglePlay} aria-label="play">{playing ? '❚❚' : '▶'}</button>
            <span className={`studio-state ${studio.active ? 'on' : ''}`}>{studio.active ? S.active : S.inactive}</span>
            <button onClick={() => studio.setSt(defaultStudio())}>{S.resetAll}</button>
            <button onClick={onClose}>{T.close}</button>
          </div>
        </div>
        <div className="seg studio-tabs">
          {Object.entries(S.tabs).map(([k, l]) => <button key={k} id={`studio-tab-${k}`} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
        </div>
        {tab === 'mixer' && <MixerTab S={S} studio={studio} openFx={(k) => { setFxTarget(k); setTab('fx'); }} goVocal={() => setTab('vocal')} />}
        {tab === 'fx' && <FxTab S={S} studio={studio} target={fxTarget} setTarget={setFxTarget} />}
        {tab === 'notes' && <NotesTab S={S} studio={studio} audioRef={audioRef} songKey={songKey} goVocal={() => setTab('vocal')} />}
        {tab === 'vocal' && <VocalTab S={S} studio={studio} onSaveStem={onSaveStem} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- mixer
function useMeters(engine, on) {
  const [m, setM] = useState(null);
  useEffect(() => {
    if (!on) { setM(null); return undefined; }
    let raf, last = 0, hold = { l: -90, r: -90 };
    const loop = (t) => {
      if (t - last > 60) {
        last = t;
        const x = engine.meters();
        if (x) {
          hold = { l: Math.max(x.l, hold.l - 1.2), r: Math.max(x.r, hold.r - 1.2) };
          setM({ ...x, hl: hold.l, hr: hold.r });
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [engine, on]);
  return m;
}

function Meter({ db }) {
  const pct = Math.max(0, Math.min(100, ((db + 48) / 48) * 100));
  return <div className="meter"><div style={{ height: `${pct}%`, background: db > -1.5 ? '#ff6b6b' : db > -9 ? '#ffd166' : '#22d3c5' }} /></div>;
}

function Fader({ id, value, min = -24, max = 12, onChange, label }) {
  return (
    <div className="fader">
      <input id={id} type="range" min={min} max={max} step={0.5} value={value} aria-label={label}
        onChange={(e) => onChange(+e.target.value)} onDoubleClick={() => onChange(0)} />
      <em>{fmtDb(value)}</em>
    </div>
  );
}

function MixerTab({ S, studio, openFx, goVocal }) {
  const { st, setSt, plan, stems, engine } = studio;
  const meters = useMeters(engine, studio.active);
  const setCh = (k, patch) => setSt((s) => ({ ...s, ch: { ...s.ch, [k]: { ...s.ch[k], ...patch } } }));
  const setM = (patch) => setSt((s) => ({ ...s, master: { ...s.master, ...patch } }));
  const chans = st.stems && stems ? CHANNELS : ['mix'];
  return (
    <div className="mixer-wrap">
      <div className="mixer">
        {chans.map((k) => {
          const c = st.ch[k];
          return (
            <div key={k} className={`strip ${c.mute ? 'muted' : ''}`}>
              <div className="strip-name">{S.ch[k]}</div>
              <Fader id={`fader-${k}`} label={S.ch[k]} value={c.gain} onChange={(v) => setCh(k, { gain: v })} />
              <label className="pan">{S.pan}
                <input type="range" min={-1} max={1} step={0.05} value={c.pan} onChange={(e) => setCh(k, { pan: +e.target.value })} onDoubleClick={() => setCh(k, { pan: 0 })} />
              </label>
              <div className="ms">
                <button className={c.mute ? 'on mute' : ''} onClick={() => setCh(k, { mute: !c.mute })}>M</button>
                <button className={c.solo ? 'on solo' : ''} onClick={() => setCh(k, { solo: !c.solo })}>S</button>
              </div>
              <button className="fxbtn" onClick={() => openFx(k)}>{c.fx.filter((f) => f.on).length} {S.fxCount}</button>
            </div>
          );
        })}
        <div className="strip master">
          <div className="strip-name">{S.master}</div>
          <div className="master-row">
            <Fader id="fader-master" label={S.master} value={st.master.gain} onChange={(v) => setM({ gain: v })} />
            <div className="meters">
              <Meter db={meters ? meters.hl : -90} /><Meter db={meters ? meters.hr : -90} />
            </div>
          </div>
          <button className="fxbtn" onClick={() => openFx('master')}>{st.master.fx.filter((f) => f.on).length} {S.fxCount}</button>
        </div>
      </div>

      <div className="smart">
        <label className="check"><input id="smart-mode" type="checkbox" checked={st.master.smart} onChange={(e) => setM({ smart: e.target.checked })} /> <b>{S.smart}</b></label>
        <p className="hint">{S.smartHint}</p>
        <div id="smart-risk" className={`risk risk-${plan.risk}`}>{S.risk[plan.risk]}</div>
        <div className="smart-nums">
          <span>{S.predicted}: <b>{fmtDb(plan.peakPred)}</b></span>
          {meters && Math.max(meters.l, meters.r) > -90 && <span>{S.out}: <b>{fmtDb(Math.max(meters.l, meters.r))}</b></span>}
          {meters && Math.max(meters.l, meters.r) > -90 && <span>{S.reduction}: <b>{fmtDb(meters.comp + meters.lim)}</b></span>}
        </div>
        <ul className="smart-notes">
          {plan.notes.map((n) => <li key={n}>{S.smartNotes[n]}</li>)}
          {plan.lowShelf !== 0 && <li className="dim">≤120 Hz: {fmtDb(plan.lowShelf)} · ≥8 kHz: {fmtDb(plan.highShelf)}</li>}
          {plan.comp && <li className="dim">comp {plan.comp.ratio.toFixed(1)}:1 @ {plan.comp.threshold.toFixed(0)} dB</li>}
        </ul>
        {stems ? (
          <label className="check"><input type="checkbox" checked={st.stems} onChange={(e) => setSt((s) => ({ ...s, stems: e.target.checked }))} /> {S.useStems}</label>
        ) : (
          <p className="hint">{S.needStems} <button className="link" onClick={goVocal}>{S.tabs.vocal} →</button></p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- effects
function FxTab({ S, studio, target, setTarget }) {
  const { st, setSt, stems, cleaned } = studio;
  const chans = st.stems && stems ? CHANNELS : ['mix'];
  const tgt = target === 'master' || chans.includes(target) ? target : 'master';
  const list = tgt === 'master' ? st.master.fx : st.ch[tgt].fx;
  const setList = (fn) => setSt((s) => (tgt === 'master'
    ? { ...s, master: { ...s.master, fx: fn(s.master.fx) } }
    : { ...s, ch: { ...s.ch, [tgt]: { ...s.ch[tgt], fx: fn(s.ch[tgt].fx) } } }));
  const types = FX_ORDER.filter((t) => !(tgt === 'master' && t === 'clean'));
  const add = (type, p) => setList((l) => {
    const n = [...l, makeFx(type, p)];
    return n.sort((a, b) => FX_ORDER.indexOf(a.type) - FX_ORDER.indexOf(b.type));
  });
  const cl = cleaned[tgt];
  return (
    <div className="fxtab">
      <div className="row"><span>{S.target}</span>
        <div className="seg">
          {['master', ...chans].map((k) => <button key={k} className={tgt === k ? 'on' : ''} onClick={() => setTarget(k)}>{k === 'master' ? S.master : S.ch[k]}</button>)}
        </div>
      </div>
      <div className="sub">{S.presets}</div>
      <div className="chips">
        {Object.keys(FX_PRESETS).map((k) => (
          <button key={k} id={`preset-${k}`} onClick={() => setList(() => FX_PRESETS[k].filter((f) => !(tgt === 'master' && f.type === 'clean')).map((f) => makeFx(f.type, f.p)))}>{S.presetNames[k]}</button>
        ))}
      </div>
      <select id="fx-add" value="" onChange={(e) => e.target.value && add(e.target.value)}>
        <option value="">{S.addFx}</option>
        {types.map((t) => <option key={t} value={t}>{S.fxNames[t]}</option>)}
      </select>
      {tgt === 'master' && <p className="hint">{S.masterNoClean}</p>}
      {!list.length && <p className="hint">{S.noFx}</p>}
      <div className="fx-list">
        {list.map((f, i) => (
          <div key={f.id} className={`fxcard ${f.on ? '' : 'off'}`}>
            <div className="fxcard-head">
              <label className="check"><input type="checkbox" checked={f.on} onChange={(e) => setList((l) => l.map((x) => (x.id === f.id ? { ...x, on: e.target.checked } : x)))} /> <b>{S.fxNames[f.type]}</b></label>
              <span>
                <button disabled={!i} onClick={() => setList((l) => { const n = [...l]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; return n; })}>↑</button>
                <button disabled={i === list.length - 1} onClick={() => setList((l) => { const n = [...l]; [n[i + 1], n[i]] = [n[i], n[i + 1]]; return n; })}>↓</button>
                <button onClick={() => setList((l) => l.filter((x) => x.id !== f.id))} aria-label="remove">✕</button>
              </span>
            </div>
            {f.type === 'clean' && <p className="hint">{S.cleanNote}{cl?.busy ? ` · ${S.cleaning}` : ''}</p>}
            <div className="params">
              {FX_PARAMS[f.type].map((d) => (
                <Param key={d[0]} S={S} d={d} value={f.p[d[0]]} hidden={f.type === 'delay' && d[0] === 'ms' && f.p.sync !== 'ms'}
                  onChange={(v) => setList((l) => l.map((x) => (x.id === f.id ? { ...x, p: { ...x.p, [d[0]]: v } } : x)))} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Param({ S, d, value, onChange, hidden }) {
  const [k, kind, a, b, step, unit] = d;
  if (hidden) return null;
  if (kind === 'b') return <label className="check param"><input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} /> {S.p[k]}</label>;
  if (kind === 's') {
    return (
      <label className="param">{S.p[k]}
        <select value={value} onChange={(e) => onChange(typeof a[0] === 'number' ? +e.target.value : e.target.value)}>
          {a.map((o) => <option key={o} value={o}>{S.opt[o] ?? o}</option>)}
        </select>
      </label>
    );
  }
  const log = kind === 'log';
  const toPos = (v) => (log ? Math.log(v / a) / Math.log(b / a) : (v - a) / (b - a));
  const fromPos = (p) => { const v = log ? a * (b / a) ** p : a + p * (b - a); return Math.round(v / step) * step; };
  const shown = unit === '%' ? `${Math.round(value * 100)}%` : `${+(+value).toFixed(step < 1 ? (step < 0.1 ? 2 : 1) : 0)} ${unit}`;
  return (
    <label className="param">{S.p[k]}
      <span className="rng"><input type="range" min={0} max={1} step={0.001} value={toPos(value)} onChange={(e) => onChange(fromPos(+e.target.value))} /><em>{shown}</em></span>
    </label>
  );
}

// ---------------------------------------------------------------- notes (piano roll)
const SCALE_OPTS = ['auto', 'chromatic', ...NOTE_NAMES.flatMap((n) => [`${n} major`, `${n} minor`])];

function NotesTab({ S, studio, audioRef, songKey, goVocal }) {
  const { pitch, pitchCh, stems } = studio;
  const [opts, setOpts] = useState(() => pitch?.opts || { scale: 'auto', ...AUTO_TUNE });
  const [sel, setSel] = useState([]);
  const busy = pitch && (pitch.status === 'tracking' || pitch.status === 'rendering');
  const notes = pitch?.notes || [];
  const scale = studio.scaleFor(opts);
  const keyName = songKey ? `${songKey.name} ${S[songKey.mode] || songKey.mode}` : '—';
  const avg = (list, f) => (list.length ? Math.round(list.reduce((s, n) => s + Math.abs(f(n)), 0) / list.length) : 0);
  const selNotes = notes.filter((n) => sel.includes(n.id));
  const updSel = (patch) => studio.editNotes(notes.map((n) => (sel.includes(n.id) ? { ...n, ...patch } : n)));
  return (
    <div className="notes-tab">
      <p className="hint">{S.notesIntro}</p>
      <div className="row"><span>{S.notesOn}: <b>{S.ch[pitchCh]}</b></span></div>
      {pitchCh === 'mix' && <p className="warn">{S.notesOnMix} {!stems && <button className="link" onClick={goVocal}>{S.tabs.vocal} →</button>}</p>}
      <div className="notes-ctl">
        <label className="param">{S.scale}
          <select id="tune-scale" value={opts.scale} onChange={(e) => setOpts({ ...opts, scale: e.target.value })}>
            {SCALE_OPTS.map((o) => <option key={o} value={o}>{o === 'auto' ? `${S.scaleAuto} (${keyName})` : o === 'chromatic' ? S.chromatic : o.replace('major', S.major).replace('minor', S.minor)}</option>)}
          </select>
        </label>
        <label className="param">{S.center}<span className="rng"><input type="range" min={0} max={1} step={0.05} value={opts.center} onChange={(e) => setOpts({ ...opts, center: +e.target.value })} /><em>{Math.round(opts.center * 100)}%</em></span></label>
        <label className="param">{S.drift}<span className="rng"><input type="range" min={0} max={1} step={0.05} value={opts.drift} onChange={(e) => setOpts({ ...opts, drift: +e.target.value })} /><em>{Math.round(opts.drift * 100)}%</em></span></label>
        <label className="param">{S.tolerance}<span className="rng"><input type="range" min={0} max={40} step={1} value={opts.tolerance} onChange={(e) => setOpts({ ...opts, tolerance: +e.target.value })} /><em>{opts.tolerance} {S.cents}</em></span></label>
      </div>
      <div className="q-actions">
        <button id="tune-detect" className="primary" disabled={busy} onClick={() => { setSel([]); studio.detect(opts, true); }}>{S.detect}</button>
        <button disabled={busy} onClick={() => { setSel([]); studio.detect(opts, false); }}>{S.detectOnly}</button>
        {pitch?.orig && <button id="tune-correct" disabled={busy} onClick={() => studio.correctAll(opts, sel.length ? sel : null)}>{sel.length ? S.correctSel : S.correctAll}</button>}
        {pitch?.orig && <button disabled={busy} onClick={() => studio.editNotes(notes.map((n) => (!sel.length || sel.includes(n.id) ? { ...n, target: n.center, keep: 1, gain: 0 } : n)))}>{sel.length ? S.resetSel : S.resetNotes}</button>}
        {pitch?.tuned && (
          <div className="seg ab">
            <button className={!pitch.applied ? 'on' : ''} onClick={() => studio.setTuneApplied(false)}>{S.original}</button>
            <button className={pitch.applied ? 'on' : ''} onClick={() => studio.setTuneApplied(true)}>{S.tuned}</button>
          </div>
        )}
      </div>
      {busy && <div className="ab-progress"><div className="bar"><div style={{ width: `${Math.round((pitch.p || 0) * 100)}%` }} /></div><small>{pitch.status === 'tracking' ? S.tracking : S.rendering} {Math.round((pitch.p || 0) * 100)}%</small></div>}
      {pitch?.status === 'error' && <p className="err">{pitch.msg}</p>}
      {pitch?.orig && (
        <p id="tune-summary" className="hint">
          {notes.length} {S.notesFound} · {S.avgOff}: {avg(pitch.orig, (n) => (n.center - Math.round(n.center)) * 100)} {S.cents} → {S.after}: {avg(notes, (n) => (n.target - Math.round(n.target)) * 100)} {S.cents}
        </p>
      )}
      {pitch?.track && <PianoRoll S={S} track={pitch.track} notes={notes} sel={sel} setSel={setSel} scale={scale} audioRef={audioRef} onChange={studio.editNotes} />}
      {selNotes.length > 0 && (
        <div className="notes-sel">
          <b>{S.selNote}: {selNotes.length === 1 ? `${noteName(selNotes[0].target)} (${noteName(selNotes[0].center)} ${Math.round((selNotes[0].center - Math.round(selNotes[0].center)) * 100)}c)` : selNotes.length}</b>
          <label className="param">{S.noteKeep}<span className="rng"><input type="range" min={0} max={1} step={0.05} value={selNotes[0].keep} onChange={(e) => updSel({ keep: +e.target.value })} /><em>{Math.round(selNotes[0].keep * 100)}%</em></span></label>
          <label className="param">{S.noteGain}<span className="rng"><input type="range" min={-12} max={6} step={0.5} value={selNotes[0].gain} onChange={(e) => updSel({ gain: +e.target.value })} /><em>{fmtDb(selNotes[0].gain)}</em></span></label>
        </div>
      )}
      {pitch?.track && <p className="hint">{S.rollHelp}</p>}
    </div>
  );
}

const ROW = 14, KEYS_W = 44;
function PianoRoll({ S, track, notes, sel, setSel, scale, audioRef, onChange }) {
  const cvs = useRef(null), wrap = useRef(null);
  const [view, setView] = useState(() => {
    const c = notes.map((n) => n.center);
    const lo = Math.floor(Math.min(...(c.length ? c : [55]))) - 4, hi = Math.ceil(Math.max(...(c.length ? c : [72]))) + 4;
    return { t0: 0, pps: 60, lo, hi };
  });
  const [follow, setFollow] = useState(true);
  const drag = useRef(null);
  const [local, setLocal] = useState(null); // notes while dragging (rendered on drop)
  const shown = local || notes;
  const curve = useRef(null);
  useEffect(() => { curve.current = shiftCurve(track, shown); }, [track, shown]);
  const rows = view.hi - view.lo + 1;
  const H = rows * ROW;
  const yOf = (m) => (view.hi - m + 0.5) * ROW;
  const xOf = (t) => KEYS_W + (t - view.t0) * view.pps;
  const tOf = (x) => (x - KEYS_W) / view.pps + view.t0;
  const tFrame = (i) => i * track.hop + track.offset;

  useEffect(() => {
    let raf;
    const draw = () => {
      const c = cvs.current; if (!c) return;
      const W = wrap.current.clientWidth;
      const dpr = window.devicePixelRatio || 1;
      if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); c.style.width = `${W}px`; c.style.height = `${H}px`; }
      const g = c.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.fillStyle = '#10131a'; g.fillRect(0, 0, W, H);
      for (let m = view.lo; m <= view.hi; m++) {
        const pc = ((m % 12) + 12) % 12, y = yOf(m) - ROW / 2;
        const black = [1, 3, 6, 8, 10].includes(pc);
        const inScale = !scale || scale.includes(pc);
        g.fillStyle = inScale ? (black ? '#171b25' : '#1b2030') : '#0c0e13';
        g.fillRect(KEYS_W, y, W - KEYS_W, ROW);
        g.fillStyle = black ? '#2a2f3c' : '#d9dce4';
        g.fillRect(0, y, KEYS_W - 4, ROW - 1);
        if (pc === 0 || ROW >= 14) { g.fillStyle = black ? '#9aa0b0' : '#333'; g.font = '9px sans-serif'; g.fillText(noteName(m), 3, y + ROW - 4); }
        if (pc === 0) { g.fillStyle = '#2c3242'; g.fillRect(KEYS_W, y + ROW - 1, W - KEYS_W, 1); }
      }
      // seconds grid
      g.fillStyle = '#252a37'; g.font = '10px sans-serif';
      for (let s = Math.ceil(view.t0); xOf(s) < W; s++) { const x = xOf(s); g.fillRect(x, 0, 1, H); g.fillStyle = '#5b6275'; g.fillText(fmtT(s), x + 3, 10); g.fillStyle = '#252a37'; }
      // notes (blobs)
      const sh = curve.current?.shift;
      for (const n of shown) {
        const x0 = xOf(tFrame(n.i0)), x1 = xOf(tFrame(n.i1));
        if (x1 < KEYS_W || x0 > W) continue;
        const moved = Math.abs(n.target - n.center) > 0.01;
        const y = yOf(n.target);
        g.fillStyle = sel.includes(n.id) ? 'rgba(255,190,90,.85)' : moved ? 'rgba(124,92,255,.75)' : 'rgba(34,211,197,.55)';
        const r = 5;
        g.beginPath(); g.roundRect ? g.roundRect(x0, y - ROW * 0.42, Math.max(3, x1 - x0), ROW * 0.84, r) : g.rect(x0, y - ROW * 0.42, Math.max(3, x1 - x0), ROW * 0.84); g.fill();
        if (sel.includes(n.id)) { g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.stroke(); }
      }
      // pitch curves: original (faint) and result (bright)
      const step = Math.max(1, Math.floor(1 / (view.pps * track.hop * 2)));
      for (const [mode, col] of [[0, 'rgba(255,255,255,.25)'], [1, '#fff']]) {
        g.strokeStyle = col; g.lineWidth = mode ? 1.4 : 1; g.beginPath();
        let pen = false;
        const i0 = Math.max(0, Math.floor((view.t0 - track.offset) / track.hop)), i1 = Math.min(track.midi.length, Math.ceil((tOf(W) - track.offset) / track.hop));
        for (let i = i0; i < i1; i += step) {
          const m = track.midi[i];
          if (Number.isNaN(m)) { pen = false; continue; }
          const v = m + (mode && sh ? sh[i] : 0);
          const x = xOf(tFrame(i)), y = yOf(v);
          if (pen) g.lineTo(x, y); else g.moveTo(x, y);
          pen = true;
        }
        g.stroke();
      }
      // playhead
      const el = audioRef.current;
      if (el) {
        const t = el.currentTime, x = xOf(t);
        if (follow && !el.paused && (x > W - 40 || x < KEYS_W)) setView((v) => ({ ...v, t0: Math.max(0, t - 1) }));
        g.fillStyle = '#ff6b6b'; g.fillRect(x, 0, 1.5, H);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  });

  const hit = (e) => {
    const r = cvs.current.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    const t = tOf(x);
    const n = shown.find((q) => t >= tFrame(q.i0) && t <= tFrame(q.i1) && Math.abs(yOf(q.target) - y) < ROW * 0.6);
    return { n, x, y, t };
  };
  const onDown = (e) => {
    const { n, y, t, x } = hit(e);
    if (x < KEYS_W) return;
    if (!n) { setSel([]); if (audioRef.current) audioRef.current.currentTime = Math.max(0, t); return; }
    cvs.current.setPointerCapture(e.pointerId);
    let ids = sel;
    if (e.shiftKey) ids = sel.includes(n.id) ? sel.filter((i) => i !== n.id) : [...sel, n.id];
    else if (!sel.includes(n.id)) ids = [n.id];
    setSel(ids);
    drag.current = { y0: y, ids, start: Object.fromEntries(shown.map((q) => [q.id, q.target])), moved: false };
  };
  const onMove = (e) => {
    const d = drag.current; if (!d) return;
    const { y } = hit(e);
    const dm = (d.y0 - y) / ROW;
    if (Math.abs(dm) < 0.15 && !d.moved) return;
    d.moved = true;
    setLocal(shown.map((q) => {
      if (!d.ids.includes(q.id)) return q;
      const raw = d.start[q.id] + dm;
      const target = e.altKey ? Math.round(raw * 100) / 100 : d.ids.length > 1 ? d.start[q.id] + Math.round(dm) : Math.round(raw);
      return { ...q, target };
    }));
  };
  const onUp = () => {
    const d = drag.current; drag.current = null;
    if (d?.moved && local) { onChange(local); }
    setLocal(null);
  };
  const onDbl = (e) => {
    const { n } = hit(e);
    if (n) onChange(notes.map((q) => (q.id === n.id ? { ...q, target: q.center, keep: 1, gain: 0 } : q)));
  };
  const onWheel = (e) => {
    if (e.ctrlKey) {
      e.preventDefault();
      const k = e.deltaY < 0 ? 1.25 : 0.8;
      setView((v) => ({ ...v, pps: Math.max(8, Math.min(600, v.pps * k)) }));
    } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) {
      setView((v) => ({ ...v, t0: Math.max(0, v.t0 + (e.deltaX || e.deltaY) / v.pps) }));
    } else {
      setView((v) => ({ ...v, t0: Math.max(0, v.t0 + e.deltaY / v.pps) }));
    }
  };
  const onKey = (e) => {
    if (!sel.length) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const d = (e.key === 'ArrowUp' ? 1 : -1) * (e.altKey ? 0.1 : 1);
      onChange(notes.map((q) => (sel.includes(q.id) ? { ...q, target: q.target + d } : q)));
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      onChange(notes.map((q) => (sel.includes(q.id) ? { ...q, target: q.center, keep: 1, gain: 0 } : q)));
    }
  };
  const dur = track.midi.length * track.hop;
  return (
    <div className="roll">
      <div className="roll-bar">
        <button onClick={() => setView((v) => ({ ...v, pps: Math.max(8, v.pps * 0.8) }))}>{S.zoomOut}</button>
        <button onClick={() => setView((v) => ({ ...v, pps: Math.min(600, v.pps * 1.25) }))}>{S.zoomIn}</button>
        <button onClick={() => setView((v) => ({ ...v, hi: v.hi + 2, lo: v.lo + 2 }))}>▲</button>
        <button onClick={() => setView((v) => ({ ...v, hi: v.hi - 2, lo: v.lo - 2 }))}>▼</button>
        <input type="range" className="roll-scroll" min={0} max={Math.max(0, dur - 2)} step={0.05} value={view.t0} onChange={(e) => setView((v) => ({ ...v, t0: +e.target.value }))} />
        <label className="check"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> {S.follow}</label>
      </div>
      <div className="roll-canvas" ref={wrap} tabIndex={0} onKeyDown={onKey} onWheel={onWheel}>
        <canvas id="piano-roll" ref={cvs} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onDoubleClick={onDbl} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- vocal separation
function VocalTab({ S, studio, onSaveStem }) {
  const { sep, stems, st, setSt } = studio;
  const running = sep.status === 'running';
  const [saved, setSaved] = useState(null);
  const [fileErr, setFileErr] = useState(null);
  useEffect(() => { modelSaved().then(setSaved); }, [stems]);
  const dlFailed = sep.status === 'error' && /MODEL_DOWNLOAD/.test(sep.msg || '');
  const pickModel = (f) => {
    setFileErr(null);
    if (!f) return;
    if (f.size !== MODEL_BYTES) { setFileErr(S.modelWrong); return; }
    studio.separate(undefined, f);
  };
  const solo = (k) => setSt((s) => ({ ...s, stems: true, ch: Object.fromEntries(Object.entries(s.ch).map(([n, c]) => [n, { ...c, solo: k ? (k === 'minus' ? false : n === k) : false, mute: k === 'minus' ? n === 'vocals' : false }])) }));
  return (
    <div className="vocal-tab">
      <p className="hint">{S.vocalIntro}</p>
      <p className="hint">{S.vocalQuality}</p>
      <p className="hint">{S.modelNote}</p>
      <div className="q-actions">
        {!running && <button id="sep-run" className="primary" onClick={() => studio.separate()}>{S.separate}</button>}
        {!running && <button onClick={() => studio.separate('wasm')}>{S.cpuOnly}</button>}
        {running && <button onClick={studio.cancelSeparate}>{S.cancel}</button>}
      </div>
      {running && (
        <div className="ab-progress">
          <div className="bar"><div style={{ width: `${Math.round((sep.p || 0) * 100)}%` }} /></div>
          <small>{S.stage[sep.stage] || sep.stage} {Math.round((sep.p || 0) * 100)}%{sep.eta ? ` · ${S.left} ~${fmtT(sep.eta)}` : ''}{sep.ep ? ` · ${S.ep[sep.ep]}` : ''}</small>
        </div>
      )}
      {sep.status === 'error' && <p className="err">{S.sepError} {dlFailed ? S.dlBlocked : sep.msg}</p>}
      {saved === false && !running && (
        <div className={`model-box ${dlFailed ? 'hot' : ''}`}>
          <b>{S.modelManual}</b>
          <ol>
            <li>{S.modelStep1} <a href={MODEL_URL} target="_blank" rel="noreferrer">htdemucs_embedded.onnx</a> (180 MB)</li>
            <li>{S.modelStep2}
              <label className="btn"><input id="model-file" type="file" accept=".onnx" hidden onChange={(e) => pickModel(e.target.files[0])} />{S.modelPick}</label>
            </li>
          </ol>
          <small className="hint">{S.modelStep3}</small>
          <input className="txt" readOnly value={MODEL_URL} onFocus={(e) => e.target.select()} />
          {fileErr && <p className="err">{fileErr}</p>}
        </div>
      )}
      {saved && !stems && !running && <p className="ok">{S.modelReady}</p>}
      {stems && (
        <>
          <p id="sep-done" className="ok">{S.sepDone} · {Math.round(sep.secs || 0)} {S.secs} · {S.ep[stems.ep] || stems.ep}</p>
          <div className="sub">{S.listen}</div>
          <div className="seg">
            <button className={st.stems && st.ch.vocals.solo ? 'on' : ''} onClick={() => solo('vocals')}>{S.onlyVocal}</button>
            <button className={st.stems && st.ch.vocals.mute ? 'on' : ''} onClick={() => solo('minus')}>{S.minus}</button>
            {CHANNELS.filter((k) => k !== 'vocals').map((k) => <button key={k} className={st.stems && st.ch[k].solo ? 'on' : ''} onClick={() => solo(k)}>{S.ch[k]}</button>)}
            <button onClick={() => solo(null)}>{S.all}</button>
          </div>
          <div className="sub">{S.download}</div>
          <div className="q-actions">
            {['vocals', 'minus', 'drums', 'bass', 'other'].map((k) => <button key={k} onClick={() => onSaveStem(k)}>{k === 'vocals' ? S.dlVocal : k === 'minus' ? S.dlMinus : S.ch[k]} · WAV</button>)}
          </div>
        </>
      )}
    </div>
  );
}

export { scaleOf };
