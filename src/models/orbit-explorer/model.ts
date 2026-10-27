import type { DerivedQuantity, KeyResult, ParamValues, RunRecord, SimEvent, SimulationModel, Warning } from '../../engine/types';
import { bool, num } from '../../engine/validation';
import { AU, DAY, G, L_SUN, M_EARTH, M_JUP, M_SUN, R_EARTH, R_SUN, S_EARTH, SIGMA_SB } from '../orbits/constants';
import {
  accuracyParam,
  capWarning,
  drainCollisions,
  etaFor,
  f,
  newApsisTracker,
  range,
  newOrbitCounter,
  shouldReport,
  updateApsis,
  updateOrbitCounter,
  type ApsisTracker,
  type OrbitCounter,
} from '../orbits/common';
import {
  advance,
  cloneSystem,
  conicFromTangential,
  createSystem,
  energyError,
  keplerPeriod,
  makeBody,
  newRelState,
  osculating,
  relativeState,
  resetEnergyReference,
  toBarycentricFrame,
  type Body,
  type NBodyState,
} from '../orbits/nbody';

/**
 * Planetary Orbit Explorer — a star with one or two planets, integrated as a
 * Newtonian point-mass N-body system (adaptive kick–drift–kick leapfrog, see
 * ../orbits/nbody.ts). Model time is in days; positions are tracked in AU in the
 * barycentric frame of the system at t = 0.
 */

export interface PlanetTracker {
  bodyId: string;
  /** Index into sys.bodies (fixed for the run). */
  index: number;
  /** Start distance from the star, m. */
  d0: number;
  apsis: ApsisTracker;
  orbits: OrbitCounter;
  minR: number;
  maxR: number;
  escaped: boolean;
}

export interface OrbitExplorerState {
  /** Model time, days. */
  t: number;
  sys: NBodyState;
  planets: PlanetTracker[];
  pending: SimEvent[];
  eta: number;
}

export const STAR_ID = 'star';
export const PLANET_ID = 'planet';
export const PLANET2_ID = 'planet2';

/** Main-sequence mass–radius approximation, R/R☉ ≈ (M/M☉)^0.8 below 1 M☉ and ^0.57 above. */
export function starRadius(mSun: number): number {
  return R_SUN * Math.pow(mSun, mSun <= 1 ? 0.8 : 0.57);
}

/** Probabilistic mass–radius relation of Chen & Kipping (2017), mean branches, in metres. */
export function planetRadius(mEarth: number): number {
  let rEarth: number;
  if (mEarth < 2.04) rEarth = 1.008 * Math.pow(mEarth, 0.279);
  else if (mEarth < 131.6) rEarth = 0.808 * Math.pow(mEarth, 0.589);
  else rEarth = 17.74 * Math.pow(mEarth, -0.044);
  return rEarth * R_EARTH;
}

/** Equilibrium temperature from insolation S (in S⊕) and Bond albedo A, K. */
export function equilibriumTemperature(sRel: number, albedo: number): number {
  return Math.pow((sRel * S_EARTH * (1 - albedo)) / (4 * SIGMA_SB), 0.25);
}

function circularPeriodDays(p: ParamValues): number {
  const M = num(p, 'starMass') * M_SUN * Math.max(1, num(p, 'massChange'));
  const d = num(p, 'planetDistance') * AU;
  return (2 * Math.PI * Math.sqrt((d * d * d) / (G * M))) / DAY;
}

interface Prediction {
  vCirc: number;
  v0: number;
  muAfter: number;
  conic: ReturnType<typeof conicFromTangential>;
  vEsc: number;
}

/** Closed-form two-body prediction for the (first) planet from the parameters. */
export function predict(p: ParamValues): Prediction {
  const M = num(p, 'starMass') * M_SUN;
  const m = num(p, 'planetMass') * M_EARTH;
  const d = num(p, 'planetDistance') * AU;
  const vCirc = Math.sqrt((G * (M + m)) / d);
  const v0 = num(p, 'speedFactor') * vCirc;
  const muAfter = G * (M * num(p, 'massChange') + m);
  return { vCirc, v0, muAfter, conic: conicFromTangential(muAfter, d, v0), vEsc: Math.sqrt((2 * muAfter) / d) };
}

/** Sampling interval (days): fine enough for the periapsis passage, bounded by the run length. */
function sampleIntervalDays(p: ParamValues): number {
  const tau = circularPeriodDays(p);
  const pr = predict(p);
  const d = num(p, 'planetDistance') * AU;
  const rp = Math.max(pr.conic.rp, starRadius(num(p, 'starMass')));
  const vp = rp > 0 ? (d * pr.v0) / rp : pr.v0;
  const tPeri = vp > 0 ? rp / vp / DAY : tau;
  return Math.max(Math.min(tau / 200, tPeri / 3), num(p, 'duration') / 3000, 1e-3);
}

const SCR = newRelState();

function star(s: OrbitExplorerState): Body {
  return s.sys.bodies[0];
}

function bodyOf(s: OrbitExplorerState, id: string): Body | undefined {
  return s.sys.bodies.find((b) => b.id === id);
}

function trackSubstep(s: OrbitExplorerState, p: ParamValues, t0: number, sec0: number) {
  const sys = s.sys;
  const st = star(s);
  const t = t0 + (sys.t - sec0) / DAY;
  const L = num(p, 'starLuminosity');
  for (let i = 0; i < s.planets.length; i++) {
    const pt = s.planets[i];
    const b = sys.bodies[pt.index];
    if (!b.alive || !st.alive) continue;
    const rel = relativeState(b, st, SCR);
    if (rel.r < pt.minR) pt.minR = rel.r;
    if (rel.r > pt.maxR) pt.maxR = rel.r;
    const code = updateApsis(pt.apsis, rel.r, rel.rdot, rel.v, t);
    if (code === 1 && shouldReport(pt.apsis.periCount)) {
      const dAU = pt.apsis.lastR / AU;
      s.pending.push({
        t: pt.apsis.lastT,
        id: `${b.id}-peri-${pt.apsis.periCount}`,
        label: `${b.label} periapsis: ${f(dAU)} AU at day ${f(pt.apsis.lastT, 4)}`,
        detail: `Closest point of this pass (#${pt.apsis.periCount}). Insolation there: ${f(L / (dAU * dAU))} S⊕.`,
        severity: 'info',
        source: 'model',
      });
    } else if (code === 2 && shouldReport(pt.apsis.apoCount)) {
      const dAU = pt.apsis.lastR / AU;
      s.pending.push({
        t: pt.apsis.lastT,
        id: `${b.id}-apo-${pt.apsis.apoCount}`,
        label: `${b.label} apoapsis: ${f(dAU)} AU at day ${f(pt.apsis.lastT, 4)}`,
        detail: `Farthest point of this pass (#${pt.apsis.apoCount}). Insolation there: ${f(L / (dAU * dAU))} S⊕.`,
        severity: 'info',
        source: 'model',
      });
    }
    if (rel.energy < 0 && updateOrbitCounter(pt.orbits, rel.theta, t)) {
      const n = pt.orbits.count;
      if (shouldReport(n)) {
        const el = osculating(b, st);
        const kepler = keplerPeriod(el.mu, el.a) / DAY;
        s.pending.push({
          t: pt.orbits.lastCrossT,
          id: `${b.id}-orbit-${n}`,
          label: `${b.label} completed orbit ${n} in ${f(pt.orbits.lastPeriod, 4)} days`,
          detail: `Kepler’s third law for the current semi-major axis (a = ${f(el.a / AU, 4)} AU) gives ${f(kepler, 4)} days (${f(100 * (pt.orbits.lastPeriod / kepler - 1), 2)} % difference).`,
          severity: 'milestone',
          source: 'model',
        });
      }
    } else if (rel.energy >= 0) {
      // Keep the angle reference current so a later capture does not count a spurious revolution.
      pt.orbits.prevTheta = rel.theta;
      pt.orbits.prevT = t;
    }
    if (!pt.escaped && rel.energy > 0 && rel.rdot > 0 && rel.r > 2 * pt.d0) {
      pt.escaped = true;
      s.pending.push({
        t,
        id: `${b.id}-escape`,
        label: `${b.label} escaped the star`,
        detail: `At day ${f(t, 4)} it is ${f(rel.r / AU)} AU out, moving away at ${f(rel.v / 1000)} km/s with positive orbital energy (${f(rel.energy / 1e6)} MJ/kg). It will coast away at about ${f(Math.sqrt(2 * rel.energy) / 1000)} km/s.`,
        severity: 'warning',
        source: 'model',
      });
    }
  }
}

function reportCollisions(s: OrbitExplorerState, p: ParamValues, t0: number, sec0: number) {
  for (const c of drainCollisions(s.sys)) {
    const t = t0 + (c.t - sec0) / DAY;
    const imp = bodyOf(s, c.impactorId)!;
    const sur = bodyOf(s, c.survivorId)!;
    const L = num(p, 'starLuminosity') * L_SUN;
    if (sur.id === STAR_ID) {
      s.pending.push({
        t,
        id: `${imp.id}-hit-star`,
        label: `${imp.label} fell into the star`,
        detail: `Impact on day ${f(t, 4)} at ${f(c.relSpeed / 1000)} km/s, releasing ${f(c.energy)} J of kinetic energy — about ${f(c.energy / (L * DAY))} days of the star’s light output. The planet’s mass and momentum were merged into the star.`,
        severity: 'critical',
        source: 'model',
      });
    } else {
      s.pending.push({
        t,
        id: `${imp.id}-hit-${sur.id}`,
        label: `${imp.label} collided with ${sur.label}`,
        detail: `On day ${f(t, 4)} at ${f(c.relSpeed / 1000)} km/s (kinetic energy of the relative motion ${f(c.energy)} J). Modelled as a perfectly inelastic merger.`,
        severity: 'critical',
        source: 'model',
      });
    }
  }
}

export const orbitExplorerModel: SimulationModel<OrbitExplorerState> = {
  id: 'orbit-explorer',
  name: 'Planetary Orbit Explorer',
  shortName: 'Orbit Explorer',
  domain: 'astronomy',
  viewKind: '3d',
  summary:
    'A star with one or two planets under Newtonian gravity, integrated with an adaptive symplectic leapfrog. Change the star, the starting distance and speed, or the star’s mass at t = 0, and watch the orbit, the sunlight and the temperature respond.',
  params: [
    { key: 'starMass', label: 'Star mass', type: 'number', unit: 'M_sun', kind: 'initial', group: 'Star', min: 0.08, max: 20, step: 0.01, default: 1, scale: 'log', description: 'Mass of the central star before any sudden change.', marks: [
      { value: 0.5, label: '0.5 M☉' }, { value: 1, label: 'Sun' }, { value: 2, label: '2 M☉' },
    ] },
    { key: 'starLuminosity', label: 'Star luminosity', type: 'number', unit: 'L_sun', kind: 'live', group: 'Star', min: 0.001, max: 10000, step: 0.001, default: 1, scale: 'log', description: 'Light output of the star. It sets insolation and temperature only; it does not affect the orbit.', marks: [
      { value: 0.04, label: 'Red dwarf (~0.04)' }, { value: 1, label: 'Sun' }, { value: 16, label: '16 (typical 2 M☉ star)' },
    ] },
    { key: 'massChange', label: 'Sudden star-mass change at t = 0', type: 'number', unit: 'x', kind: 'initial', group: 'Star', min: 0.1, max: 5, step: 0.01, default: 1, description: 'Multiply the star’s mass instantly at t = 0. The planets keep the velocities they had for the original mass, so their orbits change shape.', marks: [
      { value: 0.5, label: 'Halved' }, { value: 1, label: 'No change' }, { value: 2, label: 'Doubled' },
    ] },
    { key: 'planetDistance', label: 'Planet starting distance', type: 'number', unit: 'AU', kind: 'initial', group: 'Planet', min: 0.05, max: 40, step: 0.01, default: 1, scale: 'log', description: 'Distance of the planet from the star at t = 0.', marks: [
      { value: 0.387, label: 'Mercury' }, { value: 0.723, label: 'Venus' }, { value: 1, label: 'Earth' }, { value: 1.524, label: 'Mars' }, { value: 5.2, label: 'Jupiter' },
    ] },
    { key: 'speedFactor', label: 'Starting speed (× circular speed)', type: 'number', unit: 'x', kind: 'initial', group: 'Planet', min: 0, max: 2, step: 0.01, default: 1, description: 'Initial speed, perpendicular to the line to the star, as a multiple of the local circular speed. 1 = circular; below 1 the planet falls inward; at √2 ≈ 1.414 or more it escapes.', marks: [
      { value: 0.5, label: 'Slow (falls in)' }, { value: 1, label: 'Circular' }, { value: 1.2, label: 'Elliptical' }, { value: 1.414, label: 'Escape (√2)' },
    ] },
    { key: 'planetMass', label: 'Planet mass', type: 'number', unit: 'M_earth', kind: 'initial', group: 'Planet', min: 0.01, max: 1000, step: 0.01, default: 1, scale: 'log', description: 'Mass of the planet.', marks: [
      { value: 0.107, label: 'Mars' }, { value: 1, label: 'Earth' }, { value: 17.1, label: 'Neptune' }, { value: 317.8, label: 'Jupiter' },
    ] },
    { key: 'albedo', label: 'Planet Bond albedo', type: 'number', unit: '1', kind: 'live', group: 'Planet', min: 0, max: 0.95, step: 0.01, default: 0.3, description: 'Fraction of incoming starlight the planet reflects (Earth ≈ 0.30). Used only for the equilibrium temperature.', marks: [
      { value: 0.3, label: 'Earth' }, { value: 0.77, label: 'Venus' },
    ] },
    { key: 'secondPlanet', label: 'Add a second planet', type: 'boolean', kind: 'initial', group: 'Second planet', default: false, description: 'Add a second planet (Jupiter-like by default) on a circular orbit. Its gravity perturbs the first planet.' },
    { key: 'secondDistance', label: 'Second planet distance', type: 'number', unit: 'AU', kind: 'initial', group: 'Second planet', min: 0.05, max: 40, step: 0.01, default: 5.2, scale: 'log', description: 'Starting distance of the second planet (circular orbit).', visibleWhen: (p) => bool(p, 'secondPlanet'), marks: [
      { value: 5.2, label: 'Jupiter' }, { value: 9.58, label: 'Saturn' },
    ] },
    { key: 'secondMass', label: 'Second planet mass', type: 'number', unit: 'M_jup', kind: 'initial', group: 'Second planet', min: 0.001, max: 50, step: 0.001, default: 1, scale: 'log', description: 'Mass of the second planet in Jupiter masses (1 M♃ ≈ 317.8 M⊕).', visibleWhen: (p) => bool(p, 'secondPlanet'), marks: [
      { value: 0.299, label: 'Saturn' }, { value: 1, label: 'Jupiter' }, { value: 10, label: '10 M♃' },
    ] },
    { key: 'secondPhase', label: 'Second planet starting angle', type: 'number', unit: 'deg', kind: 'initial', group: 'Second planet', min: 0, max: 360, step: 1, default: 90, description: 'Angle around the star between the two planets at t = 0.', visibleWhen: (p) => bool(p, 'secondPlanet') },
    { key: 'duration', label: 'Simulation duration', type: 'number', unit: 'day', kind: 'initial', group: 'Numerics', numerics: true, min: 10, max: 36525, step: 1, default: 730, scale: 'log', description: 'Run length in days (365.25 days = 1 year).', marks: [
      { value: 365.25, label: '1 yr' }, { value: 730.5, label: '2 yr' }, { value: 3652.5, label: '10 yr' }, { value: 36525, label: '100 yr' },
    ] },
    accuracyParam(),
  ],
  observables: [
    { key: 'dist', label: 'Distance to star', unit: 'AU', provenance: 'simulated', chart: true, chartGroup: 'distance', sig: 4, description: 'Centre-to-centre distance between the planet and the star.' },
    { key: 'speed', label: 'Orbital speed', unit: 'km/s', provenance: 'simulated', chart: true, chartGroup: 'speed', sig: 4, description: 'Speed of the planet relative to the star.' },
    { key: 'ecc', label: 'Eccentricity (osculating)', unit: '1', provenance: 'derived', chartGroup: 'shape', sig: 3, description: 'Shape of the two-body ellipse matching the current position and velocity (0 = circle, ≥ 1 = unbound).' },
    { key: 'sma', label: 'Semi-major axis (osculating)', unit: 'AU', provenance: 'derived', chartGroup: 'distance', sig: 4, description: 'Size of the osculating ellipse; not defined (—) when the orbit is unbound.' },
    { key: 'rp', label: 'Periapsis (osculating)', unit: 'AU', provenance: 'derived', chartGroup: 'distance', sig: 4, readout: false },
    { key: 'ra', label: 'Apoapsis (osculating)', unit: 'AU', provenance: 'derived', chartGroup: 'distance', sig: 4, readout: false },
    { key: 'insolation', label: 'Insolation', unit: 'S_earth', provenance: 'derived', chart: true, chartGroup: 'light', sig: 3, description: 'Starlight per unit area at the planet, L/d², relative to what Earth receives today.' },
    { key: 'teq', label: 'Equilibrium temperature', unit: 'K', provenance: 'derived', chart: true, chartGroup: 'temperature', sig: 3, description: 'T = [S(1 − A)/4σ]^¼ — the temperature of a rapidly rotating, evenly heated planet with Bond albedo A. Ignores any greenhouse effect (Earth’s is ≈ 255 K versus a ≈ 288 K surface average) and thermal inertia.' },
    { key: 'energyErr', label: 'Relative energy error', unit: '1', provenance: 'simulated', chartGroup: 'numerics', sig: 2, description: 'Change of the total energy since t = 0 relative to its size. Physics conserves it exactly, so this measures the integrator’s numerical error.' },
    { key: 'orbits', label: 'Completed orbits', unit: 'count', provenance: 'simulated', sig: 4, description: 'Full 360° revolutions around the star.' },
    { key: 'period', label: 'Last measured orbital period', unit: 'day', provenance: 'simulated', sig: 5, description: 'Time taken by the most recent full revolution.' },
    { key: 'minDist', label: 'Closest distance so far', unit: 'AU', provenance: 'simulated', sig: 4, readout: false },
    { key: 'maxDist', label: 'Farthest distance so far', unit: 'AU', provenance: 'simulated', sig: 4, readout: false },
    { key: 'dist2', label: 'Second planet distance', unit: 'AU', provenance: 'simulated', chartGroup: 'distance', sig: 4 },
    { key: 'ecc2', label: 'Second planet eccentricity', unit: '1', provenance: 'derived', chartGroup: 'shape', sig: 3, readout: false },
  ],
  primaryObservables: ['dist', 'insolation'],
  time: {
    unit: 'day',
    dt: (p) => Math.min(Math.max(circularPeriodDays(p) / 1000, 1e-3), 2, sampleIntervalDays(p)),
    sampleInterval: sampleIntervalDays,
    defaultDuration: (p) => num(p, 'duration'),
    durationParam: 'duration',
    maxDuration: 36525,
    realtimeRate: (p) => Math.max(circularPeriodDays(p) / 10, 0.01),
  },

  init(p) {
    const Mstar = num(p, 'starMass') * M_SUN;
    const m1 = num(p, 'planetMass') * M_EARTH;
    const d1 = num(p, 'planetDistance') * AU;
    const v1 = num(p, 'speedFactor') * Math.sqrt((G * (Mstar + m1)) / d1);
    const bodies: Body[] = [
      makeBody({ id: STAR_ID, label: 'Star', slot: -1, mass: Mstar, radius: starRadius(num(p, 'starMass')), pos: [0, 0, 0], vel: [0, 0, 0], priority: 1 }),
      makeBody({ id: PLANET_ID, label: 'Planet', slot: 0, mass: m1, radius: planetRadius(num(p, 'planetMass')), pos: [d1, 0, 0], vel: [0, v1, 0] }),
    ];
    if (bool(p, 'secondPlanet')) {
      const m2 = num(p, 'secondMass') * M_JUP;
      const d2 = num(p, 'secondDistance') * AU;
      const ph = (num(p, 'secondPhase') * Math.PI) / 180;
      const v2 = Math.sqrt((G * (Mstar + m2)) / d2);
      bodies.push(
        makeBody({ id: PLANET2_ID, label: 'Second planet', slot: 1, mass: m2, radius: planetRadius(m2 / M_EARTH), pos: [d2 * Math.cos(ph), d2 * Math.sin(ph), 0], vel: [-v2 * Math.sin(ph), v2 * Math.cos(ph), 0] }),
      );
    }
    const sys = createSystem(bodies);
    toBarycentricFrame(sys);
    const pending: SimEvent[] = [];
    const k = num(p, 'massChange');
    if (k !== 1) {
      bodies[0].mass *= k;
      // Galilean re-centring on the new barycentre; relative velocities are unchanged.
      toBarycentricFrame(sys);
      const pr = predict(p);
      pending.push({
        t: 0,
        id: 'mass-change',
        label: `Star’s mass changed ×${f(k)} to ${f(num(p, 'starMass') * k)} M☉`,
        detail: `The planet keeps its ${f(pr.v0 / 1000)} km/s. For the new mass the circular speed at ${f(d1 / AU)} AU would be ${f(Math.sqrt(pr.muAfter / d1) / 1000)} km/s and the escape speed ${f(pr.vEsc / 1000)} km/s.`,
        severity: 'warning',
        source: 'model',
      });
    }
    // Energy reference after every t = 0 change, so the diagnostic measures only numerical error.
    resetEnergyReference(sys);
    const planets: PlanetTracker[] = bodies.slice(1).map((b, i) => {
      const rel = relativeState(b, bodies[0], newRelState());
      return { bodyId: b.id, index: i + 1, d0: rel.r, apsis: newApsisTracker(), orbits: newOrbitCounter(rel.theta, 0), minR: rel.r, maxR: rel.r, escaped: false };
    });
    return { t: 0, sys, planets, pending, eta: etaFor(p) };
  },

  step(s, p, dt) {
    const t0 = s.t;
    const sec0 = s.sys.t;
    const res = advance(s.sys, dt * DAY, { eta: s.eta, onSubstep: () => trackSubstep(s, p, t0, sec0) });
    s.t = t0 + dt;
    if (s.sys.collisions.length) reportCollisions(s, p, t0, sec0);
    if (res.capped) {
      const w = capWarning(s.sys, s.t, 'days');
      if (w) s.pending.push(w);
    }
  },

  observe(s, p) {
    const st = star(s);
    const out: Record<string, number> = {
      dist: NaN, speed: NaN, ecc: NaN, sma: NaN, rp: NaN, ra: NaN, insolation: NaN, teq: NaN,
      energyErr: energyError(s.sys), orbits: NaN, period: NaN, minDist: NaN, maxDist: NaN, dist2: NaN, ecc2: NaN,
    };
    const p1 = s.planets[0];
    const b1 = bodyOf(s, PLANET_ID);
    if (p1) {
      out.orbits = p1.orbits.count;
      out.period = p1.orbits.lastPeriod;
      out.minDist = p1.minR / AU;
      out.maxDist = p1.maxR / AU;
    }
    if (b1 && b1.alive && st.alive) {
      const el = osculating(b1, st);
      const dAU = el.r / AU;
      out.dist = dAU;
      out.speed = el.v / 1000;
      out.ecc = el.e;
      out.sma = el.bound ? el.a / AU : NaN;
      out.rp = el.rp / AU;
      out.ra = el.bound ? el.ra / AU : NaN;
      out.insolation = num(p, 'starLuminosity') / (dAU * dAU);
      out.teq = equilibriumTemperature(out.insolation, num(p, 'albedo'));
    }
    const b2 = bodyOf(s, PLANET2_ID);
    if (b2 && b2.alive && st.alive) {
      const el2 = osculating(b2, st);
      out.dist2 = el2.r / AU;
      out.ecc2 = el2.e;
    }
    return out;
  },

  clone(s) {
    return {
      ...s,
      sys: cloneSystem(s.sys),
      planets: s.planets.map((pt) => ({ ...pt, apsis: { ...pt.apsis }, orbits: { ...pt.orbits } })),
      pending: [...s.pending],
    };
  },

  time_of: (s) => s.t,

  detectEvents(_prev, _cur, s) {
    const out = s.pending.sort((a, b) => a.t - b.t);
    s.pending = [];
    return out;
  },

  finished(s) {
    const st = star(s);
    const active = s.planets.filter((pt) => {
      const b = bodyOf(s, pt.bodyId);
      if (!b || !b.alive) return false;
      return !(pt.escaped && relativeState(b, st, SCR).r > 20 * pt.d0);
    });
    if (active.length > 0) return null;
    const anyHit = s.planets.some((pt) => bodyOf(s, pt.bodyId)?.mergedInto);
    return anyHit && s.planets.every((pt) => bodyOf(s, pt.bodyId)?.mergedInto)
      ? 'No planets remain in orbit: they collided with the star or each other.'
      : 'No planets remain bound: they escaped (beyond 20× their starting distance) or collided.';
  },

  tracks(s) {
    const out = [];
    for (const b of s.sys.bodies) {
      if (!b.alive) continue;
      out.push({ id: b.id, x: b.pos[0] / AU, y: b.pos[1] / AU, z: b.pos[2] / AU });
    }
    return out;
  },

  derived(p) {
    const pr = predict(p);
    const d = num(p, 'planetDistance');
    const L = num(p, 'starLuminosity');
    const A = num(p, 'albedo');
    const kM = num(p, 'starMass') * num(p, 'massChange');
    const out: DerivedQuantity[] = [
      { key: 'vCirc', label: 'Circular speed at start (original star mass)', value: pr.vCirc / 1000, unit: 'km/s', formula: 'v_c = √(G(M + m)/d)', provenance: 'derived', sig: 4 },
      { key: 'v0', label: 'Planet’s starting speed', value: pr.v0 / 1000, unit: 'km/s', formula: 'v₀ = f · v_c', provenance: 'derived', sig: 4 },
      { key: 'vEsc', label: 'Escape speed at start', value: pr.vEsc / 1000, unit: 'km/s', formula: 'v_esc = √(2G(M′ + m)/d)', provenance: 'derived', sig: 4, note: 'Uses the star’s mass after any sudden change (M′).' },
    ];
    if (pr.conic.bound) {
      out.push(
        { key: 'period', label: 'Kepler period of the predicted orbit', value: pr.conic.period / DAY, unit: 'day', formula: 'T = 2π √(a³/G(M′ + m))', provenance: 'derived', sig: 5, note: 'Two-body prediction; a second planet perturbs it slightly.' },
        { key: 'sma', label: 'Predicted semi-major axis', value: pr.conic.a / AU, unit: 'AU', formula: 'a = −G(M′+m) / 2ε,  ε = v₀²/2 − G(M′+m)/d', provenance: 'derived', sig: 4 },
        { key: 'ecc', label: 'Predicted eccentricity', value: pr.conic.e, unit: '1', formula: 'e = √(1 + 2εh²/μ²),  h = d·v₀', provenance: 'derived', sig: 3 },
        { key: 'rp', label: 'Predicted periapsis', value: pr.conic.rp / AU, unit: 'AU', formula: 'r_p = a(1 − e)', provenance: 'derived', sig: 4 },
        { key: 'ra', label: 'Predicted apoapsis', value: pr.conic.ra / AU, unit: 'AU', formula: 'r_a = a(1 + e)', provenance: 'derived', sig: 4 },
      );
      const sMax = L / (pr.conic.rp / AU) ** 2;
      const sMin = L / (pr.conic.ra / AU) ** 2;
      out.push(
        { key: 'sMax', label: 'Insolation at predicted periapsis', value: sMax, unit: 'S_earth', formula: 'S = L / r_p²', provenance: 'derived', sig: 3 },
        { key: 'sMin', label: 'Insolation at predicted apoapsis', value: sMin, unit: 'S_earth', formula: 'S = L / r_a²', provenance: 'derived', sig: 3 },
      );
    } else {
      out.push({ key: 'vInf', label: 'Predicted speed far from the star', value: Math.sqrt(2 * pr.conic.energy) / 1000, unit: 'km/s', formula: 'v∞ = √(2ε)', provenance: 'derived', sig: 3, note: 'The orbit is unbound: the planet escapes.' });
    }
    const s0 = L / (d * d);
    out.push(
      { key: 's0', label: 'Insolation at the starting distance', value: s0, unit: 'S_earth', formula: 'S = (L/L☉) / (d/AU)²', provenance: 'derived', sig: 3 },
      { key: 'teq0', label: 'Equilibrium temperature at the start', value: equilibriumTemperature(s0, A), unit: 'K', formula: 'T = [S(1 − A)/4σ]^¼', provenance: 'derived', sig: 3, note: 'No greenhouse effect; Earth’s value (≈ 255 K) is about 33 K below its actual mean surface temperature.' },
      { key: 'msL', label: 'Typical main-sequence luminosity for this mass', value: Math.pow(kM, 3.5), unit: 'L_sun', formula: 'L ≈ (M/M☉)^3.5 L☉', provenance: 'derived', sig: 2, note: 'Rough empirical mass–luminosity rule, for comparison only. The model uses the luminosity you set; a star whose mass changed suddenly would not instantly settle onto this relation.' },
    );
    if (bool(p, 'secondPlanet')) {
      const M = num(p, 'starMass') * M_SUN * num(p, 'massChange');
      const m1 = num(p, 'planetMass') * M_EARTH;
      const m2 = num(p, 'secondMass') * M_JUP;
      const d2 = num(p, 'secondDistance');
      const rH = Math.cbrt((m1 + m2) / (3 * M)) * ((d + d2) / 2);
      out.push(
        { key: 'period2', label: 'Second planet’s circular period', value: keplerPeriod(G * (num(p, 'starMass') * M_SUN + m2), d2 * AU) / DAY, unit: 'day', formula: 'T = 2π √(d³/G(M + m))', provenance: 'derived', sig: 4 },
        { key: 'hill', label: 'Planet spacing in mutual Hill radii', value: Math.abs(d2 - d) / rH, unit: '1', formula: 'Δ / R_H,  R_H = [(m₁+m₂)/3M]^⅓ (a₁+a₂)/2', provenance: 'derived', sig: 3, note: 'For two planets on circular orbits, spacing above 2√3 ≈ 3.46 guarantees they can never have close encounters (Gladman 1993).' },
      );
    }
    return out;
  },

  warnings(p) {
    const w: Warning[] = [];
    const pr = predict(p);
    const Rs = starRadius(num(p, 'starMass'));
    if (!pr.conic.bound) {
      w.push({ id: 'unbound', severity: 'warning', message: `Unbound orbit: the starting speed (${f(pr.v0 / 1000)} km/s) is at or above the escape speed (${f(pr.vEsc / 1000)} km/s). The planet will leave the star.` });
    } else if (pr.conic.rp < Rs + planetRadius(num(p, 'planetMass'))) {
      w.push({ id: 'hits-star', severity: 'warning', message: `The predicted closest approach (${f(pr.conic.rp / AU)} AU) is inside the star (radius ${f(Rs / AU)} AU): the planet will hit it.` });
    } else if (pr.conic.rp < 0.05 * AU) {
      w.push({ id: 'close-in', severity: 'info', message: `The planet comes within ${f(pr.conic.rp / AU)} AU of the star. Tides, stellar drag and relativistic effects matter this close; they are not modelled.` });
    }
    if (num(p, 'massChange') !== 1) {
      w.push({ id: 'mass-change', severity: 'info', message: 'No known process changes a star’s mass instantly. The change is a thought experiment: only gravity responds; the star’s size and the luminosity you set stay the same.' });
    }
    if (bool(p, 'secondPlanet')) {
      const M = num(p, 'starMass') * M_SUN * num(p, 'massChange');
      const m1 = num(p, 'planetMass') * M_EARTH;
      const m2 = num(p, 'secondMass') * M_JUP;
      const a1 = num(p, 'planetDistance');
      const a2 = num(p, 'secondDistance');
      const rH = Math.cbrt((m1 + m2) / (3 * M)) * ((a1 + a2) / 2);
      if (Math.abs(a2 - a1) < 2 * Math.sqrt(3) * rH) {
        w.push({ id: 'hill', severity: 'warning', message: `The planets are only ${f(Math.abs(a2 - a1) / rH)} mutual Hill radii apart (below 2√3 ≈ 3.46): close encounters, chaotic orbits or ejection are possible.` });
      }
    }
    return w;
  },

  summarize(run: RunRecord): KeyResult[] {
    const out: KeyResult[] = [];
    const hit = run.events.find((e) => e.id === `${PLANET_ID}-hit-star` || e.id.startsWith(`${PLANET_ID}-hit-`));
    const esc = run.events.find((e) => e.id === `${PLANET_ID}-escape`);
    out.push({
      label: 'Outcome for the planet',
      value: hit ? hit.label : esc ? `Escaped (from day ${f(esc.t, 4)})` : 'Stayed in orbit for the whole run',
      provenance: 'simulated',
      note: hit?.detail ?? esc?.detail,
    });
    if (Number.isFinite(run.final.minDist)) out.push({ label: 'Closest distance to the star', value: run.final.minDist, unit: 'AU', provenance: 'simulated', sig: 4 });
    if (Number.isFinite(run.final.maxDist)) out.push({ label: 'Farthest distance from the star', value: run.final.maxDist, unit: 'AU', provenance: 'simulated', sig: 4 });
    if (Number.isFinite(run.final.period)) {
      const pred = predict(run.params).conic.period / DAY;
      out.push({ label: 'Measured orbital period', value: run.final.period, unit: 'day', provenance: 'simulated', sig: 5, note: Number.isFinite(pred) ? `Two-body Kepler prediction: ${f(pred, 5)} days.` : undefined });
    }
    if (Number.isFinite(run.final.ecc)) out.push({ label: 'Final eccentricity', value: run.final.ecc, unit: '1', provenance: 'derived', sig: 3 });
    const ins = (run.samples.obs.insolation ?? []).filter(Number.isFinite);
    if (ins.length) {
      out.push({ label: 'Insolation range (recorded samples)', value: range(ins), unit: 'S_earth', provenance: 'derived' });
    }
    const te = (run.samples.obs.teq ?? []).filter(Number.isFinite);
    if (te.length) {
      out.push({ label: 'Equilibrium temperature range', value: range(te), unit: 'K', provenance: 'derived', note: 'No greenhouse effect or thermal inertia; actual surface temperatures would differ.' });
    }
    const err = (run.samples.obs.energyErr ?? []).filter(Number.isFinite).map(Math.abs);
    if (err.length) out.push({ label: 'Largest relative energy error', value: Math.max(...err), unit: '1', provenance: 'simulated', sig: 2, note: 'Numerical accuracy check: should stay far below 1 %.' });
    return out;
  },

  assumptions: [
    { kind: 'established', text: 'Newtonian gravity between point masses: every body attracts every other with F = Gm₁m₂/r².' },
    { kind: 'simplification', text: 'Bodies are spheres that act as point masses; tides, rotation, and the planets’ and star’s internal structure are ignored.' },
    { kind: 'simplification', text: 'All motion stays in one plane (the planets start in the same plane with in-plane velocities).' },
    { kind: 'simplification', text: 'Only the bodies shown exist: no other planets, moons, asteroid belts or passing stars.' },
    { kind: 'simplification', text: 'General relativity is ignored. It matters only very close to the star (e.g. Mercury’s perihelion advances 43″ per century).' },
    { kind: 'speculative', text: 'A sudden change of the star’s mass is a thought experiment. It is applied instantly at t = 0 with no change to the star’s size or brightness; real stars lose mass gradually through winds.' },
    { kind: 'approximation', text: 'Star radius follows a main-sequence mass–radius rule (R ∝ M^0.8 below 1 M☉, M^0.57 above); planet radius follows the mean mass–radius relation of Chen & Kipping (2017), which has large scatter. Radii are used only for drawing and collision checks.' },
    { kind: 'approximation', text: 'Equilibrium temperature assumes the absorbed starlight is re-radiated evenly over the whole planet with a constant Bond albedo, and ignores any greenhouse effect and the heat stored in oceans and air.' },
    { kind: 'simplification', text: 'Collisions are perfectly inelastic mergers that conserve mass and momentum; the energy released is reported but its effects are not modelled.' },
  ],
  limitations: [
    'Planets cannot be launched with a radial velocity component; the starting velocity is always perpendicular to the line to the star.',
    'Temperatures are equilibrium values for an airless, evenly heated sphere; climate, atmospheres and seasons are not modelled.',
    'Stellar evolution is not modelled: the star’s luminosity is whatever you set, independent of its mass.',
    'Orbit, apsis and period events are listed in full for the first ten occurrences, then thinned (every 10th, 100th, …).',
    'Long runs at small distances take more computing time because the integrator sub-steps adapt to the shortest orbital timescale.',
  ],
  equations: [
    { label: 'Equation of motion', formula: 'd²rᵢ/dt² = Σⱼ G mⱼ (rⱼ − rᵢ) / |rⱼ − rᵢ|³', explanation: 'Newton’s law of gravitation for every pair of bodies.' },
    { label: 'Leapfrog (kick–drift–kick)', formula: 'v ← v + ½h·a(r);  r ← r + h·v;  v ← v + ½h·a(r)', explanation: 'A symplectic integrator: errors in energy oscillate instead of accumulating. Sub-step h = η · min(√(r³/G(mᵢ+mⱼ)), r/|v_rel|).' },
    { label: 'Vis-viva', formula: 'v² = G(M + m)(2/r − 1/a)', explanation: 'Links speed, distance and the size of the orbit. It predicts the new orbit after the star’s mass changes.' },
    { label: 'Kepler’s third law', formula: 'T = 2π √(a³ / G(M + m))', explanation: 'The orbital period depends only on the semi-major axis and the total mass.' },
    { label: 'Circular and escape speed', formula: 'v_c = √(GM/r),  v_esc = √2 · v_c', explanation: 'At √2 times the circular speed the orbital energy is zero and the planet escapes.' },
    { label: 'Insolation', formula: 'S = L / (4π d²)  →  S/S⊕ = (L/L☉) / (d/AU)²', explanation: 'Starlight spreads over a sphere, so it falls with the square of distance.' },
    { label: 'Equilibrium temperature', formula: 'T_eq = [S(1 − A) / 4σ]^¼ ≈ 278 K · (S/S⊕)^¼ (1 − A)^¼', explanation: 'Absorbed starlight balances thermal radiation from the whole surface (Stefan–Boltzmann law). For Earth (A = 0.3) this gives ≈ 255 K.' },
  ],
  education: {
    objectives: [
      'Explain why a planet with exactly the right sideways speed stays on a circle, and what happens when it is slower or faster.',
      'Use vis-viva and Kepler’s third law to predict an orbit’s size, shape and period, and check the prediction against the simulation.',
      'Connect distance from the star to sunlight received and to a planet’s equilibrium temperature.',
      'Recognise how a sudden change in the central mass reshapes an orbit while the planet’s velocity stays the same.',
    ],
    background: {
      beginner:
        'A planet is always falling toward its star, but it also moves sideways so fast that it keeps missing. If the sideways speed is just right, the path is a circle. Slower, and it swoops closer to the star before swinging back out; faster, and it swings farther out — and above about 1.4 times the circular speed it never comes back. Closer to the star, sunlight is much stronger: half the distance means four times the light.',
      intermediate:
        'For two bodies, the orbit is a conic: an ellipse when the total energy is negative, a parabola or hyperbola otherwise. The vis-viva equation v² = GM(2/r − 1/a) links speed and distance to the semi-major axis a, and Kepler’s third law gives the period T = 2π√(a³/GM). Starting at distance d with speed f·v_c (perpendicular to the radius) puts the planet at an apsis: apoapsis if f < 1, periapsis if f > 1, with eccentricity |1 − f²| in the test-particle limit. If the star’s mass suddenly doubles, the old circular speed is only 1/√2 of the new circular speed, so the planet falls into an ellipse with e = 0.5 and periapsis at one third of the starting distance.',
      advanced:
        'The system is integrated as an N-body problem in the barycentric frame using a kick–drift–kick leapfrog with sub-steps h = η·min_{ij}(√(r³/G(mᵢ+mⱼ)), r/|v_rel|). The relative energy error ΔE/|E₀| is recorded as an observable; for η = 0.01 it stays around 10⁻⁶–10⁻⁴ for moderately eccentric orbits. Osculating elements are computed from the instantaneous relative state of planet and star with μ = G(M + m). With a second massive planet the inner orbit is no longer a fixed ellipse: its osculating elements oscillate on the synodic period and evolve secularly; spacings below 2√3 mutual Hill radii permit close encounters (Gladman 1993). Insolation scales as L/d² and the equilibrium temperature as S^¼.',
    },
    variables: [
      { symbol: 'M, M′', meaning: 'star mass before and after the sudden change', unit: 'M☉' },
      { symbol: 'm', meaning: 'planet mass', unit: 'M⊕' },
      { symbol: 'd', meaning: 'starting distance', unit: 'AU' },
      { symbol: 'f', meaning: 'starting speed as a multiple of circular speed' },
      { symbol: 'a, e', meaning: 'semi-major axis and eccentricity of the orbit', unit: 'AU, –' },
      { symbol: 'r_p, r_a', meaning: 'periapsis and apoapsis distances', unit: 'AU' },
      { symbol: 'L', meaning: 'star luminosity', unit: 'L☉' },
      { symbol: 'S', meaning: 'insolation relative to Earth’s', unit: 'S⊕' },
      { symbol: 'A', meaning: 'Bond albedo' },
      { symbol: 'η', meaning: 'integrator accuracy parameter' },
    ],
    guidedSteps: [
      'Run the default (Earth-like planet, circular orbit at 1 AU). Check that the measured period in the events matches the Kepler period in the derived values.',
      'Set the starting speed to 0.8 and predict the closest distance from the derived values before running. Compare with the periapsis events.',
      'Try 1.414 (√2) and 1.5: when does the planet escape, and how fast is it moving far away?',
      'Set the sudden star-mass change to 2. Where does the planet’s closest approach end up, and what happens to its insolation and temperature?',
      'Add the second planet and watch the inner planet’s eccentricity chart. Then make the second planet 10 Jupiter masses at 2 AU.',
      'Switch accuracy to Draft and compare the relative energy error with Standard and High.',
    ],
    questions: [
      'Why does halving the distance quadruple the insolation but raise the equilibrium temperature by only about 41 %?',
      'If the Sun suddenly lost half its mass, would Earth stay bound? Use the escape speed to decide, then test it.',
      'Why is the planet fastest at periapsis? Which conservation law explains it?',
      'Why does the orbit shape change when the star’s mass changes, even though the planet’s velocity does not?',
    ],
  },
  dataSources: [
    {
      name: 'Probabilistic mass–radius relation for exoplanets',
      provider: 'Chen & Kipping (2017)',
      citation: 'Chen, J. & Kipping, D. (2017). Probabilistic Forecasting of the Masses and Radii of Other Worlds. The Astrophysical Journal 834, 17.',
      url: 'https://doi.org/10.3847/1538-4357/834/1/17',
      license: 'Published equations (fit coefficients used)',
      notes: 'Mean power-law branches only (Terran M^0.279, Neptunian M^0.589, Jovian M^−0.044); used for display radii and collision size.',
    },
    {
      name: 'Nominal solar and planetary constants',
      provider: 'IAU 2015 Resolution B3; CODATA 2018; NASA planetary fact sheets',
      citation: 'Prša, A. et al. (2016). Nominal values for selected solar and planetary quantities: IAU 2015 Resolution B3. AJ 152, 41.',
      url: 'https://doi.org/10.3847/0004-6256/152/2/41',
      license: 'Public reference values',
      notes: 'L☉ = 3.828×10²⁶ W, R☉ = 6.957×10⁸ m, M☉ = 1.98847×10³⁰ kg, AU = 1.495978707×10¹¹ m, G = 6.674×10⁻¹¹ m³ kg⁻¹ s⁻².',
    },
  ],
};
