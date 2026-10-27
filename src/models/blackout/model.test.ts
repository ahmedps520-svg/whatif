import { describe, expect, it } from 'vitest';
import { runHeadless } from '../../engine/headless';
import { validateParams } from '../../engine/validation';
import { blackoutModel, branchCombos, bufferShare, describeSystems, gridLevel, inForce } from './model';

const custom = { restoration: 'custom', preparedness: 'custom', logistics: 'custom' };

function at(run: ReturnType<typeof runHeadless>, key: string, t: number): number {
  const i = run.samples.t.findIndex((x) => x >= t - 1e-9);
  return run.samples.obs[key][i];
}

describe('blackout model', () => {
  it('keeps every system near 100 % with instant restoration', () => {
    const run = runHeadless(blackoutModel, { ...custom, restorationDelay: 0, restorationTime: 0, durationDays: 30 });
    for (const key of ['grid', 'backup', 'comms', 'water', 'transport', 'health', 'foodHouseholds', 'refrigerated', 'frozen', 'esi']) {
      for (const v of run.samples.obs[key]) expect(v).toBeGreaterThan(99.5);
    }
    expect(run.events.filter((e) => e.severity === 'critical' || e.severity === 'warning')).toHaveLength(0);
  });

  it('refrigerated food stops being safe after 4 h without power, frozen food after 48 h', () => {
    const run = runHeadless(blackoutModel, { ...custom, restorationDelay: 10, restorationTime: 10, durationDays: 5, dt: 0.25 });
    expect(at(run, 'refrigerated', 3)).toBeCloseTo(100, 6);
    expect(at(run, 'refrigerated', 4)).toBeLessThan(1);
    expect(at(run, 'frozen', 47)).toBeCloseTo(100, 6);
    expect(at(run, 'frozen', 48)).toBeLessThan(1);
    expect(run.events.find((e) => e.id === 'fridge-unsafe')!.t).toBe(4);
    expect(run.events.find((e) => e.id === 'freezer-unsafe')!.t).toBe(48);
  });

  it('households whose power returns before 4 h keep safe refrigerated food', () => {
    // Linear restoration from t = 0 over 8 h: half of households are back by 4 h.
    const run = runHeadless(blackoutModel, { ...custom, restorationDelay: 0, restorationTime: 8 / 24, restorationCurve: 'linear', durationDays: 1, dt: 0.05 });
    expect(at(run, 'refrigerated', 4.5)).toBeGreaterThan(49);
    expect(at(run, 'refrigerated', 4.5)).toBeLessThan(53);
  });

  it('generator fuel runs out at fuel_hours when resupply is disrupted', () => {
    for (const hours of [24, 48, 96]) {
      const run = runHeadless(blackoutModel, { ...custom, restorationDelay: 30, restorationTime: 30, fuelOnHand: hours, resupplyCapacity: 0, durationDays: 10 });
      const e = run.events.find((x) => x.id === 'fuel-exhausted');
      expect(e).toBeDefined();
      expect(e!.t).toBeCloseTo(hours, 6);
      expect(at(run, 'backup', hours + 1)).toBeCloseTo(0, 6);
      expect(at(run, 'backup', hours - 1)).toBeGreaterThan(80);
    }
  });

  it('cell batteries and water storage deplete on their stated schedule', () => {
    const run = runHeadless(blackoutModel, { ...custom, restorationDelay: 30, cellBattery: 4, cellGenerators: 0, waterStorage: 12, waterBackup: 0, durationDays: 3 });
    expect(at(run, 'comms', 4)).toBeCloseTo(50, 6);
    expect(at(run, 'comms', 6)).toBeCloseTo(0, 6);
    expect(at(run, 'water', 12)).toBeCloseTo(50, 6);
    expect(at(run, 'water', 18)).toBeCloseTo(0, 6);
    expect(run.events.find((e) => e.id === 'cell-batteries')!.t).toBe(4);
    expect(run.events.find((e) => e.id === 'water-storage-all')!.t).toBe(18);
    expect(bufferShare(2, 4)).toBe(1);
    expect(bufferShare(8, 4)).toBe(0);
  });

  it('more backup is never worse (monotonic in preparedness, logistics and fuel)', () => {
    const esi = (p: Record<string, string | number>) => runHeadless(blackoutModel, { durationDays: 40, ...p }).samples.obs.esi;
    for (const restoration of ['rapid', 'regional', 'prolonged']) {
      for (const logistics of ['prioritised', 'disrupted']) {
        const well = esi({ restoration, logistics, preparedness: 'well' });
        const typ = esi({ restoration, logistics, preparedness: 'typical' });
        const min = esi({ restoration, logistics, preparedness: 'minimal' });
        for (let i = 0; i < typ.length; i++) {
          expect(well[i]).toBeGreaterThanOrEqual(typ[i] - 1e-9);
          expect(typ[i]).toBeGreaterThanOrEqual(min[i] - 1e-9);
        }
      }
      const pri = esi({ restoration, logistics: 'prioritised' });
      const dis = esi({ restoration, logistics: 'disrupted' });
      for (let i = 0; i < pri.length; i++) expect(pri[i]).toBeGreaterThanOrEqual(dis[i] - 1e-9);
    }
    const base = { ...custom, restorationDelay: 5, restorationTime: 10, durationDays: 20 };
    const lo = runHeadless(blackoutModel, { ...base, fuelOnHand: 24 }).samples.obs;
    const hi = runHeadless(blackoutModel, { ...base, fuelOnHand: 72 }).samples.obs;
    for (const key of ['backup', 'water', 'comms', 'health', 'esi']) {
      for (let i = 0; i < lo[key].length; i++) expect(hi[key][i]).toBeGreaterThanOrEqual(lo[key][i] - 1e-9);
    }
  });

  it('restoration follows the documented curve and reports 50 % / 90 % events', () => {
    const { values } = validateParams(blackoutModel, { restoration: 'regional', restorationCurve: 'linear' });
    const a = inForce(values);
    expect(gridLevel(a.restorationDelayH - 1, a)).toBe(0);
    expect(gridLevel(a.restorationDelayH + a.restorationTimeH / 2, a)).toBeCloseTo(0.5, 12);
    const { values: v2 } = validateParams(blackoutModel, { restoration: 'regional' });
    const b = inForce(v2);
    expect(gridLevel(b.restorationDelayH + b.restorationTimeH / 2, b)).toBeCloseTo(0.5, 12);
    expect(gridLevel(b.restorationDelayH + b.restorationTimeH, b)).toBeCloseTo(1, 12);
    const run = runHeadless(blackoutModel, { restoration: 'regional' });
    const half = run.events.find((e) => e.id === 'grid-50')!;
    expect(half.t).toBeCloseTo(b.restorationDelayH + b.restorationTimeH / 2, 0);
    expect(run.events.some((e) => e.id === 'grid-90')).toBe(true);
  });

  it('a branch sets its numbers and custom uses the advanced parameters', () => {
    const { values } = validateParams(blackoutModel, { preparedness: 'minimal', fuelOnHand: 200 });
    expect(inForce(values).fuelOnHandH).toBe(24);
    const { values: c } = validateParams(blackoutModel, { preparedness: 'custom', fuelOnHand: 200 });
    expect(inForce(c).fuelOnHandH).toBe(200);
    expect(branchCombos()).toHaveLength(18);
  });

  it('stays within 0–100 % and finite for every branch and extreme custom inputs', () => {
    const runs = [
      ...branchCombos().map((b) => runHeadless(blackoutModel, { ...b, durationDays: 60 })),
      runHeadless(blackoutModel, { ...custom, restorationDelay: 60, restorationTime: 180, hospitalBackup: 0, waterBackup: 0, cellGenerators: 0, cellBattery: 0.5, waterStorage: 1, fuelOnHand: 0, pumpBackup: 0, generatorFailure: 20, resupplyCapacity: 200, terminalBackup: 100, householdFood: 0.5, vehicleTank: 1, durationDays: 60, dt: 1 }),
    ];
    for (const run of runs) {
      for (const key of ['grid', 'backup', 'comms', 'water', 'transport', 'health', 'foodHouseholds', 'refrigerated', 'frozen', 'esi']) {
        const vals = run.samples.obs[key];
        expect(vals.every((v) => Number.isFinite(v))).toBe(true);
        expect(Math.min(...vals)).toBeGreaterThanOrEqual(-1e-9);
        expect(Math.max(...vals)).toBeLessThanOrEqual(100 + 1e-9);
      }
      expect(Math.min(...run.samples.obs.fuel)).toBeGreaterThanOrEqual(0);
    }
  });

  it('builds milestone and status text from the actual state', () => {
    const run = runHeadless(blackoutModel, { restoration: 'prolonged', logistics: 'disrupted', durationDays: 10 });
    const d3 = run.events.find((e) => e.id === 'milestone-72')!;
    expect(d3.label).toContain(`${Math.round(at(run, 'esi', 72))} %`);
    const { values } = validateParams(blackoutModel, { restoration: 'prolonged' });
    const s = blackoutModel.init(values);
    for (let i = 0; i < 8; i++) blackoutModel.step(s, values, 0.25);
    const rows = describeSystems(s, values);
    expect(rows.find((r) => r.key === 'comms')!.state).toContain('on batteries — 2 h left');
    expect(rows.find((r) => r.key === 'refrigerated')!.state).toContain('safe for 2 h more');
  });
});
