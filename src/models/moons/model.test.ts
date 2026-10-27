import { describe, expect, it } from 'vitest';
import { runHeadless } from '../../engine/headless';
import { validateParams } from '../../engine/validation';
import { LUNAR_TIDE_TODAY, SOLAR_TIDE, moonsModel as model, predictMoon1, rocheLimit } from './model';
import { experiments } from './experiments';

const maxAbs = (a: number[]) => Math.max(...a.filter(Number.isFinite).map(Math.abs));
const derivedOf = (p: Record<string, unknown>) => {
  const d = model.derived!(validateParams(model, p as never).values);
  return (key: string) => d.find((q) => q.key === key)!.value;
};

describe('moons model', () => {
  it('default: the Moon stays on its circle and Earth wobbles around the barycentre', () => {
    const t0 = performance.now();
    const run = runHeadless(model, {});
    expect(performance.now() - t0).toBeLessThan(2000);
    for (const d of run.samples.obs.d1) expect(Math.abs(d / 384400 - 1)).toBeLessThan(1e-4);
    const dv = derivedOf({});
    const off = run.samples.obs.earthOffset;
    for (const v of off) expect(Math.abs(v / dv('bary') - 1)).toBeLessThan(1e-3);
    expect(run.final.earthSpeed / dv('vE')).toBeCloseTo(1, 3);
    expect(dv('bary')).toBeGreaterThan(4600);
    expect(dv('bary')).toBeLessThan(4750);
    expect(maxAbs(run.samples.obs.energyErr)).toBeLessThan(1e-6);
    expect(run.final.tideRel).toBeCloseTo(1, 3);
    // Sidereal period from the closed form, ≈ 27.3 days.
    expect(dv('T1')).toBeGreaterThan(27.2);
    expect(dv('T1')).toBeLessThan(27.4);
  });

  it('computes the Sun’s tide as ≈ 0.46 of today’s lunar tide', () => {
    expect(SOLAR_TIDE / LUNAR_TIDE_TODAY).toBeGreaterThan(0.45);
    expect(SOLAR_TIDE / LUNAR_TIDE_TODAY).toBeLessThan(0.47);
    const run = runHeadless(model, { duration: 5 });
    expect(run.final.tideSunRel).toBeCloseTo(SOLAR_TIDE / LUNAR_TIDE_TODAY, 10);
    // Fluid Roche limit for lunar density ≈ 18,400 km.
    expect(rocheLimit(1) / 1000).toBeGreaterThan(18000);
    expect(rocheLimit(1) / 1000).toBeLessThan(18800);
  });

  it('gravity doubled: perigee ≈ r/3 and e ≈ 0.5, as vis-viva predicts', () => {
    const run = runHeadless(model, { earthMassFactor: 2, duration: 60 });
    const r = 384400;
    expect(Math.abs(run.final.minD1 / (r / 3) - 1)).toBeLessThan(0.03);
    expect(Math.abs(run.final.ecc1 - 0.5)).toBeLessThan(0.02);
    const pr = predictMoon1(validateParams(model, { earthMassFactor: 2 }).values).conic;
    expect(Math.abs(run.final.minD1 / (pr.rp / 1000) - 1)).toBeLessThan(0.005);
    const perigees = run.events.filter((e) => e.id.startsWith('moon1-perigee-'));
    expect(perigees.length).toBeGreaterThan(2);
    expect(perigees[0].label).toMatch(/perigee: 129,000 km at day/);
    // Tides near perigee approach (3)³ = 27 × today’s.
    expect(Math.max(...run.samples.obs.tideRel)).toBeGreaterThan(20);
    expect(run.events.some((e) => e.id === 'earth-mass-change')).toBe(true);
  });

  it('Moon vanishes: Earth drifts in a straight line at its wobble speed', () => {
    const run = runHeadless(model, { moonVanish: true, vanishTime: 7, duration: 60 });
    const ev = run.events.find((e) => e.id === 'moon1-vanished')!;
    expect(ev).toBeDefined();
    expect(ev.t).toBeCloseTo(7, 6);
    const dv = derivedOf({});
    const v = dv('vE');
    const rE = dv('bary');
    const dt = (60 - 7) * 86400;
    const expected = Math.hypot(rE, (v * dt) / 1000);
    expect(run.final.earthDrift / expected).toBeCloseTo(1, 2);
    expect(run.final.earthSpeed / v).toBeCloseTo(1, 3);
    expect(run.final.tideRel).toBe(0);
    expect(Number.isNaN(run.final.d1)).toBe(true);
    // Energy diagnostic is unaffected by the deliberate removal.
    expect(maxAbs(run.samples.obs.energyErr)).toBeLessThan(1e-6);
    const base = runHeadless(model, { moonVanish: false, duration: 60 });
    expect(Math.max(...base.samples.obs.earthDrift)).toBeLessThan(rE * 1.01);
  });

  it('two moons: Hill-stable configuration with combined tides and close approaches', () => {
    const p = experiments.find((e) => e.id === 'two-moons')!.params;
    const run = runHeadless(model, p);
    expect(derivedOf(p)('hill')).toBeGreaterThan(2 * Math.sqrt(3));
    expect(run.events.some((e) => e.id.startsWith('moons-close-'))).toBe(true);
    expect(run.final.minSep).toBeGreaterThan(100000);
    expect(Math.min(...run.samples.obs.tideRel)).toBeGreaterThan(2);
    expect(run.events.some((e) => e.severity === 'critical')).toBe(false);
    expect(maxAbs(run.samples.obs.energyErr)).toBeLessThan(1e-4);
  });

  it('reports a Roche-limit crossing, a crash into Earth and an escape', () => {
    const roche = runHeadless(model, { moon1Distance: 15000, duration: 2 });
    expect(roche.events.some((e) => e.id === 'moon1-roche-1')).toBe(true);
    const crash = runHeadless(model, { moon1Distance: 20000, earthMassFactor: 5, duration: 5 });
    const hit = crash.events.find((e) => e.id === 'moon1-hit-earth');
    expect(hit).toBeDefined();
    expect(hit!.detail).toMatch(/km\/s/);
    const esc = runHeadless(model, { earthMassFactor: 0.4, duration: 60 });
    expect(esc.events.some((e) => e.id === 'moon1-escape')).toBe(true);
  });

  it('summarize returns computed key results', () => {
    const run = runHeadless(model, { earthMassFactor: 2, duration: 30 });
    const res = model.summarize!(run);
    expect(res.find((r) => r.label === 'Moon’s closest distance')!.value).toBeCloseTo(run.final.minD1, 8);
  });

  it('never produces invalid output for extreme inputs', () => {
    const cases = [
      { moonCount: '2', moon1Distance: 15000, moon2Distance: 15100, moon1Mass: 10, moon2Mass: 10, duration: 30, accuracy: 'draft' },
      { moonCount: '2', moon1Distance: 1000000, moon2Distance: 990000, moon2Phase: 0, duration: 365, earthMassFactor: 0.1 },
      { moonVanish: true, vanishTime: 0, duration: 10 },
    ];
    for (const c of cases) {
      const run = runHeadless(model, c);
      expect(run.events.some((e) => e.id === 'numerical-instability' || e.id === 'engine-error')).toBe(false);
    }
  });

  it('experiments reference only real parameters', () => {
    const keys = new Set(model.params.map((p) => p.key));
    for (const e of experiments) {
      expect(e.modelId).toBe('moons');
      for (const k of Object.keys({ ...e.params, ...(e.baseline ?? {}) })) expect(keys.has(k)).toBe(true);
      expect(validateParams(model, e.params).issues).toEqual([]);
    }
  });
});
