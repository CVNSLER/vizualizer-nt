import { EFFECTS, POSITIONS, GPU_FILTERS, GPU_TRANSITIONS } from './one.js';
import { peekAutoColors } from './palette.js';
import { useEffect, useState } from 'react';

const LEVEL_ICON = { bad: '●', warn: '●', info: '●' };
const fmt1 = (v) => (Math.round(v * 10) / 10).toFixed(1);

export function LayerEditor({ T, layers, onChange }) {
  // show the colours the auto mode is using right now
  const [live, setLive] = useState(null);
  useEffect(() => { const id = setInterval(() => setLive(peekAutoColors()), 400); return () => clearInterval(id); }, []);
  if (!layers?.length) return null;
  const upd = (i, patch) => onChange(layers.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const allAuto = layers.every((l) => l.colorAuto);
  return (
    <div className="layers">
      <div className="layers-head">
        <span className="sub">{T.colorsLabel}</span>
        <button className={allAuto ? 'on' : ''} onClick={() => onChange(layers.map((l) => ({ ...l, colorAuto: !allAuto })))} title={T.autoColorHint}>
          {allAuto ? T.autoAllOn : T.autoAll}
        </button>
      </div>
      {layers.map((l, i) => (
        <div key={l.sound} className={`layer ${l.on ? '' : 'off'}`}>
          <label className="check layer-name">
            <input id={`layer-${l.sound}-on`} type="checkbox" checked={l.on} onChange={(e) => upd(i, { on: e.target.checked })} />
            {T.sounds[l.sound]}
          </label>
          <select id={`layer-${l.sound}-fx`} value={l.effect} onChange={(e) => upd(i, { effect: e.target.value })} aria-label={T.layerEffect}>
            <optgroup label={`${T.fxGroupFilters} (${GPU_FILTERS.length})`}>
              {GPU_FILTERS.map((e) => <option key={e} value={e}>{T.gpuFx[e.slice(2)] || e.slice(2)}</option>)}
            </optgroup>
            <optgroup label={`${T.fxGroupTransitions} (${GPU_TRANSITIONS.length})`}>
              {GPU_TRANSITIONS.map((e) => <option key={e} value={e}>{e.slice(2).replace(/([a-z])([A-Z])/g, '$1 $2')}</option>)}
            </optgroup>
            <optgroup label={`${T.fxGroupOverlay} (${EFFECTS.length})`}>
              {EFFECTS.map((e) => <option key={e} value={e}>{T.effects[e]}</option>)}
            </optgroup>
          </select>
          <select id={`layer-${l.sound}-pos`} value={l.pos} onChange={(e) => upd(i, { pos: e.target.value })} aria-label={T.layerPos}>
            {POSITIONS.map((p) => <option key={p} value={p}>{T.layerPositions[p]}</option>)}
          </select>
          <span className="colpick">
            <input id={`layer-${l.sound}-col`} type="color" value={l.colorAuto && live?.[l.sound] ? live[l.sound] : l.color}
              onChange={(e) => upd(i, { color: e.target.value, colorAuto: false })} aria-label={T.color1} />
            <button className={`auto ${l.colorAuto ? 'on' : ''}`} onClick={() => upd(i, { colorAuto: !l.colorAuto })} title={T.autoColorHint}>{T.auto}</button>
          </span>
          <input id={`layer-${l.sound}-amt`} type="range" min={0.1} max={1.5} step={0.05} value={l.amount} onChange={(e) => upd(i, { amount: +e.target.value })} aria-label={T.layerAmount} />
        </div>
      ))}
    </div>
  );
}

export default function OnePanel({ T, hasAudio, deepReady, quality, onCheck, onImprove, target, setTarget, useEnhanced, setUseEnhanced, onBuild, onVariant, layers, setLayers, mood, detected, moodPick, setMoodPick, moods, onClose }) {
  const q = quality;
  const issueText = (i) => {
    const f = T.issues[i.id] || T.issues[i.id.replace(/^(too|lack)_.*/, '$1_band')];
    const band = i.id.includes('_') ? T.bandNames[i.id.split('_')[1]] : '';
    return typeof f === 'function' ? f(i.value, band) : (f || i.id);
  };
  const m = q.result?.metrics, after = q.enhanced?.after;
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
                  {q.enhanced && (
                    <div className="score sok"><b>{q.enhanced.score}</b><span>{T.scoreAfter}</span></div>
                  )}
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
                <div className="spec">
                  {Object.entries(m.spectrum).map(([k, v]) => (
                    <div key={k} className="spec-col" title={`${fmt1(v)} dB`}>
                      <div className="spec-bar"><i style={{ height: `${Math.max(4, Math.min(100, 50 + v * 3))}%` }} /></div>
                      <span>{T.bandNames[k]}</span>
                    </div>
                  ))}
                </div>
                <div className="q-actions">
                  <label className="row">{T.target}
                    <select id="q-target" value={target} onChange={(e) => setTarget(+e.target.value)}>
                      <option value={-14}>{T.targets.stream}</option>
                      <option value={-9}>{T.targets.club}</option>
                      <option value={-16}>{T.targets.podcast}</option>
                    </select>
                  </label>
                  <button className="primary" onClick={onImprove} disabled={q.enhancing}>
                    {q.enhancing ? `${T.improving} ${Math.round((q.p || 0) * 100)}%` : q.enhanced ? T.improveAgain : T.improve}
                  </button>
                  {q.enhanced && (
                    <div className="ab">
                      <button className={!useEnhanced ? 'on' : ''} onClick={() => setUseEnhanced(false)}>A · {T.original}</button>
                      <button className={useEnhanced ? 'on' : ''} onClick={() => setUseEnhanced(true)}>B · {T.enhanced}</button>
                    </div>
                  )}
                </div>
                {q.enhanced?.stages && (
                  <div className="stages">
                    <span className="sub">{T.stagesDone}</span>
                    <ol>{q.enhanced.stages.map((st) => <li key={st}>{T.stageNames[st] || st}</li>)}</ol>
                  </div>
                )}
                <p className="hint">{T.qualityNote}</p>
              </>
            )}
          </section>
        )}

        <section className="one-sec">
          <h3>{T.builderTitle}</h3>
          <p className="hint">{deepReady ? T.builderHint : T.builderWait}</p>
          <div className="mood-row">
            <span>{T.moodLabel}:</span>
            <select id="mood-pick" value={moodPick} onChange={(e) => setMoodPick(e.target.value)}>
              <option value="auto">{T.moodAuto}{detected ? ` (${T.moodNames[detected.id]})` : ''}</option>
              {moods.map((id) => <option key={id} value={id}>{T.moodNames[id]}</option>)}
            </select>
            {detected && <span className="hint">{detected.bpm} BPM · {T.moodNow}: <b>{T.moodNames[mood || detected.id]}</b></span>}
          </div>
          <div className="q-actions">
            <button className="primary" onClick={onBuild} disabled={!hasAudio}>{T.buildNow}</button>
            <button onClick={onVariant} disabled={!layers?.length}>{T.variant}</button>
          </div>
          <LayerEditor T={T} layers={layers} onChange={setLayers} />
          <p className="hint">{T.fxCredits}</p>
        </section>
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
