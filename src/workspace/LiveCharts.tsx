import { useMemo, useState } from 'react';
import { LineChart, type ChartSeries } from '../components/LineChart';
import type { LiveRunner } from '../engine/runner';
import type { ObservableDef, RunRecord } from '../engine/types';
import { canConvert, convert, displayUnit, formatNumber, unitInfo, unitSymbol, type UnitSystem } from '../engine/units';

interface Props {
  runner: LiveRunner;
  version: number;
  baseline: RunRecord | null;
  baselineLabel?: string;
  units: UnitSystem;
  height?: number;
}

export function groupObservables(obs: ObservableDef[]): { id: string; label: string; items: ObservableDef[] }[] {
  const groups = new Map<string, ObservableDef[]>();
  for (const o of obs) {
    const g = o.chartGroup ?? o.key;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(o);
  }
  return [...groups.entries()].map(([id, items]) => ({
    id,
    items,
    label: items.length === 1 ? items[0].label : `${items[0].label}${items.length > 1 ? ` + ${items.length - 1} more` : ''}`,
  }));
}

function toDisplay(arr: number[], unit: ObservableDef['unit'], system: UnitSystem): { data: number[]; unit: ObservableDef['unit'] } {
  const d = displayUnit(unit, system);
  if (d === unit || !canConvert(unit, d)) return { data: arr, unit };
  return { data: arr.map((v) => convert(v, unit, d)), unit: d };
}

/** Time-series chart of a chosen observable group, experiment vs baseline on the same scale. */
export function LiveCharts({ runner, version, baseline, baselineLabel, units, height = 230 }: Props) {
  const model = runner.model;
  const groups = useMemo(() => groupObservables(model.observables), [model]);
  const defaultGroup = useMemo(() => {
    const primary = model.primaryObservables?.[0] ?? model.observables.find((o) => o.chart)?.key;
    const o = model.observables.find((x) => x.key === primary);
    return o?.chartGroup ?? o?.key ?? groups[0]?.id;
  }, [model, groups]);
  const [groupId, setGroupId] = useState(defaultGroup);
  const group = groups.find((g) => g.id === groupId) ?? groups[0];

  const { series, yUnit } = useMemo(() => {
    const out: ChartSeries[] = [];
    let yUnit = group?.items[0]?.unit ?? '1';
    const t = runner.core.samples.t;
    const plotted = group.items.filter((o) => o.chart !== false || group.items.length <= 3);
    for (const o of plotted) {
      const raw = runner.core.samples.obs[o.key];
      if (!raw || raw.every((v) => Number.isNaN(v))) continue;
      const { data, unit } = toDisplay(raw, o.unit, units);
      yUnit = unit;
      out.push({ id: o.key, label: o.label, x: t, y: data, role: 'experiment' });
    }
    if (baseline) {
      for (const o of plotted) {
        const raw = baseline.samples.obs[o.key];
        if (!raw || raw.every((v) => Number.isNaN(v))) continue;
        out.push({ id: `base-${o.key}`, label: `${o.label} — ${baselineLabel ?? 'baseline'}`, x: baseline.samples.t, y: toDisplay(raw, o.unit, units).data, role: 'baseline' });
      }
    }
    return { series: out, yUnit };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runner, group, baseline, units, version, baselineLabel]);

  const markers = runner.core.events.filter((e) => e.severity !== 'info').map((e) => ({ x: e.t, label: e.label, severity: e.severity }));
  const tUnit = unitSymbol(model.time.unit) || unitInfo(model.time.unit).name;
  const xMax = Math.max(runner.core.duration, baseline?.samples.t.at(-1) ?? 0);
  const sym = unitSymbol(yUnit);

  if (!group) return null;
  return (
    <div className="live-charts">
      <div className="lc-head">
        <label className="lc-pick">
          <span className="sr-only">Quantity to plot</span>
          <select value={group.id} onChange={(e) => setGroupId(e.target.value)} className="select">
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.items.length > 1 ? g.items.map((i) => i.label).join(' · ') : g.label}
              </option>
            ))}
          </select>
        </label>
        <span className="muted small">Click or drag on the chart to inspect that moment.</span>
      </div>
      <LineChart
        series={series}
        xLabel={`Time (${tUnit})`}
        yLabel={sym ? `${group.items[0].label.replace(/ of [A-Z]$| \(all\)$/, '')} (${sym})` : group.items[0].label}
        xDomain={[0, xMax]}
        cursorX={runner.time}
        markers={markers}
        onScrub={(x) => runner.seekTime(Math.min(x, runner.core.time))}
        version={version}
        height={height}
        yFormat={(v) => formatNumber(v, 3)}
        xFormat={(v) => formatNumber(v, 3)}
      />
    </div>
  );
}
