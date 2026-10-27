import { describe, expect, it } from 'vitest';
import { EXPERIMENTS } from './catalog';
import { getModel } from '../models/registry';
import { runHeadless } from '../engine/headless';
import { validateParams } from '../engine/validation';

// Models whose data must be fetched in a browser are covered by their own tests.
const NEEDS_DATA = new Set(['sea-level']);

describe('every experiment runs and summarises', () => {
  for (const e of EXPERIMENTS) {
    if (NEEDS_DATA.has(e.modelId)) continue;
    it(e.id, () => {
      const m = getModel(e.modelId)!;
      const run = runHeadless(m, e.params, { timeoutMs: 8000, maxSamples: 800 });
      expect(run.samples.t.length).toBeGreaterThan(1);
      expect(run.events.some((ev) => ev.id === 'engine-error' || ev.id === 'numerical-instability'), `${e.id}: ${run.numerics.stoppedReason}`).toBe(false);
      for (const v of Object.values(run.final)) expect(Number.isNaN(v) || Number.isFinite(v)).toBe(true);
      const key = m.summarize?.(run) ?? [];
      for (const k of key) if (typeof k.value === 'number') expect(Number.isNaN(k.value) || Number.isFinite(k.value) || k.value === Infinity, k.label).toBe(true);
      const p = validateParams(m, e.params).values;
      expect(() => m.derived?.(p)).not.toThrow();
      expect(() => m.warnings?.(p)).not.toThrow();
      if (e.baseline) {
        const b = runHeadless(m, e.baseline, { timeoutMs: 8000, maxSamples: 800, duration: run.duration });
        expect(b.events.some((ev) => ev.id === 'engine-error')).toBe(false);
      }
    });
  }
});
