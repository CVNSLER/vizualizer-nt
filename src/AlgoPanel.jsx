import { useEffect, useMemo, useRef, useState } from 'react';

const LANES = [
  { key: 'kick', color: '#ff5a5f' },
  { key: 'snare', color: '#ffa53c' },
  { key: 'hat', color: '#ffe066' },
  { key: 'ohat', color: '#b6f36b' },
  { key: 'vocal', color: '#4cd6ff' },
  { key: 'sfx', color: '#e27bff' },
];
const SECTION_COLORS = {
  intro: '#3d5a80', verse: '#4f6d7a', section: '#5c677d', build: '#c97b2a',
  chorus: '#2a9d8f', drop: '#d1495b', breakdown: '#6c5b7b', outro: '#3d405b',
};
const PX_PER_SEC = 34;
const RULER = 18, SEC_H = 30, LANE_H = 22;

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export default function AlgoPanel({ T, deep, status, audioRef, audition, setAudition, onClose }) {
  const canvasRef = useRef(null);
  const headRef = useRef(null);
  const scrollRef = useRef(null);
  const [follow, setFollow] = useState(true);
  const dur = deep?.duration || 0;
  const W = Math.max(600, Math.ceil(dur * PX_PER_SEC));
  const H = RULER + SEC_H + LANES.length * LANE_H + 6;

  const stats = useMemo(() => {
    if (!deep) return null;
    const vocalSec = deep.vocals.reduce((s, v) => s + (v.t1 - v.t0), 0);
    return {
      kick: deep.events.kick.length, snare: deep.events.snare.length, hat: deep.events.hat.length, ohat: deep.events.ohat.length,
      vocalPct: Math.round((vocalSec / Math.max(1, dur)) * 100), sfx: deep.sfx.length, sections: deep.sections.length,
      bars: deep.downbeats.length,
    };
  }, [deep, dur]);

  // static timeline drawing
  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !deep) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = W * dpr; c.height = H * dpr;
    c.style.width = `${W}px`; c.style.height = `${H}px`;
    const ctx = c.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.fillStyle = '#10131a'; ctx.fillRect(0, 0, W, H);
    // ruler + bar lines
    ctx.fillStyle = '#8a90a2'; ctx.font = '11px "Segoe UI", Arial, sans-serif';
    for (let s = 0; s <= dur; s += 5) {
      const x = s * PX_PER_SEC;
      ctx.fillRect(x, RULER - 6, 1, 6);
      if (s % 10 === 0) ctx.fillText(fmt(s), x + 3, 11);
    }
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    for (const d of deep.downbeats) ctx.fillRect(d * PX_PER_SEC, RULER + SEC_H, 1, H);
    // sections
    for (const s of deep.sections) {
      const x0 = s.t0 * PX_PER_SEC, x1 = s.t1 * PX_PER_SEC;
      ctx.fillStyle = SECTION_COLORS[s.kind] || '#555';
      ctx.globalAlpha = 0.45 + 0.55 * s.energy;
      ctx.fillRect(x0 + 1, RULER + 2, x1 - x0 - 2, SEC_H - 4);
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#fff';
      ctx.font = '600 12px "Segoe UI", Arial, sans-serif';
      ctx.save(); ctx.beginPath(); ctx.rect(x0 + 1, RULER, x1 - x0 - 2, SEC_H); ctx.clip();
      ctx.fillText(`${T.sectionKinds[s.kind] || s.kind} ${s.letter}`, x0 + 6, RULER + 19);
      ctx.restore();
    }
    // lanes
    LANES.forEach((l, i) => {
      const y = RULER + SEC_H + i * LANE_H;
      ctx.fillStyle = i % 2 ? 'rgba(255,255,255,0.025)' : 'rgba(255,255,255,0.05)';
      ctx.fillRect(0, y, W, LANE_H);
      ctx.fillStyle = l.color;
      if (l.key === 'vocal') {
        for (const v of deep.vocals) { ctx.globalAlpha = 0.35 + 0.65 * v.conf; ctx.fillRect(v.t0 * PX_PER_SEC, y + 5, Math.max(2, (v.t1 - v.t0) * PX_PER_SEC), LANE_H - 10); }
      } else if (l.key === 'sfx') {
        for (const s of deep.sfx) {
          const x = s.t0 * PX_PER_SEC, w = Math.max(3, (s.t1 - s.t0) * PX_PER_SEC);
          ctx.globalAlpha = 0.8;
          ctx.beginPath();
          if (s.type === 'riser') { ctx.moveTo(x, y + LANE_H - 4); ctx.lineTo(x + w, y + 4); ctx.lineTo(x + w, y + LANE_H - 4); }
          else if (s.type === 'downlifter') { ctx.moveTo(x, y + 4); ctx.lineTo(x + w, y + LANE_H - 4); ctx.lineTo(x, y + LANE_H - 4); }
          else ctx.rect(x, y + 5, w, LANE_H - 10);
          ctx.fill();
        }
      } else {
        for (const e of deep.events[l.key]) { ctx.globalAlpha = 0.35 + 0.65 * Math.min(1, e.s); ctx.fillRect(e.t * PX_PER_SEC - 1, y + 3, 2.5, LANE_H - 6); }
      }
      ctx.globalAlpha = 1;
    });
  }, [deep, W, H, dur, T]);

  // playhead
  useEffect(() => {
    let raf;
    const loop = () => {
      const t = audioRef.current?.currentTime || 0;
      if (headRef.current) headRef.current.style.transform = `translateX(${t * PX_PER_SEC}px)`;
      const sc = scrollRef.current;
      if (sc && follow && audioRef.current && !audioRef.current.paused) {
        const x = t * PX_PER_SEC;
        if (x < sc.scrollLeft + 40 || x > sc.scrollLeft + sc.clientWidth - 80) sc.scrollLeft = x - 60;
      }
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [audioRef, follow]);

  const seek = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const t = (e.clientX - r.left) / PX_PER_SEC;
    if (audioRef.current) audioRef.current.currentTime = Math.max(0, Math.min(dur, t));
  };

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal algo" onClick={(e) => e.stopPropagation()}>
        <div className="algo-head">
          <h2>{T.algo}</h2>
          <button onClick={onClose}>{T.close}</button>
        </div>
        {status.status === 'running' && (
          <>
            <p>{T.algoRunning} {Math.round(status.p * 100)}% · {T.algoStages[status.stage] || ''}</p>
            <div className="bar"><div style={{ width: `${status.p * 100}%` }} /></div>
          </>
        )}
        {status.status === 'error' && <p className="err">{T.error} {status.msg}</p>}
        {status.status === 'idle' && <p>{T.noAudio}</p>}
        {deep && stats && (
          <>
            <div className="algo-stats">
              <Stat label={T.bpm} value={`${deep.bpm}`} />
              <Stat label={T.algoKey} value={`${deep.key.name} ${deep.key.mode === 'minor' ? T.minor : T.major}`} />
              <Stat label={T.algoBars} value={stats.bars} />
              <Stat label="Kick" value={stats.kick} color="#ff5a5f" />
              <Stat label="Snare / clap" value={stats.snare} color="#ffa53c" />
              <Stat label="Hi-hat" value={stats.hat} color="#ffe066" />
              <Stat label={T.algoOhat} value={stats.ohat} color="#b6f36b" />
              <Stat label={T.algoVocal} value={`${stats.vocalPct}%`} color="#4cd6ff" />
              <Stat label="SFX" value={stats.sfx} color="#e27bff" />
              <Stat label={T.algoSections} value={stats.sections} />
            </div>
            <div className="algo-legend">
              {LANES.map((l) => <span key={l.key}><i style={{ background: l.color }} />{T.lanes[l.key]}</span>)}
            </div>
            <div className="algo-timeline" ref={scrollRef}>
              <div className="algo-inner" style={{ width: W, height: H }} onClick={seek}>
                <canvas ref={canvasRef} />
                <div className="algo-head-line" ref={headRef} />
              </div>
            </div>
            <div className="algo-controls">
              <span className="sub">{T.algoListen}</span>
              {['kick', 'snare', 'hat', 'vocal'].map((k) => (
                <label key={k} className="check"><input id={`aud-${k}`} type="checkbox" checked={!!audition[k]} onChange={(e) => setAudition((a) => ({ ...a, [k]: e.target.checked }))} /> {T.lanes[k]}</label>
              ))}
              <label className="check"><input id="aud-duck" type="checkbox" checked={!!audition.duck} onChange={(e) => setAudition((a) => ({ ...a, duck: e.target.checked }))} /> {T.algoDuck}</label>
              <label className="check"><input id="aud-follow" type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> {T.algoFollow}</label>
            </div>
            <div className="algo-sections">
              {deep.sections.map((s, i) => (
                <button key={i} onClick={() => { if (audioRef.current) audioRef.current.currentTime = s.t0; }}>
                  <i style={{ background: SECTION_COLORS[s.kind] }} />
                  <b>{T.sectionKinds[s.kind] || s.kind} {s.letter}</b>
                  <span>{fmt(s.t0)} – {fmt(s.t1)} · {s.bars} {T.algoBarsShort}</span>
                </button>
              ))}
            </div>
            <p className="hint">{T.algoNote}</p>
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, color }) {
  return (
    <div className="stat">
      <span>{color && <i style={{ background: color }} />}{label}</span>
      <b>{value}</b>
    </div>
  );
}

// ---------------------------------------------------------------- audition clicks
let actx = null;
let noiseBuf = null;
function ctxGet() {
  if (!actx) {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    noiseBuf = actx.createBuffer(1, actx.sampleRate * 0.5, actx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (actx.state === 'suspended') actx.resume();
  return actx;
}
export function playClick(kind) {
  const c = ctxGet(), t = c.currentTime;
  const out = c.createGain(); out.connect(c.destination);
  if (kind === 'kick') {
    const o = c.createOscillator(); o.frequency.setValueAtTime(160, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    out.gain.setValueAtTime(0.9, t); out.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    o.connect(out); o.start(t); o.stop(t + 0.2);
  } else if (kind === 'vocal') {
    const o = c.createOscillator(); o.frequency.value = 880;
    out.gain.setValueAtTime(0.25, t); out.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    o.connect(out); o.start(t); o.stop(t + 0.13);
  } else {
    const s = c.createBufferSource(); s.buffer = noiseBuf;
    const f = c.createBiquadFilter();
    if (kind === 'snare') { f.type = 'bandpass'; f.frequency.value = 1800; f.Q.value = 0.7; out.gain.setValueAtTime(0.7, t); out.gain.exponentialRampToValueAtTime(0.001, t + 0.14); }
    else { f.type = 'highpass'; f.frequency.value = 8000; out.gain.setValueAtTime(0.35, t); out.gain.exponentialRampToValueAtTime(0.001, t + (kind === 'ohat' ? 0.2 : 0.04)); }
    s.connect(f); f.connect(out); s.start(t); s.stop(t + 0.25);
  }
}
