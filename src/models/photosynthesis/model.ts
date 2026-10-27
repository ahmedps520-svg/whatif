import type { DerivedQuantity, KeyResult, ParamValues, RunRecord, SimEvent, SimulationModel, Warning } from '../../engine/types';
import { num, str } from '../../engine/validation';

/**
 * Photosynthetic human — an energy budget.
 *
 * Sunlight on exposed skin is computed hour by hour from solar geometry and a
 * clear-sky irradiance approximation, multiplied by a photosynthetic
 * efficiency, and compared with a daily food-energy requirement. It answers
 * "how much of a person's energy could sunlight supply?", not whether such a
 * body could exist.
 */

const DEG = Math.PI / 180;
export const SOLAR_CONSTANT = 1361; // W/m², total solar irradiance (Kopp & Lean 2011)
export const KCAL = 4184; // J per kcal

export interface PhotoState {
  t: number; // hours since local midnight of the start day
  harvestToday: number; // J since local midnight
  harvestTotal: number; // J
  lastDayTotal: number; // J harvested on the previous complete day
  days: number[]; // J per completed day
  pending: SimEvent[];
  sunUp: boolean;
  peakToday: number; // W
  peakTodayT: number;
}

/** Solar declination (rad) for day-of-year n (Cooper 1969). */
export function declination(n: number): number {
  return 23.44 * DEG * Math.sin((2 * Math.PI * (284 + n)) / 365);
}

/** Sine of the solar elevation for latitude φ, declination δ and local solar time (h). */
export function sinElevation(latRad: number, decl: number, solarHour: number): number {
  const omega = (15 * (solarHour - 12)) * DEG;
  return Math.sin(latRad) * Math.sin(decl) + Math.cos(latRad) * Math.cos(decl) * Math.cos(omega);
}

/** Relative air mass (Kasten & Young 1989); zenith angle in degrees. */
export function airMass(zenithDeg: number): number {
  return 1 / (Math.cos(zenithDeg * DEG) + 0.50572 * Math.pow(96.07995 - zenithDeg, -1.6364));
}

/**
 * Clear-sky direct-normal irradiance (W/m²) from the empirical Meinel & Meinel
 * relation I = 1.353 kW/m² · 0.7^(AM^0.678), as given by PVEducation.
 */
export function directNormal(zenithDeg: number): number {
  if (zenithDeg >= 90) return 0;
  return 1353 * Math.pow(0.7, Math.pow(airMass(zenithDeg), 0.678));
}

/**
 * Fraction of the exposed skin area that intercepts the direct beam, per unit
 * of direct-normal irradiance, for a simple body shape:
 * - standing: vertical cylinder; projected side area / total side area = sin z / π
 * - lying: flat slab with one face up; projected / total = cos z / 2
 * - facing the sun: flat slab turned to the beam; projected / total = 1 / 2
 */
export function beamFraction(posture: string, zenithDeg: number): number {
  if (zenithDeg >= 90) return 0;
  const z = zenithDeg * DEG;
  if (posture === 'standing') return Math.sin(z) / Math.PI;
  if (posture === 'lying') return Math.max(0, Math.cos(z)) / 2;
  return 0.5;
}

/** Instantaneous harvested power (W) and the irradiance terms, for parameters p at time t (h). */
export function harvestAt(p: ParamValues, tHours: number) {
  const lat = num(p, 'latitude') * DEG;
  const day = num(p, 'dayOfYear') + Math.floor(tHours / 24);
  const solarHour = ((tHours % 24) + 24) % 24;
  const sinEl = sinElevation(lat, declination(day), solarHour);
  const elevation = Math.asin(Math.max(-1, Math.min(1, sinEl))) / DEG;
  const zenith = 90 - elevation;
  const sky = num(p, 'skyTransmission') / 100;
  const dni = directNormal(zenith) * sky;
  // Diffuse sky light ≈ 10 % of the direct beam on a clear day (PVEducation), falling on the upper half of exposed skin.
  const diffuse = elevation > 0 ? 0.1 * directNormal(zenith) * sky : 0;
  const ghi = dni * Math.max(0, sinEl) + diffuse;
  const area = num(p, 'skinArea') * (num(p, 'exposedFraction') / 100);
  const intercepted = area * (dni * beamFraction(str(p, 'posture'), zenith) + diffuse * 0.5); // W of sunlight
  const power = intercepted * (num(p, 'efficiency') / 100);
  return { elevation, dni, ghi, intercepted, power, solarHour };
}

function needW(p: ParamValues): number {
  return (num(p, 'dailyNeed') * KCAL) / 86400;
}

const fmt = (v: number, d = 0) => v.toFixed(d);

export const photosynthesisModel: SimulationModel<PhotoState> = {
  id: 'photosynthesis',
  name: 'Photosynthetic Human Energy Budget',
  shortName: 'Sunlight Budget',
  domain: 'biology',
  viewKind: '2d',
  summary:
    'How much of a person’s daily energy could sunlight on their skin supply? Solar geometry, a clear-sky irradiance model, body posture and a photosynthetic efficiency give the harvest hour by hour.',
  params: [
    { key: 'latitude', label: 'Latitude', type: 'number', unit: 'deg', kind: 'initial', group: 'Place and season', min: -66, max: 66, step: 0.5, default: 35, description: 'Positive north. The model covers latitudes with a sunrise every day.', marks: [ { value: 0, label: 'Equator' }, { value: 23.44, label: 'Tropic' }, { value: 51.5, label: 'London' } ] },
    { key: 'dayOfYear', label: 'Starting day of the year', type: 'number', unit: 'count', kind: 'initial', group: 'Place and season', min: 1, max: 365, step: 1, default: 172, description: 'Day number (1 = 1 January). 172 is near the June solstice, 355 near the December solstice.', marks: [ { value: 80, label: 'Mar equinox' }, { value: 172, label: 'Jun solstice' }, { value: 355, label: 'Dec solstice' } ] },
    { key: 'skyTransmission', label: 'Sky clearness', type: 'number', unit: '%', kind: 'live', group: 'Place and season', min: 5, max: 100, step: 1, default: 100, description: 'Share of the clear-sky sunlight that gets through. 100 % is a cloudless day; overcast skies can be far lower. A simplification: real clouds vary in time and change the direct/diffuse mix.' },
    { key: 'posture', label: 'Posture', type: 'choice', kind: 'live', group: 'Body', default: 'standing', description: 'How the body meets the light.', options: [
      { value: 'standing', label: 'Standing / walking', description: 'Body as an upright cylinder: low sun hits it best.' },
      { value: 'lying', label: 'Lying in the sun', description: 'One side faces the sky: high sun hits it best.' },
      { value: 'facing', label: 'Always facing the sun', description: 'Best case: the body turns to face the sun all day.' },
    ] },
    { key: 'skinArea', label: 'Skin surface area', type: 'number', unit: 'm2', kind: 'live', group: 'Body', min: 0.2, max: 3, step: 0.05, default: 1.8, description: 'Typical adults have roughly 1.6–2.0 m² of skin.' },
    { key: 'exposedFraction', label: 'Skin exposed to light', type: 'number', unit: '%', kind: 'live', group: 'Body', min: 0, max: 100, step: 1, default: 50, description: 'Share of the skin not covered by clothing or hair.' },
    { key: 'efficiency', label: 'Photosynthetic efficiency', type: 'number', unit: '%', kind: 'live', group: 'Biology', min: 0, max: 10, step: 0.1, default: 4.6, description: 'Share of the intercepted solar energy stored as chemical energy. Theoretical maxima are about 4.6 % for C3 plants and 6 % for C4 plants (Zhu, Long & Ort 2008); crops average around 1 % over a season.', marks: [ { value: 1, label: '≈ crop average' }, { value: 4.6, label: 'C3 maximum' }, { value: 6, label: 'C4 maximum' } ] },
    { key: 'dailyNeed', label: 'Daily energy need', type: 'number', unit: 'kcal', kind: 'live', group: 'Biology', min: 500, max: 5000, step: 50, default: 2000, description: 'Food energy in kilocalories per day. 2,000 kcal is the common nutrition-label reference value; actual needs vary with body size and activity.' },
    { key: 'duration', label: 'Days to simulate', type: 'number', unit: 'day', kind: 'initial', group: 'Numerics', numerics: true, min: 1, max: 60, step: 1, default: 3, description: 'Run length in days. Each day starts at local solar midnight.' },
  ],
  observables: [
    { key: 'elevation', label: 'Sun elevation', unit: 'deg', provenance: 'derived', chartGroup: 'sun', sig: 3 },
    { key: 'dni', label: 'Direct sunlight (beam)', unit: 'W/m2', provenance: 'derived', chartGroup: 'irr', sig: 3, description: 'Clear-sky direct-normal irradiance times sky clearness.' },
    { key: 'ghi', label: 'Sunlight on flat ground', unit: 'W/m2', provenance: 'derived', chartGroup: 'irr', sig: 3 },
    { key: 'intercepted', label: 'Sunlight hitting exposed skin', unit: 'W', provenance: 'derived', chartGroup: 'power', sig: 3 },
    { key: 'power', label: 'Energy harvested (power)', unit: 'W', provenance: 'simulated', chart: true, chartGroup: 'harvest', sig: 3 },
    { key: 'need', label: 'Average power the body needs', unit: 'W', provenance: 'assumed', chartGroup: 'harvest', sig: 3 },
    { key: 'todayKcal', label: 'Harvested today', unit: 'kcal', provenance: 'simulated', chart: true, chartGroup: 'today', sig: 3, description: 'Kilocalories since local midnight.' },
    { key: 'todayShare', label: 'Share of daily need so far', unit: '%', provenance: 'simulated', chartGroup: 'share', sig: 3 },
    { key: 'totalKcal', label: 'Harvested since start', unit: 'kcal', provenance: 'simulated', chartGroup: 'total', sig: 4, description: 'Kilocalories.' },
  ],
  primaryObservables: ['power', 'todayKcal'],
  time: {
    unit: 'h',
    dt: 0.05,
    sampleInterval: 0.25,
    defaultDuration: (p) => num(p, 'duration') * 24,
    maxDuration: 60 * 24,
    realtimeRate: 2,
  },

  init(p) {
    const s: PhotoState = { t: 0, harvestToday: 0, harvestTotal: 0, lastDayTotal: NaN, days: [], pending: [], sunUp: harvestAt(p, 0).elevation > 0, peakToday: 0, peakTodayT: 0 };
    return s;
  },

  step(s, p, dt) {
    // Trapezoidal integration of harvested power over the step.
    const a = harvestAt(p, s.t);
    const b = harvestAt(p, s.t + dt);
    const e = 0.5 * (a.power + b.power) * dt * 3600;
    s.harvestToday += e;
    s.harvestTotal += e;
    if (b.power > s.peakToday) {
      s.peakToday = b.power;
      s.peakTodayT = s.t + dt;
    }
    const up = b.elevation > 0;
    if (up !== s.sunUp) {
      const frac = Math.abs(a.elevation) / (Math.abs(a.elevation) + Math.abs(b.elevation) || 1);
      const tt = s.t + frac * dt;
      const hh = Math.floor(tt % 24);
      const mm = Math.round(((tt % 24) - hh) * 60);
      s.pending.push({ t: tt, id: `${up ? 'sunrise' : 'sunset'}-${Math.floor(tt / 24)}`, label: up ? 'Sunrise' : 'Sunset', detail: `Local solar time ${hh}:${String(mm).padStart(2, '0')}.`, severity: 'info', source: 'model' });
      s.sunUp = up;
    }
    const dayBefore = Math.floor(s.t / 24 + 1e-9);
    s.t += dt;
    const dayAfter = Math.floor(s.t / 24 + 1e-9);
    if (dayAfter > dayBefore) {
      const kcal = s.harvestToday / KCAL;
      const share = (kcal / num(p, 'dailyNeed')) * 100;
      s.days.push(s.harvestToday);
      s.lastDayTotal = s.harvestToday;
      const ph = Math.floor(s.peakTodayT % 24);
      s.pending.push({
        t: s.t,
        id: `day-${dayAfter}`,
        label: `Day ${dayAfter}: ${fmt(kcal)} kcal from sunlight — ${fmt(share, 1)} % of ${fmt(num(p, 'dailyNeed'))} kcal`,
        detail: `Peak harvest ${fmt(s.peakToday, 1)} W around ${ph}:00 local solar time.`,
        severity: 'milestone',
        source: 'model',
      });
      s.harvestToday = 0;
      s.peakToday = 0;
    }
  },

  observe(s, p) {
    const h = harvestAt(p, s.t);
    const kcal = s.harvestToday / KCAL;
    return {
      elevation: h.elevation,
      dni: h.dni,
      ghi: h.ghi,
      intercepted: h.intercepted,
      power: h.power,
      need: needW(p),
      todayKcal: kcal,
      todayShare: (kcal / num(p, 'dailyNeed')) * 100,
      totalKcal: s.harvestTotal / KCAL,
    };
  },

  clone: (s) => ({ ...s, days: [...s.days], pending: [...s.pending] }),
  time_of: (s) => s.t,

  detectEvents(_prev, _cur, s) {
    const out = s.pending;
    s.pending = [];
    return out;
  },

  tracks(s, p) {
    const h = harvestAt(p, s.t);
    return [{ id: 'sun', x: (s.t % 24), y: h.elevation }];
  },

  derived(p) {
    // Closed-form daily totals by numerical quadrature of the same irradiance model.
    let wh = 0;
    let beamWh = 0;
    for (let m = 0; m < 24 * 60; m += 2) {
      const h = harvestAt(p, m / 60);
      wh += (h.power * 2) / 60;
      beamWh += (h.intercepted * 2) / 60;
    }
    const kcal = (wh * 3600) / KCAL;
    const need = num(p, 'dailyNeed');
    const area = num(p, 'skinArea') * (num(p, 'exposedFraction') / 100);
    const perM2 = area > 0 ? kcal / area : 0;
    const out: DerivedQuantity[] = [
      { key: 'dayKcal', label: 'Sunlight harvest on the first day', value: kcal, unit: 'kcal', provenance: 'derived', formula: 'E = η ∫ P_intercepted dt (kcal)', sig: 3 },
      { key: 'share', label: 'Share of the daily need', value: (kcal / need) * 100, unit: '%', provenance: 'derived', sig: 3 },
      { key: 'sunlight', label: 'Sunlight energy hitting exposed skin', value: (beamWh * 3600) / KCAL, unit: 'kcal', provenance: 'derived', formula: '∫ (beam + diffuse) · A_exposed · shape factor dt (kcal)', sig: 3 },
      { key: 'needW', label: 'Daily need as average power', value: needW(p), unit: 'W', provenance: 'derived', formula: 'P = need × 4184 J / 86,400 s', sig: 3 },
      { key: 'areaNeeded', label: 'Exposed area needed to cover the need', value: perM2 > 0 ? need / perM2 : Infinity, unit: 'm2', provenance: 'derived', formula: 'A = need ÷ (harvest per m² of exposed skin)', sig: 3, note: 'Same posture, place, day and efficiency. Compare with the ≈1.8 m² of skin a person has.' },
    ];
    return out;
  },

  warnings(p) {
    const w: Warning[] = [];
    const lat = Math.abs(num(p, 'latitude'));
    if (lat > 60) w.push({ id: 'polar', message: 'Near the polar circles the day length changes quickly through the season; results apply to the simulated days only.', severity: 'info' });
    if (num(p, 'efficiency') > 6) w.push({ id: 'eff', message: 'Efficiencies above about 6 % exceed the estimated theoretical maximum for natural photosynthesis (C4 plants).', severity: 'warning' });
    w.push({ id: 'bio', message: 'Skin cannot photosynthesise. The model assumes it could, with a plant-like efficiency, and says nothing about whether such a body could work.', severity: 'info' });
    return w;
  },

  summarize(run: RunRecord): KeyResult[] {
    const days = run.events.filter((e) => e.id.startsWith('day-'));
    const need = Number(run.params.dailyNeed);
    const totalKcal = run.final.totalKcal;
    const nDays = Math.max(1, run.samples.t.at(-1)! / 24);
    const powers = run.samples.obs.power ?? [];
    return [
      { label: 'Average harvest per day', value: totalKcal / nDays, unit: 'kcal', provenance: 'simulated', sig: 3, note: 'Per 24 hours of the run.' },
      { label: 'Share of the daily need', value: ((totalKcal / nDays) / need) * 100, unit: '%', provenance: 'simulated', sig: 3 },
      { label: 'Peak harvested power', value: Math.max(0, ...powers), unit: 'W', provenance: 'simulated', sig: 3 },
      { label: 'Average power the body needs', value: (need * KCAL) / 86400, unit: 'W', provenance: 'assumed', sig: 3 },
      { label: 'Complete days simulated', value: days.length, provenance: 'simulated' },
    ];
  },

  assumptions: [
    { kind: 'established', text: 'Solar position from latitude, day of year and local solar time; declination from Cooper’s (1969) approximation.' },
    { kind: 'approximation', text: 'Clear-sky direct sunlight follows the empirical Meinel & Meinel relation 1.353 kW/m² · 0.7^(AM^0.678) with the Kasten–Young air mass; diffuse sky light is taken as 10 % of the direct beam (both as given by PVEducation).' },
    { kind: 'simplification', text: 'The body is an upright cylinder (standing), a flat slab facing up (lying) or a slab turned to the sun (facing). Self-shading, limbs and ground reflection are ignored.' },
    { kind: 'approximation', text: 'Photosynthetic efficiency is the share of intercepted sunlight stored as chemical energy; literature maxima are about 4.6 % (C3) and 6 % (C4) (Zhu, Long & Ort 2008).' },
    { kind: 'simplification', text: 'Cloud cover is a single clearness factor; real clouds change from minute to minute.' },
    { kind: 'speculative', text: 'Human skin has no chloroplasts. The model asks only how much energy sunlight could supply if it did; anatomy, gas exchange, water, nutrients and heat load are not considered.' },
  ],
  limitations: [
    'No atmosphere refraction, altitude, aerosols or local horizon.',
    'Energy stored by photosynthesis is not the same as usable food energy; conversion losses would lower the result further.',
    'Day length is computed for each simulated day; equation of time and longitude offsets are ignored (local solar time).',
    'Only latitudes between the polar circles are supported.',
  ],
  equations: [
    { label: 'Solar elevation', formula: 'sin h = sin φ sin δ + cos φ cos δ cos ω,   ω = 15° (t − 12)', explanation: 'Latitude φ, declination δ and hour angle ω set the sun’s height.' },
    { label: 'Declination', formula: 'δ = 23.44° · sin(360° (284 + n) / 365)', explanation: 'Cooper’s approximation for day of year n.' },
    { label: 'Clear-sky direct sunlight', formula: 'I_D = 1353 W/m² · 0.7^(AM^0.678)', explanation: 'Empirical attenuation through the atmosphere; AM is the relative air mass.' },
    { label: 'Light intercepted', formula: 'P = A·f·(I_D·s(z) + 0.5·I_diffuse)', explanation: 'Exposed area A·f, a shape factor s(z) for the posture, and diffuse light on half the exposed skin.' },
    { label: 'Energy harvested', formula: 'E = η ∫ P dt', explanation: 'Photosynthetic efficiency η times the intercepted solar energy, integrated over the day.' },
  ],
  education: {
    objectives: [
      'Estimate the solar energy available to a human-sized surface.',
      'Compare a photosynthetic energy budget with a person’s daily food-energy need.',
      'See how latitude, season, posture and efficiency change the answer.',
      'Explain why large, flat leaves suit photosynthesis better than bodies do.',
    ],
    background: {
      beginner: 'Plants turn sunlight into food, but only a few percent of the light ends up stored as sugar. A person has far less surface than a tree and is not flat like a leaf. This model adds up how much sunlight lands on your skin in a day and what share of your food energy it could replace.',
      intermediate: 'Sunlight at the top of the atmosphere carries about 1,361 W/m²; on a clear day roughly 1,000 W/m² reaches the ground when the sun is high. A standing body intercepts the direct beam mostly when the sun is low, a lying body when it is high. Multiplying by an efficiency of a few percent and integrating over the day gives the harvest, which you can compare with about 2,000 kcal (≈ 97 W on average) a person needs.',
      advanced: 'The harvest is η∫A f [I_D(z) s(z) + 0.5·0.1 I_D(z)] dt with I_D from the Meinel relation and AM from Kasten–Young. For a vertical cylinder the beam-intercepting fraction of lateral area is sin z/π; for a horizontal slab it is cos z/2. Integrating with a 3-minute step over a day reproduces the closed-form quadrature in the derived panel. Theoretical photosynthetic maxima (≈4.6 % C3, ≈6 % C4) bound η; realistic field efficiencies are several times lower.',
    },
    variables: [
      { symbol: 'φ, δ, ω', meaning: 'latitude, solar declination, hour angle', unit: '°' },
      { symbol: 'z', meaning: 'solar zenith angle (90° − elevation)', unit: '°' },
      { symbol: 'I_D', meaning: 'direct-normal irradiance', unit: 'W/m²' },
      { symbol: 'A, f', meaning: 'skin area and exposed share', unit: 'm², %' },
      { symbol: 'η', meaning: 'photosynthetic efficiency', unit: '%' },
    ],
    guidedSteps: [
      'Run the default day and read the daily harvest event: what share of 2,000 kcal is it?',
      'Switch posture to “Always facing the sun” and set exposed skin to 100 % — the generous best case.',
      'Move to the equator, then to 51.5° N in December. How much does the season matter?',
      'Read “Exposed area needed to cover the need” in the derived panel and compare it with 1.8 m².',
      'Lower the efficiency to a typical crop value (≈1 %).',
    ],
    questions: [
      'Why would a photosynthetic animal benefit from being flat and still?',
      'Which matters more for the harvest: latitude or posture?',
      'What else, besides energy, would a photosynthetic body need?',
    ],
  },
};
