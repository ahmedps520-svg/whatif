import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useExperiments } from '../store/history';
import { listSessionRuns } from '../workspace/sessionRuns';
import { getModel } from '../models/registry';
import type { RunRecord, SimulationModel } from '../engine/types';
import { LineChart, type ChartSeries } from '../components/LineChart';
import { groupObservables } from '../workspace/LiveCharts';
import { paramsTable } from '../lib/export';
import { canConvert, convert, displayUnit, formatQuantity, unitSymbol } from '../engine/units';
import { usePrefs } from '../store/prefs';
import { Icon } from '../components/Icon';
import { interpAt, KeyResults } from './Results';
import { noteCounter } from '../store/activity';
import { evaluateUnlocks } from '../store/achievements';
import { AssistantPanel } from '../ai/AssistantPanel';
import { seriesColor } from '../lib/palette';

interface Candidate {
  id: string;
  label: string;
  sub: string;
  model: SimulationModel;
  record: RunRecord;
  question: string;
}

export default function Compare() {
  const saved = useExperiments();
  const prefs = usePrefs();
  const [sp, setSp] = useSearchParams();
  const [assistant, setAssistant] = useState(false);
  const candidates = useMemo<Candidate[]>(() => {
    const out: Candidate[] = [];
    for (const s of listSessionRuns()) {
      const model = getModel(s.modelId);
      if (!model || s.savedId) continue;
      out.push({ id: s.id, label: s.name, sub: `This session · ${new Date(s.createdAt).toLocaleTimeString()}`, model, record: s.record, question: s.question });
      if (s.baseline) out.push({ id: `${s.id}:baseline`, label: `${s.name} — baseline`, sub: s.baselineLabel ?? 'baseline run', model, record: s.baseline, question: s.question });
    }
    for (const s of saved) {
      const model = getModel(s.modelId);
      if (!model || !s.result) continue;
      out.push({ id: s.id, label: s.name, sub: `Saved · ${new Date(s.updatedAt).toLocaleDateString()}`, model, record: s.result, question: s.question });
    }
    return out;
  }, [saved]);

  const selectedIds = (sp.get('runs') ?? '').split(',').filter(Boolean);
  const selected = selectedIds.map((id) => candidates.find((c) => c.id === id)).filter((c): c is Candidate => !!c);
  const toggle = (id: string) => {
    const next = selectedIds.includes(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id].slice(-4);
    setSp({ runs: next.join(',') }, { replace: true });
  };

  useEffect(() => {
    if (selected.length >= 2) {
      noteCounter('comparisons');
      evaluateUnlocks();
    }
    // Count once per distinct selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected.map((s) => s.id).join(',')]);

  const sameModel = selected.length > 0 && selected.every((s) => s.model.id === selected[0].model.id);
  const model = selected[0]?.model;
  const groups = useMemo(() => (model ? groupObservables(model.observables) : []), [model]);
  const [groupId, setGroupId] = useState<string | null>(null);
  const group = groups.find((g) => g.id === groupId) ?? groups.find((g) => g.items.some((o) => o.key === model?.primaryObservables?.[0])) ?? groups[0];

  const chart = useMemo(() => {
    if (!sameModel || !group || !model) return null;
    const o = group.items[0];
    const d = displayUnit(o.unit, prefs.units);
    const conv = (v: number) => (d !== o.unit && canConvert(o.unit, d) ? convert(v, o.unit, d) : v);
    const series: ChartSeries[] = selected.map((s, i) => ({ id: s.id, label: s.label, x: s.record.samples.t, y: (s.record.samples.obs[o.key] ?? []).map(conv), color: seriesColor(i) }));
    const ref = selected[0];
    const diffs: ChartSeries[] = selected.slice(1).map((s, i) => ({
      id: `d-${s.id}`,
      label: `${s.label} − ${ref.label}`,
      x: s.record.samples.t,
      y: s.record.samples.t.map((t, k) => (t > (ref.record.samples.t.at(-1) ?? 0) ? NaN : conv(s.record.samples.obs[o.key]?.[k] ?? NaN) - conv(interpAt(ref.record.samples.t, ref.record.samples.obs[o.key] ?? [], t)))),
      color: seriesColor(i + 1),
    }));
    return { o, unit: d, series, diffs };
  }, [sameModel, group, model, selected, prefs.units]);

  return (
    <div className="page compare">
      <header className="page-head">
        <h1>Compare runs</h1>
        <p className="muted">Choose up to four recorded runs. Runs of the same model are drawn on shared scales with difference charts against the first selection.</p>
      </header>
      {candidates.length === 0 ? (
        <div className="empty-state">
          <p>No recorded runs yet. Run an experiment, open its results, or save it with results — then compare here.</p>
          <Link to="/library" className="btn primary">
            Browse experiments
          </Link>
        </div>
      ) : (
        <section className="panel">
          <h2 className="subhead">Runs</h2>
          <ul className="pick-list">
            {candidates.map((c) => (
              <li key={c.id}>
                <label className="check">
                  <input type="checkbox" checked={selectedIds.includes(c.id)} onChange={() => toggle(c.id)} />
                  <span>
                    <strong>{c.label}</strong> <span className="muted small">· {c.model.shortName ?? c.model.name} · {c.sub}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </section>
      )}

      {selected.length >= 2 && !sameModel && (
        <div className="notice notice-info">These runs use different models, so their time series are not drawn on a shared scale. Their parameters and final states are listed side by side below.</div>
      )}

      {selected.length >= 2 && (
        <>
          <div className="toolbar">
            <button className="btn secondary" onClick={() => setAssistant(true)}>
              <Icon name="assistant" /> Ask the assistant to compare
            </button>
          </div>
          {sameModel && chart && (
            <section>
              <label className="lc-pick">
                Quantity{' '}
                <select className="select" value={group.id} onChange={(e) => setGroupId(e.target.value)}>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.items[0].label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="chart-grid">
                <LineChart title={chart.o.label} series={chart.series} xLabel={`Time (${unitSymbol(model!.time.unit)})`} yLabel={unitSymbol(chart.unit) || 'value'} height={240} />
                <LineChart title={`Difference from “${selected[0].label}”`} series={chart.diffs} xLabel={`Time (${unitSymbol(model!.time.unit)})`} yLabel={unitSymbol(chart.unit) || 'difference'} includeZero height={240} />
              </div>
            </section>
          )}
          <section className="compare-cols" style={{ ['--cols' as string]: selected.length }}>
            {selected.map((s, i) => (
              <div key={s.id} className="panel">
                <h3>
                  <span className="legend-key" style={{ background: seriesColor(i) }} /> {s.label}
                </h3>
                <p className="small muted">{s.question}</p>
                <KeyResults model={s.model} run={s.record} baseline={null} units={prefs.units} />
                <h4 className="subhead">Parameters</h4>
                <table className="kv-table small">
                  <tbody>
                    {paramsTable(s.model, s.record.params).map((r) => {
                      const differs = selected.some((o) => o !== s && o.model.id === s.model.id && paramsTable(o.model, o.record.params).find((x) => x.label === r.label)?.value !== r.value);
                      return (
                        <tr key={r.label} className={differs ? 'changed' : ''}>
                          <th>{r.label}</th>
                          <td className="mono">{r.value}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <h4 className="subhead">Final state</h4>
                <table className="kv-table small">
                  <tbody>
                    {s.model.observables
                      .filter((o) => !Number.isNaN(s.record.final[o.key]) && s.record.final[o.key] !== undefined)
                      .map((o) => (
                        <tr key={o.key}>
                          <th>{o.label}</th>
                          <td className="mono">{formatQuantity(s.record.final[o.key], o.unit, { sig: 4, system: prefs.units })}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            ))}
          </section>
        </>
      )}
      {assistant && selected.length >= 2 && (
        <AssistantPanel
          onClose={() => setAssistant(false)}
          getContext={() => ({
            model: selected[0].model,
            question: `Comparison of ${selected.length} runs`,
            experiment: null,
            params: null,
            record: null,
            baseline: null,
            runs: selected.map((s, i) => ({ label: `Run ${i + 1}: ${s.label}`, model: s.model, record: s.record })),
          })}
        />
      )}
    </div>
  );
}
