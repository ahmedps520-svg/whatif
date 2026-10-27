import { describe, expect, it } from 'vitest';
import { runHeadless } from '../../engine/headless';
import { validateParams } from '../../engine/validation';
import { R_EARTH } from '../orbits/constants';
import { asteroidModel as model, predictFlyby, transientCraterDiameter } from './model';
import { experiments } from './experiments';

const maxAbs = (a: number[]) => Math.max(...a.filter(Number.isFinite).map(Math.abs));
const pred = (p: Record<string, unknown>) => predictFlyby(validateParams(model, p as never).values);

describe('asteroid model', () => {
  it('default near miss: closest approach and deflection match the hyperbola, quickly', () => {
    const t0 = performance.now();
    const run = runHeadless(model, {});
    expect(performance.now() - t0).toBeLessThan(2000);
    const pr = pred({});
    expect(pr.hits).toBe(false);
    expect(Math.abs(run.final.minDist / (pr.rp / R_EARTH) - 1)).toBeLessThan(1e-3);
    expect(Math.abs(run.final.vClosest / (pr.vp / 1000) - 1)).toBeLessThan(1e-3);
    expect(run.events.some((e) => e.id === 'closest-approach')).toBe(true);
    expect(run.events.some((e) => e.id === 'impact')).toBe(false);
    expect(run.numerics.stoppedReason).toMatch(/left the simulated region/);
    // At the end the path has turned by most of the asymptotic deflection.
    const defl = (pr.deflection * 180) / Math.PI;
    expect(run.final.turn).toBeGreaterThan(0.9 * defl);
    expect(run.final.turn).toBeLessThan(defl);
    expect(maxAbs(run.samples.obs.energyErr)).toBeLessThan(1e-4);
  });

  it('gravitational focusing: b slightly inside b_crit hits, slightly outside misses', () => {
    const p = { vInf: 5, startDistance: 60 };
    const bc = pred(p).bCrit / R_EARTH;
    expect(bc).toBeGreaterThan(2.4);
    expect(bc).toBeLessThan(2.5);
    const hit = runHeadless(model, { ...p, impactParam: 0.98 * bc });
    expect(hit.events.some((e) => e.id === 'impact')).toBe(true);
    const miss = runHeadless(model, { ...p, impactParam: 1.02 * bc });
    expect(miss.events.some((e) => e.id === 'impact')).toBe(false);
    expect(miss.final.minDist).toBeGreaterThan(1);
    expect(miss.final.minDist).toBeLessThan(1.05);
  });

  it('head-on impact: speed √(v∞² + v_esc²), energy in Mt TNT and crater from the scaling law', () => {
    const p = { diameter: 1000, density: 3000, vInf: 17, impactParam: 0, duration: 24 };
    const run = runHeadless(model, p);
    const ev = run.events.find((e) => e.id === 'impact')!;
    expect(ev).toBeDefined();
    const pr = pred(p);
    expect(Math.abs(run.final.impactSpeed / (pr.vImpact / 1000) - 1)).toBeLessThan(1e-3);
    expect(run.final.impactAngle).toBeGreaterThan(89);
    const m = 3000 * (Math.PI / 6) * 1e9;
    const E = 0.5 * m * (pr.vImpact * pr.vImpact);
    expect(Math.abs(run.final.impactEnergyMt / (E / 4.184e15) - 1)).toBeLessThan(2e-3);
    const D = transientCraterDiameter(1000, 3000, pr.vImpact, 9.82, Math.PI / 2) / 1000;
    expect(run.final.craterKm / D).toBeCloseTo(1, 2);
    expect(run.events.some((e) => e.id === 'atmosphere')).toBe(true);
    expect(run.numerics.stoppedReason).toMatch(/hit Earth/);
  });

  it('crater scaling reproduces a hand calculation (1 km, 20 km/s, 45°)', () => {
    // 1.161 · (3000/2500)^⅓ · 1000^0.78 · 20000^0.44 · 9.81^−0.22 · sin(45°)^⅓ ≈ 11.4 km
    const D = transientCraterDiameter(1000, 3000, 20000, 9.81, Math.PI / 4);
    expect(D / 1000).toBeGreaterThan(11.2);
    expect(D / 1000).toBeLessThan(11.5);
  });

  it('with gravity off the path is a straight line at constant speed', () => {
    const run = runHeadless(model, { earthMassFactor: 0, impactParam: 3 });
    expect(run.final.minDist).toBeCloseTo(3, 4);
    for (const v of run.samples.obs.speed.filter(Number.isFinite)) expect(v).toBeCloseTo(12, 6);
    expect(maxAbs(run.samples.obs.turn)).toBeLessThan(1e-6);
  });

  it('summarize returns computed key results', () => {
    const run = runHeadless(model, experiments[1].params);
    const res = model.summarize!(run);
    expect(res[0].value).toBe('Impact');
    expect(res.find((r) => r.label === 'Impact energy')!.value).toBeCloseTo(run.final.impactEnergyMt, 8);
  });

  it('never produces invalid output for extreme inputs', () => {
    const cases = [
      { diameter: 20000, density: 8000, vInf: 70, impactParam: 0, startDistance: 10, accuracy: 'draft' },
      { diameter: 1, density: 300, vInf: 0.5, impactParam: 20, startDistance: 10, duration: 2000, earthMassFactor: 5 },
      { vInf: 0.5, impactParam: 0, earthMassFactor: 0, startDistance: 200, duration: 2000 },
    ];
    for (const c of cases) {
      const run = runHeadless(model, c);
      expect(run.events.some((e) => e.id === 'numerical-instability' || e.id === 'engine-error')).toBe(false);
    }
  });

  it('experiments reference only real parameters', () => {
    const keys = new Set(model.params.map((p) => p.key));
    for (const e of experiments) {
      expect(e.modelId).toBe('asteroid');
      for (const k of Object.keys({ ...e.params, ...(e.baseline ?? {}) })) expect(keys.has(k)).toBe(true);
      expect(validateParams(model, e.params).issues).toEqual([]);
    }
  });
});
