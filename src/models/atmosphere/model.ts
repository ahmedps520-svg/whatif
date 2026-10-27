import type { DerivedQuantity, KeyResult, ParamValues, RunRecord, SimulationModel, Warning } from '../../engine/types';
import { num, str } from '../../engine/validation';

/**
 * Atmospheric oxygen calculator with a hypothetical, linear transition.
 *
 * The model changes the amount of O₂ in a dry, well-mixed atmosphere and
 * computes immediate physical quantities: composition, total pressure,
 * oxygen partial pressure, the inspired and alveolar oxygen pressure of a
 * person at sea level, the equivalent altitude on today's Earth, air density
 * and the speed of sound. Biological and ecological consequences are not
 * modelled.
 */

/** Present-day dry-air mole fractions (rounded; CO₂ ≈ 420 ppm in the 2020s). */
export const PRESENT = { N2: 0.78084, O2: 0.20946, Ar: 0.00934, CO2: 0.00042 } as const;
export const MOLAR = { N2: 28.0134, O2: 31.9988, Ar: 39.948, CO2: 44.0095 } as const; // g/mol
const R_GAS = 8.314462618; // J/(mol·K)
const GAMMA = 1.4; // ratio of specific heats for a diatomic-dominated gas
export const P_STD = 101.325; // kPa, ICAO standard sea-level pressure
export const P_H2O_BODY = 6.27; // kPa, saturated water vapour at 37 °C
export const PACO2 = 5.33; // kPa, normal arterial CO₂ (≈40 mmHg)
export const RQ = 0.8; // respiratory quotient

export interface Composition {
  N2: number;
  O2: number;
  Ar: number;
  CO2: number;
}

const SUM_PRESENT = PRESENT.N2 + PRESENT.O2 + PRESENT.Ar + PRESENT.CO2;

/** Normalised present composition (fractions sum to 1). */
export function presentComposition(): Composition {
  return { N2: PRESENT.N2 / SUM_PRESENT, O2: PRESENT.O2 / SUM_PRESENT, Ar: PRESENT.Ar / SUM_PRESENT, CO2: PRESENT.CO2 / SUM_PRESENT };
}

/**
 * Composition and total pressure when the amount of O₂ is scaled by k
 * (1 = today). In "remove" mode the other gases are untouched, so pressure
 * changes with the O₂ amount. In "replace" mode total pressure is held fixed
 * and nitrogen makes up the difference.
 */
export function atmosphereFor(k: number, mode: 'remove' | 'replace', p0: number): { comp: Composition; pressure: number } {
  const c0 = presentComposition();
  if (mode === 'remove') {
    const o2 = c0.O2 * k;
    const total = c0.N2 + o2 + c0.Ar + c0.CO2;
    return { comp: { N2: c0.N2 / total, O2: o2 / total, Ar: c0.Ar / total, CO2: c0.CO2 / total }, pressure: p0 * total };
  }
  const maxO2 = c0.N2 + c0.O2;
  const o2 = Math.min(c0.O2 * k, maxO2);
  return { comp: { N2: maxO2 - o2, O2: o2, Ar: c0.Ar, CO2: c0.CO2 }, pressure: p0 };
}

export function meanMolarMass(c: Composition): number {
  return c.N2 * MOLAR.N2 + c.O2 * MOLAR.O2 + c.Ar * MOLAR.Ar + c.CO2 * MOLAR.CO2;
}

/** ICAO standard atmosphere pressure (kPa) at geometric-ish altitude h (m), valid to 20 km. */
export function isaPressure(h: number): number {
  if (h <= 11000) return P_STD * Math.pow(1 - 2.25577e-5 * h, 5.25588);
  return 22.632 * Math.exp(-(h - 11000) / 6341.62);
}

/** Inverse of isaPressure: altitude (m) at which the standard atmosphere has pressure p (kPa). */
export function isaAltitude(p: number): number {
  if (p >= 22.632) return (1 - Math.pow(p / P_STD, 1 / 5.25588)) / 2.25577e-5;
  return 11000 - 6341.62 * Math.log(p / 22.632);
}

/** Inspired (tracheal) O₂ partial pressure, kPa: air warmed to 37 °C and saturated with water vapour. */
export function inspiredPO2(fO2: number, p: number): number {
  return Math.max(0, fO2 * (p - P_H2O_BODY));
}

/** Simplified alveolar gas equation, kPa (normal ventilation; no acclimatisation). */
export function alveolarPO2(piO2: number): number {
  return Math.max(0, piO2 - PACO2 / RQ);
}

/** Altitude on present-day Earth (m) with the same inspired PO₂. */
export function equivalentAltitude(piO2: number): number {
  const p = piO2 / presentComposition().O2 + P_H2O_BODY;
  return isaAltitude(p);
}

export interface AtmosphereState {
  t: number;
  /** Current O₂ amount relative to today. */
  k: number;
}

function targetK(p: ParamValues): number {
  return num(p, 'o2Amount') / 100;
}

export function kAt(p: ParamValues, t: number): number {
  const T = num(p, 'transitionYears');
  const kT = targetK(p);
  if (T <= 0) return kT;
  return 1 + (kT - 1) * Math.min(1, t / T);
}

function mode(p: ParamValues): 'remove' | 'replace' {
  return str(p, 'mode') === 'replace' ? 'replace' : 'remove';
}

/** All quantities for an O₂ amount k under the parameters p. */
export function compute(p: ParamValues, k: number) {
  const { comp, pressure } = atmosphereFor(k, mode(p), num(p, 'surfacePressure'));
  const M = meanMolarMass(comp);
  const T = num(p, 'temperature') + 273.15;
  const piO2 = inspiredPO2(comp.O2, pressure);
  return {
    comp,
    pressure,
    pO2: comp.O2 * pressure,
    piO2,
    pAO2: alveolarPO2(piO2),
    eqAlt: equivalentAltitude(piO2),
    M,
    density: (pressure * 1000 * M) / 1000 / (R_GAS * T),
    sound: Math.sqrt((GAMMA * R_GAS * T) / (M / 1000)),
  };
}

const fmt = (v: number, d = 1) => v.toFixed(d);
const km = (m: number) => (Math.abs(m) >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);

export const atmosphereModel: SimulationModel<AtmosphereState> = {
  id: 'atmosphere',
  name: 'Atmospheric Oxygen Model',
  shortName: 'Oxygen Model',
  domain: 'earth',
  viewKind: 'chart',
  summary:
    'Change the amount of oxygen in the air and compute the composition, pressure, oxygen available to a person at sea level, the equivalent altitude on today’s Earth, air density and the speed of sound.',
  params: [
    { key: 'o2Amount', label: 'Oxygen amount (relative to today)', type: 'number', unit: '%', kind: 'initial', group: 'Scenario', min: 0, max: 250, step: 1, default: 100, description: 'Total amount of O₂ in the atmosphere as a percentage of today’s. 50 means half the oxygen.', marks: [ { value: 50, label: 'Half' }, { value: 75, label: '¾' }, { value: 100, label: 'Today' }, { value: 143, label: '≈30 % air' } ] },
    { key: 'mode', label: 'What happens to the removed or added oxygen', type: 'choice', kind: 'initial', group: 'Scenario', default: 'remove', description: 'This modelling choice changes the answer: does total pressure follow the oxygen, or does nitrogen take its place?', options: [
      { value: 'remove', label: 'Removed outright — pressure changes', description: 'Other gases are untouched, so total surface pressure falls (or rises) with the oxygen.' },
      { value: 'replace', label: 'Replaced by nitrogen — pressure fixed', description: 'Total pressure stays the same; nitrogen fills the gap (or is displaced).' },
    ] },
    { key: 'transitionYears', label: 'Transition time', type: 'number', unit: 'yr', kind: 'initial', group: 'Scenario', min: 0, max: 200, step: 1, default: 10, description: 'A hypothetical linear change from today’s atmosphere to the target. 0 = the change has already happened at t = 0. No real mechanism is implied.' },
    { key: 'surfacePressure', label: 'Present surface pressure', type: 'number', unit: 'kPa', kind: 'initial', group: 'Reference conditions', min: 50, max: 150, step: 0.1, default: 101.325, description: 'Today’s mean sea-level pressure (before any change). 101.325 kPa is the standard atmosphere.' },
    { key: 'temperature', label: 'Air temperature', type: 'number', unit: 'C', kind: 'live', group: 'Reference conditions', min: -40, max: 50, step: 0.5, default: 15, description: 'Used for air density and the speed of sound only.' },
    { key: 'duration', label: 'Duration', type: 'number', unit: 'yr', kind: 'initial', group: 'Numerics', numerics: true, min: 1, max: 300, step: 1, default: 20, description: 'Length of the timeline in years.' },
  ],
  observables: [
    { key: 'o2Fraction', label: 'O₂ share of the air', unit: '%', provenance: 'derived', chart: true, chartGroup: 'fraction', sig: 4, description: 'Mole (volume) fraction of oxygen in dry air.' },
    { key: 'o2Amount', label: 'O₂ amount vs today', unit: '%', provenance: 'assumed', chartGroup: 'fraction', sig: 3 },
    { key: 'pressure', label: 'Surface pressure', unit: 'kPa', provenance: 'derived', chartGroup: 'pressure', sig: 4 },
    { key: 'pO2', label: 'O₂ partial pressure', unit: 'kPa', provenance: 'derived', chart: true, chartGroup: 'po2', sig: 4 },
    { key: 'piO2', label: 'Inspired PO₂ (at 37 °C)', unit: 'kPa', provenance: 'derived', chart: true, chartGroup: 'po2', sig: 4, description: 'Oxygen pressure of air in the windpipe after warming and humidification.' },
    { key: 'pAO2', label: 'Alveolar PO₂ (estimate)', unit: 'kPa', provenance: 'derived', chartGroup: 'po2', sig: 4, description: 'Simplified alveolar gas equation with normal breathing.' },
    { key: 'eqAltitude', label: 'Equivalent altitude today', unit: 'm', provenance: 'derived', chart: true, chartGroup: 'alt', sig: 4, description: 'Altitude on present-day Earth with the same inspired oxygen pressure (ICAO standard atmosphere).' },
    { key: 'density', label: 'Air density', unit: 'kg/m3', provenance: 'derived', chartGroup: 'density', sig: 4 },
    { key: 'molarMass', label: 'Mean molar mass', unit: 'g/mol', provenance: 'derived', chartGroup: 'density', sig: 4 },
    { key: 'soundSpeed', label: 'Speed of sound', unit: 'm/s', provenance: 'derived', chartGroup: 'sound', sig: 4 },
  ],
  primaryObservables: ['eqAltitude', 'piO2'],
  time: {
    unit: 'yr',
    dt: 0.05,
    sampleInterval: 0.1,
    defaultDuration: (p) => num(p, 'duration'),
    durationParam: 'duration',
    maxDuration: 300,
    realtimeRate: 2,
    milestones: (p) => (num(p, 'transitionYears') > 0 ? [num(p, 'transitionYears')] : []),
  },

  init() {
    return { t: 0, k: NaN };
  },

  step(s, p, dt) {
    s.t += dt;
    s.k = kAt(p, s.t);
  },

  observe(s, p) {
    const k = kAt(p, s.t);
    const c = compute(p, k);
    return {
      o2Fraction: c.comp.O2 * 100,
      o2Amount: k * 100,
      pressure: c.pressure,
      pO2: c.pO2,
      piO2: c.piO2,
      pAO2: c.pAO2,
      eqAltitude: c.eqAlt,
      density: c.density,
      molarMass: c.M,
      soundSpeed: c.sound,
    };
  },

  clone: (s) => ({ ...s }),
  time_of: (s) => s.t,

  thresholds: [
    { id: 'osha-deficient', observable: 'o2Fraction', op: '<', value: 19.5, label: 'Below 19.5 % O₂ — “oxygen-deficient” by the OSHA workplace definition', detail: (v) => `O₂ share ${fmt(v, 2)} %. Regulatory reference point for confined spaces (29 CFR 1910.134); not a prediction of harm.`, severity: 'warning' },
    { id: 'osha-enriched', observable: 'o2Fraction', op: '>', value: 23.5, label: 'Above 23.5 % O₂ — “oxygen-enriched” by the OSHA workplace definition', detail: (v) => `O₂ share ${fmt(v, 2)} %. Enriched air makes materials ignite more easily and burn faster.`, severity: 'warning' },
    { id: 'fire-15', observable: 'o2Fraction', op: '<', value: 15, label: 'O₂ share near 15 % — the level oxygen-reduction fire-prevention systems use', detail: (v) => `O₂ share ${fmt(v, 2)} %. Such systems keep warehouses and archives near this level because flaming combustion of many materials becomes difficult. Approximate reference; fire behaviour also depends on pressure and fuel.`, severity: 'warning' },
    { id: 'alt-2500', observable: 'eqAltitude', op: '>', value: 2500, label: 'Breathing at sea level now resembles ≈2,500 m altitude today', detail: (v) => `Equivalent altitude ${km(v)}. Above about 2,500 m, acute mountain sickness becomes common in people who are not acclimatised (reference point).`, severity: 'warning' },
    { id: 'alt-5100', observable: 'eqAltitude', op: '>', value: 5100, label: 'Equivalent to the highest permanent settlements (≈5,100 m)', detail: (v) => `Equivalent altitude ${km(v)}. The highest year-round towns, such as La Rinconada in Peru, lie near this altitude (reference point).`, severity: 'critical' },
    { id: 'alt-8000', observable: 'eqAltitude', op: '>', value: 8000, label: 'Equivalent to the climbers’ “death zone” (above ≈8,000 m)', detail: (v) => `Equivalent altitude ${km(v)}. People cannot stay long at these altitudes without supplemental oxygen (reference point).`, severity: 'critical' },
  ],

  describeMilestone(t, obs) {
    return {
      label: `Transition complete after ${fmt(t, 0)} years`,
      detail: `O₂ share ${fmt(obs.o2Fraction, 2)} %, surface pressure ${fmt(obs.pressure, 1)} kPa, inspired PO₂ ${fmt(obs.piO2, 2)} kPa, equivalent altitude ${km(obs.eqAltitude)}.`,
    };
  },

  derived(p) {
    const today = compute({ ...p, o2Amount: 100 }, 1);
    const target = compute(p, targetK(p));
    const out: DerivedQuantity[] = [
      { key: 'fTarget', label: 'O₂ share after the change', value: target.comp.O2 * 100, unit: '%', provenance: 'derived', formula: str(p, 'mode') === 'remove' ? 'x = kx₀ / (1 − x₀ + kx₀)' : 'x = kx₀ (nitrogen fills the rest)', sig: 4 },
      { key: 'pTarget', label: 'Surface pressure after the change', value: target.pressure, unit: 'kPa', provenance: 'derived', formula: str(p, 'mode') === 'remove' ? 'P = P₀(1 − x₀ + kx₀)' : 'P = P₀', sig: 4 },
      { key: 'piToday', label: 'Inspired PO₂ today', value: today.piO2, unit: 'kPa', provenance: 'derived', formula: 'PᵢO₂ = x(P − 6.27 kPa)', sig: 4 },
      { key: 'piTarget', label: 'Inspired PO₂ after the change', value: target.piO2, unit: 'kPa', provenance: 'derived', formula: 'PᵢO₂ = x(P − 6.27 kPa)', sig: 4 },
      { key: 'paTarget', label: 'Alveolar PO₂ after the change', value: target.pAO2, unit: 'mmHg', provenance: 'derived', formula: 'P_AO₂ = PᵢO₂ − P_aCO₂ / RQ', sig: 3, note: 'Shown in mmHg, the unit used in physiology.' },
      { key: 'eqTarget', label: 'Equivalent altitude after the change', value: target.eqAlt, unit: 'm', provenance: 'derived', formula: 'solve x₀(P_ISA(h) − 6.27) = PᵢO₂ for h', sig: 4, note: 'Negative values mean more oxygen pressure than at sea level today.' },
      { key: 'rhoChange', label: 'Change in air density', value: (target.density / today.density - 1) * 100, unit: '%', provenance: 'derived', formula: 'ρ = PM/(RT)', sig: 3 },
    ];
    // Convert alveolar kPa → mmHg for that one item.
    out[4].value = target.pAO2 * (1000 / 133.322);
    return out;
  },

  warnings(p) {
    const w: Warning[] = [];
    const target = compute(p, targetK(p));
    if (target.pAO2 <= 0) w.push({ id: 'no-o2', message: 'At this level the simplified alveolar equation gives no usable oxygen in the lungs — far outside conditions people can survive.', severity: 'critical' });
    if (str(p, 'mode') === 'replace' && targetK(p) * presentComposition().O2 > presentComposition().N2 + presentComposition().O2)
      w.push({ id: 'cap', message: 'Oxygen cannot replace more nitrogen than exists; the O₂ share is capped.', severity: 'info' });
    if (target.eqAlt > 20000) w.push({ id: 'isa-range', message: 'The equivalent altitude lies above 20 km, beyond the standard-atmosphere layers used here; treat it as “extremely high”.', severity: 'warning' });
    return w;
  },

  summarize(run: RunRecord): KeyResult[] {
    const f = run.final;
    return [
      { label: 'Final O₂ share', value: f.o2Fraction, unit: '%', provenance: 'derived', sig: 4 },
      { label: 'Final surface pressure', value: f.pressure, unit: 'kPa', provenance: 'derived', sig: 4 },
      { label: 'Inspired PO₂ at sea level', value: f.piO2, unit: 'kPa', provenance: 'derived', sig: 4 },
      { label: 'Equivalent altitude today', value: f.eqAltitude, unit: 'm', provenance: 'derived', sig: 3 },
      { label: 'Air density', value: f.density, unit: 'kg/m3', provenance: 'derived', sig: 4 },
      { label: 'Reference thresholds crossed', value: run.events.filter((e) => e.source === 'threshold').length, provenance: 'derived', sig: 2 },
    ];
  },

  assumptions: [
    { kind: 'established', text: 'Dalton’s law: each gas contributes a partial pressure equal to its mole fraction times the total pressure.' },
    { kind: 'established', text: 'Air in the airways is warmed to 37 °C and saturated with water vapour (6.27 kPa), which reduces the oxygen pressure that reaches the lungs.' },
    { kind: 'approximation', text: 'Alveolar oxygen uses the simplified alveolar gas equation with normal arterial CO₂ (5.33 kPa) and a respiratory quotient of 0.8. People at altitude breathe harder, which raises alveolar oxygen; that acclimatisation is ignored.' },
    { kind: 'approximation', text: 'Equivalent altitude uses the ICAO standard atmosphere (valid to 20 km) for present-day Earth.' },
    { kind: 'simplification', text: 'Present dry air is N₂ 78.084 %, O₂ 20.946 %, Ar 0.934 %, CO₂ ≈ 420 ppm; trace gases and humidity are ignored.' },
    { kind: 'simplification', text: 'The change is a hypothetical linear transition; no mechanism (e.g. a chemical sink or source of oxygen) is modelled.' },
    { kind: 'speculative', text: 'Effects on people, animals, plants, fire regimes and climate are not calculated. Threshold events compare the computed values with established reference points only.' },
  ],
  limitations: [
    'A single global, well-mixed atmosphere: no weather, altitude-dependent composition or regional differences.',
    'Changing total pressure would also change the atmosphere’s height profile, boiling points and climate; only the quantities listed are computed.',
    'Human tolerance varies widely with acclimatisation, health and exertion; the reference altitudes are context, not predictions.',
    'Fire behaviour depends on oxygen fraction, oxygen partial pressure, fuel and humidity together; the 15 % reference is approximate.',
  ],
  equations: [
    { label: 'Partial pressure', formula: 'pO₂ = x_O₂ · P', explanation: 'Dalton’s law: the oxygen share of the air times the total pressure.' },
    { label: 'O₂ removed outright', formula: 'x = k·x₀ / (1 − x₀ + k·x₀),   P = P₀(1 − x₀ + k·x₀)', explanation: 'Scaling the oxygen amount by k changes both its share and the total pressure.' },
    { label: 'Inspired oxygen', formula: 'PᵢO₂ = x_O₂ · (P − 6.27 kPa)', explanation: 'Humidified air at body temperature in the windpipe.' },
    { label: 'Alveolar gas equation (simplified)', formula: 'P_AO₂ = PᵢO₂ − P_aCO₂ / RQ', explanation: 'Oxygen pressure in the lungs’ air sacs with normal breathing.' },
    { label: 'Standard atmosphere', formula: 'P(h) = 101.325 kPa · (1 − 2.25577×10⁻⁵ h)^5.25588  (h ≤ 11 km)', explanation: 'Inverted to find the altitude on today’s Earth with the same inspired oxygen.' },
    { label: 'Air density and sound', formula: 'ρ = P·M / (R·T),   c = √(γRT / M)', explanation: 'Ideal-gas density and the speed of sound depend on the mean molar mass M.' },
  ],
  education: {
    objectives: [
      'Distinguish oxygen percentage from oxygen partial pressure.',
      'Explain why “removing” and “replacing” oxygen lead to different answers.',
      'Relate a change in the air to an equivalent mountain altitude.',
      'Separate computed physical effects from biological consequences that a simple model cannot predict.',
    ],
    background: {
      beginner: 'Air is mostly nitrogen with about one-fifth oxygen. What our lungs care about is how hard the oxygen “pushes” — its pressure. Climbing a mountain lowers that pressure, so losing oxygen at sea level feels like being on a mountain. This model tells you which mountain.',
      intermediate: 'Each gas contributes a partial pressure equal to its share times the total pressure. Taking oxygen out lowers both its share and, unless something replaces it, the total pressure. Air reaching the lungs is diluted by water vapour, and carbon dioxide from the body further lowers alveolar oxygen. Matching the inspired oxygen pressure to the standard atmosphere gives an equivalent altitude.',
      advanced: 'With mole fraction x₀ = 0.20946 and amount scaling k, removal gives x = kx₀/(1 − x₀ + kx₀) and P = P₀(1 − x₀ + kx₀). Inspired PO₂ = x(P − P_H₂O) with P_H₂O = 6.27 kPa; the simplified alveolar gas equation subtracts P_aCO₂/RQ. The ICAO troposphere relation P = P₀(1 − L h/T₀)^(gM/RL) is inverted for the equivalent altitude. Mean molar mass enters density and sound speed. Acclimatisation (hyperventilation lowering P_aCO₂) is deliberately excluded.',
    },
    variables: [
      { symbol: 'x_O₂', meaning: 'oxygen mole fraction (share of the air)', unit: '%' },
      { symbol: 'P', meaning: 'total surface pressure', unit: 'kPa' },
      { symbol: 'k', meaning: 'oxygen amount relative to today' },
      { symbol: 'PᵢO₂', meaning: 'inspired oxygen pressure', unit: 'kPa' },
      { symbol: 'P_AO₂', meaning: 'alveolar oxygen pressure', unit: 'kPa / mmHg' },
      { symbol: 'M', meaning: 'mean molar mass of air', unit: 'g/mol' },
    ],
    guidedSteps: [
      'Run with “half the oxygen, removed outright” and note the final O₂ share — it is not 10.5 %. Why?',
      'Switch to “replaced by nitrogen”. The O₂ share changes a lot, but the O₂ partial pressure stays the same — why? (Hint: the same number of oxygen molecules is left.)',
      'Read the threshold events: which reference points were crossed, and when during the transition?',
      'Set the oxygen amount to 143 % in “replace” mode (about 30 % O₂) and look at the fire-related reference.',
      'Open the Science tab and list which consequences the model does not compute.',
    ],
    questions: [
      'Why does removing half the oxygen leave more than half the oxygen share?',
      'If oxygen partial pressure is what the lungs feel, why do the two modes give almost the same equivalent altitude?',
      'Why can climbers acclimatise to high altitude, and why does this model ignore that?',
      'Which matters more for a flame: the oxygen percentage or its partial pressure?',
    ],
  },
};
