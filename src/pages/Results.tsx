import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { getSessionRun, markSessionSaved, type SessionRun } from '../workspace/sessionRuns';
import { getSaved, saveExperiment } from '../store/history';
import { getModel } from '../models/registry';
import { getExperiment } from '../experiments/catalog';
import type { RunRecord, SimulationModel } from '../engine/types';
import { LineChart, type ChartSeries } from '../components/LineChart';
import { groupObservables } from '../workspace/LiveCharts';
import { EventsList } from '../workspace/EventsList';
import { KindBadge, ProvBadge } from '../components/Provenance';
import { Icon } from '../components/Icon';
import { toast } from '../components/Toasts';
import { canConvert, convert, displayUnit, formatNumber, formatQuantity, formatTime, unitSymbol, type UnitSystem } from '../engine/units';
import { usePrefs } from '../store/prefs';
import { download, eventsToCsv, paramsTable, runToCsv, runToMarkdown, slug } from '../lib/export';
import { AssistantPanel } from '../ai/AssistantPanel';
import { noteCounter } from '../store/activity';
import { evaluateUnlocks } from '../store/achievements';
import { seriesColor } from '../lib/palette';
import { IS_ARTIFACT } from '../lib/target';
import { FullSiteNote } from '../components/FullSiteNote';

export function interpAt(ts: number[], ys: number[], t: number): number {
  if (!ts.length) return NaN;
  if (t <= ts[0]) return ys[0];
  if (t >= ts[ts.length - 1]) return ys[ys.length - 1];
  let lo = 0;
  let hi = ts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] <= t) lo = mid;
    else hi = mid;
  }
  const f = (t - ts[lo]) / (ts[hi] - ts[lo] || 1);
  return ys[lo] + (ys[hi] - ys[lo]) * f;
}

interface Loaded {
  model: SimulationModel;
  question: string;
  name: string;
  experimentId: string | null;
  record: RunRecord;
  baseline: RunRecord | null;
  baselineLabel?: string;
  assumptions?: string[];
  session?: SessionRun;
  savedId?: string;
  notes?: string;
}

function load(id: string): Loaded | null {
  const s = getSessionRun(id);
  if (s) {
    const model = getModel(s.modelId);
    if (!model) return null;
    return { model, question: s.question, name: s.name, experimentId: s.experimentId, record: s.record, baseline: s.baseline, baselineLabel: s.baselineLabel, assumptions: s.experimentAssumptions, session: s, savedId: s.savedId };
  }
  const saved = getSaved(id);
  if (saved?.result) {
    const model = getModel(saved.modelId);
    if (!model) return null;
    return {
      model,
      question: saved.question,
      name: saved.name,
      experimentId: saved.experimentId,
      record: saved.result,
      baseline: null,
      baselineLabel: saved.baselineLabel,
      assumptions: saved.experimentId ? getExperiment(saved.experimentId)?.assumptions : undefined,
      savedId: saved.id,
      notes: saved.notes,
    };
  }
  return null;
}

function disp(arr: number[], unit: Parameters<typeof displayUnit>[0], sys: UnitSystem) {
  const d = displayUnit(unit, sys);
  return d !== unit && canConvert(unit, d) ? { data: arr.map((v) => convert(v, unit, d)), unit: d } : { data: arr, unit };
}

export function KeyResults({ model, run, baseline, units }: { model: SimulationModel; run: RunRecord; baseline: RunRecord | null; units: UnitSystem }) {
  const key = model.summarize?.(run) ?? [];
  const keyB = baseline ? model.summarize?.(baseline) ?? [] : [];
  if (!key.length) return null;
  const fmt = (k: (typeof key)[number]) => (typeof k.value === 'number' ? (k.unit ? formatQuantity(k.value, k.unit, { sig: k.sig ?? 4, system: units }) : formatNumber(k.value, k.sig ?? 4)) : k.value);
  return (
    <div className="stat-grid">
      {key.map((k, i) => {
        const b = keyB.find((x) => x.label === k.label);
        return (
          <div key={i} className="stat" title={k.note}>
            <div className="stat-label">
              {k.label} <ProvBadge kind={k.provenance} />
            </div>
            <div className="stat-value">{fmt(k)}</div>
            {b && <div className="stat-delta muted">baseline: {fmt(b)}</div>}
            {k.note && <div className="stat-note">{k.note}</div>}
          </div>
        );
      })}
    </div>
  );
}

export default function Results() {
  const { id } = useParams();
  const navigate = useNavigate();
  const prefs = usePrefs();
  const [, force] = useState(0);
  const [assistant, setAssistant] = useState(false);
  const data = useMemo(() => (id ? load(id) : null), [id]);
  const groups = useMemo(() => (data ? groupObservables(data.model.observables) : []), [data]);

  if (!data)
    return (
      <div className="page narrow empty-state">
        <h1>Results not available</h1>
        <p>Session results are kept until you reload the page. Save experiments with results to keep them.</p>
        <Link className="btn primary" to="/history">
          Open history
        </Link>
      </div>
    );

  const { model, record, baseline } = data;
  const exp = data.experimentId ? getExperiment(data.experimentId) : undefined;
  const units = prefs.units;
  const pRows = paramsTable(model, record.params);
  const bRows = baseline ? paramsTable(model, baseline.params) : [];
  const tSym = unitSymbol(model.time.unit) || model.time.unit;

  const save = () => {
    const rec = saveExperiment({
      name: data.name,
      question: data.question,
      experimentId: data.experimentId,
      modelId: model.id,
      params: record.params,
      baseline: baseline?.params ?? null,
      baselineLabel: data.baselineLabel,
      notes: '',
      tags: [],
      collectionIds: [],
      result: record,
    });
    if (data.session) markSessionSaved(data.session.id, rec.id);
    data.savedId = rec.id;
    evaluateUnlocks();
    toast('Saved with results.', 'success');
    force((x) => x + 1);
  };

  const primary = model.primaryObservables?.[0];
  const primaryObs = model.observables.find((o) => o.key === primary) ?? model.observables.find((o) => o.chart);
  const tracks = Object.entries(record.tracks);
  const baseTracks = baseline ? Object.entries(baseline.tracks) : [];

  return (
    <div className="page results">
      <header className="page-head">
        <div className="crumbs">
          <Link to={exp ? `/lab/${exp.id}` : '/library'}>{exp ? 'Back to experiment' : 'Library'}</Link>
        </div>
        <div className="eyebrow">Results &amp; analysis</div>
        <h1>{data.question}</h1>
        <p className="muted">
          {model.name} · {data.name !== data.question ? `${data.name} · ` : ''}
          simulated {formatTime(record.samples.t.at(-1) ?? 0, model.time.unit)} · {record.numerics.stoppedReason}
        </p>
        <div className="toolbar">
          {!data.savedId ? (
            <button className="btn primary" onClick={save}>
              <Icon name="save" /> Save with results
            </button>
          ) : (
            <Link className="btn secondary" to="/history">
              <Icon name="check" /> Saved — view history
            </Link>
          )}
          {!IS_ARTIFACT && (
            <>
              <button className="btn secondary" onClick={() => download(`${slug(data.question)}.json`, JSON.stringify({ question: data.question, model: model.id, run: record, baseline }, null, 1))}>
                <Icon name="download" /> JSON
              </button>
              <button className="btn secondary" onClick={() => download(`${slug(data.question)}-samples.csv`, runToCsv(model, record), 'text/csv')}>
                <Icon name="download" /> CSV
              </button>
              <button className="btn secondary" onClick={() => download(`${slug(data.question)}-events.csv`, eventsToCsv(model, record), 'text/csv')}>
                <Icon name="download" /> Events CSV
              </button>
              <button
                className="btn secondary"
                onClick={() => download(`${slug(data.question)}-report.md`, runToMarkdown({ model, question: data.question, run: record, baseline, baselineLabel: data.baselineLabel, experimentAssumptions: data.assumptions, notes: data.notes, includeEducation: prefs.educationMode, level: prefs.level }), 'text/markdown')}
              >
                <Icon name="download" /> Report (.md)
              </button>
              <button className="btn secondary" onClick={() => window.print()}>
                <Icon name="print" /> Print / PDF
              </button>
            </>
          )}
          <button
            className="btn secondary"
            onClick={() => {
              noteCounter('comparisons');
              navigate(`/compare?runs=${data.savedId ?? data.session?.id ?? ''}`);
            }}
          >
            <Icon name="compare" /> Compare
          </button>
          <button className="btn secondary" onClick={() => setAssistant(true)}>
            <Icon name="assistant" /> Ask about these results
          </button>
        </div>
        {IS_ARTIFACT && <FullSiteNote text="Exports and printing are available" />}
      </header>

      <section>
        <h2 className="section-title">Key results</h2>
        <KeyResults model={model} run={record} baseline={baseline} units={units} />
        <p className="small muted">Every value is computed from the recorded run(s) above; the badge shows whether it was simulated, calculated in closed form, read from data, or assumed.</p>
      </section>

      <div className="two-col">
        <section className="panel">
          <h2 className="subhead">Experimental parameters</h2>
          <table className="kv-table">
            <tbody>
              {pRows.map((r) => {
                const b = bRows.find((x) => x.label === r.label);
                const changed = b && b.value !== r.value;
                return (
                  <tr key={r.label} className={changed ? 'changed' : ''}>
                    <th>{r.label}</th>
                    <td className="mono">{r.value}</td>
                    {baseline && <td className="mono muted">{b?.value ?? '—'}</td>}
                  </tr>
                );
              })}
            </tbody>
            {baseline && (
              <tfoot>
                <tr>
                  <td />
                  <td className="small">experiment</td>
                  <td className="small muted">{data.baselineLabel ?? 'baseline'}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </section>
        <section className="panel">
          <h2 className="subhead">Final state</h2>
          <table className="kv-table">
            <thead>
              <tr>
                <th>Quantity</th>
                <th>Experiment</th>
                {baseline && <th>Baseline</th>}
                {baseline && <th>Difference</th>}
              </tr>
            </thead>
            <tbody>
              {model.observables.map((o) => {
                const v = record.final[o.key];
                if (v === undefined || Number.isNaN(v)) return null;
                const b = baseline?.final[o.key];
                return (
                  <tr key={o.key}>
                    <th>
                      {o.label} <ProvBadge kind={o.provenance} />
                    </th>
                    <td className="mono">{formatQuantity(v, o.unit, { sig: 4, system: units })}</td>
                    {baseline && <td className="mono muted">{b === undefined || Number.isNaN(b) ? '—' : formatQuantity(b, o.unit, { sig: 4, system: units })}</td>}
                    {baseline && <td className="mono">{b === undefined || Number.isNaN(b) ? '—' : formatQuantity(v - b, o.unit === 'C' ? 'dC' : o.unit, { sig: 3, system: units })}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      </div>

      <section>
        <h2 className="section-title">Graphs</h2>
        <p className="small muted">Experiment and baseline share each chart’s scale. Hover for values; the data table under each chart lists the numbers.</p>
        <div className="chart-grid">
          {groups.map((g) => {
            const series: ChartSeries[] = [];
            let yUnit = g.items[0].unit;
            for (const o of g.items) {
              const ys = record.samples.obs[o.key];
              if (!ys || ys.every((v) => Number.isNaN(v))) continue;
              const d = disp(ys, o.unit, units);
              yUnit = d.unit;
              series.push({ id: o.key, label: o.label, x: record.samples.t, y: d.data, role: 'experiment' });
            }
            if (baseline)
              for (const o of g.items) {
                const ys = baseline.samples.obs[o.key];
                if (!ys || ys.every((v) => Number.isNaN(v))) continue;
                series.push({ id: `b-${o.key}`, label: `${o.label} (baseline)`, x: baseline.samples.t, y: disp(ys, o.unit, units).data, role: 'baseline' });
              }
            if (!series.length) return null;
            return (
              <LineChart
                key={g.id}
                title={g.items.length > 1 ? g.items.map((i) => i.label).join(', ') : g.items[0].label}
                series={series}
                xLabel={`Time (${tSym})`}
                yLabel={unitSymbol(yUnit) || 'value'}
                markers={record.events.filter((e) => e.severity === 'milestone' || e.severity === 'warning' || e.severity === 'critical').map((e) => ({ x: e.t, label: e.label, severity: e.severity }))}
                height={200}
              />
            );
          })}
          {baseline && primaryObs && record.samples.obs[primaryObs.key] && baseline.samples.obs[primaryObs.key] && (
            <LineChart
              title={`Difference: ${primaryObs.label} (experiment − baseline)`}
              series={[
                {
                  id: 'diff',
                  label: 'Experiment − baseline',
                  x: record.samples.t,
                  y: record.samples.t.map((t, i) => {
                    const a = record.samples.obs[primaryObs.key][i];
                    const b = interpAt(baseline.samples.t, baseline.samples.obs[primaryObs.key], t);
                    return t > (baseline.samples.t.at(-1) ?? 0) ? NaN : a - b;
                  }),
                },
              ]}
              xLabel={`Time (${tSym})`}
              yLabel={unitSymbol(primaryObs.unit) || 'difference'}
              includeZero
              height={200}
            />
          )}
          {tracks.length > 0 && tracks.length <= 8 && (
            <LineChart
              title="Recorded paths"
              subtitle="Positions recorded with each sample (model units)"
              series={[
                ...tracks.map(([tid, tr], k) => ({ id: tid, label: tid.replace('body-', 'Object ').replace(/Object (\d+)/, (_m, n) => `Object ${'ABCDEFGHIJKL'[Number(n)] ?? n}`), x: tr.x, y: tr.y, color: seriesColor(k) })),
                ...baseTracks.slice(0, 4).map(([tid, tr]) => ({ id: `b-${tid}`, label: `${tid} (baseline)`, x: tr.x, y: tr.y, role: 'baseline' as const })),
              ]}
              xLabel="x"
              yLabel="y"
              height={240}
              showTable={false}
            />
          )}
        </div>
      </section>

      <div className="two-col">
        <section className="panel">
          <h2 className="subhead">Observations (events in this run)</h2>
          <EventsList events={record.events.filter((e) => !(e.source === 'user' && e.severity === 'info'))} unit={model.time.unit} />
        </section>
        <section className="panel">
          {data.assumptions && data.assumptions.length > 0 && (
            <>
              <h2 className="subhead">How the question was interpreted</h2>
              <ul className="bullets">
                {data.assumptions.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </>
          )}
          <h2 className="subhead">Assumptions</h2>
          <ul className="assumptions">
            {model.assumptions.map((a, i) => (
              <li key={i}>
                <KindBadge kind={a.kind} /> {a.text}
              </li>
            ))}
          </ul>
          <h2 className="subhead">Limitations</h2>
          <ul className="bullets">
            {model.limitations.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
          <h2 className="subhead">Numerics</h2>
          <p className="small mono">
            {record.numerics.steps.toLocaleString()} steps × {formatNumber(record.numerics.dt, 3)} {tSym}; recorded every {formatNumber(record.numerics.sampleInterval, 3)} {tSym}; computed in {record.numerics.wallMs} ms.
          </p>
        </section>
      </div>

      {exp?.followUps && (
        <section>
          <h2 className="section-title">Suggested follow-up experiments</h2>
          <div className="chip-row">
            {exp.followUps
              .map((f) => getExperiment(f))
              .filter(Boolean)
              .map((e) => (
                <Link key={e!.id} to={`/lab/${e!.id}`} className="chip link">
                  {e!.title}
                </Link>
              ))}
          </div>
        </section>
      )}
      {assistant && (
        <AssistantPanel
          onClose={() => setAssistant(false)}
          getContext={() => ({ model, question: data.question, experiment: exp ?? null, params: record.params, record, baseline, baselineLabel: data.baselineLabel, status: 'finished' })}
        />
      )}
    </div>
  );
}
