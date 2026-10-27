import { describe, expect, it } from 'vitest';
import { runHeadless } from '../../engine/headless';
import { validateParams } from '../../engine/validation';
import { equilibriumTemperature, orbitExplorerModel as model, predict } from './model';
import { experiments } from './experiments';

const maxAbs = (a: number[]) => Math.max(...a.filter(Number.isFinite).map(Math.abs));

describe('orbit-explorer model', () => {
  it('default run: circular 1 AU orbit with a Kepler year, quickly', () => {
    const t0 = performance.now();
    const run = runHeadless(model, {});
    const wall = performance.now() - t0;
    expect(wall).toBeLessThan(2000);
    const d = run.samples.obs.dist;
    for (const v of d) expect(Math.abs(v - 1)).toBeLessThan(1e-4);
    const orbit1 = run.events.find((e) => e.id === 'planet-orbit-1');
    expect(orbit1).toBeDefined();
    const pred = predict(validateParams(model, {}).values).conic.period / 86400;
    expect(Math.abs(orbit1!.t / pred - 1)).toBeLessThan(0.005);
    expect(pred).toBeCloseTo(365.25, 0);
    expect(maxAbs(run.samples.obs.energyErr)).toBeLessThan(1e-6);
    // Earth-like insolation and the textbook equilibrium temperature (≈ 255 K for A = 0.3).
    expect(run.final.insolation).toBeCloseTo(1, 3);
    expect(run.final.teq).toBeGreaterThan(253);
    expect(run.final.teq).toBeLessThan(256);
    // No spurious apsis events on a circular orbit.
    expect(run.events.filter((e) => e.id.includes('-peri-')).length).toBe(0);
  });

  it('elliptical start: periapsis matches the vis-viva prediction', () => {
    const p = { speedFactor: 0.8, duration: 800 };
    const run = runHeadless(model, p);
    const pred = predict(validateParams(model, p).values).conic;
    const peri = run.events.filter((e) => e.id.startsWith('planet-peri-'));
    expect(peri.length).toBeGreaterThan(1);
    expect(Math.abs(run.final.minDist / (pred.rp / 1.495978707e11) - 1)).toBeLessThan(0.002);
    expect(peri[0].label).toMatch(/periapsis: 0\.47\d? AU at day/);
    expect(Math.abs(run.final.ecc - pred.e)).toBeLessThan(1e-3);
    expect(Math.abs(run.final.period / (pred.period / 86400) - 1)).toBeLessThan(0.005);
  });

  it('a doubled solar mass sends Earth to periapsis ≈ 1/3 AU with e ≈ 0.5', () => {
    const run = runHeadless(model, { massChange: 2, duration: 400 });
    expect(run.events.some((e) => e.id === 'mass-change')).toBe(true);
    expect(Math.abs(run.final.minDist - 1 / 3)).toBeLessThan(0.003);
    expect(run.final.ecc).toBeCloseTo(0.5, 2);
    // New period: T·(2/3)^1.5/√2 ≈ 0.385 yr.
    expect(Math.abs(run.final.period / (365.25 * Math.pow(2 / 3, 1.5) / Math.SQRT2) - 1)).toBeLessThan(0.01);
    // Insolation at periapsis ≈ 9 S⊕ (recorded samples come close to it).
    expect(Math.max(...run.samples.obs.insolation)).toBeGreaterThan(8);
  });

  it('losing 55 % of the star mass unbinds a circular orbit (escape)', () => {
    const run = runHeadless(model, { massChange: 0.45, duration: 3000 });
    expect(run.events.some((e) => e.id === 'planet-escape')).toBe(true);
    expect(run.final.ecc).toBeGreaterThanOrEqual(1);
  });

  it('a planet with almost no sideways speed falls into the star', () => {
    const run = runHeadless(model, { speedFactor: 0.02, duration: 200 });
    const hit = run.events.find((e) => e.id === 'planet-hit-star');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('critical');
    // Free-fall time from 1 AU ≈ 64.6 days (T/(4√2)).
    expect(hit!.t).toBeGreaterThan(60);
    expect(hit!.t).toBeLessThan(66);
    expect(run.numerics.stoppedReason).toMatch(/No planets remain/);
    expect(Number.isNaN(run.final.dist)).toBe(true);
  });

  it('closer orbit: 0.7 AU gets 1/0.49 of the sunlight and a shorter year', () => {
    const run = runHeadless(model, { planetDistance: 0.7, duration: 500 });
    expect(run.final.insolation).toBeCloseTo(1 / 0.49, 3);
    expect(run.final.teq / equilibriumTemperature(1, 0.3)).toBeCloseTo(Math.pow(1 / 0.49, 0.25), 4);
    const o1 = run.events.find((e) => e.id === 'planet-orbit-1')!;
    expect(o1.t / 365.25).toBeCloseTo(Math.pow(0.7, 1.5), 2);
  });

  it('runs with a Jupiter-like second planet and records its orbit', () => {
    const run = runHeadless(model, { secondPlanet: true, duration: 3652.5 });
    expect(run.tracks.planet2).toBeDefined();
    expect(Math.abs(run.final.dist2 - 5.2)).toBeLessThan(0.05);
    expect(maxAbs(run.samples.obs.energyErr)).toBeLessThan(1e-4);
    // Jupiter perturbs the inner orbit slightly.
    expect(run.final.ecc).toBeGreaterThan(1e-5);
    expect(run.final.ecc).toBeLessThan(0.02);
  });

  it('summarize returns computed key results', () => {
    const run = runHeadless(model, { speedFactor: 0.9, duration: 400 });
    const res = model.summarize!(run);
    expect(res.find((r) => r.label === 'Closest distance to the star')!.value).toBeCloseTo(run.final.minDist, 10);
    expect(res[0].value).toMatch(/Stayed in orbit/);
  });

  it('never produces invalid output for extreme inputs', () => {
    const cases = [
      { starMass: 20, planetDistance: 0.05, speedFactor: 2, planetMass: 1000, duration: 50, accuracy: 'draft' },
      { starMass: 0.08, planetDistance: 40, speedFactor: 0, duration: 36525, accuracy: 'draft' },
      { secondPlanet: true, secondDistance: 1.1, secondMass: 50, duration: 2000, accuracy: 'draft' },
    ];
    for (const c of cases) {
      const run = runHeadless(model, c);
      expect(run.events.some((e) => e.id === 'numerical-instability' || e.id === 'engine-error')).toBe(false);
    }
  });

  it('experiments reference only real parameters', () => {
    const keys = new Set(model.params.map((p) => p.key));
    for (const e of experiments) {
      expect(e.modelId).toBe('orbit-explorer');
      for (const k of Object.keys({ ...e.params, ...(e.baseline ?? {}) })) expect(keys.has(k)).toBe(true);
      const { issues } = validateParams(model, e.params);
      expect(issues).toEqual([]);
    }
  });
});
