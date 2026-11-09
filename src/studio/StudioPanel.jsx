import { useEffect, useRef, useState } from 'react';
import { FX_ORDER, FX_PARAMS, FX_PRESETS, makeFx } from './fx.js';
import { defaultStudio, EQ_DEFAULT, FX_MODES } from './smart.js';

const fmtDb = (v) => `${v > 0 ? '+' : ''}${(Math.round(v * 10) / 10).toFixed(1)} dB`;
const DELAY_MS = 3000; // fader moves are applied 3 s after the last change

export default function StudioPanel({ T, studio, playing, onTogglePlay, hasEnhanced, enhancing, onEnhance, listen, setListen, onClose }) {
  const S = T.st;
  const [tab, setTab] = useState('mixer');
  return (
    <div className="modal-bg studio-bg" onPointerDown={() => studio.resume()}>
      <div className="modal studio" role="dialog" aria-label={S.title}>
        <div className="algo-head">
          <h2>{S.title}</h2>
          <div className="studio-head-r">
            <button className="play small" onClick={onTogglePlay} aria-label="play">{playing ? '❚❚' : '▶'}</button>
            <div className="seg ab-studio">
              <button id="studio-ab-orig" className={listen === 'orig' ? 'on' : ''} onClick={() => setListen('orig')}>{T.original}</button>
              {hasEnhanced && <button id="studio-ab-enh" className={listen === 'enh' ? 'on' : ''} onClick={() => setListen('enh')}>{T.enhanced}</button>}
              <button id="studio-ab-studio" className={listen === 'studio' ? 'on' : ''} onClick={() => setListen('studio')}>{T.studioBtn}</button>
            </div>
            <span className={`studio-state ${studio.active && listen === 'studio' ? 'on' : ''}`}>{listen !== 'studio' ? S.listenOrig : studio.active ? S.active : S.inactive}</span>
            <button onClick={() => studio.setSt(defaultStudio())}>{S.resetAll}</button>
            <button onClick={onClose}>{T.close}</button>
          </div>
        </div>
        <div className="studio-source">
          <span>{S.source}</span>
          <div className="seg">
            <button id="src-orig" className={studio.source === 'orig' ? 'on' : ''} onClick={() => { studio.setSource('orig'); setListen('studio'); }}>{T.original}</button>
            <button id="src-enh" className={studio.source === 'enh' ? 'on' : ''} onClick={() => { studio.setSource('enh'); setListen('studio'); if (!hasEnhanced) onEnhance(); }} disabled={enhancing}>
              {enhancing && studio.source === 'enh' && !hasEnhanced ? S.enhancing : T.enhanced}
            </button>
          </div>
          <small className="hint">{studio.source === 'enh' ? (hasEnhanced ? S.sourceEnh : S.needEnhanced) : S.sourceOrig}</small>
        </div>
        <div className="seg studio-tabs">
          {Object.entries(S.tabs).map(([k, l]) => <button key={k} id={`studio-tab-${k}`} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
        </div>
        {tab === 'mixer' && <MixerTab S={S} studio={studio} />}
        {tab === 'fx' && <FxTab S={S} studio={studio} hasEnhanced={hasEnhanced} enhancing={enhancing} onEnhance={onEnhance} />}
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
        if (x) { hold = { l: Math.max(x.l, hold.l - 1.2), r: Math.max(x.r, hold.r - 1.2) }; setM({ ...x, hl: hold.l, hr: hold.r }); }
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
  return <div className="meter"><div style={{ height: `${pct}%`, background: db > -1.5 ? '#ff6b6b' : db > -9 ? '#ffd166' : 'var(--accent2)' }} /></div>;
}

/** Vertical fader in 0.1 dB steps; the value is handed over 3 s after the last move. */
function Fader({ id, value, onCommit, label, S }) {
  const [v, setV] = useState(value);
  const [left, setLeft] = useState(0);
  const timer = useRef(null), tick = useRef(null);
  useEffect(() => { if (!timer.current) setV(value); }, [value]);
  useEffect(() => () => { clearTimeout(timer.current); clearInterval(tick.current); }, []);
  const change = (nv) => {
    setV(nv);
    clearTimeout(timer.current); clearInterval(tick.current);
    const until = Date.now() + DELAY_MS;
    setLeft(DELAY_MS);
    tick.current = setInterval(() => setLeft(Math.max(0, until - Date.now())), 100);
    timer.current = setTimeout(() => { clearInterval(tick.current); timer.current = null; setLeft(0); onCommit(nv); }, DELAY_MS);
  };
  return (
    <div className="fader">
      <input id={id} type="range" min={-24} max={12} step={0.1} value={v} aria-label={label}
        onChange={(e) => change(+e.target.value)} onDoubleClick={() => change(0)} />
      <input className="db-in" type="number" min={-24} max={12} step={0.1} value={v} onChange={(e) => change(Math.max(-24, Math.min(12, +e.target.value || 0)))} aria-label={label} />
      <small className={`pending ${left ? 'on' : ''}`}>{left ? `${S.applyIn} ${(left / 1000).toFixed(1)} s` : ' '}</small>
    </div>
  );
}

function MixerTab({ S, studio }) {
  const { st, setSt, plan, engine } = studio;
  const meters = useMeters(engine, studio.active);
  const setMix = (patch) => setSt((s) => ({ ...s, mix: { ...s.mix, ...patch } }));
  const setM = (patch) => setSt((s) => ({ ...s, master: { ...s.master, ...patch } }));
  const playingLevel = meters && Math.max(meters.l, meters.r) > -90;
  return (
    <>
      <div className="mixer-wrap">
        <div className="mixer">
          <div className="strip">
            <div className="strip-name">{S.mixCh}</div>
            <Fader id="fader-mix" S={S} label={S.mixCh} value={st.mix.gain} onCommit={(v) => setMix({ gain: v })} />
            <label className="pan">{S.pan}
              <input type="range" min={-1} max={1} step={0.05} value={st.mix.pan} onChange={(e) => setMix({ pan: +e.target.value })} onDoubleClick={() => setMix({ pan: 0 })} />
            </label>
          </div>
          <div className="strip master">
            <div className="strip-name">{S.master}</div>
            <div className="master-row">
              <Fader id="fader-master" S={S} label={S.master} value={st.master.gain} onCommit={(v) => setM({ gain: v })} />
              <div className="meters"><Meter db={meters ? meters.hl : -90} /><Meter db={meters ? meters.hr : -90} /></div>
            </div>
          </div>
        </div>
        <div className="smart">
          <label className="check"><input id="smart-mode" type="checkbox" checked={st.master.smart} onChange={(e) => setM({ smart: e.target.checked })} /> <b>{S.smart}</b></label>
          <p className="hint">{S.smartHint}</p>
          <div id="smart-risk" className={`risk risk-${plan.risk}`}>{S.risk[plan.risk]}</div>
          <div className="smart-nums">
            <span>{S.predicted}: <b>{fmtDb(plan.peakPred)}</b></span>
            {playingLevel && <span>{S.out}: <b>{fmtDb(Math.max(meters.l, meters.r))}</b></span>}
            {playingLevel && <span>{S.reduction}: <b>{fmtDb(meters.comp + meters.lim)}</b></span>}
          </div>
          <ul className="smart-notes">
            {plan.notes.map((n) => <li key={n}>{S.smartNotes[n]}</li>)}
            {plan.lowShelf !== 0 && <li className="dim">≤120 Hz: {fmtDb(plan.lowShelf)} · ≥8 kHz: {fmtDb(plan.highShelf)}</li>}
            {plan.comp && <li className="dim">comp {plan.comp.ratio.toFixed(1)}:1 @ {plan.comp.threshold.toFixed(0)} dB</li>}
          </ul>
        </div>
      </div>
      <ParamEq S={S} studio={studio} />
    </>
  );
}

// ---------------------------------------------------------------- parametric EQ
const F_LO = 20, F_HI = 20000, G_MAX = 18;
const fx2 = (f, W) => (Math.log(f / F_LO) / Math.log(F_HI / F_LO)) * W;
const x2f = (x, W) => F_LO * (F_HI / F_LO) ** Math.max(0, Math.min(1, x / W));
const fmtF = (f) => (f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 1 : 2)}k` : `${Math.round(f)}`);

function ParamEq({ S, studio }) {
  const { st, setSt, engine } = studio;
  const cvs = useRef(null), wrap = useRef(null), drag = useRef(null);
  const [sel, setSel] = useState(3);
  const [hunt, setHunt] = useState(null); // index of the band in "find the bad sound" mode
  const eq = st.eq;
  const setBand = (i, patch) => setSt((s) => ({ ...s, eq: s.eq.map((b, j) => (j === i ? { ...b, ...patch } : b)) }));
  const H = 220;
  const yOf = (g) => H / 2 - (g / G_MAX) * (H / 2 - 10);

  useEffect(() => {
    let raf, freqs = null, lastW = 0, resp = null, respKey = '';
    const draw = () => {
      const c = cvs.current; if (!c) return;
      const W = wrap.current.clientWidth, dpr = window.devicePixelRatio || 1;
      if (c.width !== Math.round(W * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); c.style.width = `${W}px`; c.style.height = `${H}px`; }
      const g = c.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.fillStyle = '#0b0d12'; g.fillRect(0, 0, W, H);
      // grid
      g.font = '10px sans-serif';
      for (const f of [30, 50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
        const x = fx2(f, W); g.fillStyle = '#1d2230'; g.fillRect(x, 0, 1, H); g.fillStyle = '#596075'; g.fillText(fmtF(f), x + 2, H - 4);
      }
      for (const db of [-12, -6, 0, 6, 12]) { const y = yOf(db); g.fillStyle = db ? '#1d2230' : '#2c3242'; g.fillRect(0, y, W, 1); g.fillStyle = '#596075'; g.fillText(`${db > 0 ? '+' : ''}${db}`, 2, y - 2); }
      // live spectrum of the output
      const sp = engine.spectrum();
      if (sp) {
        const { data, fs } = sp, bins = data.length;
        g.beginPath();
        for (let x = 0; x < W; x += 2) {
          const f = x2f(x, W), k = Math.min(bins - 1, Math.round((f / (fs / 2)) * bins));
          const y = H - Math.max(0, Math.min(1, (data[k] + 100) / 80)) * H;
          if (x) g.lineTo(x, y); else g.moveTo(x, y);
        }
        g.lineTo(W, H); g.lineTo(0, H); g.closePath();
        g.fillStyle = 'rgba(124,92,255,.16)'; g.fill();
      }
      // EQ curve
      const k = JSON.stringify([eq, st.autoEq.bands]) + W;
      if (k !== respKey || W !== lastW) {
        freqs = new Float32Array(Math.ceil(W / 2)).map((_, i) => x2f(i * 2, W));
        resp = engine.eqResponse(st, freqs); respKey = k; lastW = W;
      }
      g.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent2') || '#22d3c5';
      g.lineWidth = 2; g.beginPath();
      for (let i = 0; i < resp.length; i++) { const y = yOf(20 * Math.log10(resp[i] + 1e-9)); if (i) g.lineTo(i * 2, y); else g.moveTo(0, y); }
      g.stroke();
      // automatic cuts
      for (const ab of st.autoEq.bands) {
        const x = fx2(ab.f, W), y = yOf(ab.g);
        g.fillStyle = '#ffd166'; g.beginPath(); g.moveTo(x, y - 6); g.lineTo(x + 6, y); g.lineTo(x, y + 6); g.lineTo(x - 6, y); g.closePath(); g.fill();
      }
      // handles
      eq.forEach((b, i) => {
        const x = fx2(b.f, W), y = b.type === 'highpass' ? yOf(0) : yOf(b.on ? b.g : 0);
        g.beginPath(); g.arc(x, y, i === sel ? 8 : 6, 0, Math.PI * 2);
        g.fillStyle = !b.on ? '#3a4155' : i === hunt ? '#ffd166' : i === sel ? '#fff' : '#7c5cff';
        g.fill();
        g.fillStyle = '#0b0d12'; g.font = 'bold 9px sans-serif'; g.fillText(String(i + 1), x - 3, y + 3);
      });
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  });

  const pick = (e) => {
    const r = cvs.current.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, W = r.width;
    let best = -1, bd = 20;
    eq.forEach((b, i) => { const d = Math.hypot(fx2(b.f, W) - x, (b.type === 'highpass' ? yOf(0) : yOf(b.g)) - y); if (d < bd) { bd = d; best = i; } });
    return { best, x, y, W };
  };
  const onDown = (e) => {
    const { best } = pick(e);
    if (best < 0) return;
    setSel(best);
    cvs.current.setPointerCapture(e.pointerId);
    drag.current = best;
    if (!eq[best].on) setBand(best, { on: true });
  };
  const onMove = (e) => {
    const i = drag.current; if (i == null) return;
    const r = cvs.current.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    const f = Math.round(x2f(x, r.width));
    const gdb = Math.round(Math.max(-G_MAX, Math.min(G_MAX, ((H / 2 - y) / (H / 2 - 10)) * G_MAX)) * 10) / 10;
    setBand(i, eq[i].type === 'highpass' || i === hunt ? { f } : { f, g: gdb });
  };
  const onUp = () => { drag.current = null; };
  const onWheel = (e) => {
    const { best } = pick(e); const i = best >= 0 ? best : sel;
    e.preventDefault();
    const q = Math.max(0.2, Math.min(18, eq[i].q * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    setBand(i, { q: Math.round(q * 100) / 100 });
  };
  const toggleHunt = (i) => {
    if (hunt === i) { setBand(i, { g: -4, q: 4 }); setHunt(null); return; }
    setHunt(i); setSel(i);
    setBand(i, { type: 'peaking', on: true, g: 12, q: 7 });
  };
  const b = eq[sel];
  return (
    <div className="peq">
      <div className="peq-head">
        <b>{S.eqTitle}</b>
        <span className="hint">{S.eqHint}</span>
        <button onClick={() => { setHunt(null); setSt((s) => ({ ...s, eq: EQ_DEFAULT.map((x) => ({ ...x })) })); }}>{S.eqFlat}</button>
      </div>
      <div className="peq-canvas" ref={wrap} onWheel={onWheel}>
        <canvas id="peq" ref={cvs} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onDoubleClick={() => setBand(sel, { g: 0 })} />
      </div>
      <div className="peq-bands">
        {eq.map((x, i) => (
          <button key={i} className={`${i === sel ? 'on' : ''} ${x.on ? '' : 'off'}`} onClick={() => setSel(i)}>
            {i + 1} · {fmtF(x.f)}{x.type !== 'highpass' ? ` ${x.g > 0 ? '+' : ''}${x.g.toFixed(1)}` : ''}
          </button>
        ))}
      </div>
      {b && (
        <div className="peq-edit">
          <label className="check"><input type="checkbox" checked={b.on} onChange={(e) => setBand(sel, { on: e.target.checked })} /> {S.eqOn}</label>
          <label className="param">{S.eqType}
            <select value={b.type} onChange={(e) => setBand(sel, { type: e.target.value })}>
              {['highpass', 'lowshelf', 'peaking', 'notch', 'highshelf'].map((t) => <option key={t} value={t}>{S.eqTypes[t]}</option>)}
            </select>
          </label>
          <label className="param">Hz<input type="number" min={20} max={20000} value={Math.round(b.f)} onChange={(e) => setBand(sel, { f: Math.max(20, Math.min(20000, +e.target.value || 20)) })} /></label>
          <label className="param">dB<input type="number" min={-18} max={18} step={0.1} value={b.g} disabled={b.type === 'highpass' || b.type === 'notch'} onChange={(e) => setBand(sel, { g: Math.max(-18, Math.min(18, +e.target.value || 0)) })} /></label>
          <label className="param">Q<input type="number" min={0.2} max={18} step={0.05} value={b.q} onChange={(e) => setBand(sel, { q: Math.max(0.2, Math.min(18, +e.target.value || 1)) })} /></label>
          <button className={hunt === sel ? 'on' : ''} onClick={() => toggleHunt(sel)}>{hunt === sel ? S.huntStop : S.huntStart}</button>
          <button id="eq-auto" className={`auto-btn ${st.autoEq.on ? 'on' : ''}`} onClick={studio.toggleAuto} title={S.autoHint}>
            {studio.autoBusy ? S.autoBusy : st.autoEq.on ? S.autoOn : S.autoOff}
          </button>
        </div>
      )}
      {st.autoEq.bands.length > 0 && (
        <div id="eq-auto-list" className="auto-list">
          <b>{S.autoFound}</b>
          {st.autoEq.bands.map((x) => <span key={x.f}>{fmtF(x.f)} Hz {x.g.toFixed(1)} dB <em>Q {x.q}</em></span>)}
          <button onClick={() => setSt((s) => ({ ...s, autoEq: { on: false, bands: [] } }))}>{S.autoClear}</button>
        </div>
      )}
      {st.autoEq.on && !studio.autoBusy && st.autoEq.bands.length === 0 && st.autoEq.at && <p className="hint okc">{S.autoNone}</p>}
      {hunt != null && <p className="warn">{S.huntHint}</p>}
    </div>
  );
}

// ---------------------------------------------------------------- effects (three panels)
function FxTab({ S, studio, hasEnhanced, enhancing, onEnhance }) {
  const { st, setSt, mode, result, fresh } = studio;
  const list = st.fx[mode];
  const setList = (fn) => setSt((s) => ({ ...s, fx: { ...s.fx, [mode]: fn(s.fx[mode]) } }));
  const presetOn = (k) => list.some((f) => f.preset === k);
  const togglePreset = (k) => setList((l) => (presetOn(k)
    ? l.filter((f) => f.preset !== k)
    : [...l, ...FX_PRESETS[k].map((f) => makeFx(f.type, f.p, k))]));
  const add = (type) => setList((l) => [...l, makeFx(type)]);
  const busy = result?.busy && result.mode === mode;
  return (
    <div className="fxtab">
      <div className="seg fx-modes">
        {FX_MODES.map((m, i) => (
          <button key={m} id={`fx-mode-${m}`} className={mode === m ? 'on' : ''} onClick={() => setSt((s) => ({ ...s, fxMode: m }))}>
            {i + 1} · {S.fxModes[m]}
            {st.fx[m].some((f) => f.on) && <i className="dotmark" />}
          </button>
        ))}
      </div>
      <p className="hint">{S.fxModeHint[mode]}</p>
      {mode === 'enh' && !hasEnhanced && (
        <p className="warn">{S.needEnhanced} <button onClick={onEnhance} disabled={enhancing}>{enhancing ? S.enhancing : S.enhanceNow}</button></p>
      )}
      <div className="sub">{S.presets}</div>
      <div className="chips">
        {Object.keys(FX_PRESETS).map((k) => (
          <button key={k} id={`preset-${k}`} className={presetOn(k) ? 'on' : ''} onClick={() => togglePreset(k)}>{S.presetNames[k]}</button>
        ))}
      </div>
      <select id="fx-add" value="" onChange={(e) => e.target.value && add(e.target.value)}>
        <option value="">{S.addFx}</option>
        {FX_ORDER.map((t) => <option key={t} value={t}>{S.fxNames[t]}</option>)}
      </select>
      {mode !== 'enh' && list.some((f) => f.on) && (
        <div className="apply-row">
          {busy ? (
            <div className="ab-progress"><div className="bar"><div style={{ width: `${Math.round((result.p || 0) * 100)}%` }} /></div><small>{S.applying} {Math.round((result.p || 0) * 100)}%</small></div>
          ) : (
            <>
              <button id="fx-apply" className="primary" onClick={studio.apply}>{fresh ? S.reapply : S.applyEnh}</button>
              <span className={`hint ${fresh ? 'okc' : ''}`}>{fresh ? `${S.applied}${result.score != null ? ` · ${S.score} ${result.score}` : ''}` : S.liveOnly}</span>
            </>
          )}
          {result?.error && result.mode === mode && <span className="err">{result.error}</span>}
        </div>
      )}
      {!list.length && <p className="hint">{S.noFx}</p>}
      <div className="fx-list">
        {list.map((f, i) => (
          <div key={f.id} className={`fxcard ${f.on ? '' : 'off'}`}>
            <div className="fxcard-head">
              <label className="check"><input type="checkbox" checked={f.on} onChange={(e) => setList((l) => l.map((x) => (x.id === f.id ? { ...x, on: e.target.checked } : x)))} /> <b>{S.fxNames[f.type]}</b>{f.preset && <em className="tag">{S.presetNames[f.preset]}</em>}</label>
              <span>
                <button disabled={!i} onClick={() => setList((l) => { const n = [...l]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; return n; })}>↑</button>
                <button disabled={i === list.length - 1} onClick={() => setList((l) => { const n = [...l]; [n[i + 1], n[i]] = [n[i], n[i + 1]]; return n; })}>↓</button>
                <button onClick={() => setList((l) => l.filter((x) => x.id !== f.id))} aria-label="remove">✕</button>
              </span>
            </div>
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
