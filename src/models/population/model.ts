import type { DerivedQuantity, KeyResult, ParamValues, RunRecord, SimEvent, SimulationModel, Warning } from '../../engine/types';
import { bool, num } from '../../engine/validation';

/**
 * Population & Resource Simulator — a transparent stock-and-flow scenario model.
 *
 * Stocks: population P (billion), renewable resource S (resource units, RU),
 * energy supply capacity E (energy units per year, EU/yr) and infrastructure
 * capacity I (billion people it can serve). Every feedback is an explicit,
 * documented formula with an adjustable strength. Time is in years; the stocks
 * are integrated together with classical RK4, sub-stepped for stability.
 *
 * Units used internally:
 *  - 1 RU  = the resource needs of one billion people for one year at the
 *            present average consumption (consumption multiplier c = 1).
 *  - 1 EU  = the energy needs of one billion people for one year at c = 1 with
 *            resources as accessible as at the start of the run.
 * Resource, energy and infrastructure capacities are hypothetical model
 * quantities, not measured data.
 */

/** Present world population used as the reference for "relative to present demand" (billion, rounded UN WPP value). */
export const P_REF = 8.1;
/** Infrastructure is built toward this multiple of the current population (10 % spare capacity). */
export const HEADROOM = 1.1;
/** Relative change in P needed to confirm a peak or trough (hysteresis against numerical noise). */
const TURN_TOL = 1e-3;
const MAX_TURNS_REPORTED = 4;
/** Stability target for the sub-step: (largest per-unit rate) × h ≤ this. */
const SUBSTEP_RATE_DT = 0.25;

export interface PopulationState {
  t: number;
  /** Population, billion people. */
  P: number;
  /** Renewable resource stock, RU. */
  S: number;
  /** Energy supply capacity, EU/yr. */
  E: number;
  /** Infrastructure capacity, billion people served. */
  I: number;
  /** Cumulative flows since t = 0 (billion people or RU). Used for mass-balance checks and totals. */
  cumBirths: number;
  cumDeaths: number;
  cumMigration: number;
  cumOutbreakDeaths: number;
  cumRegen: number;
  cumHarvest: number;
  /** Fixed at t = 0. */
  P0: number;
  S0: number;
  K: number;
  /** Peak / trough tracking. */
  trend: -1 | 0 | 1;
  extP: number;
  extT: number;
  extNeeds: number;
  extResource: number;
  turnsReported: number;
  turnsCapped: boolean;
  outbreakStarted: boolean;
  outbreakEnded: boolean;
  outbreakCumAtStart: number;
  pending: SimEvent[];
}

/** Every flow and ratio of the model at one instant. Rates are per year (fractions, not ‰). */
export interface PopulationFlows {
  /** Resource demand D = c·P (RU/yr). */
  demand: number;
  /** Physical extraction limit A = h·S (RU/yr). */
  availability: number;
  /** Harvest H = min(D, A) (RU/yr). */
  harvest: number;
  /** f_S = H / D. */
  needsMet: number;
  /** Logistic regeneration (RU/yr). */
  regen: number;
  /** Maximum sustainable yield (1 − ε)·r·K/4 (RU/yr). */
  msy: number;
  /** Energy demand (EU/yr). */
  energyDemand: number;
  /** f_E = min(1, E / D_E). */
  energySufficiency: number;
  /** P / I (NaN when there is no infrastructure). */
  crowding: number;
  /** Share of people the infrastructure cannot serve: max(0, 1 − I/P). */
  unserved: number;
  birthRate: number;
  /** Birth rate with no scarcity (the parameter). */
  baseBirthRate: number;
  deathBase: number;
  deathOutbreak: number;
  deathScarcity: number;
  deathCrowding: number;
  deathEnergy: number;
  deathRate: number;
  migrationRate: number;
  births: number;
  deaths: number;
  migration: number;
  /** Infrastructure building and wear-out (billion people of capacity per year). */
  build: number;
  depreciation: number;
  outbreakActive: boolean;
  dP: number;
  dS: number;
  dE: number;
  dI: number;
}

function clamp01(v: number) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Resource carrying capacity K (RU) such that the maximum sustainable yield r·K/4 supplies `sustainablePop` billion people at c = 1. */
export function capacityK(p: ParamValues): number {
  return (4 * num(p, 'sustainablePop')) / (num(p, 'regenRate') / 100);
}

export function computeFlows(t: number, P: number, S: number, E: number, I: number, st: { K: number; S0: number }, p: ParamValues): PopulationFlows {
  const c = num(p, 'consumption');
  const r = num(p, 'regenRate') / 100;
  const h = num(p, 'maxExtraction') / 100;
  const eps = num(p, 'stress') / 100;
  const alpha = num(p, 'depletionEnergy');
  const K = st.K;

  const Pp = Math.max(P, 0);
  const Sp = Math.max(S, 0);
  const demand = c * Pp;
  const availability = h * Sp;
  const harvest = Math.min(demand, availability);
  const needsMet = demand > 0 ? harvest / demand : 1;
  const regen = (1 - eps) * r * Sp * (1 - Sp / K);
  const msy = ((1 - eps) * r * K) / 4;

  const depletion = Math.max(0, st.S0 - Sp) / K;
  const energyDemand = c * Pp * (1 + alpha * depletion);
  const energySufficiency = energyDemand > 0 ? Math.min(1, Math.max(E, 0) / energyDemand) : 1;

  const Ip = Math.max(I, 0);
  const crowding = Ip > 1e-12 ? Pp / Ip : NaN;
  const unserved = Pp > 0 ? clamp01(1 - Ip / Pp) : 0;

  const fb = bool(p, 'feedbacks') ? 1 : 0;
  const baseBirthRate = num(p, 'birthRate') / 1000;
  const birthRate = baseBirthRate * Math.max(0, 1 - fb * num(p, 'birthSensitivity') * (1 - needsMet));

  let outbreakActive = false;
  if (bool(p, 'outbreak')) {
    const start = num(p, 'outbreakStart');
    outbreakActive = t >= start && t < start + num(p, 'outbreakDuration');
  }
  const deathBase = num(p, 'deathRate') / 1000;
  const deathOutbreak = outbreakActive ? num(p, 'outbreakMortality') / 1000 : 0;
  const deathScarcity = (fb * num(p, 'scarcityMortality') * (1 - needsMet)) / 1000;
  const deathCrowding = (fb * num(p, 'crowdingMortality') * unserved) / 1000;
  const deathEnergy = (fb * num(p, 'energyMortality') * (1 - energySufficiency)) / 1000;
  const deathRate = deathBase + deathOutbreak + deathScarcity + deathCrowding + deathEnergy;
  const migrationRate = num(p, 'migration') / 1000;

  const births = birthRate * Pp;
  const deaths = deathRate * Pp;
  const migration = migrationRate * Pp;

  const beta = num(p, 'buildRate') / 100;
  const delta = num(p, 'depreciation') / 100;
  const target = HEADROOM * Pp;
  const build = energySufficiency * (delta * Math.min(Ip, target) + beta * Math.max(0, target - Ip));
  const depreciation = delta * Ip;

  return {
    demand,
    availability,
    harvest,
    needsMet,
    regen,
    msy,
    energyDemand,
    energySufficiency,
    crowding,
    unserved,
    birthRate,
    baseBirthRate,
    deathBase,
    deathOutbreak,
    deathScarcity,
    deathCrowding,
    deathEnergy,
    deathRate,
    migrationRate,
    births,
    deaths,
    migration,
    build,
    depreciation,
    outbreakActive,
    dP: births - deaths + migration,
    dS: regen - harvest,
    dE: (num(p, 'energyGrowth') / 100) * Math.max(E, 0),
    dI: build - depreciation,
  };
}

/** Flows at the state's own time. */
export function flowsOf(s: PopulationState, p: ParamValues): PopulationFlows {
  return computeFlows(s.t, s.P, s.S, s.E, s.I, s, p);
}

// State vector for RK4: [P, S, E, I, cumBirths, cumDeaths, cumMigration, cumOutbreak, cumRegen, cumHarvest]
const NV = 10;

function deriv(t: number, y: number[], s: PopulationState, p: ParamValues, out: number[]) {
  const f = computeFlows(t, y[0], y[1], y[2], y[3], s, p);
  out[0] = f.dP;
  out[1] = f.dS;
  out[2] = f.dE;
  out[3] = f.dI;
  out[4] = f.births;
  out[5] = f.deaths;
  out[6] = f.migration;
  out[7] = f.deathOutbreak * Math.max(y[0], 0);
  out[8] = f.regen;
  out[9] = f.harvest;
}

const k1 = new Array<number>(NV).fill(0);
const k2 = new Array<number>(NV).fill(0);
const k3 = new Array<number>(NV).fill(0);
const k4 = new Array<number>(NV).fill(0);
const yt = new Array<number>(NV).fill(0);

function rk4(s: PopulationState, p: ParamValues, h: number) {
  const y = [s.P, s.S, s.E, s.I, s.cumBirths, s.cumDeaths, s.cumMigration, s.cumOutbreakDeaths, s.cumRegen, s.cumHarvest];
  const t = s.t;
  deriv(t, y, s, p, k1);
  for (let i = 0; i < NV; i++) yt[i] = y[i] + 0.5 * h * k1[i];
  deriv(t + 0.5 * h, yt, s, p, k2);
  for (let i = 0; i < NV; i++) yt[i] = y[i] + 0.5 * h * k2[i];
  deriv(t + 0.5 * h, yt, s, p, k3);
  for (let i = 0; i < NV; i++) yt[i] = y[i] + h * k3[i];
  deriv(t + h, yt, s, p, k4);
  for (let i = 0; i < NV; i++) y[i] += (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
  // Numerical guard only: the exact solution cannot go negative (every outflow is proportional to its stock).
  s.P = Math.max(0, y[0]);
  s.S = Math.max(0, y[1]);
  s.E = Math.max(0, y[2]);
  s.I = Math.max(0, y[3]);
  s.cumBirths = y[4];
  s.cumDeaths = y[5];
  s.cumMigration = y[6];
  s.cumOutbreakDeaths = y[7];
  s.cumRegen = y[8];
  s.cumHarvest = y[9];
}

/** Upper bound on any per-unit rate (1/yr), used to choose the sub-step. */
function rateBound(p: ParamValues): number {
  const permille =
    Math.abs(num(p, 'birthRate')) +
    num(p, 'deathRate') +
    (bool(p, 'outbreak') ? num(p, 'outbreakMortality') : 0) +
    (bool(p, 'feedbacks') ? num(p, 'scarcityMortality') + num(p, 'crowdingMortality') + num(p, 'energyMortality') : 0) +
    Math.abs(num(p, 'migration'));
  const percent = num(p, 'maxExtraction') + num(p, 'regenRate') + Math.abs(num(p, 'energyGrowth')) + num(p, 'buildRate') + num(p, 'depreciation');
  return permille / 1000 + percent / 100;
}

// ---------- formatting helpers (text is always built from computed values) ----------

export function fmtSig(v: number, sig = 3): string {
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1000) return Math.round(v).toLocaleString('en-US');
  return Number(v.toPrecision(sig)).toString();
}

export function fmtPct(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 10) return `${Math.round(v)} %`;
  return `${Number(v.toFixed(1))} %`;
}

function fmtYear(t: number): string {
  return Math.abs(t - Math.round(t)) < 0.05 ? String(Math.round(t)) : t.toFixed(1);
}

function fmtPermille(v: number): string {
  return `${Number(v.toFixed(1))}‰`;
}

// ---------- explanation of the current growth (used by the view and milestones) ----------

export interface GrowthTerm {
  key: 'births' | 'migration' | 'deathBase' | 'deathOutbreak' | 'deathScarcity' | 'deathCrowding' | 'deathEnergy';
  label: string;
  /** Contribution to the net growth rate, ‰ per year (signed). */
  permille: number;
}

export interface GrowthExplanation {
  direction: 'rising' | 'falling' | 'stable';
  netPermille: number;
  terms: GrowthTerm[];
  /** Births suppressed by scarcity, ‰/yr (b0 − b_eff). */
  birthsSuppressed: number;
  /** Largest pressure term, if any acts. */
  dominantPressure: { label: string; permille: number } | null;
  headline: string;
  detail: string;
}

export function explainGrowth(f: PopulationFlows): GrowthExplanation {
  const pm = (v: number) => v * 1000;
  const terms: GrowthTerm[] = [
    { key: 'births', label: 'Births', permille: pm(f.birthRate) },
    { key: 'migration', label: 'Net migration', permille: pm(f.migrationRate) },
    { key: 'deathBase', label: 'Base deaths', permille: -pm(f.deathBase) },
    { key: 'deathOutbreak', label: 'Outbreak deaths', permille: -pm(f.deathOutbreak) },
    { key: 'deathScarcity', label: 'Scarcity deaths', permille: -pm(f.deathScarcity) },
    { key: 'deathCrowding', label: 'Overcrowding deaths', permille: -pm(f.deathCrowding) },
    { key: 'deathEnergy', label: 'Energy-shortage deaths', permille: -pm(f.deathEnergy) },
  ];
  const net = terms.reduce((a, b) => a + b.permille, 0);
  const birthsSuppressed = pm(f.baseBirthRate - f.birthRate);
  const pressures = [
    { label: 'resource scarcity raising deaths', permille: pm(f.deathScarcity) },
    { label: 'scarcity reducing births', permille: birthsSuppressed },
    { label: 'overcrowded infrastructure', permille: pm(f.deathCrowding) },
    { label: 'energy shortage', permille: pm(f.deathEnergy) },
    { label: 'the disease outbreak', permille: pm(f.deathOutbreak) },
  ].sort((a, b) => b.permille - a.permille);
  const dominantPressure = pressures[0].permille > 0.05 ? pressures[0] : null;
  const direction: GrowthExplanation['direction'] = net > 0.05 ? 'rising' : net < -0.05 ? 'falling' : 'stable';
  const b = pm(f.birthRate);
  const d = pm(f.deathRate);
  const m = pm(f.migrationRate);
  const migText = Math.abs(m) > 0.05 ? ` and net migration adds ${fmtPermille(m)}` : '';
  let headline: string;
  let detail: string;
  if (direction === 'rising') {
    headline = `Population is rising (${net > 0 ? '+' : ''}${fmtPermille(net)} per year)`;
    detail = `Births (${fmtPermille(b)}) outnumber deaths (${fmtPermille(d)})${migText}.`;
    detail += dominantPressure
      ? ` The strongest brake right now is ${dominantPressure.label} (${fmtPermille(dominantPressure.permille)}).`
      : ' No scarcity, crowding, energy or disease pressure is acting now.';
  } else if (direction === 'falling') {
    headline = `Population is falling (${fmtPermille(net)} per year)`;
    detail = dominantPressure
      ? `Deaths (${fmtPermille(d)}) exceed births (${fmtPermille(b)})${migText}, mainly because of ${dominantPressure.label} (${fmtPermille(dominantPressure.permille)}).`
      : `Deaths (${fmtPermille(d)}) exceed births (${fmtPermille(b)})${migText}: the base rates alone produce decline.`;
  } else {
    headline = 'Population is roughly stable';
    detail = `Births (${fmtPermille(b)}) balance deaths (${fmtPermille(d)})${migText}.`;
    if (dominantPressure) detail += ` The balance is held by ${dominantPressure.label} (${fmtPermille(dominantPressure.permille)}).`;
  }
  return { direction, netPermille: net, terms, birthsSuppressed, dominantPressure, headline, detail };
}

// ---------- events tracked during stepping ----------

function trackTurns(s: PopulationState, p: ParamValues) {
  const P = s.P;
  const record = () => {
    const f = flowsOf(s, p);
    s.extNeeds = f.needsMet;
    s.extResource = s.S / s.K;
  };
  const report = (kind: 'peak' | 'trough') => {
    if (s.turnsReported >= MAX_TURNS_REPORTED * 2) {
      if (!s.turnsCapped) {
        s.turnsCapped = true;
        s.pending.push({ t: s.extT, id: 'turns-capped', label: 'Population keeps oscillating', detail: 'Further peaks and troughs are not listed; see the population chart.', severity: 'info', source: 'model' });
      }
      return;
    }
    s.turnsReported++;
    const pctChange = (s.extP / s.P0 - 1) * 100;
    const cond = `At that moment needs met were ${fmtPct(s.extNeeds * 100)} and the resource stock was ${fmtPct(s.extResource * 100)} of capacity.`;
    if (kind === 'peak') {
      s.pending.push({
        t: s.extT,
        id: `peak-${s.turnsReported}`,
        label: `Population peaked at ${fmtSig(s.extP)} billion`,
        detail: `Year ${fmtYear(s.extT)} (${pctChange >= 0 ? '+' : ''}${fmtPct(pctChange)} vs start). Growth then turned negative: deaths exceeded births plus net migration. ${cond}`,
        severity: 'milestone',
        source: 'model',
      });
    } else {
      s.pending.push({
        t: s.extT,
        id: `trough-${s.turnsReported}`,
        label: `Population bottomed out at ${fmtSig(s.extP)} billion`,
        detail: `Year ${fmtYear(s.extT)} (${pctChange >= 0 ? '+' : ''}${fmtPct(pctChange)} vs start). Growth then turned positive again. ${cond}`,
        severity: 'info',
        source: 'model',
      });
    }
  };
  if (s.trend === 0) {
    if (P > s.extP * (1 + TURN_TOL)) {
      s.trend = 1;
      s.extP = P;
      s.extT = s.t;
      record();
    } else if (P < s.extP * (1 - TURN_TOL)) {
      s.trend = -1;
      s.extP = P;
      s.extT = s.t;
      record();
    }
  } else if (s.trend === 1) {
    if (P >= s.extP) {
      s.extP = P;
      s.extT = s.t;
      record();
    } else if (P < s.extP * (1 - TURN_TOL)) {
      report('peak');
      s.trend = -1;
      s.extP = P;
      s.extT = s.t;
      record();
    }
  } else {
    if (P <= s.extP) {
      s.extP = P;
      s.extT = s.t;
      record();
    } else if (P > s.extP * (1 + TURN_TOL)) {
      report('trough');
      s.trend = 1;
      s.extP = P;
      s.extT = s.t;
      record();
    }
  }
}

function outbreakEvents(s: PopulationState, p: ParamValues) {
  if (!bool(p, 'outbreak')) return;
  const start = num(p, 'outbreakStart');
  const dur = num(p, 'outbreakDuration');
  const mort = num(p, 'outbreakMortality');
  if (!s.outbreakStarted && s.t >= start) {
    s.outbreakStarted = true;
    s.outbreakCumAtStart = s.cumOutbreakDeaths;
    s.pending.push({
      t: start,
      id: 'outbreak-start',
      label: 'Disease outbreak begins',
      detail: `Extra mortality of ${fmtPermille(mort)} per year for ${fmtSig(dur)} years, on top of the base death rate. Population at onset ≈ ${fmtSig(s.P)} billion.`,
      severity: 'warning',
      source: 'model',
    });
  }
  if (s.outbreakStarted && !s.outbreakEnded && s.t >= start + dur) {
    s.outbreakEnded = true;
    const extra = (s.cumOutbreakDeaths - s.outbreakCumAtStart) * 1000;
    s.pending.push({
      t: start + dur,
      id: 'outbreak-end',
      label: 'Disease outbreak ends',
      detail: `About ${fmtSig(extra, 2)} million extra deaths in the model over the outbreak; population now ${fmtSig(s.P)} billion.`,
      severity: 'info',
      source: 'model',
    });
  }
}

function initialState(p: ParamValues): PopulationState {
  const K = capacityK(p);
  const P0 = num(p, 'P0');
  const S0 = (num(p, 'resource0') / 100) * K;
  return {
    t: 0,
    P: P0,
    S: S0,
    E: num(p, 'energySupply') * P_REF,
    I: num(p, 'infrastructure0'),
    cumBirths: 0,
    cumDeaths: 0,
    cumMigration: 0,
    cumOutbreakDeaths: 0,
    cumRegen: 0,
    cumHarvest: 0,
    P0,
    S0,
    K,
    trend: 0,
    extP: P0,
    extT: 0,
    extNeeds: 1,
    extResource: S0 / K,
    turnsReported: 0,
    turnsCapped: false,
    outbreakStarted: false,
    outbreakEnded: false,
    outbreakCumAtStart: 0,
    pending: [],
  };
}

function sampleInterval(p: ParamValues): number {
  const d = num(p, 'duration');
  const base = d <= 100 ? 0.25 : d <= 250 ? 0.5 : d <= 500 ? 1 : 2;
  return Math.max(num(p, 'dt'), base);
}

const feedbackOn = (p: ParamValues) => bool(p, 'feedbacks');
const outbreakOn = (p: ParamValues) => bool(p, 'outbreak');

export const populationModel: SimulationModel<PopulationState> = {
  id: 'population',
  name: 'Population & Resource Simulator',
  shortName: 'Population',
  domain: 'population',
  viewKind: '2d',
  summary:
    'A transparent stock-and-flow scenario model: population draws on a regenerating resource, an energy supply and infrastructure, and explicit feedbacks change birth and death rates when needs go unmet. It explores mechanisms, not predictions.',
  params: [
    // Population
    { key: 'P0', label: 'Initial population', type: 'number', unit: 'billion', kind: 'initial', group: 'Population', min: 0.01, max: 40, step: 0.01, default: 8.1, scale: 'log', description: 'Population at t = 0. The default ≈8.1 billion is rounded from UN World Population Prospects estimates for the early 2020s.', marks: [
      { value: 1, label: '≈1800' }, { value: 2.5, label: '≈1950' }, { value: 8.1, label: 'Today (rounded)' }, { value: 16.2, label: 'Doubled' },
    ] },
    { key: 'birthRate', label: 'Crude birth rate (needs fully met)', type: 'number', unit: 'permille/yr', kind: 'live', group: 'Population', min: 0, max: 60, step: 0.5, default: 17, description: 'Births per 1,000 people per year when needs are fully met. ≈17‰ is the rounded world value for the early 2020s (UN World Population Prospects). Scarcity lowers it through the birth feedback.' },
    { key: 'deathRate', label: 'Crude death rate (base)', type: 'number', unit: 'permille/yr', kind: 'live', group: 'Population', min: 1, max: 60, step: 0.5, default: 8, description: 'Deaths per 1,000 people per year with no scarcity, crowding, energy shortage or outbreak. ≈8‰ is the rounded world value for the early 2020s (UN World Population Prospects).' },
    { key: 'migration', label: 'Net migration rate', type: 'number', unit: 'permille/yr', kind: 'live', group: 'Population', min: -30, max: 30, step: 0.5, default: 0, description: 'Net arrivals per 1,000 people per year. For the whole world it is zero by definition; non-zero values treat the population as a region gaining (+) or losing (−) people.' },
    // Resources
    { key: 'sustainablePop', label: 'Resource capacity: max sustainable population', type: 'number', unit: 'billion', kind: 'initial', group: 'Resources', min: 0.5, max: 200, step: 0.1, default: 12, scale: 'log', description: 'Hypothetical model quantity, not a measured carrying capacity: the largest population (at present consumption, no environmental stress) whose needs the renewable resource can supply indefinitely. That maximum is reached with the stock held at half its capacity.' },
    { key: 'regenRate', label: 'Resource regeneration rate', type: 'number', unit: '%/yr', kind: 'initial', group: 'Resources', min: 0.5, max: 50, step: 0.5, default: 5, description: 'Intrinsic logistic growth rate r of the resource stock. Faster regeneration means a smaller stock delivers the same sustainable yield, so it buffers less overuse.' },
    { key: 'resource0', label: 'Initial resource level', type: 'number', unit: '%', kind: 'initial', group: 'Resources', min: 1, max: 100, step: 1, default: 70, description: 'Starting stock as a percentage of the resource capacity K (hypothetical).' },
    { key: 'maxExtraction', label: 'Maximum extraction rate', type: 'number', unit: '%/yr', kind: 'live', group: 'Resources', min: 0.5, max: 100, step: 0.5, default: 4, description: 'At most this share of the remaining stock can be harvested per year — a stand-in for how accessible the resource is. Needs go unmet once demand exceeds it. If it exceeds the regeneration rate, a depleted stock can be mined to exhaustion; if it is lower, a depleted stock recovers toward K·(1 − h/r).', marks: [{ value: 4, label: 'Below regeneration' }, { value: 10, label: 'Above regeneration' }] },
    { key: 'consumption', label: 'Consumption per person', type: 'number', unit: 'x', kind: 'live', group: 'Resources', min: 0.1, max: 5, step: 0.05, default: 1, description: 'Multiplier on resource and energy needs per person, relative to the present average (1×).' },
    { key: 'stress', label: 'Environmental stress', type: 'number', unit: '%', kind: 'live', group: 'Resources', min: 0, max: 90, step: 1, default: 0, description: 'Reduces the resource’s regeneration by this percentage — an abstract stand-in for pollution, climate change or land degradation, none of which are modelled explicitly.' },
    // Energy
    { key: 'energySupply', label: 'Energy supply (relative to present demand)', type: 'number', unit: 'x', kind: 'initial', group: 'Energy', min: 0.1, max: 50, step: 0.05, default: 1, scale: 'log', description: 'Energy supply capacity at t = 0. 1× meets the needs of ≈8.1 billion people at present consumption — a hypothetical capacity, not a measured value.', marks: [{ value: 1, label: 'Present (1×)' }, { value: 10, label: '10×' }] },
    { key: 'energyGrowth', label: 'Energy supply growth', type: 'number', unit: '%/yr', kind: 'live', group: 'Energy', min: -5, max: 10, step: 0.1, default: 1, description: 'Yearly growth of the energy supply capacity. A round illustrative value; world primary energy use has grown by very roughly 1–2 % per year in recent decades.' },
    { key: 'depletionEnergy', label: 'Depletion → extra energy demand', type: 'number', unit: '1', kind: 'live', group: 'Energy', min: 0, max: 5, step: 0.1, default: 1, description: 'How much more energy each person needs as the resource is depleted below its starting level (harder-to-reach sources). 1 means +100 % energy demand if the whole capacity K were depleted; 0 switches the coupling off.' },
    // Infrastructure
    { key: 'infrastructure0', label: 'Infrastructure capacity', type: 'number', unit: 'billion', kind: 'initial', group: 'Infrastructure', min: 0.1, max: 100, step: 0.1, default: 9, scale: 'log', description: 'Hypothetical number of people that housing, water, sanitation, transport and health systems can serve at t = 0.' },
    { key: 'buildRate', label: 'Infrastructure build rate', type: 'number', unit: '%/yr', kind: 'live', group: 'Infrastructure', min: 0, max: 50, step: 0.5, default: 10, description: 'Share of the gap between capacity and 110 % of the population that is closed per year when energy is sufficient (reduced in proportion to energy sufficiency).' },
    { key: 'depreciation', label: 'Infrastructure depreciation', type: 'number', unit: '%/yr', kind: 'live', group: 'Infrastructure', min: 0, max: 10, step: 0.1, default: 2, description: 'Share of capacity that wears out per year unless maintained (2 %/yr ≈ a 50-year lifetime). Maintenance also needs energy.' },
    // Disease
    { key: 'outbreak', label: 'Disease outbreak', type: 'boolean', kind: 'live', group: 'Disease', default: false, description: 'Add a period of extra mortality (a stylised epidemic).' },
    { key: 'outbreakStart', label: 'Outbreak starts in year', type: 'number', unit: 'yr', kind: 'live', group: 'Disease', min: 0, max: 1000, step: 1, default: 20, description: 'Model year in which the outbreak begins.', visibleWhen: outbreakOn },
    { key: 'outbreakDuration', label: 'Outbreak duration', type: 'number', unit: 'yr', kind: 'live', group: 'Disease', min: 0.1, max: 30, step: 0.1, default: 3, description: 'How long the extra mortality lasts.', visibleWhen: outbreakOn },
    { key: 'outbreakMortality', label: 'Extra mortality during the outbreak', type: 'number', unit: 'permille/yr', kind: 'live', group: 'Disease', min: 0, max: 200, step: 0.5, default: 10, description: 'Additional deaths per 1,000 people per year while the outbreak lasts (a constant, illustrative value).', visibleWhen: outbreakOn },
    // Feedback strength
    { key: 'feedbacks', label: 'Feedbacks on births and deaths', type: 'boolean', kind: 'live', group: 'Feedback strength', default: true, description: 'When off, scarcity, crowding and energy shortage no longer change birth or death rates (the resource is still drawn down), so population grows exponentially at b − d + m.' },
    { key: 'birthSensitivity', label: 'Scarcity → fewer births', type: 'number', unit: '1', kind: 'live', group: 'Feedback strength', min: 0, max: 3, step: 0.05, default: 1, description: 'Birth rate is multiplied by max(0, 1 − σ_b·(1 − needs met)). 1 means births fall in proportion to unmet needs. Illustrative, not calibrated.', visibleWhen: feedbackOn },
    { key: 'scarcityMortality', label: 'Scarcity → extra deaths', type: 'number', unit: 'permille/yr', kind: 'live', group: 'Feedback strength', min: 0, max: 500, step: 1, default: 100, description: 'Extra deaths per 1,000 per year if no needs at all were met; scales linearly with the unmet share. Illustrative, not calibrated.', visibleWhen: feedbackOn },
    { key: 'crowdingMortality', label: 'Overcrowding → extra deaths', type: 'number', unit: 'permille/yr', kind: 'live', group: 'Feedback strength', min: 0, max: 200, step: 1, default: 20, description: 'Extra deaths per 1,000 per year if nobody could be served by infrastructure; scales with the unserved share max(0, 1 − I/P). Illustrative, not calibrated.', visibleWhen: feedbackOn },
    { key: 'energyMortality', label: 'Energy shortage → extra deaths', type: 'number', unit: 'permille/yr', kind: 'live', group: 'Feedback strength', min: 0, max: 200, step: 1, default: 30, description: 'Extra deaths per 1,000 per year with no energy at all; scales with the energy shortfall 1 − f_E. Illustrative, not calibrated.', visibleWhen: feedbackOn },
    // Numerics
    { key: 'duration', label: 'Simulation duration', type: 'number', unit: 'yr', kind: 'initial', group: 'Numerics', numerics: true, min: 1, max: 1000, step: 1, default: 200, description: 'Run length in model years.' },
    { key: 'dt', label: 'Time step', type: 'number', unit: 'yr', kind: 'initial', group: 'Numerics', numerics: true, min: 0.01, max: 1, step: 0.01, default: 0.1, description: 'Engine step. RK4 sub-steps automatically when rates are large, so results change little with this setting.' },
  ],
  observables: [
    { key: 'population', label: 'Population', unit: 'billion', provenance: 'simulated', chart: true, chartGroup: 'population', sig: 3 },
    { key: 'change', label: 'Change vs initial', unit: '%', provenance: 'simulated', chartGroup: 'change', sig: 3 },
    { key: 'births', label: 'Births per year', unit: 'million/yr', provenance: 'simulated', chartGroup: 'flows', sig: 3 },
    { key: 'deaths', label: 'Deaths per year', unit: 'million/yr', provenance: 'simulated', chartGroup: 'flows', sig: 3 },
    { key: 'netMigration', label: 'Net migration per year', unit: 'million/yr', provenance: 'simulated', chartGroup: 'flows', readout: false, sig: 3 },
    { key: 'birthRate', label: 'Effective birth rate', unit: 'permille/yr', provenance: 'simulated', chart: true, chartGroup: 'rates', sig: 3 },
    { key: 'deathRate', label: 'Effective death rate', unit: 'permille/yr', provenance: 'simulated', chart: true, chartGroup: 'rates', sig: 3 },
    { key: 'growthRate', label: 'Net growth rate', unit: 'permille/yr', provenance: 'simulated', chartGroup: 'rates', sig: 3, description: 'b_eff − d_eff + m.' },
    { key: 'deathScarcity', label: 'Extra deaths from scarcity', unit: 'permille/yr', provenance: 'simulated', chartGroup: 'rates', readout: false, sig: 3 },
    { key: 'deathCrowding', label: 'Extra deaths from overcrowding', unit: 'permille/yr', provenance: 'simulated', chartGroup: 'rates', readout: false, sig: 3 },
    { key: 'deathEnergy', label: 'Extra deaths from energy shortage', unit: 'permille/yr', provenance: 'simulated', chartGroup: 'rates', readout: false, sig: 3 },
    { key: 'deathOutbreak', label: 'Extra deaths from the outbreak', unit: 'permille/yr', provenance: 'simulated', chartGroup: 'rates', readout: false, sig: 3 },
    { key: 'resource', label: 'Resource stock (% of capacity)', unit: '%', provenance: 'simulated', chart: true, chartGroup: 'percent', sig: 3, description: 'S/K. Capacity K is a hypothetical model quantity.' },
    { key: 'needsMet', label: 'Needs met', unit: '%', provenance: 'simulated', chart: true, chartGroup: 'percent', sig: 3, description: 'Harvest ÷ demand.' },
    { key: 'energySufficiency', label: 'Energy sufficiency', unit: '%', provenance: 'simulated', chartGroup: 'percent', sig: 3, description: 'min(1, supply ÷ demand).' },
    { key: 'regeneration', label: 'Resource regeneration', unit: 'RU/yr', provenance: 'simulated', chartGroup: 'resourceFlows', readout: false, sig: 3, description: '1 RU = the yearly needs of one billion people at present consumption.' },
    { key: 'harvest', label: 'Resource harvest', unit: 'RU/yr', provenance: 'simulated', chartGroup: 'resourceFlows', readout: false, sig: 3 },
    { key: 'demand', label: 'Resource demand', unit: 'RU/yr', provenance: 'simulated', chartGroup: 'resourceFlows', readout: false, sig: 3 },
    { key: 'demandToMsy', label: 'Demand ÷ max sustainable regeneration', unit: 'x', provenance: 'simulated', chartGroup: 'ratio', sig: 3, description: 'Above 1 the population needs more than the resource can ever regenerate per year (overshoot).' },
    { key: 'energySupply', label: 'Energy supply', unit: 'x', provenance: 'simulated', chartGroup: 'energy', readout: false, sig: 3, description: 'Relative to present world demand (≈8.1 billion people at present consumption). Hypothetical capacity.' },
    { key: 'energyDemand', label: 'Energy demand', unit: 'x', provenance: 'simulated', chartGroup: 'energy', readout: false, sig: 3, description: 'Relative to present world demand.' },
    { key: 'infrastructure', label: 'Infrastructure capacity', unit: 'billion', provenance: 'simulated', chartGroup: 'population', sig: 3, description: 'People the (hypothetical) infrastructure can serve.' },
    { key: 'crowding', label: 'Crowding ratio (P ÷ I)', unit: 'x', provenance: 'simulated', chartGroup: 'ratio', sig: 3, description: 'Above 1 the infrastructure is overloaded.' },
    { key: 'cumBirths', label: 'Total births so far', unit: 'billion', provenance: 'simulated', chartGroup: 'cumulative', readout: false, sig: 3 },
    { key: 'cumDeaths', label: 'Total deaths so far', unit: 'billion', provenance: 'simulated', chartGroup: 'cumulative', readout: false, sig: 3 },
  ],
  primaryObservables: ['population', 'needsMet'],
  time: {
    unit: 'yr',
    dt: (p) => num(p, 'dt'),
    sampleInterval,
    defaultDuration: (p) => num(p, 'duration'),
    durationParam: 'duration',
    maxDuration: 1000,
    realtimeRate: 5,
    milestones: (p) => [...new Set([1, 10, 50, 100, num(p, 'duration')])],
  },

  init(p) {
    const s = initialState(p);
    if (bool(p, 'outbreak') && num(p, 'outbreakStart') <= 0) outbreakEvents(s, p);
    return s;
  },

  step(s, p, dt) {
    const n = Math.min(400, Math.max(1, Math.ceil((dt * rateBound(p)) / SUBSTEP_RATE_DT)));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      rk4(s, p, h);
      s.t += h;
      trackTurns(s, p);
      outbreakEvents(s, p);
    }
  },

  observe(s, p) {
    const f = flowsOf(s, p);
    return {
      population: s.P,
      change: s.P0 > 0 ? (s.P / s.P0 - 1) * 100 : NaN,
      births: f.births * 1000,
      deaths: f.deaths * 1000,
      netMigration: f.migration * 1000,
      birthRate: f.birthRate * 1000,
      deathRate: f.deathRate * 1000,
      growthRate: (f.birthRate - f.deathRate + f.migrationRate) * 1000,
      deathScarcity: f.deathScarcity * 1000,
      deathCrowding: f.deathCrowding * 1000,
      deathEnergy: f.deathEnergy * 1000,
      deathOutbreak: f.deathOutbreak * 1000,
      resource: (s.S / s.K) * 100,
      needsMet: f.needsMet * 100,
      energySufficiency: f.energySufficiency * 100,
      regeneration: f.regen,
      harvest: f.harvest,
      demand: f.demand,
      demandToMsy: f.msy > 0 ? f.demand / f.msy : NaN,
      energySupply: s.E / P_REF,
      energyDemand: f.energyDemand / P_REF,
      infrastructure: s.I,
      crowding: f.crowding,
      cumBirths: s.cumBirths,
      cumDeaths: s.cumDeaths,
    };
  },

  clone(s) {
    return { ...s, pending: [...s.pending] };
  },

  time_of: (s) => s.t,

  detectEvents(_prev, _cur, s) {
    const out = s.pending.sort((a, b) => a.t - b.t);
    s.pending = [];
    return out;
  },

  thresholds: [
    { id: 'overshoot', observable: 'demandToMsy', op: '>', value: 1, label: 'Overshoot: demand exceeds the maximum sustainable regeneration', detail: (v, t) => `In year ${fmtYear(t)} the population needs ${v.toFixed(2)}× the most the resource can regenerate in a year, so the stock must eventually shrink.`, severity: 'warning' },
    { id: 'needs-90', observable: 'needsMet', op: '<', value: 90, label: 'Needs met fell below 90 %', detail: (v, t) => `Year ${fmtYear(t)}: only ${fmtPct(v)} of resource needs can be harvested. Scarcity feedbacks now lower births and raise deaths.`, severity: 'warning' },
    { id: 'needs-50', observable: 'needsMet', op: '<', value: 50, label: 'Needs met fell below half', detail: (v, t) => `Year ${fmtYear(t)}: ${fmtPct(v)} of needs met.`, severity: 'critical' },
    { id: 'resource-25', observable: 'resource', op: '<', value: 25, label: 'Resource stock below a quarter of capacity', detail: (v, t) => `Year ${fmtYear(t)}: stock at ${fmtPct(v)} of its (hypothetical) capacity.`, severity: 'warning' },
    { id: 'energy-90', observable: 'energySufficiency', op: '<', value: 90, label: 'Energy supply below 90 % of demand', detail: (v, t) => `Year ${fmtYear(t)}: energy sufficiency ${fmtPct(v)}. Shortage slows infrastructure building and adds mortality.`, severity: 'warning' },
    { id: 'infra-overloaded', observable: 'crowding', op: '>', value: 1.01, label: 'Infrastructure overloaded', detail: (v, t) => `Year ${fmtYear(t)}: crowding ratio ${v.toFixed(2)}; ${fmtPct((1 - 1 / v) * 100)} of the population cannot be served.`, severity: 'warning' },
    { id: 'pop-doubled', observable: 'population', op: '>', value: (p) => 2 * num(p, 'P0'), label: 'Population doubled', detail: (v, t) => `Year ${fmtYear(t)}: ${fmtSig(v)} billion.`, severity: 'info' },
    { id: 'pop-halved', observable: 'population', op: '<', value: (p) => 0.5 * num(p, 'P0'), label: 'Population halved', detail: (v, t) => `Year ${fmtYear(t)}: ${fmtSig(v)} billion, half the starting population.`, severity: 'critical' },
  ],

  describeMilestone(t, obs, p) {
    const end = Math.abs(t - num(p, 'duration')) < 1e-6;
    const ch = obs.change;
    return {
      label: `${end ? 'End of run — year' : 'Year'} ${fmtYear(t)}: ${fmtSig(obs.population)} billion people (${ch >= 0 ? '+' : ''}${fmtPct(ch)})`,
      detail: `Births ${fmtSig(obs.births)} million/yr, deaths ${fmtSig(obs.deaths)} million/yr. Needs met ${fmtPct(obs.needsMet)}, resource stock ${fmtPct(obs.resource)} of capacity, energy sufficiency ${fmtPct(obs.energySufficiency)}, crowding ratio ${fmtSig(obs.crowding)}.`,
    };
  },

  finished(s) {
    if (s.P < 1e-6) return 'The modelled population fell to (near) zero.';
    return null;
  },

  derived(p) {
    const r = (num(p, 'birthRate') - num(p, 'deathRate') + num(p, 'migration')) / 1000;
    const P0 = num(p, 'P0');
    const c = num(p, 'consumption');
    const T = num(p, 'duration');
    const sustainable = ((1 - num(p, 'stress') / 100) * num(p, 'sustainablePop')) / c;
    const out: DerivedQuantity[] = [
      { key: 'r0', label: 'Initial net growth rate', value: r * 1000, unit: 'permille/yr', formula: 'r = b₀ − d₀ + m', provenance: 'derived', note: 'Before any feedback acts.' },
      { key: 'sustainable', label: 'Sustainable population at this consumption', value: sustainable, unit: 'billion', formula: 'P* = (1 − ε)·P_sus / c', provenance: 'assumed', note: 'Follows from the hypothetical resource capacity; not a measured carrying capacity.' },
      { key: 'K', label: 'Resource capacity K', value: capacityK(p), unit: 'RU', formula: 'K = 4·P_sus / r', provenance: 'derived', note: '1 RU = the yearly needs of one billion people at present consumption.' },
      { key: 'noFeedback', label: 'Population at the end without feedbacks', value: P0 * Math.exp(r * T), unit: 'billion', formula: 'P₀·e^{rT}', provenance: 'derived', note: 'Pure exponential growth for comparison; real fertility also responds to development, which this model omits.' },
    ];
    if (Math.abs(r) > 1e-9) {
      out.push({ key: 'doubling', label: r > 0 ? 'Doubling time (no feedback)' : 'Halving time (no feedback)', value: Math.log(2) / Math.abs(r), unit: 'yr', formula: 'ln 2 / |r|', provenance: 'derived' });
    }
    if (r > 0 && sustainable > P0) {
      out.push({ key: 'tOvershoot', label: 'Years until demand reaches the sustainable maximum (no feedback)', value: Math.log(sustainable / P0) / r, unit: 'yr', formula: 'ln(P*/P₀) / r', provenance: 'derived' });
    }
    return out;
  },

  warnings(p) {
    const w: Warning[] = [];
    const P0 = num(p, 'P0');
    const c = num(p, 'consumption');
    const sustainable = (1 - num(p, 'stress') / 100) * num(p, 'sustainablePop');
    if (c * P0 > sustainable) w.push({ id: 'initial-overshoot', message: `Demand at t = 0 (${fmtSig(c * P0)} billion people’s worth) already exceeds the most the resource can regenerate (${fmtSig(sustainable)}): the stock will shrink from the start.`, severity: 'warning' });
    const eRatio = (num(p, 'energySupply') * P_REF) / (c * P0);
    if (eRatio < 1) w.push({ id: 'energy-short', message: `Energy supply covers only ${fmtPct(eRatio * 100)} of demand at t = 0.`, severity: 'info' });
    if (num(p, 'infrastructure0') < P0) w.push({ id: 'infra-short', message: `Infrastructure serves ${fmtSig(num(p, 'infrastructure0'))} billion people but the population is ${fmtSig(P0)} billion: overloaded from the start.`, severity: 'info' });
    if (!bool(p, 'feedbacks')) w.push({ id: 'no-feedback', message: 'Feedbacks are off: population follows pure exponential growth whatever happens to resources, energy and infrastructure.', severity: 'info' });
    return w;
  },

  summarize(run: RunRecord): KeyResult[] {
    const out: KeyResult[] = [];
    const t = run.samples.t;
    const P = run.samples.obs.population ?? [];
    if (!P.length) return out;
    let iMax = 0;
    let iMin = 0;
    for (let i = 1; i < P.length; i++) {
      if (P[i] > P[iMax]) iMax = i;
      if (P[i] < P[iMin]) iMin = i;
    }
    out.push({ label: 'Highest population', value: P[iMax], unit: 'billion', provenance: 'simulated', sig: 3, note: `In year ${fmtYear(t[iMax])}.` });
    out.push({ label: 'Lowest population', value: P[iMin], unit: 'billion', provenance: 'simulated', sig: 3, note: `In year ${fmtYear(t[iMin])}.` });
    out.push({ label: 'Final population', value: run.final.population, unit: 'billion', provenance: 'simulated', sig: 3 });
    out.push({ label: 'Change vs initial', value: run.final.change, unit: '%', provenance: 'simulated', sig: 3 });
    const needs = run.samples.obs.needsMet ?? [];
    if (needs.length) {
      let j = 0;
      for (let i = 1; i < needs.length; i++) if (needs[i] < needs[j]) j = i;
      out.push({ label: 'Lowest share of needs met', value: needs[j], unit: '%', provenance: 'simulated', sig: 3, note: `In year ${fmtYear(t[j])}.` });
    }
    const res = run.samples.obs.resource ?? [];
    if (res.length) out.push({ label: 'Lowest resource stock', value: Math.min(...res), unit: '%', provenance: 'simulated', sig: 3, note: 'Percent of the hypothetical capacity.' });
    const ratio = run.samples.obs.demandToMsy ?? [];
    let over = 0;
    for (let i = 1; i < t.length; i++) if (ratio[i] > 1) over += t[i] - t[i - 1];
    out.push({ label: 'Years in overshoot', value: over, unit: 'yr', provenance: 'simulated', sig: 3, note: 'Time with demand above the maximum sustainable regeneration.' });
    out.push({ label: 'Total births', value: run.final.cumBirths, unit: 'billion', provenance: 'simulated', sig: 3 });
    out.push({ label: 'Total deaths', value: run.final.cumDeaths, unit: 'billion', provenance: 'simulated', sig: 3 });
    const peak = run.events.find((e) => e.id.startsWith('peak-'));
    if (peak) out.push({ label: 'First population peak', value: peak.t, unit: 'yr', provenance: 'simulated', sig: 3, note: peak.label });
    return out;
  },

  assumptions: [
    { kind: 'simplification', text: 'One aggregate population with no age structure, regions, income groups or inequality. Crude birth and death rates are treated as fixed per-person rates, although in reality they depend on age structure.' },
    { kind: 'simplification', text: 'No demographic transition: birth rates change only through the scarcity feedback. Real fertility has fallen mainly with income, education, health and urbanisation, so unchecked-growth runs here are not projections.' },
    { kind: 'approximation', text: 'All renewable resources (food, water, materials) are lumped into one stock with logistic regeneration dS/dt = (1 − ε)·r·S·(1 − S/K). Its capacity is a hypothetical model quantity.' },
    { kind: 'simplification', text: 'Harvest is the smaller of demand and an accessibility limit (a fixed share of the remaining stock per year). There are no prices, trade, substitution, recycling or technological change.' },
    { kind: 'speculative', text: 'The feedback forms (births ∝ needs met, extra deaths linear in unmet needs, unserved share and energy shortfall) and their default strengths are illustrative choices made for transparency, not calibrated to historical famines, crowding or energy crises.' },
    { kind: 'simplification', text: 'Energy is only a capacity constraint: supply grows at a set rate; demand is proportional to population and consumption and rises as the resource is depleted. Costs, prices, emissions and the energy mix are not modelled.' },
    { kind: 'simplification', text: 'Infrastructure is built toward 110 % of the population and maintained at a rate proportional to energy sufficiency; capacity beyond that target is not maintained. Building needs no resources or money.' },
    { kind: 'approximation', text: 'Default population, birth and death rates are rounded world values for the early 2020s (≈8.1 billion, ≈17‰, ≈8‰; UN World Population Prospects). Net migration is zero for the world as a whole.' },
    { kind: 'simplification', text: 'An outbreak is a rectangular pulse of extra mortality; transmission, immunity and health-care responses are not modelled.' },
  ],
  limitations: [
    'This is a scenario model for exploring mechanisms, not a forecast. The UN’s projections, which model fertility decline with development, have world population levelling off at roughly 10 billion later this century — a mechanism absent here.',
    'Overshoot and collapse in this model follow largely from the delayed feedback (births react only to actual shortages, after the stock has been drawn down). Societies can anticipate and adapt; the model cannot.',
    'Resource, energy and infrastructure capacities are hypothetical; outcome timings (years to overshoot, peak size) scale directly with them and should not be read as dates.',
    'The sensitivity of mortality and fertility to scarcity is highly uncertain; try the "Feedback strength" sliders to see how much the outcome depends on them.',
    'Migration is a constant rate and does not respond to conditions.',
  ],
  equations: [
    { label: 'Population', formula: 'dP/dt = (b_eff − d_eff + m)·P', explanation: 'Births minus deaths plus net migration, all as per-person rates.' },
    { label: 'Resource stock', formula: 'dS/dt = (1 − ε)·r·S·(1 − S/K) − H', explanation: 'Logistic regeneration (fastest at S = K/2), reduced by environmental stress ε, minus the harvest.' },
    { label: 'Resource capacity', formula: 'K = 4·P_sus / r', explanation: 'Chosen so the maximum sustainable yield r·K/4 equals the needs of P_sus billion people at present consumption.' },
    { label: 'Harvest and needs met', formula: 'D = c·P,  A = h·S,  H = min(D, A),  f_S = H / D', explanation: 'Demand D grows with population and consumption c; at most a share h of the stock can be extracted per year.' },
    { label: 'Energy', formula: 'dE/dt = g_E·E,  D_E = c·P·(1 + α·max(0, S₀ − S)/K),  f_E = min(1, E / D_E)', explanation: 'Supply grows at a set rate; demand rises when the resource is depleted below its starting level. E₀ = (supply multiplier) × 8.1 billion people’s needs.' },
    { label: 'Infrastructure', formula: 'dI/dt = f_E·[δ·min(I, 1.1·P) + β·max(0, 1.1·P − I)] − δ·I', explanation: 'Maintenance offsets wear-out δ on the capacity that is needed (up to 110 % of the population) and building closes a share β of the gap per year, both scaled by energy sufficiency. Unneeded capacity wears out.' },
    { label: 'Crowding', formula: 'C = P / I,  u = max(0, 1 − I/P)', explanation: 'Crowding ratio and the share of people the infrastructure cannot serve.' },
    { label: 'Effective birth rate', formula: 'b_eff = b₀·max(0, 1 − σ_b·(1 − f_S))', explanation: 'Births fall linearly with unmet needs; σ_b = 1 gives births proportional to needs met.' },
    { label: 'Effective death rate', formula: 'd_eff = d₀ + d_out(t) + μ_S·(1 − f_S) + μ_C·u + μ_E·(1 − f_E)', explanation: 'Base mortality plus the outbreak pulse and three pressure terms with adjustable strengths μ.' },
    { label: 'Overshoot indicator', formula: 'D / [(1 − ε)·r·K/4]', explanation: 'Demand relative to the most the resource can regenerate per year. Above 1 the stock cannot be sustained.' },
    { label: 'Numerics', formula: 'RK4, sub-step h ≤ 0.25 / Σ|rates|', explanation: 'All stocks and cumulative totals are integrated together, so P − P₀ equals births − deaths + migration to rounding error.' },
  ],
  education: {
    objectives: [
      'Read a stock-and-flow diagram: which flows fill and drain each stock.',
      'Explain why exponential growth meeting a finite, regenerating resource tends to overshoot when the feedback is delayed.',
      'Identify which feedback (scarcity, crowding, energy) dominates the death rate at different times.',
      'Recognise that abstract capacities and feedback strengths drive the timing of every outcome.',
    ],
    background: {
      beginner:
        'People need food, water, energy and places to live. In this model, if there is plenty of everything, the population grows a little each year because more people are born than die. Resources grow back, but only so fast. If people use more than grows back, the store of resources shrinks; when it runs short, fewer babies are born and more people die. Watch the diagram to see which effect is in charge.',
      intermediate:
        'Population changes by births minus deaths plus migration. With constant rates this gives exponential growth with doubling time ln2 / r. The resource regenerates logistically: slowly when nearly empty or nearly full, fastest at half capacity. As long as the stock lasts, needs are fully met and nothing slows growth, so demand can rise well past the sustainable yield (overshoot). When accessible resources finally run short, the scarcity feedback lowers births and raises deaths — after the stock has already been depleted.',
      advanced:
        'The model is a coupled system of ODEs for P, S, E and I with piecewise-smooth feedbacks (min, max) integrated by RK4. The long-run behaviour depends on the ratio of demand to maximum sustainable yield r·K/4 and on the delay introduced by the stock buffer: with births responding only to f_S = min(1, hS/cP), the system behaves like a predator–prey model and can overshoot, oscillate or collapse. Adding anticipatory feedbacks (e.g. births responding to S/K) or a demographic transition would damp this. Because capacities are hypothetical, treat outcomes as qualitative: compare runs rather than reading off dates.',
    },
    variables: [
      { symbol: 'P', meaning: 'population', unit: 'billion' },
      { symbol: 'b₀, d₀, m', meaning: 'base birth, base death and net migration rates', unit: '‰/yr' },
      { symbol: 'S, K', meaning: 'resource stock and its capacity (hypothetical)', unit: 'RU' },
      { symbol: 'r, ε', meaning: 'regeneration rate and environmental stress', unit: '%/yr, %' },
      { symbol: 'P_sus', meaning: 'maximum sustainable population at present consumption (hypothetical)', unit: 'billion' },
      { symbol: 'c', meaning: 'consumption per person relative to present', unit: '×' },
      { symbol: 'h', meaning: 'maximum extraction rate', unit: '%/yr' },
      { symbol: 'f_S, f_E', meaning: 'share of needs met; energy sufficiency', unit: '%' },
      { symbol: 'E, g_E, α', meaning: 'energy supply, its growth rate, depletion-energy coupling' },
      { symbol: 'I, β, δ', meaning: 'infrastructure capacity, build rate, depreciation', unit: 'billion, %/yr' },
      { symbol: 'σ_b, μ_S, μ_C, μ_E', meaning: 'feedback strengths (births, scarcity, crowding, energy)' },
    ],
    guidedSteps: [
      'Run the defaults and watch the diagram: note the year demand first exceeds the sustainable regeneration (overshoot event) and the year needs met first drop below 90 %.',
      'How long is the gap between those two events? That delay is the resource stock being drawn down.',
      'Switch "Feedbacks on births and deaths" off and compare: the population follows P₀·e^{rt} while the resource collapses.',
      'Turn feedbacks back on and set "Scarcity → fewer births" to 2. Does the population peak earlier and lower?',
      'Raise the environmental stress to 30 % mid-run and watch the overshoot indicator jump.',
      'Set the maximum extraction rate to 10 %/yr, above the 5 %/yr regeneration rate. Why can the stock now be mined to exhaustion instead of recovering?',
      'Enable the disease outbreak and read the outbreak-end event: how many extra deaths did the model compute?',
    ],
    questions: [
      'Why does needs met stay at 100 % for decades even after the population exceeds the sustainable maximum?',
      'What would change if birth rates responded to the size of the resource stock instead of current shortages?',
      'Does a larger initial resource stock prevent overshoot, or only delay it?',
      'Why does more energy (try 10×) not remove the resource limit in this model?',
    ],
  },
  dataSources: [
    {
      name: 'World Population Prospects 2024',
      provider: 'United Nations, Department of Economic and Social Affairs, Population Division',
      citation: 'United Nations (2024). World Population Prospects 2024.',
      url: 'https://population.un.org/wpp/',
      license: 'CC BY 3.0 IGO',
      notes: 'Only rounded headline values are used as defaults (≈8.1 billion people, crude birth rate ≈17‰, crude death rate ≈8‰ for the early 2020s). No time series is loaded.',
    },
  ],
};
