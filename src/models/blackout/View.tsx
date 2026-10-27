import { useEffect, useMemo, useState } from 'react';
import { LineChart, type ChartMarker, type ChartSeries } from '../../components/LineChart';
import { runHeadless } from '../../engine/headless';
import type { ParamValues, RunRecord } from '../../engine/types';
import { runInBackground, type Job } from '../../engine/workerClient';
import { COLORS, STATUS, withAlpha } from '../../lib/palette';
import type { ModelViewProps } from '../../views/types';
import { BRANCH_AXES, BRANCH_KEYS, blackoutModel, branchCombos, describeSystems, fmtDur, type BlackoutState, type SystemRow } from './model';
import styles from './View.module.css';

/**
 * Blackout scenario view: a status board (one row per system, bar + % + state
 * text + status pill with glyph, never colour alone), the branch tree with the
 * selected path highlighted, and the essential-services index of this run over
 * the range across all 18 modelled branch combinations (computed headless in a
 * background worker — a range across branches, not a probability).
 */

type Status = 'good' | 'warning' | 'serious' | 'critical';
const GLYPH: Record<Status, string> = { good: '✓', warning: '!', serious: '▲', critical: '✕' };
const WORD: Record<Status, string> = { good: 'Normal', warning: 'Degraded', serious: 'Severe', critical: 'Critical' };

function statusOf(level: number): Status {
  if (level >= 0.9) return 'good';
  if (level >= 0.6) return 'warning';
  if (level >= 0.3) return 'serious';
  return 'critical';
}

function comboKey(c: Record<string, unknown>): string {
  return BRANCH_KEYS.map((k) => String(c[k])).join('/');
}

interface Envelope {
  /** Days. */
  x: number[];
  lo: number[];
  hi: number[];
  /** Time-averaged ESI (%) per branch combination. */
  avg: Map<string, number>;
}

function timeAverage(t: number[], y: number[]): number {
  let area = 0;
  for (let i = 1; i < t.length; i++) area += 0.5 * (y[i] + y[i - 1]) * (t[i] - t[i - 1]);
  const span = t[t.length - 1] - t[0];
  return span > 0 ? area / span : y[0] ?? NaN;
}

function valueAt(t: number[], y: number[], x: number): number {
  let lo = 0;
  let hi = t.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return y[lo];
}

function buildEnvelope(runs: { key: string; run: RunRecord }[]): Envelope {
  const ref = runs[0].run.samples.t;
  const lo: number[] = [];
  const hi: number[] = [];
  for (const tt of ref) {
    let a = Infinity;
    let b = -Infinity;
    for (const { run } of runs) {
      const v = valueAt(run.samples.t, run.samples.obs.esi, tt);
      if (v < a) a = v;
      if (v > b) b = v;
    }
    lo.push(a);
    hi.push(b);
  }
  const avg = new Map<string, number>();
  for (const { key, run } of runs) avg.set(key, timeAverage(run.samples.t, run.samples.obs.esi));
  return { x: ref.map((v) => v / 24), lo, hi, avg };
}

/** Run every named branch combination with the current non-branch settings, in the background. */
function useBranchEnvelope(params: ParamValues) {
  const shared = useMemo(() => {
    const out: ParamValues = {};
    for (const [k, v] of Object.entries(params)) if (!(BRANCH_KEYS as readonly string[]).includes(k)) out[k] = v;
    return out;
  }, [params]);
  const key = JSON.stringify(Object.entries(shared).sort(([a], [b]) => a.localeCompare(b)));
  const [env, setEnv] = useState<Envelope | null>(null);
  const [done, setDone] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const combos = branchCombos();
    const jobs: Job<RunRecord>[] = [];
    const results: ({ key: string; run: RunRecord } | null)[] = combos.map(() => null);
    const timers: number[] = [];
    let count = 0;
    setEnv(null);
    setDone(0);
    setError(null);
    const accept = (i: number, run: RunRecord) => {
      if (cancelled) return;
      results[i] = { key: comboKey(combos[i]), run };
      count++;
      setDone(count);
      if (count === combos.length) setEnv(buildEnvelope(results as { key: string; run: RunRecord }[]));
    };
    combos.forEach((c, i) => {
      const p = { ...shared, ...c };
      const job = runInBackground('blackout', p);
      jobs.push(job);
      job.promise.then(
        (run) => accept(i, run),
        () => {
          if (cancelled) return;
          // Worker unavailable (or model not registered there): compute on the main thread, one run per task.
          timers.push(
            window.setTimeout(() => {
              if (cancelled) return;
              try {
                accept(i, runHeadless(blackoutModel, p));
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              }
            }, 0),
          );
        },
      );
    });
    return () => {
      cancelled = true;
      for (const j of jobs) j.cancel();
      for (const t of timers) window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return { env, done, total: 18, error };
}

function StatusRow({ row }: { row: SystemRow }) {
  const st: Status = row.standby ? 'good' : statusOf(row.level);
  const color = STATUS[st];
  const word = row.standby ? 'Standby' : WORD[st];
  const pctText = `${Math.round(row.level * 100)} %`;
  return (
    <li className={`${styles.row} ${row.key === 'esi' ? styles.rowEsi : ''}`}>
      <span className={styles.name}>{row.name}</span>
      <span className={styles.pill} style={{ color }}>
        <span className={styles.glyph} style={{ background: withAlpha(color, 0.22) }} aria-hidden="true">
          {GLYPH[st]}
        </span>
        {word}
      </span>
      <span className={styles.track} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(row.level * 100)} aria-label={`${row.name}: ${pctText}, ${word}`}>
        <span className={styles.fill} style={{ display: 'block', width: `${Math.max(0, Math.min(1, row.level)) * 100}%`, background: color }} />
      </span>
      <span className={styles.value}>{pctText}</span>
      <span className={styles.state}>{row.state}</span>
    </li>
  );
}

export default function BlackoutView({ runner, baseline, version }: ModelViewProps<BlackoutState>) {
  const s = runner.viewState;
  const p = runner.viewParams;
  const rows = describeSystems(s, p);
  const initial = runner.core.initialParams;
  const { env, done, total, error } = useBranchEnvelope(initial);
  const durationDays = Number(initial.durationDays) || 30;
  const selected = Object.fromEntries(BRANCH_KEYS.map((k) => [k, String(initial[k])])) as Record<string, string>;
  const isCustom = BRANCH_KEYS.some((k) => selected[k] === 'custom');
  const pathText = BRANCH_AXES.map((ax) => {
    const v = selected[ax.key];
    return v === 'custom' ? `${ax.label}: custom numbers` : ax.options.find((o) => o.value === v)?.label ?? v;
  }).join(' → ');

  const series: ChartSeries[] = useMemo(() => {
    const t = runner.core.samples.t;
    const esi = runner.core.samples.obs.esi;
    const out: ChartSeries[] = [{ id: 'run', label: 'This run', x: t.map((v) => v / 24), y: [...esi], role: 'experiment' }];
    if (baseline) out.push({ id: 'baseline', label: 'Baseline', x: baseline.samples.t.map((v) => v / 24), y: baseline.samples.obs.esi ?? [], role: 'baseline' });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, baseline, runner.core]);

  const markers: ChartMarker[] = useMemo(
    () =>
      runner.core.events
        .filter((e) => e.source === 'model' && (e.severity === 'critical' || e.severity === 'milestone'))
        .slice(0, 16)
        .map((e) => ({ x: e.t / 24, label: e.label, severity: e.severity })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, runner.core],
  );

  const bands = env ? [{ id: 'range', label: 'Range across 18 modelled branches (not a probability)', x: env.x, lo: env.lo, hi: env.hi }] : [];

  // Per-option range of the run-averaged index across the combinations that include that option.
  const optionRange = (axisKey: string, value: string): string | null => {
    if (!env) return null;
    const vals = branchCombos()
      .filter((c) => String((c as Record<string, string>)[axisKey]) === value)
      .map((c) => env.avg.get(comboKey(c)))
      .filter((v): v is number => v !== undefined);
    if (!vals.length) return null;
    return `avg ${Math.round(Math.min(...vals))}–${Math.round(Math.max(...vals))} %`;
  };
  const thisAvg = env && !isCustom ? env.avg.get(comboKey(selected)) : undefined;
  const allAvg = env ? [...env.avg.values()] : [];

  const t = runner.time;
  return (
    <div className={styles.root}>
      <header className={styles.head}>
        <div className={styles.clock}>
          Day {Math.floor(t / 24)} · {fmtDur(t)} after the grid failed
        </div>
        <p className={styles.sub}>
          Path: {pathText}. A transparent scenario model, not a prediction of how any country would respond.
        </p>
      </header>

      <div className={styles.layout}>
        <section className={styles.panel} aria-label="System status board">
          <h3 className={styles.panelTitle}>System status</h3>
          <ul className={styles.board}>
            {rows.map((r) => (
              <StatusRow key={r.key} row={r} />
            ))}
          </ul>
          <p className={styles.note}>Status: ✓ normal (≥ 90 %), ! degraded (60–90 %), ▲ severe (30–60 %), ✕ critical (&lt; 30 %).</p>
        </section>

        <div className={styles.col}>
          <section className={styles.panel} aria-label="Scenario branch tree">
            <h3 className={styles.panelTitle}>Scenario branches</h3>
            <div className={styles.tree}>
              {BRANCH_AXES.map((ax, i) => (
                <div key={ax.key} className={styles.axis}>
                  {i > 0 && (
                    <span className={styles.joiner} aria-hidden="true">
                      ↓
                    </span>
                  )}
                  <span className={styles.axisLabel}>{ax.label}</span>
                  <div className={styles.options} role="list">
                    {[...ax.options, { value: 'custom', label: 'Custom numbers', detail: 'numbers under Advanced assumptions' }].map((o) => {
                      const on = selected[ax.key] === o.value;
                      if (o.value === 'custom' && !on) return null;
                      const range = o.value === 'custom' ? null : optionRange(ax.key, o.value);
                      return (
                        <span key={o.value} role="listitem" className={`${styles.option} ${on ? styles.optionOn : ''}`} title={o.detail} aria-current={on ? 'true' : undefined}>
                          {on ? '✓ ' : ''}
                          {o.label}
                          {range && <span className={styles.optionRange}>{range}</span>}
                        </span>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
            <p className={styles.note}>
              Selected path highlighted (✓). “avg” = essential-services index averaged over the run, across the branch combinations that include that option. Change branches in the parameter panel.
            </p>
          </section>

          <section className={styles.panel} aria-label="Essential-services envelope">
            {!env && !error && (
              <p className={styles.status}>
                Computing the other branch combinations in the background… {done}/{total}
              </p>
            )}
            {error && <p className={styles.status}>Branch range unavailable: {error}</p>}
            <LineChart
              title="Essential-services index"
              subtitle="Shaded: range across modelled branches, not a probability"
              series={series}
              bands={bands}
              xLabel="Days since the outage"
              yLabel="Index (%)"
              xFormat={(v) => `${Number(v.toFixed(1))}`}
              yFormat={(v) => `${Math.round(v)}`}
              xDomain={[0, durationDays]}
              yDomain={[0, 100]}
              cursorX={t / 24}
              onScrub={(x) => runner.seekTime(x * 24)}
              markers={markers}
              version={version}
              height={220}
            />
            {env && (
              <p className={styles.note}>
                Run-averaged index across the 18 branches: {Math.round(Math.min(...allAvg))}–{Math.round(Math.max(...allAvg))} %
                {thisAvg !== undefined ? `; this path ${Math.round(thisAvg)} %` : isCustom ? '; this run uses custom numbers, so it is not one of the 18' : ''}. The spread shows how much the outcome depends on the branch assumptions; it is a range across modelled branches, not a probability.
              </p>
            )}
          </section>
        </div>
      </div>
      <p className={styles.note} style={{ color: COLORS.muted }}>
        Food-safety limits (≈4 h refrigerator, ≈48 h full freezer) follow USDA guidance. Branch numbers are illustrative assumptions; human behaviour, emergency response and health outcomes are not modelled.
      </p>
    </div>
  );
}
