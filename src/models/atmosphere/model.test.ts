import { describe, expect, it } from 'vitest';
import { runHeadless } from '../../engine/headless';
import { atmosphereFor, atmosphereModel, alveolarPO2, compute, equivalentAltitude, inspiredPO2, isaAltitude, isaPressure, presentComposition } from './model';
import { defaultParams } from '../../engine/validation';

const base = defaultParams(atmosphereModel);

describe('atmosphere model', () => {
  it('reproduces present-day sea-level physiology', () => {
    const c = presentComposition();
    const pi = inspiredPO2(c.O2, 101.325);
    expect(pi).toBeCloseTo(19.9, 1);
    // Alveolar ≈ 13.3 kPa ≈ 100 mmHg with the simplified equation.
    expect(alveolarPO2(pi)).toBeCloseTo(13.25, 1);
    expect((alveolarPO2(pi) * 1000) / 133.322).toBeGreaterThan(97);
    expect((alveolarPO2(pi) * 1000) / 133.322).toBeLessThan(102);
    expect(equivalentAltitude(pi)).toBeCloseTo(0, 0);
  });

  it('inverts the standard atmosphere consistently', () => {
    for (const h of [0, 1500, 5100, 8848, 11000, 15000]) {
      expect(isaAltitude(isaPressure(h))).toBeCloseTo(h, 3);
    }
    expect(isaPressure(5500)).toBeCloseTo(50.5, 0); // about half the sea-level pressure near 5.5 km
  });

  it('removing half the oxygen lowers both its share and the pressure', () => {
    const { comp, pressure } = atmosphereFor(0.5, 'remove', 101.325);
    const x0 = presentComposition().O2;
    expect(comp.O2).toBeCloseTo((0.5 * x0) / (1 - x0 + 0.5 * x0), 10);
    expect(comp.O2 * 100).toBeGreaterThan(11.6);
    expect(comp.O2 * 100).toBeLessThan(11.8);
    expect(pressure).toBeCloseTo(101.325 * (1 - 0.5 * x0), 6);
    const sum = comp.N2 + comp.O2 + comp.Ar + comp.CO2;
    expect(sum).toBeCloseTo(1, 12);
  });

  it('replacing oxygen with nitrogen keeps pressure constant', () => {
    const { comp, pressure } = atmosphereFor(0.5, 'replace', 101.325);
    expect(pressure).toBe(101.325);
    expect(comp.O2).toBeCloseTo(presentComposition().O2 / 2, 12);
    expect(comp.N2 + comp.O2 + comp.Ar + comp.CO2).toBeCloseTo(1, 12);
  });

  it('equivalent altitude follows from the barometric formula', () => {
    const c = compute({ ...base, o2Amount: 50, mode: 'remove' }, 0.5);
    // The same inspired PO2 at that altitude on today's Earth:
    const back = presentComposition().O2 * (isaPressure(c.eqAlt) - 6.27);
    expect(back).toBeCloseTo(c.piO2, 6);
    expect(c.eqAlt).toBeGreaterThan(5000);
    // Same number of O2 molecules → identical dry partial pressure in both modes;
    // only the water-vapour dilution term (x · 6.27 kPa) differs slightly.
    const r = compute({ ...base, o2Amount: 50, mode: 'replace' }, 0.5);
    expect(r.pO2).toBeCloseTo(c.pO2, 10);
    expect(c.eqAlt).toBeGreaterThan(r.eqAlt);
    expect(c.eqAlt - r.eqAlt).toBeLessThan(150);
  });

  it('air density matches the standard value at 15 °C', () => {
    const c = compute(base, 1);
    expect(c.density).toBeCloseTo(1.225, 2);
    expect(c.sound).toBeCloseTo(340.3, 0);
    expect(c.M).toBeCloseTo(28.96, 1);
  });

  it('runs a transition and reports reference crossings in order', () => {
    const run = runHeadless(atmosphereModel, { o2Amount: 50, mode: 'remove', transitionYears: 10, duration: 20 });
    expect(run.final.o2Amount).toBeCloseTo(50, 6);
    const ids = run.events.map((e) => e.id);
    expect(ids).toContain('osha-deficient');
    expect(ids).toContain('alt-2500');
    expect(ids).toContain('fire-15');
    const t2500 = run.events.find((e) => e.id === 'alt-2500')!.t;
    const t5100 = run.events.find((e) => e.id === 'alt-5100')?.t ?? Infinity;
    expect(t2500).toBeLessThan(t5100);
    expect(run.events.some((e) => e.source === 'milestone')).toBe(true);
  });

  it('never produces non-finite output across the parameter range', () => {
    for (const amount of [0, 1, 50, 100, 250]) {
      for (const mode of ['remove', 'replace']) {
        const run = runHeadless(atmosphereModel, { o2Amount: amount, mode, transitionYears: 0, duration: 2 });
        for (const v of Object.values(run.final)) expect(Number.isNaN(v) || Number.isFinite(v)).toBe(true);
      }
    }
  });
});
