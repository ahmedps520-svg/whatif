import type { DerivedQuantity, KeyResult, ParamValues, RunRecord, SimEvent, SimulationModel, Warning } from '../../engine/types';
import { bool, num, str } from '../../engine/validation';
import { AU, DAY, EARTH_MOON_DISTANCE, G, M_EARTH, M_MOON, M_SUN, MT_TNT, R_EARTH, R_MOON, RHO_EARTH, RHO_MOON } from '../orbits/constants';
import {
  accuracyParam,
  capWarning,
  drainCollisions,
  etaFor,
  f,
  newApsisTracker,
  newMinimumTracker,
  shouldReport,
  updateApsis,
  updateMinimum,
  type ApsisTracker,
  type MinimumTracker,
} from '../orbits/common';
import {
  advance,
  centreOfMass,
  cloneSystem,
  conicFromTangential,
  createSystem,
  energyError,
  keplerPeriod,
  makeBody,
  newRelState,
  osculating,
  relativeState,
  removeBody,
  resetEnergyReference,
  separation,
  toBarycentricFrame,
  type Body,
  type NBodyState,
} from '../orbits/nbody';

/**
 * Earth with one or two moons — a Newtonian N-body integration of Earth and its
 * moons together (Earth wobbles around the barycentre). Model time is in days;
 * positions are tracked in km in the barycentric frame at t = 0 (after any
 * sudden change of Earth's mass).
 */

export interface MoonTracker {
  bodyId: string;
  index: number;
  /** Starting distance from Earth's centre, m. */
  d0: number;
  apsis: ApsisTracker;
  minD: number;
  maxD: number;
  escaped: boolean;
  insideRoche: boolean;
  rocheCrossings: number;
}

export interface MoonsState {
  /** Model time, days. */
  t: number;
  sys: NBodyState;
  moons: MoonTracker[];
  /** Closest approaches between the two moons (null with one moon). */
  pair: MinimumTracker | null;
  pending: SimEvent[];
  eta: number;
  vanished: boolean;
  /** Fluid Roche limit for a lunar-density moon around this Earth, m. */
  roche: number;
}

export const EARTH_ID = 'earth';
export const MOON1_ID = 'moon1';
export const MOON2_ID = 'moon2';

/** Tidal (differential) acceleration at Earth's surface from a body of mass m at distance d: 2GmR/d³. */
export function tidalAcceleration(m: number, d: number): number {
  return (2 * G * m * R_EARTH) / (d * d * d);
}

/** Today's lunar tidal acceleration at Earth's surface (mean distance), m/s². */
export const LUNAR_TIDE_TODAY = tidalAcceleration(M_MOON, EARTH_MOON_DISTANCE);
/** The Sun's tidal acceleration at Earth's surface at 1 AU, m/s². */
export const SOLAR_TIDE = tidalAcceleration(M_SUN, AU);

/** Fluid-body Roche limit d = 2.44 R⊕ (ρ⊕/ρ_moon)^⅓ for Earth's mass × k at fixed radius. */
export function rocheLimit(k: number): number {
  return 2.44 * R_EARTH * Math.cbrt((k * RHO_EARTH) / RHO_MOON);
}

/** Earth's Hill radius in the Sun's field, a·(m/3M☉)^⅓ (reference only: no Sun in this model). */
export function earthHillRadius(k: number): number {
  return AU * Math.cbrt((k * M_EARTH) / (3 * M_SUN));
}

function seededMinimum(d: number): MinimumTracker {
  const m = newMinimumTracker();
  m.globalMin = d;
  m.globalMinT = 0;
  return m;
}

function moonRadius(massFactor: number) {
  return R_MOON * Math.cbrt(massFactor);
}

function twoMoons(p: ParamValues) {
  return str(p, 'moonCount') === '2';
}

/** Closed-form prediction for moon 1 after the sudden change of Earth's mass. */
export function predictMoon1(p: ParamValues) {
  const m = num(p, 'moon1Mass') * M_MOON;
  const d = num(p, 'moon1Distance') * 1000;
  const v0 = Math.sqrt((G * (M_EARTH + m)) / d);
  const mu1 = G * (M_EARTH * num(p, 'earthMassFactor') + m);
  return { v0, period0: keplerPeriod(G * (M_EARTH + m), d), conic: conicFromTangential(mu1, d, v0) };
}

function shortestPeriodDays(p: ParamValues): number {
  const k = Math.max(1, num(p, 'earthMassFactor'));
  let d = num(p, 'moon1Distance');
  if (twoMoons(p)) d = Math.min(d, num(p, 'moon2Distance'));
  return keplerPeriod(G * M_EARTH * k, d * 1000) / DAY;
}

function sampleIntervalDays(p: ParamValues): number {
  const tau = shortestPeriodDays(p);
  const pr = predictMoon1(p);
  const d = num(p, 'moon1Distance') * 1000;
  const rp = Math.max(pr.conic.rp, R_EARTH);
  const tPeri = rp / ((d * pr.v0) / rp) / DAY;
  return Math.max(Math.min(tau / 150, tPeri / 3), num(p, 'duration') / 3000, 1e-3);
}

const SCR = newRelState();
const MIN_OUT = { d: 0, t: 0 };

function earthOf(s: MoonsState): Body {
  return s.sys.bodies[0];
}

function bodyOf(s: MoonsState, id: string): Body | undefined {
  return s.sys.bodies.find((b) => b.id === id);
}

function trackSubstep(s: MoonsState, t0: number, sec0: number) {
  const sys = s.sys;
  const earth = earthOf(s);
  const t = t0 + (sys.t - sec0) / DAY;
  for (let i = 0; i < s.moons.length; i++) {
    const mt = s.moons[i];
    const b = sys.bodies[mt.index];
    if (!b.alive || !earth.alive) continue;
    const rel = relativeState(b, earth, SCR);
    if (rel.r < mt.minD) mt.minD = rel.r;
    if (rel.r > mt.maxD) mt.maxD = rel.r;
    const code = updateApsis(mt.apsis, rel.r, rel.rdot, rel.v, t);
    if (code === 1 && shouldReport(mt.apsis.periCount)) {
      const dkm = mt.apsis.lastR / 1000;
      s.pending.push({
        t: mt.apsis.lastT,
        id: `${b.id}-perigee-${mt.apsis.periCount}`,
        label: `${b.label} perigee: ${f(dkm)} km at day ${f(mt.apsis.lastT, 4)}`,
        detail: `Closest point of pass #${mt.apsis.periCount}. Its tidal pull on Earth there is ${f(tidalAcceleration(b.mass, mt.apsis.lastR) / LUNAR_TIDE_TODAY)}× today’s lunar tide.`,
        severity: 'info',
        source: 'model',
      });
    } else if (code === 2 && shouldReport(mt.apsis.apoCount)) {
      const dkm = mt.apsis.lastR / 1000;
      s.pending.push({
        t: mt.apsis.lastT,
        id: `${b.id}-apogee-${mt.apsis.apoCount}`,
        label: `${b.label} apogee: ${f(dkm)} km at day ${f(mt.apsis.lastT, 4)}`,
        detail: `Farthest point of pass #${mt.apsis.apoCount}. Tidal pull there: ${f(tidalAcceleration(b.mass, mt.apsis.lastR) / LUNAR_TIDE_TODAY)}× today’s lunar tide.`,
        severity: 'info',
        source: 'model',
      });
    }
    if (rel.r < s.roche && !mt.insideRoche) {
      mt.insideRoche = true;
      mt.rocheCrossings++;
      if (shouldReport(mt.rocheCrossings)) {
        s.pending.push({
          t,
          id: `${b.id}-roche-${mt.rocheCrossings}`,
          label: `${b.label} passed inside the Roche limit`,
          detail: `At ${f(rel.r / 1000)} km on day ${f(t, 4)}, inside the fluid Roche limit of ${f(s.roche / 1000)} km. Tides there would tear apart a moon held together only by its own gravity; a rocky moon may survive for a while through material strength. This model does not simulate breakup and keeps the moon whole.`,
          severity: 'warning',
          source: 'model',
        });
      }
    } else if (mt.insideRoche && rel.r > 1.01 * s.roche) {
      mt.insideRoche = false;
    }
    if (!mt.escaped && rel.energy > 0 && rel.rdot > 0 && rel.r > 2 * mt.d0) {
      mt.escaped = true;
      s.pending.push({
        t,
        id: `${b.id}-escape`,
        label: `${b.label} escaped from Earth`,
        detail: `On day ${f(t, 4)} it is ${f(rel.r / 1000)} km away, receding at ${f(rel.v)} m/s with positive orbital energy. In reality, beyond Earth’s Hill sphere (about ${f(earthHillRadius(earth.mass / M_EARTH) / 1000)} km) the Sun’s gravity would take over; the Sun is not in this model.`,
        severity: 'warning',
        source: 'model',
      });
    }
  }
  if (s.pair) {
    const a = sys.bodies[s.moons[0].index];
    const b = sys.bodies[s.moons[1].index];
    if (a.alive && b.alive && updateMinimum(s.pair, separation(a, b), t, MIN_OUT) && shouldReport(s.pair.count)) {
      s.pending.push({
        t: MIN_OUT.t,
        id: `moons-close-${s.pair.count}`,
        label: `Moons’ closest approach: ${f(MIN_OUT.d / 1000)} km at day ${f(MIN_OUT.t, 4)}`,
        detail: `Close approach #${s.pair.count} between ${a.label} and ${b.label} (centre to centre).`,
        severity: MIN_OUT.d < 20 * (a.radius + b.radius) ? 'warning' : 'info',
        source: 'model',
      });
    }
  }
}

function reportCollisions(s: MoonsState, t0: number, sec0: number) {
  for (const c of drainCollisions(s.sys)) {
    const t = t0 + (c.t - sec0) / DAY;
    const imp = bodyOf(s, c.impactorId)!;
    const sur = bodyOf(s, c.survivorId)!;
    s.pending.push({
      t,
      id: `${imp.id}-hit-${sur.id}`,
      label: sur.id === EARTH_ID ? `${imp.label} crashed into Earth` : `${imp.label} collided with ${sur.label}`,
      detail: `On day ${f(t, 4)} at ${f(c.relSpeed / 1000)} km/s, releasing about ${f(c.energy)} J (${f(c.energy / MT_TNT)} Mt of TNT) of kinetic energy. Modelled as a perfectly inelastic merger; the consequences are far outside this model.`,
      severity: 'critical',
      source: 'model',
    });
  }
}

function vanishMoon(s: MoonsState, t: number): SimEvent | null {
  if (s.vanished) return null;
  const earth = earthOf(s);
  const moon = bodyOf(s, MOON1_ID);
  if (!moon || !moon.alive) return null;
  const v = Math.hypot(earth.vel[0], earth.vel[1], earth.vel[2]);
  removeBody(s.sys, MOON1_ID);
  s.vanished = true;
  return {
    t,
    id: 'moon1-vanished',
    label: `${moon.label} vanished on day ${f(t, 4)}`,
    detail: `Earth keeps the ${f(v)} m/s it had while circling the old Earth–Moon barycentre, so it now drifts in a straight line (about ${f((v * DAY) / 1000)} km per day). The Moon’s tides disappear; the Sun’s remain at ${f(SOLAR_TIDE / LUNAR_TIDE_TODAY)}× today’s lunar tide.`,
    severity: 'critical',
    source: 'model',
  };
}

function advanceTracked(s: MoonsState, dtDays: number, tStart: number) {
  if (dtDays <= 0) return;
  const sec0 = s.sys.t;
  const res = advance(s.sys, dtDays * DAY, { eta: s.eta, onSubstep: () => trackSubstep(s, tStart, sec0) });
  if (s.sys.collisions.length) reportCollisions(s, tStart, sec0);
  if (res.capped) {
    const w = capWarning(s.sys, tStart + dtDays, 'days');
    if (w) s.pending.push(w);
  }
}

export const moonsModel: SimulationModel<MoonsState> = {
  id: 'moons',
  name: 'Earth and Its Moons',
  shortName: 'Moons',
  domain: 'astronomy',
  viewKind: '3d',
  summary:
    'Earth with one or two moons, integrated together under Newtonian gravity so Earth wobbles around the barycentre. Add a second moon, change Earth’s mass suddenly, or make the Moon vanish, and follow the orbits, the barycentre and the tides.',
  params: [
    { key: 'moonCount', label: 'Number of moons', type: 'choice', kind: 'initial', group: 'Moons', default: '1', description: 'One moon (the Moon) or two (the Moon plus a hypothetical second moon).', options: [
      { value: '1', label: 'One moon' },
      { value: '2', label: 'Two moons', description: 'Adds a hypothetical second moon.' },
    ] },
    { key: 'moon1Distance', label: 'Moon distance', type: 'number', unit: 'km', kind: 'initial', group: 'Moons', min: 15000, max: 1000000, step: 100, default: 384400, scale: 'log', description: 'Starting centre-to-centre distance of the (first) Moon, on a circular orbit for Earth’s original mass.', marks: [
      { value: 42164, label: 'Geostationary' }, { value: 192200, label: 'Half today' }, { value: 384400, label: 'Today' },
    ] },
    { key: 'moon1Mass', label: 'Moon mass', type: 'number', unit: 'M_moon', kind: 'initial', group: 'Moons', min: 0.001, max: 10, step: 0.001, default: 1, scale: 'log', description: 'Mass of the (first) Moon, in units of today’s Moon. Its radius scales assuming lunar density.', marks: [
      { value: 0.1, label: '0.1×' }, { value: 1, label: 'Today' }, { value: 2, label: '2×' },
    ] },
    { key: 'moon2Distance', label: 'Second moon distance', type: 'number', unit: 'km', kind: 'initial', group: 'Second moon', min: 15000, max: 1000000, step: 100, default: 200000, scale: 'log', description: 'Starting distance of the second moon from Earth’s centre (circular orbit).', visibleWhen: twoMoons },
    { key: 'moon2Mass', label: 'Second moon mass', type: 'number', unit: 'M_moon', kind: 'initial', group: 'Second moon', min: 0.001, max: 10, step: 0.001, default: 0.25, scale: 'log', description: 'Mass of the second moon in Moon masses.', visibleWhen: twoMoons },
    { key: 'moon2Phase', label: 'Second moon starting angle', type: 'number', unit: 'deg', kind: 'initial', group: 'Second moon', min: 0, max: 360, step: 1, default: 120, description: 'Angle around Earth between the two moons at t = 0.', visibleWhen: twoMoons },
    { key: 'earthMassFactor', label: 'Sudden Earth-mass change at t = 0', type: 'number', unit: 'x', kind: 'initial', group: 'Earth', min: 0.1, max: 5, step: 0.01, default: 1, description: 'Multiply Earth’s mass (and so its gravity) instantly at t = 0. The moons start on circular orbits for the original mass and keep their velocities.', marks: [
      { value: 0.5, label: 'Halved' }, { value: 1, label: 'Today' }, { value: 2, label: 'Doubled' },
    ] },
    { key: 'moonVanish', label: 'Make the Moon vanish', type: 'boolean', kind: 'initial', group: 'Scenario', default: false, description: 'Remove the (first) Moon at the chosen time. Earth keeps the velocity it had around the old barycentre.' },
    { key: 'vanishTime', label: 'Moon vanishes at', type: 'number', unit: 'day', kind: 'initial', group: 'Scenario', min: 0, max: 3650, step: 0.1, default: 7, description: 'Simulated day on which the Moon disappears.', visibleWhen: (p) => bool(p, 'moonVanish') },
    { key: 'duration', label: 'Simulation duration', type: 'number', unit: 'day', kind: 'initial', group: 'Numerics', numerics: true, min: 1, max: 3650, step: 1, default: 60, scale: 'log', description: 'Run length in days.', marks: [
      { value: 27.3, label: '1 month' }, { value: 365.25, label: '1 yr' },
    ] },
    accuracyParam(),
  ],
  observables: [
    { key: 'd1', label: 'Moon distance', unit: 'km', provenance: 'simulated', chart: true, chartGroup: 'distance', sig: 4, description: 'Centre-to-centre distance between Earth and the (first) Moon.' },
    { key: 'd2', label: 'Second moon distance', unit: 'km', provenance: 'simulated', chart: true, chartGroup: 'distance', sig: 4 },
    { key: 'ecc1', label: 'Moon eccentricity (osculating)', unit: '1', provenance: 'derived', chartGroup: 'shape', sig: 3, description: 'Shape of the two-body ellipse matching the Moon’s current motion relative to Earth.' },
    { key: 'rp1', label: 'Moon perigee (osculating)', unit: 'km', provenance: 'derived', chartGroup: 'distance', sig: 4, readout: false },
    { key: 'earthOffset', label: 'Earth’s offset from the barycentre', unit: 'km', provenance: 'simulated', chartGroup: 'earth', sig: 4, description: 'Distance of Earth’s centre from the current centre of mass of Earth and its moons.' },
    { key: 'earthDrift', label: 'Earth’s distance from the starting barycentre', unit: 'km', provenance: 'simulated', chart: true, chartGroup: 'earth', sig: 4, description: 'How far Earth’s centre is from where the system’s centre of mass was at t = 0. Stays near the wobble radius while the system is intact; grows if a moon vanishes.' },
    { key: 'earthSpeed', label: 'Earth’s speed (starting barycentre frame)', unit: 'm/s', provenance: 'simulated', chartGroup: 'earthSpeed', sig: 3, description: 'Speed of Earth’s centre in the frame where the system’s centre of mass was at rest at t = 0.' },
    { key: 'tide1', label: 'Tidal acceleration from the Moon', unit: 'm/s2', provenance: 'derived', chartGroup: 'tideAbs', sig: 3, description: '2GmR⊕/d³ at the point on Earth’s surface nearest the Moon.' },
    { key: 'tide2', label: 'Tidal acceleration from the second moon', unit: 'm/s2', provenance: 'derived', chartGroup: 'tideAbs', sig: 3 },
    { key: 'tideRel', label: 'Total lunar tide (× today)', unit: 'x', provenance: 'derived', chart: true, chartGroup: 'tide', sig: 3, description: 'Sum of the moons’ tidal accelerations relative to today’s Moon at its mean distance.' },
    { key: 'tideSunRel', label: 'Solar tide (× today’s lunar tide)', unit: 'x', provenance: 'derived', chart: true, chartGroup: 'tide', sig: 3, description: 'The Sun’s tidal acceleration at 1 AU (2GM☉R⊕/AU³) relative to today’s lunar tide; computed, constant here because the Sun is not simulated.' },
    { key: 'moonSep', label: 'Distance between the moons', unit: 'km', provenance: 'simulated', chartGroup: 'distance', sig: 4 },
    { key: 'minSep', label: 'Closest moon–moon approach so far', unit: 'km', provenance: 'simulated', sig: 4, readout: false },
    { key: 'minD1', label: 'Moon’s closest distance so far', unit: 'km', provenance: 'simulated', sig: 4, readout: false },
    { key: 'maxD1', label: 'Moon’s farthest distance so far', unit: 'km', provenance: 'simulated', sig: 4, readout: false },
    { key: 'energyErr', label: 'Relative energy error', unit: '1', provenance: 'simulated', chartGroup: 'numerics', sig: 2, description: 'Numerical error of the integrator: change of total energy since t = 0 (excluding deliberate changes such as the Moon vanishing) relative to its size.' },
  ],
  primaryObservables: ['d1', 'tideRel'],
  time: {
    unit: 'day',
    dt: (p) => Math.max(Math.min(shortestPeriodDays(p) / 1000, sampleIntervalDays(p)), 1e-4),
    sampleInterval: sampleIntervalDays,
    defaultDuration: (p) => num(p, 'duration'),
    durationParam: 'duration',
    maxDuration: 3650,
    realtimeRate: (p) => Math.max(shortestPeriodDays(p) / 9, 0.01),
  },

  init(p) {
    const ME = M_EARTH;
    const earth = makeBody({ id: EARTH_ID, label: 'Earth', slot: 0, mass: ME, radius: R_EARTH, pos: [0, 0, 0], vel: [0, 0, 0], priority: 1 });
    const specs = [{ id: MOON1_ID, label: 'Moon', slot: 1, mf: num(p, 'moon1Mass'), d: num(p, 'moon1Distance') * 1000, phase: 0 }];
    if (twoMoons(p)) specs.push({ id: MOON2_ID, label: 'Second moon', slot: 2, mf: num(p, 'moon2Mass'), d: num(p, 'moon2Distance') * 1000, phase: (num(p, 'moon2Phase') * Math.PI) / 180 });
    const moons = specs.map((m) => makeBody({ id: m.id, label: m.label, slot: m.slot, mass: m.mf * M_MOON, radius: moonRadius(m.mf), pos: [m.d * Math.cos(m.phase), m.d * Math.sin(m.phase), 0], vel: [0, 0, 0] }));
    // Hierarchical (Jacobi) set-up: the inner moon circles Earth; the outer one circles the inner pair's centre of mass.
    const order = moons.map((_, i) => i).sort((a, b) => specs[a].d - specs[b].d);
    const inner = moons[order[0]];
    {
      const ph = specs[order[0]].phase;
      const v = Math.sqrt((G * (ME + inner.mass)) / specs[order[0]].d);
      inner.vel = [-v * Math.sin(ph), v * Math.cos(ph), 0];
    }
    if (order.length > 1) {
      const outer = moons[order[1]];
      const mIn = ME + inner.mass;
      const c = inner.pos.map((x) => (inner.mass * x) / mIn);
      const vc = inner.vel.map((x) => (inner.mass * x) / mIn);
      const rx = outer.pos[0] - c[0];
      const ry = outer.pos[1] - c[1];
      const rho = Math.hypot(rx, ry);
      const v = Math.sqrt((G * (mIn + outer.mass)) / rho);
      outer.vel = [vc[0] - (v * ry) / rho, vc[1] + (v * rx) / rho, 0];
    }
    const sys = createSystem([earth, ...moons]);
    toBarycentricFrame(sys);
    const pending: SimEvent[] = [];
    const k = num(p, 'earthMassFactor');
    if (k !== 1) {
      earth.mass *= k;
      toBarycentricFrame(sys);
      const pr = predictMoon1(p);
      pending.push({
        t: 0,
        id: 'earth-mass-change',
        label: `Earth’s mass changed ×${f(k)}`,
        detail: pr.conic.bound
          ? `The Moon keeps its ${f(pr.v0, 4)} m/s, which is now the wrong speed for a circle. Vis-viva predicts a new orbit with eccentricity ${f(pr.conic.e)}, perigee ${f(pr.conic.rp / 1000)} km and apogee ${f(pr.conic.ra / 1000)} km.`
          : `The Moon keeps its ${f(pr.v0, 4)} m/s, which is now above the escape speed (${f(Math.sqrt((2 * G * (M_EARTH * k + num(p, 'moon1Mass') * M_MOON)) / (num(p, 'moon1Distance') * 1000)), 4)} m/s): it is no longer bound.`,
        severity: 'warning',
        source: 'model',
      });
    }
    resetEnergyReference(sys);
    const trackers: MoonTracker[] = moons.map((b, i) => {
      const r = relativeState(b, earth, newRelState()).r;
      return { bodyId: b.id, index: i + 1, d0: r, apsis: newApsisTracker(), minD: r, maxD: r, escaped: false, insideRoche: false, rocheCrossings: 0 };
    });
    const s: MoonsState = {
      t: 0,
      sys,
      moons: trackers,
      pair: moons.length > 1 ? seededMinimum(separation(moons[0], moons[1])) : null,
      pending,
      eta: etaFor(p),
      vanished: false,
      roche: rocheLimit(k),
    };
    if (bool(p, 'moonVanish') && num(p, 'vanishTime') <= 0) {
      const e = vanishMoon(s, 0);
      if (e) s.pending.push(e);
    }
    return s;
  },

  step(s, p, dt) {
    const t0 = s.t;
    if (bool(p, 'moonVanish') && !s.vanished) {
      const tv = num(p, 'vanishTime');
      if (tv >= t0 - 1e-9 && tv < t0 + dt - 1e-9) {
        const a = Math.max(0, tv - t0);
        advanceTracked(s, a, t0);
        const e = vanishMoon(s, t0 + a);
        if (e) s.pending.push(e);
        advanceTracked(s, dt - a, t0 + a);
        s.t = t0 + dt;
        return;
      }
    }
    advanceTracked(s, dt, t0);
    s.t = t0 + dt;
  },

  observe(s) {
    const earth = earthOf(s);
    const out: Record<string, number> = {
      d1: NaN, d2: NaN, ecc1: NaN, rp1: NaN, earthOffset: NaN, earthDrift: NaN, earthSpeed: NaN,
      tide1: 0, tide2: 0, tideRel: 0, tideSunRel: SOLAR_TIDE / LUNAR_TIDE_TODAY, moonSep: NaN, minSep: NaN, minD1: NaN, maxD1: NaN,
      energyErr: energyError(s.sys),
    };
    const m1 = bodyOf(s, MOON1_ID);
    const m2 = bodyOf(s, MOON2_ID);
    const t1 = s.moons[0];
    if (t1) {
      out.minD1 = t1.minD / 1000;
      out.maxD1 = t1.maxD / 1000;
    }
    if (m1?.alive) {
      const el = osculating(m1, earth);
      out.d1 = el.r / 1000;
      out.ecc1 = el.e;
      out.rp1 = el.rp / 1000;
      out.tide1 = tidalAcceleration(m1.mass, el.r);
    }
    if (m2?.alive) {
      const r = separation(m2, earth);
      out.d2 = r / 1000;
      out.tide2 = tidalAcceleration(m2.mass, r);
      if (m1?.alive) out.moonSep = separation(m1, m2) / 1000;
    } else if (!m2) out.tide2 = NaN;
    if (s.pair && Number.isFinite(s.pair.globalMin)) out.minSep = s.pair.globalMin / 1000;
    out.tideRel = ((Number.isNaN(out.tide2) ? 0 : out.tide2) + out.tide1) / LUNAR_TIDE_TODAY;
    const c = centreOfMass(s.sys);
    out.earthOffset = Math.hypot(earth.pos[0] - c.pos[0], earth.pos[1] - c.pos[1], earth.pos[2] - c.pos[2]) / 1000;
    out.earthDrift = Math.hypot(earth.pos[0], earth.pos[1], earth.pos[2]) / 1000;
    out.earthSpeed = Math.hypot(earth.vel[0], earth.vel[1], earth.vel[2]);
    return out;
  },

  clone(s) {
    return {
      ...s,
      sys: cloneSystem(s.sys),
      moons: s.moons.map((m) => ({ ...m, apsis: { ...m.apsis } })),
      pair: s.pair ? { ...s.pair } : null,
      pending: [...s.pending],
    };
  },

  time_of: (s) => s.t,

  detectEvents(_prev, _cur, s) {
    const out = s.pending.sort((a, b) => a.t - b.t);
    s.pending = [];
    return out;
  },

  tracks(s) {
    const out = [];
    for (const b of s.sys.bodies) {
      if (!b.alive) continue;
      out.push({ id: b.id, x: b.pos[0] / 1000, y: b.pos[1] / 1000, z: b.pos[2] / 1000 });
    }
    return out;
  },

  actions: [{ id: 'vanish', label: 'Make the Moon vanish now', description: 'Remove the (first) Moon at the current time. Earth keeps its current velocity.' }],

  applyAction(s, _p, id) {
    if (id !== 'vanish') return null;
    const e = vanishMoon(s, s.t);
    return e ?? { t: s.t, id: `vanish-none-${s.t}`, label: 'Nothing to remove', detail: 'The Moon is already gone.', severity: 'info' };
  },

  derived(p) {
    const k = num(p, 'earthMassFactor');
    const m1 = num(p, 'moon1Mass') * M_MOON;
    const d1 = num(p, 'moon1Distance') * 1000;
    const pr = predictMoon1(p);
    const out: DerivedQuantity[] = [
      { key: 'v1', label: 'Moon’s circular speed (original Earth mass)', value: pr.v0, unit: 'm/s', formula: 'v = √(G(M⊕ + m)/d)', provenance: 'derived', sig: 4 },
      { key: 'T1', label: 'Moon’s orbital period (original Earth mass)', value: pr.period0 / DAY, unit: 'day', formula: 'T = 2π √(d³/G(M⊕ + m))', provenance: 'derived', sig: 4, note: 'Sidereal period of a circular orbit. The real Moon’s (27.32 days) differs slightly because its orbit is elliptical and the Sun perturbs it.' },
      { key: 'bary', label: 'Barycentre offset from Earth’s centre', value: (d1 * m1) / (M_EARTH + m1) / 1000, unit: 'km', formula: 'r = d · m/(M⊕ + m)', provenance: 'derived', sig: 4, note: 'For Earth and the first Moon alone, before any mass change. Earth’s radius is 6,371 km, so today the barycentre lies inside Earth.' },
      { key: 'vE', label: 'Earth’s speed around the barycentre', value: (m1 / (M_EARTH + m1)) * pr.v0, unit: 'm/s', formula: 'v⊕ = v · m/(M⊕ + m)', provenance: 'derived', sig: 3, note: 'If the Moon vanished, Earth would keep drifting at this speed.' },
    ];
    if (k !== 1) {
      if (pr.conic.bound) {
        out.push(
          { key: 'e1', label: 'Moon’s new eccentricity (after the change)', value: pr.conic.e, unit: '1', formula: 'e = √(1 + 2εh²/μ′²)', provenance: 'derived', sig: 3 },
          { key: 'rp1', label: 'Moon’s new perigee', value: pr.conic.rp / 1000, unit: 'km', formula: 'r_p = a(1 − e)', provenance: 'derived', sig: 4 },
          { key: 'ra1', label: 'Moon’s new apogee', value: pr.conic.ra / 1000, unit: 'km', formula: 'r_a = a(1 + e)', provenance: 'derived', sig: 4 },
          { key: 'T1new', label: 'Moon’s new orbital period', value: pr.conic.period / DAY, unit: 'day', formula: 'T = 2π √(a³/μ′)', provenance: 'derived', sig: 4 },
        );
      } else {
        out.push({ key: 'vEsc1', label: 'Escape speed at the Moon’s distance after the change', value: Math.sqrt((2 * G * (M_EARTH * k + m1)) / d1), unit: 'm/s', formula: 'v_esc = √(2μ′/d)', provenance: 'derived', sig: 4, note: 'Lower than the Moon’s speed: it is no longer bound and escapes.' });
      }
    }
    out.push(
      { key: 'roche', label: 'Fluid Roche limit', value: rocheLimit(k) / 1000, unit: 'km', formula: 'd_R = 2.44 R⊕ (ρ⊕/ρ_moon)^⅓', provenance: 'derived', sig: 3, note: `With ρ⊕ = ${f(k * RHO_EARTH)} kg/m³ (Earth’s radius held fixed) and lunar density ${f(RHO_MOON)} kg/m³.` },
      { key: 'tideToday', label: 'Today’s lunar tidal acceleration', value: LUNAR_TIDE_TODAY, unit: 'm/s2', formula: 'a_t = 2 G M_moon R⊕ / d³,  d = 384,400 km', provenance: 'derived', sig: 3 },
      { key: 'tideSun', label: 'Solar tidal acceleration', value: SOLAR_TIDE, unit: 'm/s2', formula: 'a_t = 2 G M☉ R⊕ / (1 AU)³', provenance: 'derived', sig: 3 },
      { key: 'tideSunRel', label: 'Solar tide relative to today’s lunar tide', value: SOLAR_TIDE / LUNAR_TIDE_TODAY, unit: 'x', formula: '(M☉/M_moon) (d_moon/AU)³', provenance: 'derived', sig: 3 },
      { key: 'tide1Rel', label: 'Moon’s tide at its starting distance (× today)', value: tidalAcceleration(m1, d1) / LUNAR_TIDE_TODAY, unit: 'x', formula: '(m/M_moon)(384,400 km/d)³', provenance: 'derived', sig: 3 },
      { key: 'hillEarth', label: 'Earth’s Hill sphere radius (Sun not modelled)', value: earthHillRadius(k) / 1000, unit: 'km', formula: 'r_H = 1 AU · (M⊕/3M☉)^⅓', provenance: 'derived', sig: 3, note: 'Prograde moons are only long-term stable within roughly half of this; the model has no Sun, so it cannot show that.' },
    );
    if (twoMoons(p)) {
      const m2 = num(p, 'moon2Mass') * M_MOON;
      const d2 = num(p, 'moon2Distance') * 1000;
      const rH = Math.cbrt((m1 + m2) / (3 * M_EARTH)) * ((d1 + d2) / 2);
      out.push(
        { key: 'T2', label: 'Second moon’s orbital period', value: keplerPeriod(G * (M_EARTH + m2), d2) / DAY, unit: 'day', formula: 'T = 2π √(d³/G(M⊕ + m))', provenance: 'derived', sig: 4 },
        { key: 'tide2Rel', label: 'Second moon’s tide at its starting distance (× today)', value: tidalAcceleration(m2, d2) / LUNAR_TIDE_TODAY, unit: 'x', formula: '(m/M_moon)(384,400 km/d)³', provenance: 'derived', sig: 3 },
        { key: 'hill', label: 'Moon spacing in mutual Hill radii', value: Math.abs(d2 - d1) / rH, unit: '1', formula: 'Δ / R_H,  R_H = [(m₁+m₂)/3M⊕]^⅓ (d₁+d₂)/2', provenance: 'derived', sig: 3, note: 'Above 2√3 ≈ 3.46, two moons on circular orbits can never have close encounters (Gladman 1993). This says nothing about stability against the Sun’s perturbations, which are not modelled.' },
      );
    }
    return out;
  },

  warnings(p) {
    const w: Warning[] = [];
    const k = num(p, 'earthMassFactor');
    const roche = rocheLimit(k);
    const hill = earthHillRadius(k);
    const dists: [string, number][] = [['The Moon', num(p, 'moon1Distance') * 1000]];
    if (twoMoons(p)) dists.push(['The second moon', num(p, 'moon2Distance') * 1000]);
    for (const [name, d] of dists) {
      if (d < roche) w.push({ id: `roche-${name}`, severity: 'warning', message: `${name} starts inside the fluid Roche limit (${f(roche / 1000)} km). Tides would break up a fluid moon there; breakup is not simulated.` });
      if (d > 0.5 * hill) w.push({ id: `hill-${name}`, severity: 'warning', message: `${name} is beyond half of Earth’s Hill sphere (${f((0.5 * hill) / 1000)} km). The Sun, which this model leaves out, would likely pull it away.` });
    }
    const pr = predictMoon1(p);
    if (k !== 1) {
      w.push({ id: 'mass-change', severity: 'info', message: 'No known process changes a planet’s mass instantly; this is a thought experiment about gravity only. Earth’s radius is kept fixed.' });
      if (!pr.conic.bound) w.push({ id: 'unbound', severity: 'warning', message: 'With this smaller Earth mass the Moon’s speed exceeds the new escape speed: it will leave Earth.' });
      else if (pr.conic.rp < R_EARTH + moonRadius(num(p, 'moon1Mass'))) w.push({ id: 'impact', severity: 'warning', message: 'The Moon’s new orbit dips below Earth’s surface: it will crash into Earth.' });
    }
    if (twoMoons(p)) {
      const m1 = num(p, 'moon1Mass') * M_MOON;
      const m2 = num(p, 'moon2Mass') * M_MOON;
      const d1 = num(p, 'moon1Distance');
      const d2 = num(p, 'moon2Distance');
      const rH = Math.cbrt((m1 + m2) / (3 * M_EARTH)) * ((d1 + d2) / 2);
      if (Math.abs(d2 - d1) < 2 * Math.sqrt(3) * rH) {
        w.push({ id: 'moons-hill', severity: 'warning', message: `The moons are only ${f(Math.abs(d2 - d1) / rH)} mutual Hill radii apart (below 2√3 ≈ 3.46): close encounters, collisions or ejection are possible.` });
      }
      w.push({ id: 'moons-stability', severity: 'info', message: 'Long-term stability of a second moon is not assessed beyond the simulated span; the Sun and tides, which shape real satellite systems over millions of years, are not modelled.' });
    }
    if (bool(p, 'moonVanish') && num(p, 'vanishTime') >= num(p, 'duration')) {
      w.push({ id: 'vanish-late', severity: 'info', message: 'The Moon is set to vanish after the run ends; extend the duration to see it.' });
    }
    return w;
  },

  summarize(run: RunRecord): KeyResult[] {
    const out: KeyResult[] = [];
    const ev = (pred: (id: string) => boolean) => run.events.find((e) => pred(e.id));
    const crash = ev((id) => id.startsWith('moon1-hit-'));
    const esc = ev((id) => id === 'moon1-escape');
    const gone = ev((id) => id === 'moon1-vanished');
    out.push({
      label: 'What happened to the Moon',
      value: gone ? gone.label : crash ? crash.label : esc ? `Escaped from Earth (day ${f(esc.t, 4)})` : 'Stayed in orbit for the whole run',
      provenance: 'simulated',
      note: (gone ?? crash ?? esc)?.detail,
    });
    if (Number.isFinite(run.final.minD1)) out.push({ label: 'Moon’s closest distance', value: run.final.minD1, unit: 'km', provenance: 'simulated', sig: 4 });
    if (Number.isFinite(run.final.maxD1)) out.push({ label: 'Moon’s farthest distance', value: run.final.maxD1, unit: 'km', provenance: 'simulated', sig: 4 });
    if (Number.isFinite(run.final.ecc1)) out.push({ label: 'Moon’s final eccentricity', value: run.final.ecc1, unit: '1', provenance: 'derived', sig: 3 });
    const tide = (run.samples.obs.tideRel ?? []).filter(Number.isFinite);
    if (tide.length) out.push({ label: 'Strongest total lunar tide (recorded samples)', value: Math.max(...tide), unit: 'x', provenance: 'derived', sig: 3, note: `Relative to today’s Moon. The Sun adds ${f(SOLAR_TIDE / LUNAR_TIDE_TODAY)}× on top, not simulated.` });
    const drift = (run.samples.obs.earthDrift ?? []).filter(Number.isFinite);
    if (drift.length) out.push({ label: 'Earth’s largest distance from the starting barycentre', value: Math.max(...drift), unit: 'km', provenance: 'simulated', sig: 4 });
    if (Number.isFinite(run.final.earthSpeed)) out.push({ label: 'Earth’s final speed (starting barycentre frame)', value: run.final.earthSpeed, unit: 'm/s', provenance: 'simulated', sig: 3 });
    if (Number.isFinite(run.final.minSep)) out.push({ label: 'Closest approach between the moons', value: run.final.minSep, unit: 'km', provenance: 'simulated', sig: 4 });
    const err = (run.samples.obs.energyErr ?? []).filter(Number.isFinite).map(Math.abs);
    if (err.length) out.push({ label: 'Largest relative energy error', value: Math.max(...err), unit: '1', provenance: 'simulated', sig: 2, note: 'Numerical accuracy check: should stay far below 1 %.' });
    return out;
  },

  assumptions: [
    { kind: 'established', text: 'Newtonian gravity between Earth and its moons; Earth itself is integrated, so it orbits the common centre of mass (barycentre).' },
    { kind: 'simplification', text: 'The Sun is left out of the dynamics. A full model would include it: the Sun perturbs the Moon’s orbit noticeably (e.g. the ~1.3° evection and the regression of its nodes) and limits how far out a moon can stay bound. Only the Sun’s tidal strength is computed, as a fixed reference.' },
    { kind: 'simplification', text: 'No tidal dissipation or long-term orbital evolution: the real Moon recedes by about 3.8 cm per year, far too slowly to matter over the simulated span.' },
    { kind: 'simplification', text: 'Earth and moons are point masses (spheres) with no rotation, oblateness or internal structure; all orbits lie in one plane, and the moons start on circular orbits.' },
    { kind: 'simplification', text: 'The stability of a second moon is not assessed beyond the simulated span. Systems that look calm for months can become unstable over thousands of years.' },
    { kind: 'speculative', text: 'Sudden changes (Earth’s mass multiplied at t = 0, the Moon vanishing) are thought experiments with no known physical mechanism. Earth’s radius is held fixed when its mass changes.' },
    { kind: 'approximation', text: 'The Roche limit uses the classical fluid-body formula 2.44 R⊕ (ρ⊕/ρ_moon)^⅓ with lunar density for every moon. Breakup is not simulated.' },
    { kind: 'approximation', text: 'Tidal accelerations use the leading-order formula 2GmR⊕/d³ (valid when d ≫ R⊕); they measure tide-raising force, not actual tide heights, which depend on ocean basins and resonance.' },
  ],
  limitations: [
    'Without the Sun, escaped moons coast away forever and very distant moons look stable when they would not be.',
    'Tide heights, ocean dynamics, Earth’s rotation and day length are not modelled.',
    'Collisions merge bodies instantly; impact consequences are not modelled.',
    'Apsis, Roche and close-approach events are listed in full for the first ten occurrences, then thinned.',
  ],
  equations: [
    { label: 'Equation of motion', formula: 'd²rᵢ/dt² = Σⱼ G mⱼ (rⱼ − rᵢ) / |rⱼ − rᵢ|³', explanation: 'Applied to Earth and every moon (adaptive kick–drift–kick leapfrog).' },
    { label: 'Circular speed', formula: 'v = √(G(M⊕ + m)/d)', explanation: 'Speed for a circular orbit at distance d.' },
    { label: 'Vis-viva after a sudden mass change', formula: 'v² = μ′(2/r − 1/a),  μ′ = G(kM⊕ + m)', explanation: 'With k = 2 the old circular speed gives a = 2d/3, e = 0.5 and perigee d/3 (in the limit m ≪ M⊕).' },
    { label: 'Barycentre', formula: 'r⊕ = d · m/(M⊕ + m)', explanation: 'Earth circles the centre of mass at this radius, about 4,700 km for today’s Moon.' },
    { label: 'Tidal acceleration', formula: 'a_t = 2 G m R⊕ / d³', explanation: 'The difference in pull between Earth’s near side and its centre; it falls with the cube of distance.' },
    { label: 'Fluid Roche limit', formula: 'd_R = 2.44 R⊕ (ρ⊕/ρ_moon)^⅓', explanation: 'Inside this distance tides exceed a fluid moon’s self-gravity.' },
    { label: 'Hill stability (two moons)', formula: 'Δ > 2√3 R_H,  R_H = [(m₁+m₂)/3M⊕]^⅓ (d₁+d₂)/2', explanation: 'Sufficient condition for two circular orbits never to approach closely (Gladman 1993).' },
  ],
  education: {
    objectives: [
      'Show that Earth and the Moon both orbit their common centre of mass, and estimate how far Earth wobbles.',
      'Predict how a sudden change in Earth’s gravity reshapes the Moon’s orbit using vis-viva, and check it.',
      'Compare tidal forces from one or two moons and from the Sun, and explain the 1/d³ dependence.',
      'Recognise what happens to Earth’s motion if the Moon disappears, and why.',
    ],
    background: {
      beginner:
        'The Moon does not simply go around a fixed Earth: both circle a balance point between them, which sits about three quarters of the way from Earth’s centre to its surface. The Moon’s pull is slightly stronger on the side of Earth facing it — that difference raises the tides. If the Moon disappeared, Earth would stop wobbling and coast off in a straight line at its wobble speed, and only the Sun’s weaker tides would remain.',
      intermediate:
        'Each body moves under the others’ gravity. The barycentre is at r = d·m/(M + m) from Earth’s centre, about 4,700 km for the real Moon, and Earth moves around it at about 12.5 m/s. Tidal acceleration is the difference in gravity across Earth, 2GmR/d³: halving the distance makes tides eight times stronger. If Earth’s mass suddenly doubled, the Moon’s speed would be only 1/√2 of the new circular speed, so it would fall into an ellipse with perigee at one third of today’s distance — where its tides would be 27 times stronger.',
      advanced:
        'The system is integrated as an N-body problem in the barycentric frame with an adaptive kick–drift–kick leapfrog, sub-step h = η·min(√(r³/GΣm), r/|v_rel|); the relative energy error is recorded so the integration quality is visible. Two-moon systems are initialised hierarchically (inner moon around Earth, outer moon around the inner pair’s barycentre) on circular orbits. The mutual Hill criterion Δ > 2√3 R_H guarantees no close encounters for two planets/moons on circular orbits (Gladman 1993) but says nothing about secular or solar perturbations. Removing the Moon instantaneously breaks momentum conservation of the remaining system: Earth retains its barycentric velocity, so the old barycentre is no longer its centre of motion.',
    },
    variables: [
      { symbol: 'M⊕, k', meaning: 'Earth mass and the sudden multiplier', unit: 'kg, ×' },
      { symbol: 'm, d', meaning: 'moon mass and distance from Earth’s centre', unit: 'M☾, km' },
      { symbol: 'a, e', meaning: 'semi-major axis and eccentricity of a moon’s orbit', unit: 'km, –' },
      { symbol: 'a_t', meaning: 'tidal acceleration at Earth’s surface', unit: 'm/s²' },
      { symbol: 'd_R', meaning: 'Roche limit', unit: 'km' },
      { symbol: 'R_H', meaning: 'Hill radius', unit: 'km' },
    ],
    guidedSteps: [
      'Run the default and open the readouts: Earth’s offset from the barycentre should stay near the derived barycentre offset.',
      'Set Earth’s mass change to 2 and predict the Moon’s perigee from the derived values; check the perigee events and the tide chart.',
      'Turn on “Make the Moon vanish” at day 7 and watch Earth’s distance from the starting barycentre grow.',
      'Choose two moons and look at the combined tide. Then move the second moon to 300,000 km and watch the close-approach events.',
      'Move the Moon to 15,000 km: what does the Roche warning mean, and why does the model not break the Moon apart?',
    ],
    questions: [
      'Why does Earth keep moving when the Moon vanishes, instead of staying put?',
      'If the Moon were twice as far away, how would its tidal force compare with the Sun’s?',
      'Why does a sudden doubling of Earth’s mass make the Moon swing closer rather than farther away?',
      'What would a full model need, beyond this one, to judge whether a second moon could survive for a billion years?',
    ],
  },
};
