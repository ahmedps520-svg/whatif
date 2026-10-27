import { describe, expect, it } from 'vitest';
import { runHeadless } from '../../engine/headless';
import { validateParams } from '../../engine/validation';
import { capacityK, computeFlows, explainGrowth, populationModel } from './model';

function at(run: ReturnType<typeof runHeadless>, key: string, t: number): number {
  const i = run.samples.t.findIndex((x) => x >= t - 1e-9);
  return run.samples.obs[key][i];
}

describe('population model', () => {
  it('grows as P0·exp((b − d + m)t) when feedbacks are off', () => {
    const p = { feedbacks: false, P0: 2, birthRate: 25, deathRate: 9, migration: 3, duration: 150, dt: 0.5 };
    const run = runHeadless(populationModel, p);
    const r = (25 - 9 + 3) / 1000;
    for (const t of [10, 50, 100, 150]) {
      const expected = 2 * Math.exp(r * t);
      expect(Math.abs(at(run, 'population', t) - expected) / expected).toBeLessThan(1e-6);
    }
  });

  it('grows exponentially with feedbacks on when resources, energy and infrastructure are abundant', () => {
    const p = { P0: 1, birthRate: 20, deathRate: 10, sustainablePop: 200, maxExtraction: 50, energySupply: 50, energyGrowth: 5, infrastructure0: 100, duration: 100 };
    const run = runHeadless(populationModel, p);
    const expected = Math.exp(0.01 * 100);
    expect(Math.abs(run.final.population - expected) / expected).toBeLessThan(1e-6);
    expect(Math.min(...run.samples.obs.needsMet)).toBeCloseTo(100, 6);
    expect(Math.max(...run.samples.obs.deathRate)).toBeCloseTo(10, 6);
  });

  it('logistic regeneration alone carries the stock to its capacity', () => {
    // Negligible demand: a tiny, constant population consuming the minimum.
    const p = { P0: 0.01, birthRate: 8, deathRate: 8, consumption: 0.1, sustainablePop: 12, regenRate: 10, resource0: 5, duration: 300, dt: 0.1 };
    const run = runHeadless(populationModel, p);
    const r = 0.1;
    const x0 = 0.05;
    for (const t of [20, 40, 60, 100]) {
      const logistic = 1 / (1 + ((1 - x0) / x0) * Math.exp(-r * t));
      expect(at(run, 'resource', t) / 100).toBeCloseTo(logistic, 3);
    }
    expect(run.final.resource).toBeGreaterThan(99.9);
  });

  it('defines the capacity so the maximum sustainable yield feeds P_sus billion people', () => {
    const { values } = validateParams(populationModel, { sustainablePop: 12, regenRate: 5 });
    const K = capacityK(values);
    expect((0.05 * K) / 4).toBeCloseTo(12, 10);
    // At S = K/2 the regeneration equals the MSY.
    const f = computeFlows(0, 1, K / 2, 100, 100, { K, S0: K / 2 }, values);
    expect(f.regen).toBeCloseTo(12, 10);
    expect(f.msy).toBeCloseTo(12, 10);
  });

  it('scarcity lowers births and raises deaths', () => {
    const scarce = runHeadless(populationModel, { sustainablePop: 3, resource0: 30, energySupply: 20, infrastructure0: 50, duration: 120 });
    const abundant = runHeadless(populationModel, { sustainablePop: 200, maxExtraction: 50, energySupply: 20, infrastructure0: 50, duration: 120 });
    const minNeeds = Math.min(...scarce.samples.obs.needsMet);
    expect(minNeeds).toBeLessThan(90);
    const i = scarce.samples.obs.needsMet.indexOf(minNeeds);
    expect(scarce.samples.obs.deathRate[i]).toBeGreaterThan(8 + 1);
    expect(scarce.samples.obs.deathScarcity[i]).toBeGreaterThan(1);
    expect(scarce.samples.obs.birthRate[i]).toBeLessThan(17);
    expect(Math.max(...abundant.samples.obs.deathRate)).toBeCloseTo(8, 6);
    expect(scarce.final.population).toBeLessThan(abundant.final.population);
    expect(scarce.events.some((e) => e.id === 'needs-90')).toBe(true);
  });

  it('the death-rate terms follow the documented linear forms', () => {
    const { values } = validateParams(populationModel, { scarcityMortality: 100, crowdingMortality: 20, energyMortality: 30, birthSensitivity: 1, maxExtraction: 10 });
    const K = capacityK(values);
    // Availability h·S = 0.1·S; choose S so that needs met = 60 %. Infrastructure serves half; energy covers 25 %.
    const P = 10;
    const S = (0.6 * P) / 0.1;
    const f = computeFlows(0, P, S, 0.25 * P, P / 2, { K, S0: S }, values);
    expect(f.needsMet).toBeCloseTo(0.6, 12);
    expect(f.deathScarcity * 1000).toBeCloseTo(100 * 0.4, 9);
    expect(f.deathCrowding * 1000).toBeCloseTo(20 * 0.5, 9);
    expect(f.deathEnergy * 1000).toBeCloseTo(30 * 0.75, 9);
    expect(f.birthRate * 1000).toBeCloseTo(17 * 0.6, 9);
    const ex = explainGrowth(f);
    expect(ex.direction).toBe('falling');
    expect(ex.dominantPressure?.label).toContain('scarcity');
  });

  it('keeps every stock non-negative and the population mass balance exact under extreme inputs', () => {
    const extreme = {
      P0: 40, birthRate: 60, deathRate: 1, migration: 30, sustainablePop: 0.5, regenRate: 50, resource0: 100, maxExtraction: 100,
      consumption: 5, stress: 90, energySupply: 0.1, energyGrowth: -5, depletionEnergy: 5, infrastructure0: 0.1, buildRate: 0, depreciation: 10,
      outbreak: true, outbreakStart: 0, outbreakDuration: 30, outbreakMortality: 200,
      birthSensitivity: 3, scarcityMortality: 500, crowdingMortality: 200, energyMortality: 200, duration: 1000, dt: 1,
    };
    const run = runHeadless(populationModel, extreme);
    for (const key of Object.keys(run.samples.obs)) {
      for (const v of run.samples.obs[key]) expect(Number.isNaN(v) || Number.isFinite(v)).toBe(true);
    }
    for (const v of run.samples.obs.population) expect(v).toBeGreaterThanOrEqual(0);
    for (const v of run.samples.obs.resource) expect(v).toBeGreaterThanOrEqual(0);
    for (const v of run.samples.obs.infrastructure) expect(v).toBeGreaterThanOrEqual(0);
    expect(run.events.some((e) => e.id === 'engine-error' || e.id === 'numerical-instability')).toBe(false);
  });

  it('balances population and resource flows exactly', () => {
    const model = populationModel;
    const { values } = validateParams(model, { outbreak: true, outbreakStart: 30, outbreakMortality: 40, migration: -2, sustainablePop: 6, duration: 200 });
    const s = model.init(values);
    for (let i = 0; i < 2000; i++) model.step(s, values, 0.1);
    const dP = s.P - s.P0;
    expect(Math.abs(dP - (s.cumBirths - s.cumDeaths + s.cumMigration))).toBeLessThan(1e-9 * Math.max(1, s.P0));
    expect(Math.abs(s.S - s.S0 - (s.cumRegen - s.cumHarvest))).toBeLessThan(1e-7 * s.K);
    expect(s.cumOutbreakDeaths).toBeGreaterThan(0);
  });

  it('reports the population peak at the sign change of dP/dt with its value', () => {
    const run = runHeadless(populationModel, {});
    const peak = run.events.find((e) => e.id === 'peak-1');
    expect(peak).toBeDefined();
    const P = run.samples.obs.population;
    const iMax = P.indexOf(Math.max(...P));
    expect(Math.abs(peak!.t - run.samples.t[iMax])).toBeLessThan(1.01);
    expect(peak!.label).toContain(Number(P[iMax].toPrecision(3)).toString());
    const growth = run.samples.obs.growthRate;
    const k = run.samples.t.findIndex((t) => t > peak!.t + 1);
    expect(growth[k]).toBeLessThan(0);
  });

  it('generates milestones from the actual state and outbreak start/end events', () => {
    const run = runHeadless(populationModel, { outbreak: true, outbreakStart: 20, outbreakDuration: 3, outbreakMortality: 20, duration: 120 });
    const m50 = run.events.find((e) => e.id === 'milestone-50')!;
    expect(m50).toBeDefined();
    expect(m50.label).toContain(Number(at(run, 'population', 50).toPrecision(3)).toString());
    expect(run.events.find((e) => e.id === 'milestone-120')!.label).toContain('End of run');
    const start = run.events.find((e) => e.id === 'outbreak-start')!;
    const end = run.events.find((e) => e.id === 'outbreak-end')!;
    expect(start.t).toBe(20);
    expect(end.t).toBe(23);
    expect(at(run, 'deathOutbreak', 21)).toBeCloseTo(20, 6);
    expect(at(run, 'deathOutbreak', 24)).toBe(0);
  });

  it('detects overshoot and halving with the declarative thresholds', () => {
    const run = runHeadless(populationModel, { maxExtraction: 10, duration: 250 });
    expect(run.events.some((e) => e.id === 'overshoot')).toBe(true);
    const half = run.events.find((e) => e.id === 'pop-halved');
    expect(half).toBeDefined();
    expect(at(run, 'population', half!.t)).toBeLessThan(8.1 / 2);
  });

  it('summarises a run with values taken from the recording', () => {
    const run = runHeadless(populationModel, {});
    const res = populationModel.summarize!(run);
    const peak = res.find((r) => r.label === 'Highest population')!;
    expect(peak.value).toBe(Math.max(...run.samples.obs.population));
  });
});
