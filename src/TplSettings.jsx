import { PALETTES, TPL_PARAMS, tplCfg } from './catalog.js';

// Settings of the selected template: its own colours and how its effects behave.
export default function TplSettings({ T, s, setS }) {
  const id = s.template;
  if (!id || id === 'none') return null;
  const c = tplCfg(s, id);
  const upd = (patch) => setS((p) => ({ ...p, tplCfg: { ...(p.tplCfg || {}), [id]: { ...(p.tplCfg?.[id] || {}), ...patch } } }));
  const reset = () => setS((p) => { const n = { ...(p.tplCfg || {}) }; delete n[id]; return { ...p, tplCfg: n }; });
  const fmt = (k, v) => (k === 'rot' ? `${v}°` : k === 'spin' ? `${v}/min` : k === 'x' || k === 'y' ? `${Math.round(v * 100)}%` : `${Math.round(v * 100)}%`);
  return (
    <div className="tpl-set">
      <div className="tpl-set-head">
        <b>{T.tplSettings}: {T.tpl[id]}</b>
        <button onClick={reset}>{T.st.resetAll}</button>
      </div>
      <div className="sub">{T.colors}</div>
      <div className="palettes" aria-label={T.palette}>
        {PALETTES.map(([a, b]) => (
          <button key={a + b} className={`pal ${c.color1 === a && c.color2 === b ? 'on' : ''}`} style={{ background: `linear-gradient(135deg, ${a} 50%, ${b} 50%)` }}
            onClick={() => upd({ color1: a, color2: b })} />
        ))}
      </div>
      <label className="row">{T.color1}<input id="tpl-color1" type="color" value={c.color1} onChange={(e) => upd({ color1: e.target.value })} /></label>
      <label className="row">{T.color2}<input id="tpl-color2" type="color" value={c.color2} onChange={(e) => upd({ color2: e.target.value })} /></label>
      <div className="sub">{T.tplFx}</div>
      {TPL_PARAMS.map(([k, min, max, step]) => (
        <label key={k} className="row">{T.tplP[k]}
          <span className="rng">
            <input id={`tpl-${k}`} type="range" min={min} max={max} step={step} value={c[k]} onChange={(e) => upd({ [k]: +e.target.value })} onDoubleClick={() => upd({ [k]: TPL_PARAMS.find((p) => p[0] === k)[4] })} />
            <em>{fmt(k, c[k])}</em>
          </span>
        </label>
      ))}
      <label className="check"><input type="checkbox" checked={!!c.mirror} onChange={(e) => upd({ mirror: e.target.checked })} /> {T.tplP.mirror}</label>
      <p className="hint">{T.tplSetHint}</p>
    </div>
  );
}
