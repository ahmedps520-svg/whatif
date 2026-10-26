import { describe, expect, it } from 'vitest';
import { runHeadless } from '../../engine/headless';
import { projectileModel } from './model';

const vacuum = { airDensity: 0, friction: 0, restitution: 0, radius: 0.01, duration: 10, dt: 0.001 };

function eventTime(run: ReturnType<typeof runHeadless>, suffix: string) {
  return run.events.find((e) => e.id.endsWith(suffix))?.t;
}

describe('projectile model', () => {
  it('matches the closed-form vacuum range, apex and flight time', () => {
    const run = runHeadless(projectileModel, { ...vacuum, launchSpeed: 20, launchAngle: 45 });
    const g = 9.81;
    const tf = (2 * 20 * Math.sin(Math.PI / 4)) / g;
    const landing = run.events.find((e) => e.id === 'body-0-land')!;
    expect(landing).toBeDefined();
    expect(landing.t).toBeCloseTo(tf, 2);
    const apex = Math.max(...run.samples.obs.h_A);
    expect(apex).toBeCloseTo((20 * 20 * 0.5) / (2 * g), 1);
    const xAtLanding = run.tracks['body-0'].x[run.tracks['body-0'].t.findIndex((t) => t >= landing.t)];
    expect(xAtLanding).toBeCloseTo((20 * 20) / g, 0);
  });

  it('doubling gravity halves range and flight time in a vacuum', () => {
    const a = runHeadless(projectileModel, { ...vacuum, launchSpeed: 20, launchAngle: 45 });
    const b = runHeadless(projectileModel, { ...vacuum, launchSpeed: 20, launchAngle: 45, gravity: 19.62 });
    expect(eventTime(b, 'body-0-land')! / eventTime(a, 'body-0-land')!).toBeCloseTo(0.5, 2);
  });

  it('conserves mechanical energy with no drag and perfectly elastic bounces', () => {
    const run = runHeadless(projectileModel, { ...vacuum, restitution: 1, launchSpeed: 15, launchAngle: 70, duration: 8 });
    const e = run.samples.obs.energy;
    const e0 = e[0];
    for (const v of e) expect(Math.abs(v - e0) / e0).toBeLessThan(2e-3);
  });

  it('two masses land together in a vacuum but the heavier lands first in air', () => {
    const vac = runHeadless(projectileModel, { ...vacuum, setup: 'compare-mass', dropHeight: 100, mass: 0.05, radius: 0.05 });
    const air = runHeadless(projectileModel, { setup: 'compare-mass', dropHeight: 100, mass: 0.05, radius: 0.05, restitution: 0, airDensity: 1.225 });
    const dv = eventTime(vac, 'body-1-land')! - eventTime(vac, 'body-0-land')!;
    expect(Math.abs(dv)).toBeLessThan(0.01);
    const da = eventTime(air, 'body-1-land')! - eventTime(air, 'body-0-land')!;
    expect(da).toBeLessThan(-0.05); // body-1 (2× mass) lands earlier
  });

  it('conserves momentum in a head-on collision without gravity', () => {
    const run = runHeadless(projectileModel, { setup: 'collision', gravity: 0, airDensity: 0, restitution: 0.5, massRatio: 3, duration: 4 });
    const px = run.samples.obs.px;
    for (const v of px) expect(v).toBeCloseTo(px[0], 6);
    expect(run.events.some((e) => e.label.includes('collided'))).toBe(true);
  });

  it('objects coast while gravity is switched off', () => {
    const run = runHeadless(projectileModel, { ...vacuum, setup: 'projectile', launchSpeed: 10, launchAngle: 90, gravityPause: true, pauseStart: 0.5, pauseDuration: 2, duration: 4 });
    const i1 = run.samples.t.findIndex((t) => t >= 1.0);
    const i2 = run.samples.t.findIndex((t) => t >= 2.0);
    const v1 = run.samples.obs.vy_A[i1];
    const v2 = run.samples.obs.vy_A[i2];
    expect(v1).toBeCloseTo(10 - 9.81 * 0.5, 2);
    expect(v2).toBeCloseTo(v1, 6);
    expect(run.events.some((e) => e.id === 'gravity-off')).toBe(true);
    expect(run.events.some((e) => e.id === 'gravity-on')).toBe(true);
  });

  it('friction stops a sliding object at the distance v²/(2μg)', () => {
    const run = runHeadless(projectileModel, { setup: 'sliding', airDensity: 0, friction: 0.5, launchSpeed: 10, duration: 10 });
    const rest = run.events.find((e) => e.id.startsWith('body-0-rest'));
    expect(rest).toBeDefined();
    const x = run.tracks['body-0'].x.at(-1)!;
    expect(x).toBeCloseTo((10 * 10) / (2 * 0.5 * 9.81), 0);
  });

  it('never produces invalid output for extreme inputs', () => {
    const run = runHeadless(projectileModel, { launchSpeed: 150, gravity: 60, airDensity: 10, mass: 0.001, radius: 2, dt: 0.02 });
    for (const v of run.samples.obs.energy) expect(Number.isFinite(v)).toBe(true);
  });
});
