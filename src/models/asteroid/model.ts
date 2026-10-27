import type { DerivedQuantity, KeyResult, ParamValues, RunRecord, SimEvent, SimulationModel, Warning } from '../../engine/types';
import { num } from '../../engine/validation';
import { G, HOUR, M_EARTH, MT_TNT, R_EARTH } from '../orbits/constants';
import { accuracyParam, capWarning, drainCollisions, etaFor, f } from '../orbits/common';
import {
  advance,
  cloneSystem,
  createSystem,
  energyError,
  hyperbolicApproach,
  hyperbolicFlyby,
  makeBody,
  newRelState,
  relativeState,
  type Body,
  type NBodyState,
  type Vec3,
} from '../orbits/nbody';

/**
 * Asteroid approaching Earth on a hyperbolic trajectory — the Earth–asteroid
 * two-body problem integrated with the shared N-body leapfrog. Earth starts at
 * rest at the origin and is integrated too (its recoil, of order m/M⊕, is
 * computed but negligible). Model time is in hours; tracks are in Earth radii.
 */

export interface ImpactRecord {
  t: number;
  /** m/s */
  speed: number;
  /** J */
  energy: number;
  /** Elevation of the trajectory above the local horizontal, rad. */
  angle: number;
  /** Transient crater diameter, m (NaN when not applicable). */
  crater: number;
}

export interface AsteroidState {
  /** Model time, hours. */
  t: number;
  sys: NBodyState;
  pending: SimEvent[];
  eta: number;
  /** Actual starting distance, m. */
  d0: number;
  /** Direction of the initial velocity (unit vector). */
  dir0: Vec3;
  approaching: boolean;
  minR: number;
  minT: number;
  vAtMin: number;
  atmosphere: boolean;
  impact: ImpactRecord | null;
  left: boolean;
}

export const EARTH_ID = 'earth';
export const ASTEROID_ID = 'asteroid';
/** Target density used in the crater scaling (sedimentary/crystalline rock), kg/m³. */
export const TARGET_DENSITY = 2500;
/** Altitude at which the model notes atmospheric entry, m. */
export const ATMOSPHERE_TOP = 100e3;

/**
 * Transient crater diameter (m), Collins, Melosh & Marcus (2005), eq. 21:
 * D_tc = 1.161 (ρᵢ/ρₜ)^⅓ L^0.78 vᵢ^0.44 g^−0.22 sin^⅓θ (SI units).
 */
export function transientCraterDiameter(L: number, rhoI: number, vI: number, g: number, theta: number, rhoT = TARGET_DENSITY): number {
  if (!(g > 0) || !(vI > 0) || !(theta > 0) || !(L > 0)) return NaN;
  return 1.161 * Math.cbrt(rhoI / rhoT) * Math.pow(L, 0.78) * Math.pow(vI, 0.44) * Math.pow(g, -0.22) * Math.cbrt(Math.sin(theta));
}

export function asteroidMass(p: ParamValues): number {
  const r = num(p, 'diameter') / 2;
  return num(p, 'density') * (4 / 3) * Math.PI * r * r * r;
}

function mu(p: ParamValues) {
  return G * (M_EARTH * num(p, 'earthMassFactor') + asteroidMass(p));
}

function surfaceGravity(p: ParamValues) {
  return (G * M_EARTH * num(p, 'earthMassFactor')) / (R_EARTH * R_EARTH);
}

/** Closed-form predictions from the parameters. */
export function predictFlyby(p: ParamValues) {
  const vInf = num(p, 'vInf') * 1000;
  const b = num(p, 'impactParam') * R_EARTH;
  const m = mu(p);
  const fb = hyperbolicFlyby(m, vInf, b);
  const R = R_EARTH + num(p, 'diameter') / 2;
  const vEsc = Math.sqrt((2 * G * M_EARTH * num(p, 'earthMassFactor')) / R_EARTH);
  const bCrit = R * Math.sqrt(1 + (2 * m) / (R * vInf * vInf));
  const hits = b < bCrit;
  const vImpact = Math.sqrt(vInf * vInf + (2 * m) / R);
  // Angular momentum b·v∞ = R·vᵢ·cos θ  →  elevation angle θ at the surface.
  const angle = hits ? Math.acos(Math.min(1, (b * vInf) / (R * vImpact))) : NaN;
  return { vInf, b, mu: m, ...fb, bCrit, hits, vImpact, angle, vEsc };
}

/** Starting distance actually used: never inside the closest-approach region. */
export function effectiveStart(p: ParamValues): number {
  const pr = predictFlyby(p);
  return Math.max(num(p, 'startDistance') * R_EARTH, 2 * pr.b, 2 * pr.rp, 2 * R_EARTH);
}

/** Time scales (s): the approach from the start, and the closest-approach passage. */
function timescales(p: ParamValues) {
  const pr = predictFlyby(p);
  const D = effectiveStart(p);
  const vD = Math.sqrt(pr.vInf * pr.vInf + (2 * pr.mu) / D);
  const rp = Math.max(pr.rp, R_EARTH);
  const vp = Math.sqrt(pr.vInf * pr.vInf + (2 * pr.mu) / rp);
  return { approach: D / vD, passage: rp / vp };
}

function sampleIntervalHours(p: ParamValues): number {
  const ts = timescales(p);
  return Math.max(Math.min(ts.passage / 6, ts.approach / 100) / HOUR, num(p, 'duration') / 3000, 1e-4);
}

const SCR = newRelState();

function earthOf(s: AsteroidState): Body {
  return s.sys.bodies[0];
}
function asteroidOf(s: AsteroidState): Body {
  return s.sys.bodies[1];
}

function trackSubstep(s: AsteroidState, t0: number, sec0: number) {
  const a = asteroidOf(s);
  const e = earthOf(s);
  if (!a.alive) return;
  const rel = relativeState(a, e, SCR);
  const t = t0 + (s.sys.t - sec0) / HOUR;
  if (rel.r < s.minR) {
    s.minR = rel.r;
    s.minT = t;
    s.vAtMin = rel.v;
  }
  if (!s.atmosphere && rel.r < R_EARTH + ATMOSPHERE_TOP) {
    s.atmosphere = true;
    s.pending.push({
      t,
      id: 'atmosphere',
      label: `Reached 100 km altitude at ${f(rel.v / 1000)} km/s`,
      detail: `At ${f(t, 4)} h the asteroid would enter the atmosphere. Atmospheric entry (drag, heating, fragmentation, airbursts) is not modelled: the trajectory continues as if Earth had no air.`,
      severity: 'warning',
      source: 'model',
    });
  }
  if (s.approaching && rel.rdot >= 0) {
    s.approaching = false;
    const alt = s.minR - R_EARTH;
    s.pending.push({
      t: s.minT,
      id: 'closest-approach',
      label: `Closest approach: ${f(s.minR / R_EARTH)} R⊕ (${f(alt / 1000)} km altitude) at ${f(s.minT, 4)} h`,
      detail: `Speed at closest approach ${f(s.vAtMin / 1000)} km/s, centre distance ${f(s.minR / 1000)} km.`,
      severity: 'milestone',
      source: 'model',
    });
  }
}

function reportImpact(s: AsteroidState, p: ParamValues, t0: number, sec0: number) {
  for (const c of drainCollisions(s.sys)) {
    const t = t0 + (c.t - sec0) / HOUR;
    const r = Math.hypot(...c.rel);
    const v = c.relSpeed;
    const rdot = (c.rel[0] * c.vrel[0] + c.rel[1] * c.vrel[1] + c.rel[2] * c.vrel[2]) / (r * v);
    const angle = Math.asin(Math.min(1, Math.abs(rdot)));
    const crater = transientCraterDiameter(num(p, 'diameter'), num(p, 'density'), v, surfaceGravity(p), angle);
    s.impact = { t, speed: v, energy: c.energy, angle, crater };
    const deg = (angle * 180) / Math.PI;
    s.pending.push({
      t,
      id: 'impact',
      label: `Impact at ${f(v / 1000)} km/s, ${f(deg, 2)}° above the horizon`,
      detail:
        `Kinetic energy ${f(c.energy)} J = ${f(c.energy / MT_TNT)} Mt of TNT, at ${f(t, 4)} h. ` +
        (Number.isFinite(crater)
          ? `Approximate transient crater diameter: ${f(crater / 1000)} km (Collins, Melosh & Marcus 2005 scaling for a rock target of ${TARGET_DENSITY} kg/m³; the final crater is larger). `
          : '') +
        'This assumes the body reaches the ground intact at full speed. Atmospheric entry is not modelled; stony bodies up to a few tens of metres usually break up and explode in the air (airburst) instead of cratering.',
      severity: 'critical',
      source: 'model',
    });
  }
}

export const asteroidModel: SimulationModel<AsteroidState> = {
  id: 'asteroid',
  name: 'Asteroid Approach',
  shortName: 'Asteroid',
  domain: 'astronomy',
  viewKind: '3d',
  summary:
    'An asteroid falls past Earth on a hyperbolic path computed from Newtonian gravity. Earth’s pull bends the path and can turn a near miss into a hit (gravitational focusing); on impact the model reports the speed, energy and an approximate crater size.',
  params: [
    { key: 'diameter', label: 'Asteroid diameter', type: 'number', unit: 'm', kind: 'initial', group: 'Asteroid', min: 1, max: 20000, step: 1, default: 100, scale: 'log', description: 'Diameter of the (spherical) asteroid.', marks: [
      { value: 20, label: '~20 m (Chelyabinsk 2013, est.)' }, { value: 140, label: '140 m (survey size threshold)' }, { value: 1000, label: '1 km' }, { value: 10000, label: '~10 km (Chicxulub impactor, est.)' },
    ] },
    { key: 'density', label: 'Bulk density', type: 'number', unit: 'kg/m3', kind: 'initial', group: 'Asteroid', min: 300, max: 8000, step: 10, default: 3000, description: 'Mean density; together with the diameter it sets the mass.', marks: [
      { value: 600, label: 'Cometary (typical)' }, { value: 3000, label: 'Stony (typical)' }, { value: 7800, label: 'Iron (typical)' },
    ] },
    { key: 'vInf', label: 'Approach speed far from Earth (v∞)', type: 'number', unit: 'km/s', kind: 'initial', group: 'Trajectory', min: 0.5, max: 70, step: 0.1, default: 12, description: 'Speed relative to Earth before Earth’s gravity speeds it up. The speed at impact is at least Earth’s escape speed (11.2 km/s).' },
    { key: 'impactParam', label: 'Impact parameter b', type: 'number', unit: 'R_earth', kind: 'initial', group: 'Trajectory', min: 0, max: 20, step: 0.01, default: 2, description: 'How far the asteroid would miss Earth’s centre if there were no gravity (the offset of its straight-line path).', marks: [
      { value: 0, label: 'Head-on' }, { value: 1, label: '1 R⊕' },
    ] },
    { key: 'earthMassFactor', label: 'Earth mass multiplier', type: 'number', unit: 'x', kind: 'initial', group: 'Earth', min: 0, max: 5, step: 0.01, default: 1, description: 'Scale Earth’s mass (and gravity) with its radius fixed. 0 switches Earth’s gravity off for comparison.', marks: [
      { value: 0, label: 'No gravity (straight line)' }, { value: 1, label: 'Today' }, { value: 2, label: 'Doubled' },
    ] },
    { key: 'startDistance', label: 'Starting distance', type: 'number', unit: 'R_earth', kind: 'initial', group: 'Trajectory', min: 10, max: 200, step: 1, default: 60, description: 'Distance from Earth’s centre where the simulation starts (60 R⊕ ≈ the Moon’s distance).', marks: [
      { value: 60.3, label: 'Moon’s distance' },
    ] },
    { key: 'duration', label: 'Simulation duration', type: 'number', unit: 'h', kind: 'initial', group: 'Numerics', numerics: true, min: 1, max: 2000, step: 1, default: 48, scale: 'log', description: 'Run length in hours. The run ends early once the asteroid hits Earth or has passed and left the simulated region.' },
    accuracyParam(),
  ],
  observables: [
    { key: 'dist', label: 'Distance from Earth’s centre', unit: 'R_earth', provenance: 'simulated', chart: true, chartGroup: 'distance', sig: 4 },
    { key: 'distKm', label: 'Distance from Earth’s centre (km)', unit: 'km', provenance: 'simulated', chartGroup: 'distanceKm', sig: 4, readout: false },
    { key: 'alt', label: 'Altitude above the surface', unit: 'km', provenance: 'simulated', chartGroup: 'distanceKm', sig: 4 },
    { key: 'speed', label: 'Speed relative to Earth', unit: 'km/s', provenance: 'simulated', chart: true, chartGroup: 'speed', sig: 4 },
    { key: 'turn', label: 'Path bent by', unit: 'deg', provenance: 'simulated', chartGroup: 'turn', sig: 3, description: 'Angle between the current direction of motion and the starting direction: how much Earth’s gravity has bent the path.' },
    { key: 'ke', label: 'Kinetic energy', unit: 'J', provenance: 'simulated', chartGroup: 'energy', sig: 3, description: '½mv² relative to Earth.' },
    { key: 'keMt', label: 'Kinetic energy (Mt TNT)', unit: 'MtTNT', provenance: 'simulated', chart: true, chartGroup: 'energyMt', sig: 3, description: 'Kinetic energy in megatonnes of TNT (1 Mt = 4.184×10¹⁵ J).' },
    { key: 'minDist', label: 'Closest distance so far', unit: 'R_earth', provenance: 'simulated', sig: 4, readout: false },
    { key: 'vClosest', label: 'Speed at closest point so far', unit: 'km/s', provenance: 'simulated', sig: 4, readout: false },
    { key: 'impactSpeed', label: 'Impact speed', unit: 'km/s', provenance: 'simulated', sig: 3, readout: false },
    { key: 'impactAngle', label: 'Impact angle (above horizontal)', unit: 'deg', provenance: 'simulated', sig: 2, readout: false },
    { key: 'impactEnergyMt', label: 'Impact energy', unit: 'MtTNT', provenance: 'simulated', sig: 3, readout: false },
    { key: 'craterKm', label: 'Transient crater diameter (approx.)', unit: 'km', provenance: 'derived', sig: 2, readout: false, description: 'Collins, Melosh & Marcus (2005) scaling, assuming an intact impactor and a rock target. Not meaningful for bodies that would break up in the atmosphere.' },
    { key: 'energyErr', label: 'Relative energy error', unit: '1', provenance: 'simulated', chartGroup: 'numerics', sig: 2, description: 'Numerical error of the integrator (change of total energy since t = 0, relative to its size).' },
  ],
  primaryObservables: ['dist', 'speed'],
  time: {
    unit: 'h',
    dt: (p) => Math.max(sampleIntervalHours(p) / 2, 1e-5),
    sampleInterval: sampleIntervalHours,
    defaultDuration: (p) => num(p, 'duration'),
    durationParam: 'duration',
    maxDuration: 2000,
    realtimeRate: (p) => Math.max((2 * timescales(p).approach) / HOUR / 20, 1e-3),
  },

  init(p) {
    const k = num(p, 'earthMassFactor');
    const m = asteroidMass(p);
    const D = effectiveStart(p);
    const pr = predictFlyby(p);
    const start = hyperbolicApproach(pr.mu, pr.vInf, pr.b, D);
    const earth = makeBody({ id: EARTH_ID, label: 'Earth', slot: 0, mass: M_EARTH * k, radius: R_EARTH, pos: [0, 0, 0], vel: [0, 0, 0], priority: 1 });
    const ast = makeBody({ id: ASTEROID_ID, label: 'Asteroid', slot: 1, mass: m, radius: num(p, 'diameter') / 2, pos: start.pos, vel: start.vel });
    const sys = createSystem([earth, ast]);
    const v = Math.hypot(...start.vel);
    return {
      t: 0,
      sys,
      pending: [],
      eta: etaFor(p),
      d0: D,
      dir0: [start.vel[0] / v, start.vel[1] / v, start.vel[2] / v],
      approaching: true,
      minR: D,
      minT: 0,
      vAtMin: v,
      atmosphere: false,
      impact: null,
      left: false,
    };
  },

  step(s, p, dt) {
    const t0 = s.t;
    const sec0 = s.sys.t;
    const res = advance(s.sys, dt * HOUR, { eta: s.eta, onSubstep: () => trackSubstep(s, t0, sec0) });
    s.t = t0 + dt;
    if (s.sys.collisions.length) reportImpact(s, p, t0, sec0);
    if (res.capped) {
      const w = capWarning(s.sys, s.t, 'h');
      if (w) s.pending.push(w);
    }
    const a = asteroidOf(s);
    if (a.alive && !s.approaching && !s.left) {
      const rel = relativeState(a, earthOf(s), SCR);
      if (rel.r > s.d0 && rel.rdot > 0) s.left = true;
    }
  },

  observe(s) {
    const a = asteroidOf(s);
    const out: Record<string, number> = {
      dist: NaN, distKm: NaN, alt: NaN, speed: NaN, turn: NaN, ke: NaN, keMt: NaN,
      minDist: s.minR / R_EARTH, vClosest: s.vAtMin / 1000,
      impactSpeed: NaN, impactAngle: NaN, impactEnergyMt: NaN, craterKm: NaN,
      energyErr: energyError(s.sys),
    };
    if (a.alive) {
      const e = earthOf(s);
      const rel = relativeState(a, e, newRelState());
      const vx = a.vel[0] - e.vel[0];
      const vy = a.vel[1] - e.vel[1];
      const vz = a.vel[2] - e.vel[2];
      const cos = rel.v > 0 ? (vx * s.dir0[0] + vy * s.dir0[1] + vz * s.dir0[2]) / rel.v : 1;
      out.dist = rel.r / R_EARTH;
      out.distKm = rel.r / 1000;
      out.alt = (rel.r - R_EARTH) / 1000;
      out.speed = rel.v / 1000;
      out.turn = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
      out.ke = 0.5 * a.mass * rel.v * rel.v;
      out.keMt = out.ke / MT_TNT;
    }
    if (s.impact) {
      out.impactSpeed = s.impact.speed / 1000;
      out.impactAngle = (s.impact.angle * 180) / Math.PI;
      out.impactEnergyMt = s.impact.energy / MT_TNT;
      out.craterKm = s.impact.crater / 1000;
    }
    return out;
  },

  clone(s) {
    return { ...s, sys: cloneSystem(s.sys), pending: [...s.pending], dir0: [...s.dir0] as Vec3, impact: s.impact ? { ...s.impact } : null };
  },

  time_of: (s) => s.t,

  detectEvents(_prev, _cur, s) {
    const out = s.pending.sort((a, b) => a.t - b.t);
    s.pending = [];
    return out;
  },

  finished(s) {
    if (s.impact) return 'The asteroid hit Earth.';
    if (s.left) return 'The asteroid has passed Earth and left the simulated region.';
    return null;
  },

  tracks(s) {
    const out = [];
    for (const b of s.sys.bodies) {
      if (!b.alive) continue;
      out.push({ id: b.id, x: b.pos[0] / R_EARTH, y: b.pos[1] / R_EARTH, z: b.pos[2] / R_EARTH });
    }
    return out;
  },

  derived(p) {
    const pr = predictFlyby(p);
    const m = asteroidMass(p);
    const out: DerivedQuantity[] = [
      { key: 'mass', label: 'Asteroid mass', value: m, unit: 'kg', formula: 'm = ρ · (π/6) L³', provenance: 'derived', sig: 3 },
      { key: 'vEsc', label: 'Escape speed at Earth’s surface', value: pr.vEsc / 1000, unit: 'km/s', formula: 'v_esc = √(2GM⊕/R⊕)', provenance: 'derived', sig: 3 },
      { key: 'g', label: 'Surface gravity', value: surfaceGravity(p), unit: 'm/s2', formula: 'g = GM⊕/R⊕²', provenance: 'derived', sig: 3 },
      { key: 'bCrit', label: 'Critical impact parameter', value: pr.bCrit / R_EARTH, unit: 'R_earth', formula: 'b_crit = R √(1 + v_esc²/v∞²)', provenance: 'derived', sig: 4, note: 'Gravitational focusing: any asteroid aimed closer than this hits Earth, even though without gravity it would miss for b > 1 R⊕.' },
      { key: 'keInf', label: 'Kinetic energy far from Earth', value: (0.5 * m * pr.vInf * pr.vInf) / MT_TNT, unit: 'MtTNT', formula: '½ m v∞²', provenance: 'derived', sig: 3 },
    ];
    if (pr.hits) {
      const crater = transientCraterDiameter(num(p, 'diameter'), num(p, 'density'), pr.vImpact, surfaceGravity(p), pr.angle);
      out.push(
        { key: 'vImpact', label: 'Predicted impact speed', value: pr.vImpact / 1000, unit: 'km/s', formula: 'vᵢ = √(v∞² + v_esc²)', provenance: 'derived', sig: 3, note: 'The path reaches the surface: the asteroid will hit.' },
        { key: 'angle', label: 'Predicted impact angle (above horizontal)', value: (pr.angle * 180) / Math.PI, unit: 'deg', formula: 'cos θ = b v∞ / (R vᵢ)', provenance: 'derived', sig: 2 },
        { key: 'keImpact', label: 'Predicted impact energy', value: (0.5 * m * pr.vImpact * pr.vImpact) / MT_TNT, unit: 'MtTNT', formula: '½ m vᵢ²', provenance: 'derived', sig: 3 },
      );
      if (Number.isFinite(crater)) {
        out.push({ key: 'crater', label: 'Approximate transient crater diameter', value: crater / 1000, unit: 'km', formula: 'D_tc = 1.161 (ρᵢ/ρₜ)^⅓ L^0.78 vᵢ^0.44 g^−0.22 sin^⅓θ', provenance: 'derived', sig: 2, note: 'Collins, Melosh & Marcus (2005) scaling, rock target 2500 kg/m³, intact impactor; an approximation that ignores the atmosphere.' });
      }
    } else {
      out.push(
        { key: 'rp', label: 'Predicted closest approach', value: pr.rp / R_EARTH, unit: 'R_earth', formula: 'r_p = (√(μ² + b²v∞⁴) − μ) / v∞²', provenance: 'derived', sig: 4, note: 'Closest distance from Earth’s centre on the hyperbola. The asteroid misses.' },
        { key: 'altP', label: 'Predicted closest altitude', value: (pr.rp - R_EARTH) / 1000, unit: 'km', formula: 'r_p − R⊕', provenance: 'derived', sig: 4 },
        { key: 'vp', label: 'Predicted speed at closest approach', value: pr.vp / 1000, unit: 'km/s', formula: 'v_p = √(v∞² + 2μ/r_p)', provenance: 'derived', sig: 4 },
        { key: 'deflection', label: 'Predicted total deflection', value: (pr.deflection * 180) / Math.PI, unit: 'deg', formula: 'δ = 2 arcsin(1/e),  e = √(1 + (b v∞²/μ)²)', provenance: 'derived', sig: 3 },
      );
    }
    return out;
  },

  warnings(p) {
    const w: Warning[] = [];
    const pr = predictFlyby(p);
    const L = num(p, 'diameter');
    const rho = num(p, 'density');
    const k = num(p, 'earthMassFactor');
    if (pr.hits) {
      w.push({ id: 'hit', severity: 'warning', message: `On this path the asteroid hits Earth: b = ${f(pr.b / R_EARTH)} R⊕ is inside the critical impact parameter ${f(pr.bCrit / R_EARTH)} R⊕.` });
      if ((rho < 5000 && L < 100) || L < 30) {
        w.push({ id: 'airburst', severity: 'warning', message: 'Bodies this small (especially stony or cometary ones) usually break up and explode in the atmosphere rather than reaching the ground intact. Atmospheric entry is not modelled, so the impact energy is an upper bound on what reaches the surface and the crater estimate does not apply.' });
      }
      if (L >= 1000) w.push({ id: 'global', severity: 'info', message: 'Impacts this large have regional to global consequences (ejecta, fires, climate effects) that are far outside this model.' });
    }
    if (k === 0) w.push({ id: 'no-gravity', severity: 'info', message: 'Earth’s gravity is switched off: the asteroid moves in a straight line. This is a comparison case, not a physical scenario.' });
    else if (k !== 1) w.push({ id: 'mass', severity: 'info', message: 'Earth’s mass is scaled with its radius fixed — a thought experiment about gravity only.' });
    const D = effectiveStart(p);
    if (D > num(p, 'startDistance') * R_EARTH * 1.0001) {
      w.push({ id: 'start', severity: 'info', message: `The starting distance was increased to ${f(D / R_EARTH)} R⊕ so the asteroid starts well before its closest approach.` });
    }
    return w;
  },

  summarize(run: RunRecord): KeyResult[] {
    const out: KeyResult[] = [];
    const impact = run.events.find((e) => e.id === 'impact');
    const closest = run.events.find((e) => e.id === 'closest-approach');
    out.push({ label: 'Outcome', value: impact ? 'Impact' : closest ? 'Near miss' : 'Still approaching at the end of the run', provenance: 'simulated', note: (impact ?? closest)?.label });
    const fin = run.final;
    if (Number.isFinite(fin.minDist)) {
      out.push({ label: 'Closest distance from Earth’s centre', value: fin.minDist, unit: 'R_earth', provenance: 'simulated', sig: 4 });
      if (!impact) out.push({ label: 'Closest altitude', value: ((fin.minDist - 1) * R_EARTH) / 1000, unit: 'km', provenance: 'simulated', sig: 4 });
    }
    if (impact) {
      out.push(
        { label: 'Impact speed', value: fin.impactSpeed, unit: 'km/s', provenance: 'simulated', sig: 3 },
        { label: 'Impact angle above the horizontal', value: fin.impactAngle, unit: 'deg', provenance: 'simulated', sig: 2 },
        { label: 'Impact energy', value: fin.impactEnergyMt, unit: 'MtTNT', provenance: 'simulated', sig: 3, note: 'Kinetic energy at the surface, assuming no atmosphere.' },
      );
      if (Number.isFinite(fin.craterKm)) out.push({ label: 'Approximate transient crater diameter', value: fin.craterKm, unit: 'km', provenance: 'derived', sig: 2, note: 'Collins, Melosh & Marcus (2005) scaling; approximation, intact impactor.' });
    } else if (Number.isFinite(fin.vClosest)) {
      out.push({ label: 'Speed at closest approach', value: fin.vClosest, unit: 'km/s', provenance: 'simulated', sig: 4 });
      if (Number.isFinite(fin.turn)) out.push({ label: 'Path bent by Earth’s gravity', value: fin.turn, unit: 'deg', provenance: 'simulated', sig: 3 });
    }
    const err = (run.samples.obs.energyErr ?? []).filter(Number.isFinite).map(Math.abs);
    if (err.length) out.push({ label: 'Largest relative energy error', value: Math.max(...err), unit: '1', provenance: 'simulated', sig: 2, note: 'Numerical accuracy check: should stay far below 1 %.' });
    return out;
  },

  assumptions: [
    { kind: 'established', text: 'Newtonian gravity: the asteroid and Earth attract each other as point masses; the path is a hyperbola set by the speed at infinity and the impact parameter.' },
    { kind: 'simplification', text: 'Only Earth and the asteroid exist: the Sun, the Moon and Earth’s orbital motion are left out, so v∞ is the speed relative to Earth.' },
    { kind: 'simplification', text: 'Earth is a non-rotating sphere of radius 6,371 km that starts at rest; it is integrated too, but its recoil (of order m/M⊕) is negligible.' },
    { kind: 'simplification', text: 'The atmosphere is ignored: no drag, heating, ablation, fragmentation or airburst. The 100 km altitude crossing is only reported.' },
    { kind: 'simplification', text: 'The asteroid is a solid sphere of uniform density; the motion stays in one plane.' },
    { kind: 'approximation', text: 'Transient crater size uses the scaling law of Collins, Melosh & Marcus (2005) for a rock target of 2500 kg/m³ and an intact impactor. It is an order-of-magnitude estimate with substantial uncertainty.' },
    { kind: 'speculative', text: 'Changing Earth’s mass (or switching its gravity off) is a thought experiment; Earth’s radius is kept fixed.' },
  ],
  limitations: [
    'Atmospheric entry is not modelled. Small stony bodies (tens of metres) usually break up or airburst before reaching the ground, so for them the impact speed, energy and crater are not physical outcomes.',
    'Impact effects beyond the crater estimate (blast, ejecta, tsunami, climate) are not modelled.',
    'A merger ends the run at first contact with the surface.',
    'Real Earth-approaching asteroids follow orbits around the Sun; over days the Sun’s and Moon’s gravity would change the encounter slightly.',
  ],
  equations: [
    { label: 'Equation of motion', formula: 'd²r/dt² = −G(M⊕ + m) r / r³', explanation: 'Relative motion of asteroid and Earth (integrated as an N-body leapfrog).' },
    { label: 'Energy and angular momentum', formula: 'v² = v∞² + 2μ/r,  r v_⊥ = b v∞', explanation: 'Gravity speeds the asteroid up as it falls in; angular momentum is set by the impact parameter.' },
    { label: 'Gravitational focusing', formula: 'b_crit = R √(1 + v_esc²/v∞²)', explanation: 'Earth’s effective target radius is larger than its real radius, especially for slow asteroids.' },
    { label: 'Hyperbola', formula: 'e = √(1 + (b v∞²/μ)²),  r_p = (√(μ² + b²v∞⁴) − μ)/v∞²,  δ = 2 arcsin(1/e)', explanation: 'Eccentricity, closest approach and total deflection angle of the flyby.' },
    { label: 'Kinetic energy', formula: 'E = ½ m v²,  1 Mt TNT = 4.184×10¹⁵ J', explanation: 'Energy carried by the asteroid relative to Earth.' },
    { label: 'Transient crater (Collins et al. 2005, eq. 21)', formula: 'D_tc = 1.161 (ρᵢ/ρₜ)^⅓ L^0.78 vᵢ^0.44 g^−0.22 sin^⅓θ', explanation: 'Empirical scaling for the crater excavated just after impact; L is the impactor diameter, θ the angle above the horizontal (SI units).' },
  ],
  education: {
    objectives: [
      'Explain why Earth’s gravity bends an asteroid’s path and makes Earth a bigger target than its size alone.',
      'Predict closest approach, speed and deflection from the impact parameter and approach speed.',
      'Relate size, density and speed to impact energy, and recognise what the model does not include (the atmosphere).',
    ],
    background: {
      beginner:
        'An asteroid passing Earth is pulled toward it, speeding up and curving. A slow asteroid aimed to miss can be pulled in and hit. If it hits, its energy of motion — which grows with its size cubed and its speed squared — is released in moments. Small rocky asteroids usually burn up or explode high in the air; this model does not include the air, so it only tells you what would happen if the rock reached the ground.',
      intermediate:
        'Relative to Earth the asteroid follows a hyperbola. Energy conservation gives v² = v∞² + 2GM/r, so it always arrives at least at Earth’s escape speed, 11.2 km/s. Angular momentum conservation (b·v∞ = r·v at closest approach) with that energy gives the closest distance. Solving for when the closest distance equals Earth’s radius gives the critical impact parameter b_crit = R√(1 + v_esc²/v∞²): at v∞ = 5 km/s that is about 2.5 Earth radii, so Earth sweeps up asteroids from a cross-section several times larger than its disc.',
      advanced:
        'The two-body problem is integrated with the shared adaptive kick–drift–kick leapfrog (sub-step limited by r/|v| near closest approach), starting on the exact incoming branch of the hyperbola at the chosen distance. The deflection δ = 2 arcsin(1/e) with e = √(1 + (b v∞²/μ)²) and the focusing factor (1 + v_esc²/v∞²) follow from the conic solution. On contact the bodies merge inelastically and the transient crater is estimated with the Collins, Melosh & Marcus (2005) π-group scaling D_tc = 1.161(ρᵢ/ρₜ)^⅓ L^0.78 vᵢ^0.44 g^−0.22 sin^⅓θ, using the simulated impact speed and angle. Entry physics (pancake models, fragmentation, airburst altitude) would be needed for bodies below about 100 m.',
    },
    variables: [
      { symbol: 'L, ρᵢ', meaning: 'asteroid diameter and density', unit: 'm, kg/m³' },
      { symbol: 'v∞', meaning: 'approach speed far from Earth', unit: 'km/s' },
      { symbol: 'b', meaning: 'impact parameter (miss distance without gravity)', unit: 'R⊕' },
      { symbol: 'r_p, v_p', meaning: 'closest distance and speed there', unit: 'R⊕, km/s' },
      { symbol: 'e, δ', meaning: 'hyperbolic eccentricity and deflection angle', unit: '–, °' },
      { symbol: 'vᵢ, θ', meaning: 'impact speed and angle above horizontal', unit: 'km/s, °' },
      { symbol: 'D_tc', meaning: 'transient crater diameter', unit: 'km' },
    ],
    guidedSteps: [
      'Run the default near miss and compare the closest-approach event with the predicted closest approach.',
      'Lower the approach speed to 3 km/s. Does the asteroid now hit? Check the critical impact parameter.',
      'Set Earth’s mass multiplier to 0 to see the straight-line path, then back to 1: how much does gravity bend it?',
      'Make it a head-on impact (b = 0) and compare the impact energy for a 100 m stony and a 100 m iron asteroid.',
      'Try a 10 km asteroid at 20 km/s and read the crater estimate, keeping in mind what the model leaves out.',
    ],
    questions: [
      'Why can an asteroid aimed to miss Earth by two Earth radii still hit it?',
      'Why is the impact speed never below 11.2 km/s, however slowly the asteroid approaches?',
      'Doubling the diameter multiplies the energy by how much? And doubling the speed?',
      'Why do small stony asteroids rarely make craters on Earth but do on the Moon?',
    ],
  },
  dataSources: [
    {
      name: 'Earth Impact Effects Program scaling laws',
      provider: 'Collins, Melosh & Marcus (2005)',
      citation: 'Collins, G. S., Melosh, H. J. & Marcus, R. A. (2005). Earth Impact Effects Program: A Web-based computer program for calculating the regional environmental consequences of a meteoroid impact on Earth. Meteoritics & Planetary Science 40(6), 817–840.',
      url: 'https://doi.org/10.1111/j.1945-5100.2005.tb00157.x',
      license: 'Published equations',
      notes: 'Transient crater diameter, eq. 21, with target density 2500 kg/m³.',
    },
  ],
};
