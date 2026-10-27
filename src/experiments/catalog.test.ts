import { describe, expect, it } from 'vitest';
import { EXPERIMENTS, PLANNED, searchCatalog } from './catalog';
import { MODELS, getModel } from '../models/registry';
import { validateParams } from '../engine/validation';
import { CHALLENGES } from './challenges';

describe('experiment catalog', () => {
  it('has unique ids across implemented and planned experiments', () => {
    const ids = [...EXPERIMENTS.map((e) => e.id), ...PLANNED.map((p) => p.id)];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('only lists experiments whose parameters are valid for their model', () => {
    for (const e of EXPERIMENTS) {
      const m = getModel(e.modelId);
      expect(m, e.id).toBeDefined();
      const v = validateParams(m!, e.params);
      expect(v.issues.map((i) => `${e.id}: ${i.message}`)).toEqual([]);
      for (const k of Object.keys(e.params)) expect(m!.params.some((p) => p.key === k), `${e.id}: unknown param ${k}`).toBe(true);
      if (e.baseline) {
        expect(validateParams(m!, e.baseline).issues.map((i) => `${e.id} baseline: ${i.message}`)).toEqual([]);
        for (const k of Object.keys(e.baseline)) expect(m!.params.some((p) => p.key === k), `${e.id}: unknown baseline param ${k}`).toBe(true);
      }
    }
  });

  it('links only to experiments that exist', () => {
    const all = new Set([...EXPERIMENTS.map((e) => e.id), ...PLANNED.map((p) => p.id)]);
    for (const e of EXPERIMENTS) for (const f of e.followUps ?? []) expect(all.has(f), `${e.id} → ${f}`).toBe(true);
    for (const p of PLANNED) for (const r of p.relatedIds ?? []) expect(all.has(r), `${p.id} → ${r}`).toBe(true);
  });

  it('gives every registered model at least one experiment and complete documentation', () => {
    for (const m of MODELS) {
      expect(EXPERIMENTS.some((e) => e.modelId === m.id), m.id).toBe(true);
      expect(m.assumptions.length, m.id).toBeGreaterThan(0);
      expect(m.limitations.length, m.id).toBeGreaterThan(0);
      expect(m.equations.length, m.id).toBeGreaterThan(0);
      for (const lvl of ['beginner', 'intermediate', 'advanced'] as const) expect(m.education.background[lvl].length, m.id).toBeGreaterThan(20);
    }
  });

  it('finds experiments by question, subject and model', () => {
    expect(searchCatalog('gravity doubled')[0]?.exp.id).toBe('gravity-doubled');
    expect(searchCatalog('moon disappear').some((i) => i.exp.id === 'moon-disappears')).toBe(true);
    expect(searchCatalog('sea level 100').some((i) => i.exp.id === 'sea-level-100m')).toBe(true);
    expect(searchCatalog('mosquitoes').every((i) => i.kind === 'planned')).toBe(true);
  });

  it('defines challenges against existing experiments and adjustable parameters', () => {
    for (const c of CHALLENGES) {
      const e = EXPERIMENTS.find((x) => x.id === c.experimentId);
      expect(e, c.id).toBeDefined();
      const m = getModel(c.modelId)!;
      for (const k of [...c.adjustable, ...Object.keys(c.fixed), ...Object.keys(c.start)]) expect(m.params.some((p) => p.key === k), `${c.id}: ${k}`).toBe(true);
    }
  });
});
