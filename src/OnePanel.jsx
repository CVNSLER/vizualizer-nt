import { useEffect, useState } from 'react';
import { STAGES } from './quality/stages.js';

const LEVEL_ICON = { bad: '●', warn: '●', info: '●' };
const fmt1 = (v) => (Math.round(v * 10) / 10).toFixed(1);

export default function OnePanel({ T, hasAudio, quality, enhanced, onCheck, onImprove, onRefine, onPickVersion, target, setTarget, qSet, setQSet, useEnhanced, setUseEnhanced, onClose }) {
  const q = quality;
  const Q = T.q;
  const [strength, setStrength] = useState(Math.round((qSet.strength ?? 1) * 100));
  useEffect(() => setStrength(Math.round((qSet.strength ?? 1) * 100)), [qSet.strength]);
  const issueText = (i) => {
    const f = T.issues[i.id] || T.issues[i.id.replace(/^(too|lack)_.*/, '$1_band')];
    const band = i.id.includes('_') ? T.bandNames[i.id.split('_')[1]] : '';
    return typeof f === 'function' ? f(i.value, band) : (f || i.id);
  };
  const m = q.result?.metrics, after = enhanced?.after;
  const busy = !!q.enhancing || q.status === 'running';
  const ran = new Set((enhanced?.stages || []).map((x) => (x === 'monoBass' || x === 'stereoWide' ? 'stereo' : x)));
  const shown = STAGES.filter((id) => ran.has(id) || qSet.off.includes(id) || (qSet.amt[id] ?? 1) !== 1);
  const setAmt = (id, v) => setQSet((x) => ({ ...x, amt: { ...x.amt, [id]: v } }));
  const setOn = (id, on) => setQSet((x) => ({ ...x, off: on ? x.off.filter((k) => k !== id) : [...x.off, id] }));
  const kindLabel = (k) => (k === 'base' ? Q.vBase : k === 'again' ? Q.vAgain : k.startsWith('restart:') ? `${Q.vRestart}: ${T.stageNames[k.slice(8)] || k.slice(8)}` : k);
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal algo" onClick={(e) => e.stopPropagation()}>
        <div className="algo-head">
          <h2>{T.oneTitle}</h2>
          <button onClick={onClose}>{T.close}</button>
        </div>
        {!hasAudio && <p>{T.noAudio}</p>}

        {hasAudio && (
          <section className="one-sec">
            <h3>{T.qualityTitle}</h3>
            {q.status === 'running' && <p>{T.qualityRunning} {q.p ? `${Math.round(q.p * 100)}%` : ''}</p>}
            {q.status === 'error' && <p className="err">{T.error} {q.msg}</p>}
            {q.status === 'idle' && <button className="primary" onClick={onCheck}>{T.qualityCheck}</button>}
            {m && (
              <>
                <div className="q-top">
                  <div className={`score s${q.result.score >= 85 ? 'ok' : q.result.score >= 65 ? 'mid' : 'low'}`}>
                    <b>{q.result.score}</b><span>{T.scoreLabel}</span>
                  </div>
                  {enhanced && <div className="score sok"><b>{enhanced.score}</b><span>{T.scoreAfter}</span></div>}
                  <div className="q-metrics">
                    <Metric label={T.mLufs} a={`${fmt1(m.lufs)} LUFS`} b={after && `${fmt1(after.lufs)} LUFS`} />
                    <Metric label={T.mTp} a={`${fmt1(m.truePeakDb)} dBTP`} b={after && `${fmt1(after.truePeakDb)} dBTP`} />
                    <Metric label={T.mLra} a={`${fmt1(m.lra)} LU`} b={after && `${fmt1(after.lra)} LU`} />
                    <Metric label={T.mCrest} a={`${fmt1(m.crest)} dB`} b={after && `${fmt1(after.crest)} dB`} />
                    {m.channels > 1 && <Metric label={T.mCorr} a={m.corr.toFixed(2)} b={after && after.corr.toFixed(2)} />}
                    {m.tonal && <Metric label={T.mTonal} a={`${fmt1(m.tonal.error)} dB`} b={after?.tonal && `${fmt1(after.tonal.error)} dB`} />}
                  </div>
                </div>
                <ul className="issues">
                  {q.result.issues.length === 0 && <li className="info">{T.noIssues}</li>}
                  {q.result.issues.map((i) => (
                    <li key={i.id} className={i.level}>
                      <span className="dot">{LEVEL_ICON[i.level]}</span>
                      <span>{issueText(i)}</span>
                      <em>{i.fix ? T.fixes[i.fix] : T.noAutoFix}</em>
                    </li>
                  ))}
                </ul>

                <div className="q-settings">
                  <label className="row">{T.target}
                    <select id="q-target" value={target} onChange={(e) => setTarget(+e.target.value)}>
                      <option value={-14}>{T.targets.stream}</option>
                      <option value={-9}>{T.targets.club}</option>
                      <option value={-16}>{T.targets.podcast}</option>
                    </select>
                  </label>
                  <div className="row">{Q.level}
                    <div className="seg">
                      {['standard', 'high'].map((l) => <button key={l} id={`q-level-${l}`} className={qSet.level === l ? 'on' : ''} onClick={() => setQSet((x) => ({ ...x, level: l }))}>{Q.levels[l]}</button>)}
                    </div>
                  </div>
                  <p className="hint">{Q.levelHint[qSet.level]}</p>
                  <label className="row">{Q.strength}
                    <span className="rng">
                      <input id="q-strength" type="range" min={0} max={100} step={1} value={strength}
                        onChange={(e) => setStrength(+e.target.value)}
                        onPointerUp={() => setQSet((x) => ({ ...x, strength: strength / 100 }))}
                        onKeyUp={() => setQSet((x) => ({ ...x, strength: strength / 100 }))} />
                      <em>{strength}%</em>
                    </span>
                  </label>
                </div>

                <div className="q-actions">
                  <button id="q-improve" className="primary" onClick={onImprove} disabled={busy}>
                    {q.enhancing && !q.refining ? `${T.improving} ${Math.round((q.p || 0) * 100)}%` : enhanced ? Q.rebuild : T.improve}
                  </button>
                  {enhanced && (
                    <button id="q-again" onClick={() => onRefine(null)} disabled={busy}>
                      {q.refining === 'all' ? `${Q.looking} ${Math.round((q.p || 0) * 100)}%` : `↻ ${T.improveAgain}`}
                    </button>
                  )}
                  {enhanced && (
                    <div className="ab">
                      <button className={!useEnhanced ? 'on' : ''} onClick={() => setUseEnhanced(false)}>A · {T.original}</button>
                      <button className={useEnhanced ? 'on' : ''} onClick={() => setUseEnhanced(true)}>B · {T.enhanced}</button>
                    </div>
                  )}
                </div>
                {q.note?.kind === 'same' && <p id="q-note" className="hint okc">{q.note.only ? Q.sameStage : Q.sameAll}</p>}
                {enhanced && <p className="hint">{Q.againHint}</p>}

                {enhanced && (
                  <div className="stages2">
                    <div className="sub">{Q.stagesTitle}</div>
                    <p className="hint">{Q.stagesHint}</p>
                    {shown.map((id) => {
                      const on = !qSet.off.includes(id), amt = qSet.amt[id] ?? 1;
                      return (
                        <div key={id} className={`stage-row ${on ? '' : 'off'}`}>
                          <label className="check"><input type="checkbox" checked={on} onChange={(e) => setOn(id, e.target.checked)} /> {T.stageNames[id] || id}</label>
                          <span className="rng"><input type="range" min={0} max={2} step={0.05} value={amt} disabled={!on} onChange={(e) => setAmt(id, +e.target.value)} /><em>{Math.round(amt * 100)}%</em></span>
                          <button title={Q.restartHint} onClick={() => onRefine(id)} disabled={busy || !on}>{q.refining === id ? `${Math.round((q.p || 0) * 100)}%` : '↻'}</button>
                        </div>
                      );
                    })}
                  </div>
                )}

                {q.history.length > 0 && (
                  <div className="history">
                    <div className="sub">{Q.history}</div>
                    <ol>
                      {q.history.map((h, i) => (
                        <li key={h.id} className={i === q.active ? 'on' : ''}>
                          <button onClick={() => onPickVersion(i)}>
                            <b>v{h.id}</b> {kindLabel(h.kind)} · {T.scoreLabel} {h.score} · {T.mTonal} {fmt1(h.after.tonal.error)} dB · {fmt1(h.after.lufs)} LUFS
                            {h.settings && <em> · {Math.round((h.settings.strength ?? 1) * 100)}% · {Q.levels[h.settings.level || 'standard']}</em>}
                          </button>
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
                <p className="hint">{T.qualityNote}</p>
              </>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

function Metric({ label, a, b }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <b>{a}{b ? <em> → {b}</em> : null}</b>
    </div>
  );
}
