import { useEffect, useMemo, useState } from 'react';

const SECTION_COLORS = {
  intro: '#3d5a80', verse: '#4f6d7a', section: '#5c677d', build: '#c97b2a',
  chorus: '#2a9d8f', drop: '#d1495b', breakdown: '#6c5b7b', outro: '#3d405b',
};

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export default function AlgoPanel({ T, deep, status, audioRef, onClose }) {
  const dur = deep?.duration || 0;

  const stats = useMemo(() => {
    if (!deep) return null;
    const vocalSec = deep.vocals.reduce((s, v) => s + (v.t1 - v.t0), 0);
    return {
      kick: deep.events.kick.length, snare: deep.events.snare.length, hat: deep.events.hat.length, ohat: deep.events.ohat.length,
      vocalPct: Math.round((vocalSec / Math.max(1, dur)) * 100), sfx: deep.sfx.length, sections: deep.sections.length,
      bars: deep.downbeats.length,
    };
  }, [deep, dur]);

  // highlight the section that is playing
  const [now, setNow] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setNow(audioRef.current?.currentTime || 0), 200);
    return () => clearInterval(id);
  }, [audioRef]);

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
            <div className="algo-sections">
              {deep.sections.map((s, i) => (
                <button key={i} className={now >= s.t0 && now < s.t1 ? 'on' : ''} onClick={() => { if (audioRef.current) audioRef.current.currentTime = s.t0; }}>
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

