import { describe, expect, it } from 'vitest';
import { runHeadless } from '../../engine/headless';
import { validateParams } from '../../engine/validation';
import {
  AU,
  GM_EARTH,
  MOON_DISTANCE,
  R_EARTH,
  gravityCompareModel as model,
  orbitAfterChange,
  orbitalConsequences,
  predictions,
} from './model';

const run = (p: Record<string, number | string | boolean> = {}) => runHeadless(model, p);
const params = (p: Record<string, number | string | boolean> = {}) => validateParams(model, p).values;
const ev = (r: ReturnType<typeof run>, id: string) => r.events.find((e) => e.id === id);

describe('gravity-compare: surface mechanics (both worlds stepped together)', () => {
  it('drop time ratio is 1/√k and impact speed ratio √k in a vacuum', () => {
    for (const k of [2, 0.38, 4.2]) {
      const r = run({ factor: k, dropHeight: 20 });
      const tb = r.final.drop_t_base;
      const te = r.final.drop_t_exp;
      expect(tb).toBeCloseTo(Math.sqrt((2 * 20) / 9.81), 8);
      expect(te / tb).toBeCloseTo(1 / Math.sqrt(k), 8);
      expect(r.final.drop_vimp_exp / r.final.drop_vimp_base).toBeCloseTo(Math.sqrt(k), 8);
      expect(r.final.drop_vimp_base).toBeCloseTo(Math.sqrt(2 * 9.81 * 20), 6);
    }
  });

  it('throw range, apex and flight time scale as 1/k in a vacuum and match the closed form', () => {
    for (const k of [2, 0.165]) {
      const r = run({ factor: k, launchSpeed: 15, launchAngle: 40 });
      const g = 9.81;
      const th = (40 * Math.PI) / 180;
      expect(r.final.proj_range_base).toBeCloseTo((15 * 15 * Math.sin(2 * th)) / g, 6);
      expect(r.final.proj_range_exp / r.final.proj_range_base).toBeCloseTo(1 / k, 8);
      expect(r.final.proj_apex_exp / r.final.proj_apex_base).toBeCloseTo(1 / k, 8);
      expect(r.final.proj_tf_exp / r.final.proj_tf_base).toBeCloseTo(1 / k, 8);
      expect(r.final.proj_apex_base).toBeCloseTo((15 * Math.sin(th)) ** 2 / (2 * g), 6);
    }
  });

  it('the time-stepped jump matches the closed form in both worlds', () => {
    const r = run({ factor: 2, pushDistance: 0.4, jumpHeight0: 0.5 });
    // Calibration: the baseline jump reaches h₀.
    expect(r.final.jump_apex_base).toBeCloseTo(0.5, 8);
    // h′ = d(F/m − g)/g = (d + h₀)/k − d for this calibration.
    expect(r.final.jump_apex_exp).toBeCloseTo(0.9 / 2 - 0.4, 8);
    const pr = predictions(params({ factor: 2 }));
    expect(r.final.jump_v0_exp).toBeCloseTo(pr.exp.jumpTakeoffSpeed, 8);
    expect(r.final.jump_v0_exp).toBeCloseTo(Math.sqrt(2 * 0.4 * (pr.specificLegForce - 2 * 9.81)), 8);
    const takeoff = ev(r, 'exp-jump-takeoff')!;
    expect(takeoff.t).toBeCloseTo(pr.exp.jumpPushTime, 8);
    const land = ev(r, 'exp-jump-land')!;
    expect(land.t - takeoff.t).toBeCloseTo(pr.exp.jumpFlightTime, 8);
    expect(ev(r, 'base-jump-apex')).toBeDefined();
  });

  it('jump height falls to zero as F/m approaches g and the jumper cannot jump at F/m = g', () => {
    const p0 = params({ pushDistance: 0.4, jumpHeight0: 0.5 });
    const kCrit = predictions(p0).kCrit;
    expect(kCrit).toBeCloseTo(1 + 0.5 / 0.4, 12);
    let last = Infinity;
    for (const k of [1, 1.5, 2, 2.2, 2.24]) {
      const r = run({ factor: k });
      const h = r.final.jump_apex_exp;
      const closed = (0.4 * (predictions(params({ factor: k })).specificLegForce - k * 9.81)) / (k * 9.81);
      expect(h).toBeCloseTo(closed, 8);
      expect(h).toBeLessThan(last);
      last = h;
    }
    expect(last).toBeLessThan(0.002);
    const atCrit = run({ factor: kCrit });
    expect(atCrit.final.jump_apex_exp).toBe(0);
    expect(atCrit.final.jump_v0_exp).toBe(0);
    expect(ev(atCrit, 'exp-cannot-jump')).toBeDefined();
    const beyond = run({ factor: 3 });
    expect(beyond.final.jump_apex_exp).toBe(0);
    expect(beyond.final.jump_h_exp).toBeCloseTo(-0.4, 12); // still crouched
  });

  it('apparent weight: W = m g and an Earth-calibrated scale reads k·m', () => {
    const r = run({ factor: 2, bodyMass: 70, bloodColumn: 0.35 });
    expect(r.final.weight_base).toBeCloseTo(70 * 9.81, 9);
    expect(r.final.weight_exp).toBeCloseTo(2 * 70 * 9.81, 9);
    expect(r.final.scale_base).toBeCloseTo(70, 9);
    expect(r.final.scale_exp).toBeCloseTo(140, 9);
    expect(r.final.blood_dp_base).toBeCloseTo((1060 * 9.81 * 0.35) / 133.322, 9);
    expect(r.final.blood_dp_exp / r.final.blood_dp_base).toBeCloseTo(2, 12);
  });

  it('applies the same air drag in both worlds: longer falls than vacuum, and mass now matters', () => {
    const vac = run({ factor: 2, dropHeight: 100 });
    const air = run({ factor: 2, dropHeight: 100, drag: true, ballMass: 0.1, ballRadius: 0.05 });
    const heavy = run({ factor: 2, dropHeight: 100, drag: true, ballMass: 2, ballRadius: 0.05 });
    expect(air.final.drop_t_base).toBeGreaterThan(vac.final.drop_t_base + 0.05);
    expect(air.final.drop_t_exp).toBeGreaterThan(vac.final.drop_t_exp + 0.05);
    expect(heavy.final.drop_t_exp).toBeLessThan(air.final.drop_t_exp);
    // Same air: the drag length 2m/(ρC_dA) does not depend on g, so a drop from rest still scales as 1/√k…
    expect(air.final.drop_t_exp / air.final.drop_t_base).toBeCloseTo(1 / Math.sqrt(2), 6);
    // …but a throw (fixed launch speed) no longer scales as 1/k,
    const thr = run({ factor: 2, drag: true, ballMass: 0.1, ballRadius: 0.05, launchSpeed: 40 });
    expect(Math.abs(thr.final.proj_range_exp / thr.final.proj_range_base - 0.5)).toBeGreaterThan(0.01);
    // …and air whose density scales with g breaks the drop scaling too.
    const scaled = run({ factor: 2, dropHeight: 100, drag: true, ballMass: 0.1, ballRadius: 0.05, airScales: true });
    expect(scaled.final.drop_t_exp / scaled.final.drop_t_base).toBeGreaterThan(1 / Math.sqrt(2) + 0.01);
    // Impact speed stays below the terminal speed.
    const pr = predictions(params({ factor: 2, drag: true, ballMass: 0.1, ballRadius: 0.05 }));
    expect(air.final.drop_vimp_base).toBeLessThan(pr.base.terminalSpeed);
    expect(pr.exp.kd).toBe(pr.base.kd);
  });

  it('emits landing, apex and completion events built from the computed state and then finishes', () => {
    const r = run({ factor: 2 });
    for (const id of ['base-drop-land', 'exp-drop-land', 'base-proj-apex', 'exp-proj-apex', 'base-proj-land', 'exp-proj-land', 'base-jump-apex', 'exp-jump-apex', 'all-complete']) {
      expect(ev(r, id), id).toBeDefined();
    }
    expect(ev(r, 'exp-drop-land')!.t).toBeCloseTo(r.final.drop_t_exp, 12);
    expect(ev(r, 'exp-proj-land')!.detail).toContain('Range');
    expect(r.numerics.stoppedReason).toBe('All experiments have finished in both worlds.');
    // The experiment lands first at k = 2.
    expect(ev(r, 'exp-drop-land')!.t).toBeLessThan(ev(r, 'base-drop-land')!.t);
  });

  it('is deterministic and identical to the baseline when k = 1', () => {
    const a = run({ factor: 1, drag: true });
    const b = run({ factor: 1, drag: true });
    expect(a.final).toEqual(b.final);
    expect(a.final.drop_t_exp).toBe(a.final.drop_t_base);
    expect(a.final.proj_range_exp).toBe(a.final.proj_range_base);
  });

  it('never produces non-finite output for extreme settings (including k = 0)', () => {
    const cases: Record<string, number | boolean>[] = [
      { factor: 0 },
      { factor: 5, dropHeight: 0.5, launchSpeed: 100, launchAngle: 90, dt: 0.01 },
      { factor: 0.005, launchSpeed: 0.5, launchAngle: 1, drag: true, airDensity: 5, ballMass: 0.01, ballRadius: 0.5, airScales: true },
      { factor: 5, g0: 30, pushDistance: 0.1, jumpHeight0: 1.5, drag: true, airScales: true },
    ];
    for (const p of cases) {
      const r = run(p);
      for (const [k, arr] of Object.entries(r.samples.obs)) {
        for (const v of arr) expect(Number.isNaN(v) || Number.isFinite(v), k).toBe(true);
      }
      expect(r.events.some((e) => e.id === 'numerical-instability' || e.id === 'engine-error')).toBe(false);
    }
    const zero = run({ factor: 0 });
    expect(Number.isNaN(zero.final.drop_t_exp)).toBe(true);
    expect(zero.final.drop_h_exp).toBe(20);
  });
});

describe('gravity-compare: orbital consequences (closed form)', () => {
  it('a test particle on a circular orbit gets periapsis r/3 and e = 0.5 when μ doubles', () => {
    const o = orbitAfterChange(1e7, GM_EARTH, 2 * GM_EARTH);
    expect(o.periapsis).toBeCloseTo(1e7 / 3, 3);
    expect(o.apoapsis).toBeCloseTo(1e7, 6);
    expect(o.e).toBeCloseTo(0.5, 12);
    expect(o.a).toBeCloseTo((2 * 1e7) / 3, 3);
    // Vis-viva consistency at the start point.
    expect(o.vStart ** 2).toBeCloseTo(o.muNew * (2 / o.r - 1 / o.a), 3);
  });

  it('LEO satellite periapsis is below the surface for k = 2 (Earth’s mass doubled)', () => {
    const o = orbitalConsequences(params({ factor: 2, interpretation: 'mass', satAltitude: 400 }));
    const r = R_EARTH + 400e3;
    expect(o.sat.periapsis).toBeCloseTo(r / 3, 3);
    expect(o.sat.periapsis).toBeLessThan(R_EARTH);
    expect(o.satHitsSurface).toBe(true);
    expect(o.satTimeToSurface).toBeGreaterThan(0);
    expect(o.satTimeToSurface).toBeLessThan(o.sat.periodNew / 2);
  });

  it('Moon periapsis is r/3 for k = 2 (exactly with G × 2; within 1 % with M⊕ × 2 because of the Moon’s own mass)', () => {
    const g = orbitalConsequences(params({ factor: 2, interpretation: 'G' }));
    expect(g.moon.periapsis / MOON_DISTANCE).toBeCloseTo(1 / 3, 10);
    expect(g.moon.e).toBeCloseTo(0.5, 12);
    const m = orbitalConsequences(params({ factor: 2, interpretation: 'mass' }));
    expect(Math.abs(m.moon.periapsis / MOON_DISTANCE - 1 / 3) / (1 / 3)).toBeLessThan(0.01);
    expect(m.moon.periapsis).toBeGreaterThan(R_EARTH);
    // Today's sidereal month from the two-body μ (published 27.32 d).
    expect(m.moon.periodOld / 86400).toBeCloseTo(27.3, 1);
  });

  it('G × 2 also gives Earth a perihelion of 1/3 AU; M⊕ × 2 barely changes Earth’s orbit', () => {
    const g = orbitalConsequences(params({ factor: 2, interpretation: 'G' }));
    expect(g.earth.periapsis / AU).toBeCloseTo(1 / 3, 10);
    expect(g.insolationPeri).toBeCloseTo(9, 8);
    const m = orbitalConsequences(params({ factor: 2, interpretation: 'mass' }));
    expect(m.earth.e).toBeLessThan(1e-5);
    expect(m.earth.e).toBeGreaterThan(0);
  });

  it('escape speed scales as √k; the local interpretation leaves orbits unchanged', () => {
    for (const k of [0.165, 2, 5]) {
      const o = orbitalConsequences(params({ factor: k, interpretation: 'mass' }));
      expect(o.vEscNew / o.vEscOld).toBeCloseTo(Math.sqrt(k), 12);
    }
    expect(orbitalConsequences(params({})).vEscOld / 1000).toBeCloseTo(11.19, 2);
    const loc = orbitalConsequences(params({ factor: 2, interpretation: 'local' }));
    expect(loc.sat.e).toBe(0);
    expect(loc.moon.e).toBe(0);
    expect(loc.satHitsSurface).toBe(false);
    expect(loc.vEscNew).toBe(loc.vEscOld);
  });

  it('weak gravity (k ≤ ½) unbinds the Moon and the satellite', () => {
    const o = orbitalConsequences(params({ factor: 0.165, interpretation: 'mass' }));
    expect(o.moon.bound).toBe(false);
    expect(o.sat.bound).toBe(false);
    expect(o.moon.vStart).toBeGreaterThan(o.moon.vEscNew);
    const half = orbitAfterChange(1e7, 1, 0.5);
    expect(half.bound).toBe(false);
    expect(half.e).toBeCloseTo(1, 12);
  });

  it('derived values are finite or NaN (never ±Infinity) for every interpretation', () => {
    for (const interpretation of ['mass', 'G', 'local']) {
      for (const factor of [0, 0.165, 0.5, 1, 2, 2.25, 5]) {
        for (const drag of [false, true]) {
          const d = model.derived!(params({ factor, interpretation, drag }));
          for (const q of d) expect(Number.isNaN(q.value) || Number.isFinite(q.value), `${q.key} @ ${interpretation} ${factor}`).toBe(true);
          model.warnings!(params({ factor, interpretation, drag }));
        }
      }
    }
  });

  it('summarize reports simulated ratios and closed-form orbit results', () => {
    const r = run({ factor: 2 });
    const res = model.summarize!(r);
    const fall = res.find((x) => x.label === 'Fall time — experiment')!;
    expect(fall.value).toBeCloseTo(r.final.drop_t_exp, 12);
    expect(fall.note).toContain('0.707');
    expect(res.some((x) => x.label.startsWith('Satellite'))).toBe(true);
  });
});
