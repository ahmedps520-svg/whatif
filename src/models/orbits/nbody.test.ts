import { describe, expect, it } from 'vitest';
import { AU, DAY, G, M_EARTH, M_SUN, R_EARTH, R_SUN } from './constants';
import {
  advance,
  angularMomentumMagnitude,
  conicFromTangential,
  createSystem,
  energyError,
  keplerPeriod,
  makeBody,
  momentum,
  osculating,
  toBarycentricFrame,
  type NBodyState,
} from './nbody';
import { newApsisTracker, newOrbitCounter, updateApsis, updateOrbitCounter } from './common';

/** Star + planet starting at distance d with speed f × circular speed, in the barycentric frame. */
function sunEarth(d = AU, f = 1): NBodyState {
  const mu = G * (M_SUN + M_EARTH);
  const sys = createSystem([
    makeBody({ id: 'sun', label: 'Sun', slot: -1, mass: M_SUN, radius: R_SUN, pos: [0, 0, 0], vel: [0, 0, 0] }),
    makeBody({ id: 'earth', label: 'Earth', slot: 0, mass: M_EARTH, radius: R_EARTH, pos: [d, 0, 0], vel: [0, f * Math.sqrt(mu / d), 0] }),
  ]);
  toBarycentricFrame(sys);
  return sys;
}

function run(sys: NBodyState, seconds: number, stepSeconds: number, eta = 0.01, onStep?: () => void) {
  let maxErr = 0;
  const n = Math.round(seconds / stepSeconds);
  for (let i = 0; i < n; i++) {
    advance(sys, stepSeconds, { eta });
    maxErr = Math.max(maxErr, Math.abs(energyError(sys)));
    onStep?.();
  }
  return maxErr;
}

describe('N-body leapfrog core', () => {
  it('keeps a circular orbit circular for ten orbits', () => {
    const sys = sunEarth();
    const T = keplerPeriod(G * (M_SUN + M_EARTH), AU);
    let maxDev = 0;
    let maxE = 0;
    run(sys, 10 * T, DAY / 2, 0.01, () => {
      const el = osculating(sys.bodies[1], sys.bodies[0]);
      maxDev = Math.max(maxDev, Math.abs(el.r / AU - 1));
      maxE = Math.max(maxE, el.e);
    });
    expect(maxDev).toBeLessThan(1e-4);
    expect(maxE).toBeLessThan(1e-4);
  });

  it('keeps the relative energy error small on an eccentric (e = 0.6) orbit', () => {
    const sys = sunEarth(AU, Math.sqrt(1 - 0.6)); // start at apoapsis: e = 1 − f²
    const T = keplerPeriod(G * (M_SUN + M_EARTH), AU / (2 - 0.4));
    const L0 = angularMomentumMagnitude(sys);
    const maxErr = run(sys, 5 * T, DAY, 0.01);
    expect(maxErr).toBeLessThan(5e-4);
    // Leapfrog conserves angular momentum to round-off for central forces.
    expect(Math.abs(angularMomentumMagnitude(sys) / L0 - 1)).toBeLessThan(1e-10);
  });

  it('reproduces Kepler’s third law within 0.5 %', () => {
    const f = Math.sqrt(1 - 0.5); // e = 0.5, apoapsis at 1 AU
    const sys = sunEarth(AU, f);
    const mu = G * (M_SUN + M_EARTH);
    const pred = conicFromTangential(mu, AU, f * Math.sqrt(mu / AU));
    expect(pred.e).toBeCloseTo(0.5, 6);
    const tracker = newApsisTracker();
    const counter = newOrbitCounter(0, 0);
    const periTimes: number[] = [];
    const periDist: number[] = [];
    const orbitPeriods: number[] = [];
    const step = DAY / 4;
    for (let i = 0; i < Math.ceil((3.2 * pred.period) / step); i++) {
      advance(sys, step, {
        eta: 0.01,
        onSubstep: (s) => {
          const el = osculating(s.bodies[1], s.bodies[0]);
          if (updateApsis(tracker, el.r, el.rdot, el.v, s.t) === 1) {
            periTimes.push(tracker.lastT);
            periDist.push(tracker.lastR);
          }
          if (updateOrbitCounter(counter, el.theta, s.t)) orbitPeriods.push(counter.lastPeriod);
        },
      });
    }
    expect(periTimes.length).toBeGreaterThanOrEqual(3);
    const measured = periTimes[2] - periTimes[1];
    expect(Math.abs(measured / pred.period - 1)).toBeLessThan(0.005);
    expect(orbitPeriods.length).toBeGreaterThanOrEqual(3);
    expect(Math.abs(orbitPeriods[1] / pred.period - 1)).toBeLessThan(0.005);
    // Periapsis distance from vis-viva: r_p = a(1 − e) = AU/3.
    for (const r of periDist) expect(Math.abs(r / (AU / 3) - 1)).toBeLessThan(0.005);
  });

  it('conserves momentum and books the dissipated energy in a merger', () => {
    const sys = createSystem([
      makeBody({ id: 'a', label: 'A', slot: 0, mass: 5e24, radius: 6e6, pos: [-5e7, 0, 0], vel: [3000, 500, 0] }),
      makeBody({ id: 'b', label: 'B', slot: 1, mass: 1e24, radius: 3e6, pos: [5e7, 1e6, 0], vel: [-8000, 0, 0] }),
    ]);
    const p0 = [...momentum(sys)];
    for (let i = 0; i < 400 && sys.bodies[1].alive; i++) advance(sys, 60, { eta: 0.01 });
    expect(sys.bodies[1].alive).toBe(false);
    expect(sys.bodies[1].mergedInto).toBe('a');
    expect(sys.collisions.length).toBe(1);
    const p1 = momentum(sys);
    for (let k = 0; k < 3; k++) expect(Math.abs(p1[k] - p0[k])).toBeLessThan(1e-9 * Math.hypot(...p0));
    expect(sys.bodies[0].mass).toBeCloseTo(6e24, -12);
    expect(sys.collisions[0].relSpeed).toBeGreaterThan(11000);
    expect(sys.collisions[0].energy).toBeGreaterThan(0);
    // The heat of the merger is accounted for, so the diagnostic stays at integrator level.
    expect(Math.abs(energyError(sys))).toBeLessThan(1e-3);
  });

  it('caps sub-steps instead of hanging and reports it', () => {
    const sys = sunEarth(0.05 * AU, 0.1);
    const res = advance(sys, 30 * DAY, { eta: 0.01, maxSubsteps: 50 });
    expect(res.substeps).toBe(51);
    expect(res.capped).toBe(true);
    expect(sys.capHits).toBe(1);
  });
});
