import { describe, expect, it } from 'vitest';
import { runHeadless } from '../../engine/headless';
import { airMass, beamFraction, declination, directNormal, harvestAt, photosynthesisModel, sinElevation } from './model';
import { defaultParams } from '../../engine/validation';

const DEG = Math.PI / 180;
const base = defaultParams(photosynthesisModel);

describe('photosynthesis energy budget', () => {
  it('uses standard solar geometry', () => {
    expect(declination(172) / DEG).toBeCloseTo(23.44, 1); // June solstice
    expect(declination(80) / DEG).toBeCloseTo(0, 0); // near the March equinox
    // Noon sun at the equator on an equinox is overhead.
    expect(Math.asin(sinElevation(0, 0, 12)) / DEG).toBeCloseTo(90, 6);
    // Sunrise at 6:00 on the equinox anywhere (geometric horizon).
    expect(sinElevation(40 * DEG, 0, 6)).toBeCloseTo(0, 10);
  });

  it('matches the Meinel clear-sky relation and Kasten–Young air mass', () => {
    expect(airMass(0)).toBeCloseTo(1, 2);
    expect(airMass(60)).toBeCloseTo(2, 1);
    expect(directNormal(0)).toBeCloseTo(1353 * 0.7, -1);
    expect(directNormal(90)).toBe(0);
  });

  it('applies the posture shape factors', () => {
    expect(beamFraction('standing', 90 - 1e-9)).toBeCloseTo(1 / Math.PI, 6);
    expect(beamFraction('lying', 0)).toBeCloseTo(0.5, 10);
    expect(beamFraction('facing', 45)).toBe(0.5);
  });

  it('integrates the same daily harvest as the closed-form quadrature', () => {
    const run = runHeadless(photosynthesisModel, { ...base, duration: 1 });
    const day1 = run.events.find((e) => e.id === 'day-1');
    expect(day1).toBeDefined();
    const derived = photosynthesisModel.derived!(base).find((d) => d.key === 'dayKcal')!.value;
    expect(run.final.totalKcal).toBeCloseTo(derived, 0);
    expect(Math.abs(run.final.totalKcal - derived) / derived).toBeLessThan(0.01);
  });

  it('is far below a daily food requirement for a standing person', () => {
    const run = runHeadless(photosynthesisModel, { ...base, duration: 2 });
    const perDay = run.final.totalKcal / 2;
    expect(perDay).toBeGreaterThan(10);
    expect(perDay).toBeLessThan(2000 * 0.25);
  });

  it('scales linearly with efficiency and exposed skin', () => {
    const a = harvestAt({ ...base, efficiency: 2, exposedFraction: 50 }, 12).power;
    const b = harvestAt({ ...base, efficiency: 4, exposedFraction: 100 }, 12).power;
    expect(b / a).toBeCloseTo(4, 6);
  });

  it('reports sunrise and sunset with a long summer day at 35°N', () => {
    const run = runHeadless(photosynthesisModel, { ...base, latitude: 35, dayOfYear: 172, duration: 1 });
    const rise = run.events.find((e) => e.id === 'sunrise-0')!.t;
    const set = run.events.find((e) => e.id === 'sunset-0')!.t;
    expect(set - rise).toBeGreaterThan(14);
    expect(set - rise).toBeLessThan(14.8);
  });
});
