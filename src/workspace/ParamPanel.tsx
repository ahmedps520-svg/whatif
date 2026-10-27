import { useEffect, useMemo, useRef, useState } from 'react';
import type { NumberParamDef, ParamDef, ParamValue, ParamValues } from '../engine/types';
import { canConvert, convert, displayUnit, formatNumber, unitSymbol, type UnitSystem } from '../engine/units';
import { validateParam } from '../engine/validation';
import { Icon } from '../components/Icon';

interface Props {
  params: ParamDef[];
  values: ParamValues;
  baseline?: ParamValues | null;
  units: UnitSystem;
  onChange: (key: string, value: ParamValue) => void;
  /** Keys the user may not change (e.g. locked by a challenge). */
  locked?: string[];
  /** Restrict the slider range for some keys (Scenario Builder ranges). */
  ranges?: Record<string, [number, number]>;
  compact?: boolean;
}

const KIND_LABEL = {
  live: { text: 'live', title: 'Applies immediately from the current simulated time' },
  initial: { text: 'restarts', title: 'Initial condition: changing it restarts the run' },
  spawn: { text: 'next object', title: 'Used for objects you add next (e.g. the next launch)' },
};

function sliderToValue(def: NumberParamDef, pos: number, min: number, max: number): number {
  if (def.scale === 'log' && min > 0) return Math.exp(Math.log(min) + (Math.log(max) - Math.log(min)) * pos);
  return min + (max - min) * pos;
}

function valueToSlider(def: NumberParamDef, v: number, min: number, max: number): number {
  if (def.scale === 'log' && min > 0) return (Math.log(Math.max(v, min)) - Math.log(min)) / (Math.log(max) - Math.log(min));
  return (v - min) / (max - min || 1);
}

function snap(def: NumberParamDef, v: number): number {
  if (def.scale === 'log') return Number(v.toPrecision(3));
  const s = def.step;
  const snapped = Math.round(v / s) * s;
  const decimals = Math.max(0, -Math.floor(Math.log10(s)));
  return Number(snapped.toFixed(Math.min(decimals + 1, 10)));
}

function NumberControl({ def, value, baseline, units, onCommit, locked, range }: { def: NumberParamDef; value: number; baseline?: ParamValue; units: UnitSystem; onCommit: (v: number) => void; locked: boolean; range?: [number, number] }) {
  const dUnit = displayUnit(def.unit, units);
  const conv = canConvert(def.unit, dUnit) && dUnit !== def.unit;
  const toDisp = (v: number) => (conv ? convert(v, def.unit, dUnit) : v);
  const fromDisp = (v: number) => (conv ? convert(v, dUnit, def.unit) : v);
  const min = range ? Math.max(def.min, range[0]) : def.min;
  const max = range ? Math.min(def.max, range[1]) : def.max;
  const [draft, setDraft] = useState<number | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number>(0);
  const shown = draft ?? value;

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const commit = (v: number) => {
    window.clearTimeout(timer.current);
    setDraft(null);
    const { value: ok, message } = validateParam({ ...def, min, max }, v);
    setError(message ?? null);
    if (ok !== value) onCommit(ok as number);
  };

  const schedule = (v: number) => {
    setDraft(v);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => commit(v), 350);
  };

  const sym = unitSymbol(conv ? dUnit : def.unit);
  const fmt = (v: number) => formatNumber(toDisp(v), 4);

  return (
    <div className={`pc-number ${locked ? 'is-locked' : ''}`}>
      <div className="pc-row">
        <input
          type="range"
          min={0}
          max={1000}
          step={1}
          value={Math.round(valueToSlider(def, shown, min, max) * 1000)}
          disabled={locked}
          aria-label={def.label}
          aria-valuetext={`${fmt(shown)} ${sym}`}
          onChange={(e) => schedule(snap(def, sliderToValue(def, Number(e.target.value) / 1000, min, max)))}
          onPointerUp={() => draft !== null && commit(draft)}
          onKeyUp={() => draft !== null && commit(draft)}
        />
        <div className="pc-input">
          <input
            type="text"
            inputMode="decimal"
            value={text ?? String(Number(toDisp(shown).toPrecision(6)))}
            disabled={locked}
            aria-label={`${def.label} value${sym ? ` in ${sym}` : ''}`}
            onChange={(e) => setText(e.target.value)}
            onFocus={(e) => e.target.select()}
            onBlur={() => {
              if (text === null) return;
              const n = Number(text.replace(',', '.').replace('−', '-'));
              setText(null);
              if (!Number.isFinite(n)) {
                setError(`“${text}” is not a number.`);
                return;
              }
              commit(fromDisp(n));
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') {
                setText(null);
                (e.target as HTMLInputElement).blur();
              }
            }}
          />
          {sym && <span className="pc-unit">{sym}</span>}
        </div>
      </div>
      {def.marks && def.marks.length > 0 && !locked && (
        <div className="pc-marks">
          {def.marks
            .filter((m) => m.value >= min && m.value <= max)
            .map((m) => (
              <button key={m.label} className={`mark ${Math.abs(m.value - value) < 1e-9 ? 'on' : ''}`} onClick={() => commit(m.value)} title={`${fmt(m.value)} ${sym}`}>
                {m.label}
              </button>
            ))}
        </div>
      )}
      {baseline !== undefined && typeof baseline === 'number' && Math.abs(baseline - value) > 1e-12 && (
        <div className="pc-baseline">
          Baseline: {fmt(baseline)} {sym}
        </div>
      )}
      {error && (
        <div className="pc-error" role="status">
          {error}
        </div>
      )}
    </div>
  );
}

function ParamControl({ def, values, baseline, units, onChange, locked, range }: { def: ParamDef; values: ParamValues; baseline?: ParamValues | null; units: UnitSystem; onChange: Props['onChange']; locked: boolean; range?: [number, number] }) {
  const [open, setOpen] = useState(false);
  const kind = KIND_LABEL[def.kind];
  const value = values[def.key];
  const baseVal = baseline?.[def.key];
  return (
    <div className="param">
      <div className="param-head">
        <label className="param-label">
          {def.label}
          {locked && <Icon name="lock" size={12} title="Locked by the challenge rules" />}
        </label>
        <span className={`kind kind-${def.kind}`} title={kind.title}>
          {kind.text}
        </span>
        <button className="btn-icon tiny" aria-expanded={open} aria-label={`About ${def.label}`} onClick={() => setOpen(!open)}>
          <Icon name="info" size={14} />
        </button>
      </div>
      {open && <p className="param-desc">{def.description}</p>}
      {def.type === 'number' && <NumberControl def={def} value={Number(value)} baseline={baseVal} units={units} onCommit={(v) => onChange(def.key, v)} locked={locked} range={range} />}
      {def.type === 'choice' &&
        (def.options.length <= 3 ? (
          <div className="segmented" role="radiogroup" aria-label={def.label}>
            {def.options.map((o) => (
              <button key={o.value} role="radio" aria-checked={value === o.value} className={value === o.value ? 'on' : ''} disabled={locked} onClick={() => onChange(def.key, o.value)} title={o.description}>
                {o.label}
              </button>
            ))}
          </div>
        ) : (
          <select className="select" value={String(value)} disabled={locked} onChange={(e) => onChange(def.key, e.target.value)} aria-label={def.label}>
            {def.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ))}
      {def.type === 'choice' && def.options.find((o) => o.value === value)?.description && <p className="param-hint">{def.options.find((o) => o.value === value)!.description}</p>}
      {def.type === 'boolean' && (
        <label className="toggle">
          <input type="checkbox" checked={value === true} disabled={locked} onChange={(e) => onChange(def.key, e.target.checked)} />
          <span className="toggle-track" />
          <span>{value === true ? 'On' : 'Off'}</span>
        </label>
      )}
      {def.type !== 'number' && baseVal !== undefined && baseVal !== value && (
        <div className="pc-baseline">
          Baseline: {def.type === 'choice' ? def.options.find((o) => o.value === baseVal)?.label ?? String(baseVal) : baseVal ? 'On' : 'Off'}
        </div>
      )}
    </div>
  );
}

/** Grouped, validated parameter controls. Only parameters that matter for the current configuration are shown. */
export function ParamPanel({ params, values, baseline, units, onChange, locked = [], ranges, compact }: Props) {
  const groups = useMemo(() => {
    const visible = params.filter((p) => !p.visibleWhen || p.visibleWhen(values));
    const map = new Map<string, ParamDef[]>();
    for (const p of visible) {
      const g = p.group ?? 'Parameters';
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(p);
    }
    return [...map.entries()];
  }, [params, values]);

  return (
    <div className={`param-panel ${compact ? 'compact' : ''}`}>
      {groups.map(([name, defs]) => {
        const isNumerics = defs.every((d) => d.numerics);
        return (
          <details key={name} className="param-group" open={!isNumerics}>
            <summary>
              <span>{name}</span>
              <Icon name="chevronDown" size={14} />
            </summary>
            <div className="param-list">
              {defs.map((d) => (
                <ParamControl key={d.key} def={d} values={values} baseline={baseline} units={units} onChange={onChange} locked={locked.includes(d.key)} range={ranges?.[d.key]} />
              ))}
            </div>
          </details>
        );
      })}
    </div>
  );
}
