import type { LiveRunner } from '../engine/runner';
import { formatQuantity, type UnitSystem } from '../engine/units';
import { ProvBadge } from '../components/Provenance';
import type { RunRecord } from '../engine/types';

interface Props {
  runner: LiveRunner;
  version: number;
  units: UnitSystem;
  baseline: RunRecord | null;
}

function baselineAt(base: RunRecord, key: string, t: number): number | undefined {
  const ts = base.samples.t;
  const ys = base.samples.obs[key];
  if (!ys || !ts.length) return undefined;
  if (t >= ts[ts.length - 1]) return ys[ys.length - 1];
  let lo = 0;
  let hi = ts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return ys[lo];
}

/** Live values of every observable at the displayed time, with provenance and the baseline value. */
export function Readouts({ runner, units, baseline }: Props) {
  const idx = runner.viewIndex ?? runner.core.sampleCount - 1;
  const obs = runner.viewIndex === null ? runner.model.observe(runner.viewState, runner.viewParams) : runner.core.obsAt(idx);
  const items = runner.model.observables.filter((o) => o.readout !== false);
  return (
    <div className="readouts">
      <table className="readout-table">
        <thead>
          <tr>
            <th>Quantity</th>
            <th>Now</th>
            {baseline && <th>Baseline</th>}
          </tr>
        </thead>
        <tbody>
          {items.map((o) => {
            const v = obs[o.key];
            const b = baseline ? baselineAt(baseline, o.key, runner.time) : undefined;
            if (v === undefined) return null;
            return (
              <tr key={o.key} title={o.description}>
                <td>
                  <span className="ro-label">{o.label}</span> <ProvBadge kind={o.provenance} />
                </td>
                <td className="mono">{Number.isNaN(v) ? <span className="muted">n/a</span> : formatQuantity(v, o.unit, { sig: o.sig ?? 4, system: units })}</td>
                {baseline && <td className="mono muted">{b === undefined || Number.isNaN(b) ? '—' : formatQuantity(b, o.unit, { sig: o.sig ?? 4, system: units })}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function DerivedList({ runner, units }: { runner: LiveRunner; version: number; units: UnitSystem }) {
  const derived = runner.model.derived?.(runner.params) ?? [];
  const warnings = runner.model.warnings?.(runner.params) ?? [];
  if (!derived.length && !warnings.length) return null;
  return (
    <div className="derived">
      {warnings.map((w) => (
        <div key={w.id} className={`notice notice-${w.severity}`} role="note">
          <strong>{w.severity === 'critical' ? 'Not physically meaningful: ' : w.severity === 'warning' ? 'Caution: ' : 'Note: '}</strong>
          {w.message}
        </div>
      ))}
      {derived.length > 0 && (
        <>
          <h4 className="subhead">Calculated from the parameters</h4>
          <dl className="derived-list">
            {derived.map((d) => (
              <div key={d.key} className="derived-item" title={d.note}>
                <dt>
                  {d.label} <ProvBadge kind={d.provenance} />
                </dt>
                <dd className="mono">{Number.isFinite(d.value) ? formatQuantity(d.value, d.unit, { sig: d.sig ?? 4, system: units }) : '—'}</dd>
                {d.formula && <dd className="formula">{d.formula}</dd>}
                {d.note && <dd className="derived-note">{d.note}</dd>}
              </div>
            ))}
          </dl>
        </>
      )}
    </div>
  );
}
