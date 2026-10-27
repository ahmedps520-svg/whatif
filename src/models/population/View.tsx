import { useEffect, useRef, useState } from 'react';
import { COLORS, SERIES, STATUS, withAlpha } from '../../lib/palette';
import type { ModelViewProps } from '../../views/types';
import { explainGrowth, flowsOf, fmtPct, fmtSig, P_REF, type PopulationState } from './model';
import styles from './View.module.css';

/**
 * System diagram for the population model: the four stocks as labelled gauges,
 * flows as arrows whose thickness follows the current flow, the three feedback
 * ratios as status badges (colour always paired with a glyph and text), and a
 * rate budget explaining why the population is rising or falling right now.
 * Everything is read from runner.viewState through the model's own functions.
 */

type Status = 'good' | 'warning' | 'serious' | 'critical';
const GLYPH: Record<Status, string> = { good: '✓', warning: '!', serious: '▲', critical: '✕' };

function shareStatus(pct: number): { status: Status; word: string } {
  if (pct >= 99.5) return { status: 'good', word: 'fully met' };
  if (pct >= 90) return { status: 'warning', word: 'strained' };
  if (pct >= 70) return { status: 'serious', word: 'shortage' };
  return { status: 'critical', word: 'severe shortage' };
}

function crowdingStatus(c: number): { status: Status; word: string } {
  if (!Number.isFinite(c)) return { status: 'critical', word: 'no capacity' };
  if (c <= 1.0) return { status: 'good', word: 'within capacity' };
  if (c <= 1.1) return { status: 'warning', word: 'at capacity' };
  if (c <= 1.5) return { status: 'serious', word: 'overloaded' };
  return { status: 'critical', word: 'severely overloaded' };
}

function stockStatus(pct: number): { status: Status; word: string } {
  if (pct >= 50) return { status: 'good', word: 'healthy' };
  if (pct >= 25) return { status: 'warning', word: 'depleting' };
  if (pct >= 10) return { status: 'serious', word: 'low' };
  return { status: 'critical', word: 'nearly exhausted' };
}

function overshootStatus(r: number): { status: Status; word: string } {
  if (r <= 1) return { status: 'good', word: 'sustainable' };
  if (r <= 1.2) return { status: 'warning', word: 'overshoot' };
  if (r <= 1.5) return { status: 'serious', word: 'overshoot' };
  return { status: 'critical', word: 'deep overshoot' };
}

interface Pt {
  x: number;
  y: number;
}
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface FlowGeom {
  a: Pt;
  b: Pt;
  c?: Pt;
  label: Pt;
  anchor: 'start' | 'middle' | 'end';
}
interface BadgeGeom {
  x: number;
  y: number;
}
interface Layout {
  narrow: boolean;
  W: number;
  H: number;
  pop: Box;
  res: Box;
  energy: Box;
  infra: Box;
  births: FlowGeom;
  deaths: FlowGeom;
  migration: FlowGeom;
  regen: FlowGeom;
  harvest: FlowGeom;
  energyPop: FlowGeom;
  energyInfra: FlowGeom;
  infraPop: FlowGeom;
  wear: FlowGeom;
  needsBadge: BadgeGeom;
  energyBadge: BadgeGeom;
  crowdBadge: BadgeGeom;
  overshootBadge: BadgeGeom;
}

const WIDE: Layout = {
  narrow: false,
  W: 800,
  H: 560,
  pop: { x: 280, y: 18, w: 240, h: 132 },
  res: { x: 20, y: 340, w: 232, h: 132 },
  energy: { x: 284, y: 340, w: 232, h: 132 },
  infra: { x: 548, y: 340, w: 232, h: 132 },
  births: { a: { x: 40, y: 58 }, b: { x: 280, y: 58 }, label: { x: 160, y: 40 }, anchor: 'middle' },
  migration: { a: { x: 40, y: 118 }, b: { x: 280, y: 118 }, label: { x: 160, y: 100 }, anchor: 'middle' },
  deaths: { a: { x: 520, y: 84 }, b: { x: 760, y: 84 }, label: { x: 640, y: 66 }, anchor: 'middle' },
  regen: { a: { x: 136, y: 556 }, b: { x: 136, y: 472 }, label: { x: 148, y: 520 }, anchor: 'start' },
  harvest: { a: { x: 136, y: 340 }, c: { x: 140, y: 230 }, b: { x: 330, y: 150 }, label: { x: 128, y: 268 }, anchor: 'end' },
  energyPop: { a: { x: 400, y: 340 }, b: { x: 400, y: 150 }, label: { x: 410, y: 300 }, anchor: 'start' },
  energyInfra: { a: { x: 516, y: 408 }, b: { x: 548, y: 408 }, label: { x: 532, y: 398 }, anchor: 'middle' },
  infraPop: { a: { x: 664, y: 340 }, c: { x: 660, y: 230 }, b: { x: 470, y: 150 }, label: { x: 672, y: 268 }, anchor: 'start' },
  wear: { a: { x: 664, y: 472 }, b: { x: 664, y: 556 }, label: { x: 676, y: 520 }, anchor: 'start' },
  needsBadge: { x: 196, y: 196 },
  energyBadge: { x: 400, y: 232 },
  crowdBadge: { x: 604, y: 196 },
  overshootBadge: { x: 136, y: 318 },
};

const NARROW: Layout = {
  narrow: true,
  W: 360,
  H: 720,
  pop: { x: 70, y: 66, w: 220, h: 132 },
  res: { x: 6, y: 330, w: 160, h: 132 },
  energy: { x: 98, y: 568, w: 164, h: 132 },
  infra: { x: 194, y: 330, w: 160, h: 132 },
  births: { a: { x: 112, y: 6 }, b: { x: 112, y: 66 }, label: { x: 104, y: 26 }, anchor: 'end' },
  deaths: { a: { x: 248, y: 66 }, b: { x: 248, y: 6 }, label: { x: 256, y: 26 }, anchor: 'start' },
  migration: { a: { x: 2, y: 176 }, b: { x: 70, y: 176 }, label: { x: 4, y: 214 }, anchor: 'start' },
  regen: { a: { x: 48, y: 560 }, b: { x: 48, y: 462 }, label: { x: 56, y: 500 }, anchor: 'start' },
  harvest: { a: { x: 86, y: 330 }, c: { x: 90, y: 260 }, b: { x: 130, y: 198 }, label: { x: 8, y: 236 }, anchor: 'start' },
  energyPop: { a: { x: 180, y: 568 }, b: { x: 180, y: 198 }, label: { x: 188, y: 520 }, anchor: 'start' },
  energyInfra: { a: { x: 242, y: 568 }, b: { x: 262, y: 462 }, label: { x: 270, y: 540 }, anchor: 'start' },
  infraPop: { a: { x: 274, y: 330 }, c: { x: 270, y: 260 }, b: { x: 230, y: 198 }, label: { x: 352, y: 236 }, anchor: 'end' },
  wear: { a: { x: 318, y: 462 }, b: { x: 318, y: 560 }, label: { x: 310, y: 500 }, anchor: 'end' },
  needsBadge: { x: 86, y: 292 },
  energyBadge: { x: 180, y: 252 },
  crowdBadge: { x: 274, y: 292 },
  overshootBadge: { x: 86, y: 484 },
};

const FONT = '"Inter Variable", system-ui, sans-serif';
const MONO = '"JetBrains Mono Variable", ui-monospace, monospace';
const POP_COLOR = SERIES[0];
const RES_COLOR = SERIES[2];
const ENERGY_COLOR = SERIES[3];
const INFRA_COLOR = SERIES[6];
const DEATH_COLOR = SERIES[1];

function halo(): React.SVGProps<SVGTextElement> {
  return { paintOrder: 'stroke', stroke: COLORS.bg, strokeWidth: 4, strokeLinejoin: 'round' } as React.SVGProps<SVGTextElement>;
}

function flowWidth(v: number, ref: number): number {
  if (!(ref > 0) || !(v > 0)) return 1.5;
  return 1.5 + 16 * Math.min(1, v / ref);
}

function Flow({ g, width, color, title, value, dashed }: { g: FlowGeom; width: number; color: string; title: string; value: string; dashed?: boolean }) {
  const { a, b, c } = g;
  const from = c ?? a;
  let dx = b.x - from.x;
  let dy = b.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len;
  dy /= len;
  const L = Math.max(9, width * 1.35);
  const hw = Math.max(5.5, width * 0.95);
  const end = { x: b.x - dx * L * 0.8, y: b.y - dy * L * 0.8 };
  const base = { x: b.x - dx * L, y: b.y - dy * L };
  const nx = -dy;
  const ny = dx;
  const d = c ? `M${a.x},${a.y} Q${c.x},${c.y} ${end.x},${end.y}` : `M${a.x},${a.y} L${end.x},${end.y}`;
  return (
    <g>
      <path d={d} fill="none" stroke={color} strokeWidth={width} strokeDasharray={dashed ? '5 5' : undefined} opacity={0.9} />
      <polygon points={`${b.x},${b.y} ${base.x + nx * hw},${base.y + ny * hw} ${base.x - nx * hw},${base.y - ny * hw}`} fill={color} />
      <text x={g.label.x} y={g.label.y} textAnchor={g.anchor} fontFamily={FONT} fontSize={12} fill={COLORS.text2} {...halo()}>
        <tspan x={g.label.x}>{title}</tspan>
        <tspan x={g.label.x} dy={15} fontFamily={MONO} fontSize={12} fill={COLORS.text}>
          {value}
        </tspan>
      </text>
    </g>
  );
}

function Badge({ g, status, text }: { g: BadgeGeom; status: Status; text: string }) {
  const color = STATUS[status];
  const w = text.length * 6.5 + 32;
  const x = g.x - w / 2;
  return (
    <g>
      <rect x={x} y={g.y - 12} width={w} height={24} rx={12} fill={COLORS.panel} stroke={color} strokeWidth={1.5} />
      <circle cx={x + 13} cy={g.y} r={8} fill={withAlpha(color, 0.22)} />
      <text x={x + 13} y={g.y + 4} textAnchor="middle" fontFamily={FONT} fontSize={11} fontWeight={700} fill={color}>
        {GLYPH[status]}
      </text>
      <text x={x + 26} y={g.y + 4} fontFamily={FONT} fontSize={12} fill={COLORS.text}>
        {text}
      </text>
    </g>
  );
}

function barPath(x: number, y: number, w: number, h: number): string {
  // Square start, rounded data end.
  const r = Math.min(h / 2, w);
  if (w <= 0) return '';
  return `M${x},${y} H${x + w - r} A${r},${r} 0 0 1 ${x + w - r},${y + h} H${x} Z`;
}

function Sparkline({ x, y, w, h, data, color, domain }: { x: number; y: number; w: number; h: number; data: number[]; color: string; domain?: [number, number] }) {
  const pts = data.filter((v) => Number.isFinite(v));
  if (data.length < 2 || !pts.length) return null;
  let lo = domain ? domain[0] : Math.min(...pts);
  let hi = domain ? domain[1] : Math.max(...pts);
  if (hi - lo < 1e-9) {
    lo -= 1;
    hi += 1;
  }
  const n = data.length;
  let d = '';
  let last: Pt | null = null;
  for (let i = 0; i < n; i++) {
    const v = data[i];
    if (!Number.isFinite(v)) continue;
    const px = x + (i / (n - 1)) * w;
    const py = y + h - ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * h;
    d += `${d ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`;
    last = { x: px, y: py };
  }
  return (
    <g aria-hidden="true">
      <line x1={x} y1={y + h + 0.5} x2={x + w} y2={y + h + 0.5} stroke={COLORS.grid} />
      <path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
      {last && <circle cx={last.x} cy={last.y} r={2.5} fill={color} />}
    </g>
  );
}

function Card({ box, title, tag, value, lines, gauge, spark, color }: {
  box: Box;
  title: string;
  tag?: string;
  value: string;
  lines: string[];
  gauge?: { frac: number; status: Status; word: string };
  spark?: { data: number[]; domain?: [number, number] };
  color: string;
}) {
  const { x, y, w, h } = box;
  const pad = 12;
  const gw = w - 2 * pad;
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={10} fill={COLORS.panel} stroke={withAlpha(color, 0.65)} strokeWidth={1.5} />
      <rect x={x} y={y + 10} width={3} height={h - 20} rx={1.5} fill={color} />
      <text x={x + pad} y={y + 20} fontFamily={FONT} fontSize={13} fontWeight={600} fill={COLORS.text}>
        {title}
      </text>
      {tag && (
        <text x={x + w - pad} y={y + 20} textAnchor="end" fontFamily={FONT} fontSize={10.5} fill={COLORS.muted} fontStyle="italic">
          {tag}
        </text>
      )}
      <text x={x + pad} y={y + 46} fontFamily={FONT} fontSize={21} fontWeight={650} fill={COLORS.text}>
        {value}
      </text>
      {gauge && (
        <g>
          <rect x={x + pad} y={y + 55} width={gw} height={8} rx={4} fill={COLORS.grid} />
          <path d={barPath(x + pad, y + 55, gw * Math.max(0, Math.min(1, gauge.frac)), 8)} fill={STATUS[gauge.status]} />
          <text x={x + w - pad} y={y + 46} textAnchor="end" fontFamily={FONT} fontSize={11} fill={STATUS[gauge.status]}>
            {GLYPH[gauge.status]} {gauge.word}
          </text>
        </g>
      )}
      {lines.map((l, i) => (
        <text key={i} x={x + pad} y={y + (gauge ? 81 : 70) + i * 15} fontFamily={FONT} fontSize={12} fill={COLORS.text2}>
          {l}
        </text>
      ))}
      {spark && <Sparkline x={x + pad} y={y + h - 30} w={gw} h={20} data={spark.data} domain={spark.domain} color={color} />}
    </g>
  );
}

function useWidth(ref: React.RefObject<HTMLElement>): number {
  const [w, setW] = useState(800);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.getBoundingClientRect().width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

/** Recorded series up to the displayed time, downsampled for sparklines. */
function history(t: number[], series: (i: number) => number, tMax: number, maxPts = 120): number[] {
  let n = t.length;
  while (n > 0 && t[n - 1] > tMax + 1e-9) n--;
  const out: number[] = [];
  const stride = Math.max(1, Math.ceil(n / maxPts));
  for (let i = 0; i < n; i += stride) out.push(series(i));
  if (n > 0 && (n - 1) % stride !== 0) out.push(series(n - 1));
  return out;
}

function maxOf(arr: number[] | undefined, abs = false): number {
  let m = 0;
  if (!arr) return m;
  for (const v of arr) {
    const a = abs ? Math.abs(v) : v;
    if (Number.isFinite(a) && a > m) m = a;
  }
  return m;
}

function signed(v: number, digits = 1): string {
  const s = Number(v.toFixed(digits));
  return `${s > 0 ? '+' : s < 0 ? '−' : ''}${Math.abs(s)}`;
}

export default function PopulationView({ runner, baseline }: ModelViewProps<PopulationState>) {
  const rootRef = useRef<HTMLDivElement>(null);
  const width = useWidth(rootRef);
  const s = runner.viewState;
  const p = runner.viewParams;
  const f = flowsOf(s, p);
  const ex = explainGrowth(f);
  const L = width >= 700 ? WIDE : NARROW;

  const samples = runner.core.samples;
  const obs = samples.obs;
  const tNow = runner.time;
  const popHist = history(samples.t, (i) => obs.population[i], tNow);
  const resHist = history(samples.t, (i) => obs.resource[i], tNow);
  const enHist = history(samples.t, (i) => obs.energySufficiency[i], tNow);
  const servedHist = history(samples.t, (i) => (obs.population[i] > 0 ? Math.min(100, (obs.infrastructure[i] / obs.population[i]) * 100) : 100), tNow);

  // Flow-thickness references: the largest value recorded in this run (so arrows shrink when flows shrink).
  const births = f.births * 1000;
  const deaths = f.deaths * 1000;
  const mig = f.migration * 1000;
  const popRef = Math.max(maxOf(obs.births), maxOf(obs.deaths), maxOf(obs.netMigration, true), births, deaths, Math.abs(mig));
  const resRef = Math.max(maxOf(obs.regeneration), maxOf(obs.harvest), f.regen, f.harvest);
  const energyUse = Math.min(s.E, f.energyDemand) / P_REF;
  const energyRef = Math.max(maxOf(obs.energySupply), energyUse);
  const infraRef = Math.max(0.1 * s.I, 1e-9);

  const resourcePct = (s.S / s.K) * 100;
  const needsPct = f.needsMet * 100;
  const energyPct = f.energySufficiency * 100;
  const servedPct = s.P > 0 ? Math.min(100, (s.I / s.P) * 100) : 100;
  const overshoot = f.msy > 0 ? f.demand / f.msy : NaN;
  const needsS = shareStatus(needsPct);
  const energyS = shareStatus(energyPct);
  const crowdS = crowdingStatus(f.crowding);
  const stockS = stockStatus(resourcePct);
  const overS = overshootStatus(overshoot);

  let baselineText: string | null = null;
  if (baseline && baseline.samples.t.length) {
    const bt = baseline.samples.t;
    let i = 0;
    while (i < bt.length - 1 && bt[i + 1] <= tNow + 1e-9) i++;
    const bp = baseline.samples.obs.population?.[i];
    if (Number.isFinite(bp)) baselineText = `baseline ${fmtSig(bp)} billion`;
  }

  const change = s.P0 > 0 ? (s.P / s.P0 - 1) * 100 : 0;
  const netRes = f.regen - f.harvest;
  const n = L.narrow;
  const dirGlyph = ex.direction === 'rising' ? '▲' : ex.direction === 'falling' ? '▼' : '■';
  const dirColor = ex.direction === 'rising' ? SERIES[0] : ex.direction === 'falling' ? SERIES[1] : COLORS.baseline;

  const budgetScale = Math.max(1, ...ex.terms.map((t) => Math.abs(t.permille)), Math.abs(ex.netPermille));
  const ariaSummary = `${ex.headline}. ${ex.detail} Population ${fmtSig(s.P)} billion. Resource stock ${fmtPct(resourcePct)} of capacity, needs met ${fmtPct(needsPct)}, energy sufficiency ${fmtPct(energyPct)}, crowding ratio ${fmtSig(f.crowding)}.`;

  return (
    <div className={styles.root} ref={rootRef}>
      <div className={styles.why} aria-live="polite">
        <div className={styles.whyHead}>
          <span className={styles.arrowGlyph} style={{ background: withAlpha(dirColor, 0.2), color: dirColor }} aria-hidden="true">
            {dirGlyph}
          </span>
          <span>
            Year {tNow.toFixed(tNow < 10 ? 1 : 0)} · {ex.headline}
          </span>
        </div>
        <p className={styles.whyText}>{ex.detail}</p>
      </div>

      <div className={styles.layout}>
        <svg
          className={`${styles.diagram} ${n ? styles.diagramNarrow : ''}`}
          viewBox={`0 0 ${L.W} ${L.H}`}
          role="img"
          aria-label={`Stock-and-flow diagram. ${ariaSummary}`}
        >
          {/* Flows into and out of the population. */}
          <Flow g={L.births} width={flowWidth(births, popRef)} color={POP_COLOR} title="Births" value={`${fmtSig(births)} M/yr`} />
          <Flow g={L.deaths} width={flowWidth(deaths, popRef)} color={DEATH_COLOR} title="Deaths" value={`${fmtSig(deaths)} M/yr`} />
          <Flow
            g={mig >= 0 ? L.migration : { ...L.migration, a: L.migration.b, b: L.migration.a }}
            width={flowWidth(Math.abs(mig), popRef)}
            color={mig >= 0 ? POP_COLOR : DEATH_COLOR}
            title={mig >= 0 ? 'Net migration in' : 'Net migration out'}
            value={`${fmtSig(Math.abs(mig))} M/yr`}
            dashed={Math.abs(mig) < 1e-9}
          />
          {/* Resource flows. */}
          <Flow g={L.regen} width={flowWidth(f.regen, resRef)} color={RES_COLOR} title="Regrowth" value={`${fmtSig(Math.max(0, f.regen))} RU/yr`} />
          <Flow g={L.harvest} width={flowWidth(f.harvest, resRef)} color={RES_COLOR} title="Harvest" value={`${fmtSig(f.harvest)} RU/yr`} />
          {/* Energy and infrastructure. */}
          <Flow g={L.energyPop} width={flowWidth(energyUse, energyRef)} color={ENERGY_COLOR} title="Energy use" value={`${fmtSig(energyUse)}× present`} />
          <Flow g={L.energyInfra} width={flowWidth(f.build, infraRef)} color={ENERGY_COLOR} title={n ? 'Builds' : 'Build'} value="" />
          <Flow g={L.infraPop} width={flowWidth(Math.min(s.I, s.P), Math.max(s.I, s.P, 1e-9))} color={INFRA_COLOR} title="Serves" value={`${fmtSig(Math.min(s.I, s.P))} bn`} />
          <Flow g={L.wear} width={flowWidth(f.depreciation, infraRef)} color={INFRA_COLOR} title="Wear-out" value={`${fmtSig(f.depreciation * 1000)} M/yr`} />

          <Card
            box={L.pop}
            title="Population"
            value={`${fmtSig(s.P)} billion`}
            lines={[`${signed(change)} % vs start`, baselineText ?? `net ${signed(births - deaths + mig, 0)} M/yr`]}
            spark={{ data: popHist }}
            color={POP_COLOR}
          />
          <Card
            box={L.res}
            title="Resources"
            tag="hypothetical"
            value={fmtPct(resourcePct)}
            gauge={{ frac: resourcePct / 100, ...stockS }}
            lines={[n ? 'of capacity K' : 'of capacity K (renewable stock)', `net ${signed(netRes, 2)} RU/yr`]}
            spark={{ data: resHist, domain: [0, 100] }}
            color={RES_COLOR}
          />
          <Card
            box={L.energy}
            title="Energy"
            tag="hypothetical"
            value={fmtPct(energyPct)}
            gauge={{ frac: energyPct / 100, ...energyS }}
            lines={[n ? 'of demand supplied' : 'of energy demand supplied', `supply ${fmtSig(s.E / P_REF)}× present`]}
            spark={{ data: enHist, domain: [0, 100] }}
            color={ENERGY_COLOR}
          />
          <Card
            box={L.infra}
            title="Infrastructure"
            tag="hypothetical"
            value={`${fmtSig(s.I)} bn`}
            gauge={{ frac: servedPct / 100, ...crowdS }}
            lines={[`serves ${fmtPct(servedPct)} of people`, `crowding ${Number.isFinite(f.crowding) ? f.crowding.toFixed(2) : '—'}`]}
            spark={{ data: servedHist, domain: [0, 100] }}
            color={INFRA_COLOR}
          />

          <Badge g={L.needsBadge} status={needsS.status} text={`Needs met ${fmtPct(needsPct)}`} />
          <Badge g={L.energyBadge} status={energyS.status} text={n ? `Energy ${fmtPct(energyPct)}` : `Energy sufficiency ${fmtPct(energyPct)}`} />
          <Badge g={L.crowdBadge} status={crowdS.status} text={`Crowding ${Number.isFinite(f.crowding) ? f.crowding.toFixed(2) : '—'}`} />
          <Badge g={L.overshootBadge} status={overS.status} text={`Demand ${Number.isFinite(overshoot) ? overshoot.toFixed(2) : '—'}× sustainable`} />
        </svg>

        <div className={styles.side}>
          <section className={styles.panel} aria-label="Rate budget">
            <h3 className={styles.panelTitle}>What changes the population now (‰ per year)</h3>
            <ul className={styles.budget}>
              {ex.terms.map((t) => {
                const frac = Math.min(1, Math.abs(t.permille) / budgetScale) * 50;
                const pos = t.permille >= 0;
                const color = t.key === 'births' || t.key === 'migration' ? (pos ? SERIES[0] : SERIES[1]) : t.key === 'deathBase' ? COLORS.baseline : SERIES[1];
                return (
                  <li key={t.key} className={styles.budgetRow} style={{ opacity: Math.abs(t.permille) < 0.05 ? 0.5 : 1 }}>
                    <span className={styles.budgetLabel}>{t.label}</span>
                    <span className={styles.budgetTrack} aria-hidden="true">
                      <span className={styles.budgetAxis} />
                      <span
                        className={styles.budgetBar}
                        style={{
                          left: pos ? '50%' : `${50 - frac}%`,
                          width: `${frac}%`,
                          background: color,
                          borderRadius: pos ? '0 5px 5px 0' : '5px 0 0 5px',
                        }}
                      />
                    </span>
                    <span className={styles.budgetValue}>{signed(t.permille)}‰</span>
                  </li>
                );
              })}
              <li className={`${styles.budgetRow} ${styles.budgetNet}`}>
                <span className={styles.budgetLabel}>Net change</span>
                <span className={styles.budgetTrack} aria-hidden="true">
                  <span className={styles.budgetAxis} />
                  <span
                    className={styles.budgetBar}
                    style={{
                      left: ex.netPermille >= 0 ? '50%' : `${50 - Math.min(1, Math.abs(ex.netPermille) / budgetScale) * 50}%`,
                      width: `${Math.min(1, Math.abs(ex.netPermille) / budgetScale) * 50}%`,
                      background: COLORS.text,
                      borderRadius: ex.netPermille >= 0 ? '0 5px 5px 0' : '5px 0 0 5px',
                    }}
                  />
                </span>
                <span className={styles.budgetValue}>{signed(ex.netPermille)}‰</span>
              </li>
            </ul>
            {ex.birthsSuppressed > 0.05 && (
              <p className={styles.note} style={{ marginTop: 8 }}>
                Scarcity is currently suppressing {signed(ex.birthsSuppressed).replace('+', '')}‰/yr of births (base birth rate {fmtSig(f.baseBirthRate * 1000)}‰).
              </p>
            )}
          </section>
          <section className={styles.panel} aria-label="How to read the diagram">
            <h3 className={styles.panelTitle}>Reading the diagram</h3>
            <ul className={styles.legendList}>
              <li>Boxes are stocks; arrows are flows. Arrow thickness follows the current flow relative to the largest value in this run.</li>
              <li>Badges are the feedback ratios: ✓ fine, ! strained, ▲ serious, ✕ critical.</li>
              <li>1 RU = the yearly resource needs of one billion people at present consumption.</li>
              <li>Resource, energy and infrastructure capacities are hypothetical model quantities, not measured data. This is a scenario model, not a forecast.</li>
            </ul>
          </section>
        </div>
      </div>
      <p className={styles.srOnly}>{ariaSummary}</p>
    </div>
  );
}
