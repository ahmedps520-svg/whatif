import { useMemo } from 'react';
import type { ModelViewProps } from '../../views/types';
import { LineChart } from '../../components/LineChart';
import { COLORS, SERIES, STATUS } from '../../lib/palette';
import { atmosphereFor, compute, isaPressure, kAt, presentComposition, P_H2O_BODY, P_STD, type AtmosphereState } from './model';
import { str, num } from '../../engine/validation';
import styles from './View.module.css';

const GAS = [
  { key: 'N2' as const, label: 'N₂', color: SERIES[0] },
  { key: 'O2' as const, label: 'O₂', color: SERIES[1] },
  { key: 'other' as const, label: 'Ar + CO₂', color: SERIES[2] },
];

const REFS = [
  { h: 2500, label: 'Altitude illness common' },
  { h: 5100, label: 'Highest towns' },
  { h: 8000, label: '“Death zone”' },
];

function Bar({ label, comp, pressure, maxP }: { label: string; comp: { N2: number; O2: number; Ar: number; CO2: number }; pressure: number; maxP: number }) {
  const parts = { N2: comp.N2 * pressure, O2: comp.O2 * pressure, other: (comp.Ar + comp.CO2) * pressure };
  return (
    <div className={styles.barRow}>
      <span>{label}</span>
      <div className={styles.barTrack} style={{ width: `${(pressure / maxP) * 100}%` }} role="img" aria-label={`${label}: N₂ ${parts.N2.toFixed(1)} kPa, O₂ ${parts.O2.toFixed(1)} kPa, other ${parts.other.toFixed(2)} kPa`}>
        {GAS.map((g) => (
          <div key={g.key} className={styles.seg} style={{ flex: parts[g.key], background: g.color }}>
            {parts[g.key] / pressure > 0.08 ? `${g.label} ${parts[g.key].toFixed(1)}` : ''}
          </div>
        ))}
      </div>
      <span className="mono">{pressure.toFixed(1)} kPa</span>
    </div>
  );
}

/** Equivalent-altitude gauge: today's Earth from sea level to 10 km with reference points. */
function Gauge({ eqAlt }: { eqAlt: number }) {
  const H = 10000;
  const y = (h: number) => 290 - (Math.max(-500, Math.min(H, h)) / H) * 260;
  const off = eqAlt > H;
  return (
    <svg viewBox="0 0 170 310" role="img" aria-label={`Equivalent altitude ${Math.round(eqAlt)} metres`}>
      <path d={`M10 ${y(0)} L60 ${y(4200)} L85 ${y(3000)} L118 ${y(8848)} L160 ${y(0)} Z`} fill={COLORS.panel2} stroke={COLORS.axis} />
      <line x1="4" x2="166" y1={y(0)} y2={y(0)} stroke={COLORS.axis} />
      {[0, 2000, 4000, 6000, 8000, 10000].map((h) => (
        <g key={h}>
          <line x1="4" x2="12" y1={y(h)} y2={y(h)} stroke={COLORS.muted} />
          <text x="14" y={y(h) + 3} fill={COLORS.muted} fontSize="9" fontFamily="JetBrains Mono Variable, monospace">
            {h / 1000} km
          </text>
        </g>
      ))}
      {REFS.map((r) => (
        <g key={r.h}>
          <line x1="40" x2="166" y1={y(r.h)} y2={y(r.h)} stroke={STATUS.warning} strokeOpacity="0.45" />
          <text x="164" y={y(r.h) - 3} textAnchor="end" fill={COLORS.text2} fontSize="8.5">
            {r.label}
          </text>
        </g>
      ))}
      <g>
        <line x1="4" x2="166" y1={y(eqAlt)} y2={y(eqAlt)} stroke={COLORS.accent} strokeWidth="2" />
        <circle cx="96" cy={y(eqAlt)} r="5" fill={COLORS.accent} stroke={COLORS.bg} strokeWidth="2" />
        <text x="104" y={y(eqAlt) + 14} fill={COLORS.text} fontSize="10" fontWeight="600">
          {off ? '> 10 km' : `${(eqAlt / 1000).toFixed(2)} km`}
        </text>
      </g>
    </svg>
  );
}

export default function AtmosphereView({ runner, version }: ModelViewProps<AtmosphereState>) {
  const p = runner.viewParams;
  const t = runner.time;
  const k = kAt(p, t);
  const now = compute(p, k);
  const today = compute({ ...p, o2Amount: 100 }, 1);
  const todayAtm = atmosphereFor(1, 'remove', num(p, 'surfacePressure'));
  const maxP = Math.max(now.pressure, todayAtm.pressure);

  const profile = useMemo(() => {
    const hs: number[] = [];
    const a: number[] = [];
    const b: number[] = [];
    const x0 = presentComposition().O2;
    for (let h = 0; h <= 12000; h += 100) {
      const pISA = isaPressure(h);
      hs.push(h / 1000);
      a.push(Math.max(0, x0 * (pISA - P_H2O_BODY)));
      // Same pressure profile shape scaled to the new surface pressure (approximation).
      const pNow = pISA * (now.pressure / P_STD);
      b.push(Math.max(0, now.comp.O2 * (pNow - P_H2O_BODY)));
    }
    return { hs, a, b };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now.pressure, now.comp.O2, version]);

  return (
    <div className={styles.root}>
      <div className={styles.gauge}>
        <div className={styles.title}>Equivalent altitude today</div>
        <Gauge eqAlt={now.eqAlt} />
        <div className={styles.note}>Altitude on present-day Earth with the same inspired oxygen pressure (ICAO standard atmosphere). Reference lines are context, not predictions.</div>
      </div>
      <div className={styles.right}>
        <div className={styles.stats}>
          <div className={styles.stat}>
            <span>O₂ share</span>
            <b>{(now.comp.O2 * 100).toFixed(2)} %</b>
          </div>
          <div className={styles.stat}>
            <span>Surface pressure</span>
            <b>{now.pressure.toFixed(1)} kPa</b>
          </div>
          <div className={styles.stat}>
            <span>Inspired PO₂</span>
            <b>{now.piO2.toFixed(2)} kPa</b>
          </div>
          <div className={styles.stat}>
            <span>Alveolar PO₂ (est.)</span>
            <b>{((now.pAO2 * 1000) / 133.322).toFixed(0)} mmHg</b>
          </div>
        </div>
        <div>
          <div className={styles.title}>Partial pressures at sea level</div>
          <div className={styles.bars}>
            <Bar label="Today" comp={todayAtm.comp} pressure={todayAtm.pressure} maxP={maxP} />
            <Bar label={`Now · yr ${t.toFixed(1)}`} comp={now.comp} pressure={now.pressure} maxP={maxP} />
          </div>
          <div className={styles.legend}>
            {GAS.map((g) => (
              <span key={g.key}>
                <i className={styles.key} style={{ background: g.color }} /> {g.label}
              </span>
            ))}
            <span>Bar length = total pressure · {str(p, 'mode') === 'remove' ? 'oxygen removed outright' : 'oxygen replaced by nitrogen'}</span>
          </div>
        </div>
        <LineChart
          title="Inspired oxygen pressure versus altitude"
          subtitle="Where the horizontal line meets today’s curve is the equivalent altitude"
          series={[
            { id: 'today', label: 'Today’s atmosphere', x: profile.hs, y: profile.a, role: 'baseline' },
            { id: 'now', label: 'Current atmosphere', x: profile.hs, y: profile.b },
          ]}
          refLines={[{ y: now.piO2, label: `Current sea-level value ${now.piO2.toFixed(2)} kPa` }]}
          markers={REFS.map((r) => ({ x: r.h / 1000, label: r.label, severity: 'warning' as const }))}
          xLabel="Altitude (km)"
          yLabel="PᵢO₂ (kPa)"
          height={190}
          version={version}
          includeZero
          showTable={false}
        />
        <div className={styles.note}>
          Today at sea level: {today.piO2.toFixed(2)} kPa inspired. The current-atmosphere curve keeps today’s pressure profile shape scaled to the new surface pressure — an approximation.
        </div>
      </div>
    </div>
  );
}
