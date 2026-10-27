import { describe, expect, it } from 'vitest';
import './extensions';
import { CHALLENGES, getChallenge } from './challenges';
import { runHeadless } from '../engine/headless';
import { getModel } from '../models/registry';
import { getExperiment } from './catalog';
import type { ParamValues } from '../engine/types';

async function attempt(id: string, values: ParamValues) {
  const c = getChallenge(id)!;
  const m = getModel(c.modelId)!;
  const params = { ...getExperiment(c.experimentId)!.params, ...c.fixed, ...values } as ParamValues;
  const run = runHeadless(m, params);
  return c.verify(run, async (p) => runHeadless(m, p), params);
}

describe('challenges are reproducible', () => {
  it('registers the extra challenges', () => {
    expect(CHALLENGES.length).toBeGreaterThanOrEqual(6);
  });
  it('min-speed: the analytic answer passes, a lower one fails', async () => {
    const v = Math.sqrt(2 * 9.81 * 20) / Math.sin(Math.PI / 3);
    expect((await attempt('min-speed-20m', { launchSpeed: Math.ceil(v * 10) / 10 })).pass).toBe(true);
    expect((await attempt('min-speed-20m', { launchSpeed: 22 })).pass).toBe(false);
    expect((await attempt('min-speed-20m', { launchSpeed: 30 })).pass).toBe(false);
  });
  it('stop-at-10m: μ = v²/(2gd) passes', async () => {
    expect((await attempt('stop-at-10m', { friction: 0.51 })).pass).toBe(true);
    expect((await attempt('stop-at-10m', { friction: 0.3 })).pass).toBe(false);
  });
  it('hang-time: g = 2v/t passes', async () => {
    expect((await attempt('hang-time', { gravity: 5.88 })).pass).toBe(true);
    expect((await attempt('hang-time', { gravity: 9.81 })).pass).toBe(false);
  });
  it('bound-by-a-thread: 0.51 passes, 0.6 and 0.45 fail', async () => {
    expect((await attempt('bound-by-a-thread', { massChange: 0.51 })).pass).toBe(true);
    expect((await attempt('bound-by-a-thread', { massChange: 0.6 })).pass).toBe(false);
    expect((await attempt('bound-by-a-thread', { massChange: 0.45 })).pass).toBe(false);
  });
  it('grounded: k = 2.25 passes, 2.0 fails', async () => {
    expect((await attempt('grounded', { factor: 2.25 })).pass).toBe(true);
    expect((await attempt('grounded', { factor: 2 })).pass).toBe(false);
  });
  it('sustainable-growth has exactly one passing birth rate on the 0.5 grid', async () => {
    const passing: number[] = [];
    for (let b = 12; b <= 15; b += 0.5) if ((await attempt('sustainable-growth', { birthRate: b })).pass) passing.push(b);
    expect(passing.length).toBe(1);
  });
});
