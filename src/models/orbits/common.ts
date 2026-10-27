/**
 * Helpers shared by the orbital-mechanics models: the accuracy parameter,
 * allocation-free event trackers that run on every integrator sub-step, and
 * number formatting for event text (always built from computed values).
 */
import type { ChoiceParamDef, ParamValues, SimEvent } from '../../engine/types';
import { formatNumber } from '../../engine/units';
import { str } from '../../engine/validation';
import type { NBodyState } from './nbody';

// ---------------------------------------------------------------------------
// Accuracy

export const ETA: Record<string, number> = { draft: 0.03, standard: 0.01, high: 0.003 };

export function accuracyParam(group = 'Numerics'): ChoiceParamDef {
  return {
    key: 'accuracy',
    label: 'Integration accuracy',
    type: 'choice',
    kind: 'initial',
    group,
    numerics: true,
    default: 'standard',
    description:
      'Sets η, the fraction of the shortest orbital (or encounter) timescale used as the integrator sub-step. Smaller η is more accurate and slower; watch the relative energy error to judge accuracy.',
    options: [
      { value: 'draft', label: 'Draft (η = 0.03)', description: 'Fastest; energy errors around 10⁻³ in tight orbits.' },
      { value: 'standard', label: 'Standard (η = 0.01)', description: 'Good balance for most runs.' },
      { value: 'high', label: 'High (η = 0.003)', description: 'About 3× slower; errors roughly 10× smaller.' },
    ],
  };
}

export function etaFor(p: ParamValues): number {
  return ETA[str(p, 'accuracy')] ?? ETA.standard;
}

// ---------------------------------------------------------------------------
// Formatting (event text)

/** Format with significant figures, no fake precision. */
export function f(v: number, sig = 3): string {
  return formatNumber(Number.isFinite(v) ? Number(v.toPrecision(sig)) : v, sig);
}

/** "a – b" for a recorded range, or a single value when both ends agree at the shown precision. */
export function range(values: number[], sig = 3): string {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  return f(lo, sig) === f(hi, sig) ? f(lo, sig) : `${f(lo, sig)} – ${f(hi, sig)}`;
}

/** Thin out repeated events: report 1–10, then every 10th to 100, every 100th to 1000, … */
export function shouldReport(n: number): boolean {
  if (n <= 10) return true;
  const mag = Math.pow(10, Math.floor(Math.log10(n)));
  return n % mag === 0;
}

export function capWarning(sys: NBodyState, t: number, unitLabel: string): SimEvent | null {
  if (sys.capWarned || sys.capHits === 0) return null;
  sys.capWarned = true;
  return {
    t,
    id: 'substep-cap',
    label: 'Integrator sub-step limit reached',
    detail: `An extremely close or fast encounter needed more sub-steps than the per-step limit allows (first at ${f(t)} ${unitLabel}). The remainder of that step was taken in one jump, so accuracy is reduced there; check the energy error, or choose higher accuracy.`,
    severity: 'warning',
    source: 'model',
  };
}

// ---------------------------------------------------------------------------
// Trackers (plain data so they clone with the state; no allocation per update)

/**
 * Detects periapsis and apoapsis passages from the sign of the radial
 * velocity, with hysteresis so near-circular orbits (|ṙ| below a threshold
 * relative to the speed) do not generate spurious passages from round-off.
 */
export interface ApsisTracker {
  /** −1 approaching, +1 receding, 0 not yet established. */
  phase: number;
  minR: number;
  minT: number;
  maxR: number;
  maxT: number;
  periCount: number;
  apoCount: number;
  /** Distance and time of the passage reported by the last update. */
  lastR: number;
  lastT: number;
}

export function newApsisTracker(): ApsisTracker {
  return { phase: 0, minR: Infinity, minT: 0, maxR: 0, maxT: 0, periCount: 0, apoCount: 0, lastR: NaN, lastT: NaN };
}

/** Returns 1 at a periapsis passage, 2 at an apoapsis passage, otherwise 0. */
export function updateApsis(tr: ApsisTracker, r: number, rdot: number, v: number, t: number, relThreshold = 2e-4): number {
  if (r < tr.minR) {
    tr.minR = r;
    tr.minT = t;
  }
  if (r > tr.maxR) {
    tr.maxR = r;
    tr.maxT = t;
  }
  const thr = relThreshold * v;
  let code = 0;
  if (rdot > thr && tr.phase !== 1) {
    if (tr.phase === -1) {
      tr.periCount++;
      tr.lastR = tr.minR;
      tr.lastT = tr.minT;
      code = 1;
    }
    tr.phase = 1;
    tr.maxR = r;
    tr.maxT = t;
  } else if (rdot < -thr && tr.phase !== -1) {
    if (tr.phase === 1) {
      tr.apoCount++;
      tr.lastR = tr.maxR;
      tr.lastT = tr.maxT;
      code = 2;
    }
    tr.phase = -1;
    tr.minR = r;
    tr.minT = t;
  }
  return code;
}

/** Counts completed revolutions from the unwrapped polar angle around the primary. */
export interface OrbitCounter {
  prevTheta: number;
  prevT: number;
  /** Accumulated (signed) angle, rad. */
  swept: number;
  count: number;
  lastCrossT: number;
  /** Duration of the most recently completed revolution (time units of t). */
  lastPeriod: number;
}

export function newOrbitCounter(theta0: number, t0: number): OrbitCounter {
  return { prevTheta: theta0, prevT: t0, swept: 0, count: 0, lastCrossT: t0, lastPeriod: NaN };
}

/** Returns true when a revolution was completed during this update. */
export function updateOrbitCounter(c: OrbitCounter, theta: number, t: number): boolean {
  let d = theta - c.prevTheta;
  if (d > Math.PI) d -= 2 * Math.PI;
  else if (d < -Math.PI) d += 2 * Math.PI;
  const before = c.swept;
  c.swept += d;
  let done = false;
  const target = 2 * Math.PI * (c.count + 1);
  if (Math.abs(c.swept) >= target && d !== 0) {
    // Linear interpolation of the crossing time within the sub-step.
    const frac = (target - Math.abs(before)) / Math.abs(d);
    const tc = c.prevT + Math.min(1, Math.max(0, frac)) * (t - c.prevT);
    c.count++;
    c.lastPeriod = tc - c.lastCrossT;
    c.lastCrossT = tc;
    done = true;
  }
  c.prevTheta = theta;
  c.prevT = t;
  return done;
}

/** Local minima of a separation (e.g. closest approaches between two moons). */
export interface MinimumTracker {
  last: number;
  lastT: number;
  falling: boolean;
  count: number;
  /** Smallest value seen so far and when. */
  globalMin: number;
  globalMinT: number;
}

export function newMinimumTracker(): MinimumTracker {
  return { last: NaN, lastT: 0, falling: false, count: 0, globalMin: Infinity, globalMinT: NaN };
}

/** Returns true when the previous update was a local minimum (value in `last`/`lastT` before this call). */
export function updateMinimum(m: MinimumTracker, d: number, t: number, out: { d: number; t: number }): boolean {
  let hit = false;
  if (d < m.globalMin) {
    m.globalMin = d;
    m.globalMinT = t;
  }
  if (!Number.isNaN(m.last)) {
    if (d < m.last) m.falling = true;
    else if (d > m.last && m.falling) {
      m.falling = false;
      m.count++;
      out.d = m.last;
      out.t = m.lastT;
      hit = true;
    }
  }
  m.last = d;
  m.lastT = t;
  return hit;
}

/** Collision events are drained from the system by each model. */
export function drainCollisions(sys: NBodyState) {
  const out = sys.collisions;
  sys.collisions = [];
  return out;
}
