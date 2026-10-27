import { afterEach, describe, expect, it } from 'vitest';
import { runHeadless } from '../../engine/headless';
import type { ParamValues } from '../../engine/types';
import { validateParams } from '../../engine/validation';
import { renderEarthTexture } from '../../data/earthTexture';
import type { ElevationMeta } from '../../data/elevation';
import { buildHypsometry, seaLevelForWaterFraction, waterFractionAtSeaLevel } from './hypsometry';
import {
  REFERENCE,
  TAU_EARTH,
  dailyMeanInsolation,
  planetModel,
  setHypsometry,
  stellarFlux,
  waterBoilingPointK,
} from './model';
import { experiments } from './experiments';

const P = (over: Partial<ParamValues> = {}): ParamValues => validateParams(planetModel, over).values;
const derived = (p: ParamValues, key: string) => {
  const d = planetModel.derived!(p).find((q) => q.key === key);
  if (!d) throw new Error(`no derived ${key}`);
  return d.value;
};
const MARS = {
  mass: REFERENCE.mars.massKg / REFERENCE.earth.massKg,
  radius: REFERENCE.mars.radiusKm / REFERENCE.earth.radiusKm,
};

afterEach(() => setHypsometry(null));

describe('planet model: closed-form quantities', () => {
  it('surface gravity from fact-sheet mass and radius: Earth ≈ 9.8, Mars ≈ 3.7 m/s²', () => {
    expect(derived(P(), 'gravity')).toBeCloseTo(9.8, 1);
    expect(derived(P(MARS), 'gravity')).toBeCloseTo(3.7, 1);
    // Mass and radius are independent; gravity follows from both.
    expect(derived(P({ mass: 2, radius: Math.SQRT2 }), 'gravity')).toBeCloseTo(derived(P(), 'gravity'), 6);
  });

  it("Kepler's third law: 1 AU around 1 M☉ gives ≈ 365.25 days", () => {
    expect(derived(P(), 'orbitPeriod')).toBeCloseTo(365.25, 0);
    // a³ scaling: 4 AU → 8× longer.
    expect(derived(P({ distance: 4 }), 'orbitPeriod') / derived(P(), 'orbitPeriod')).toBeCloseTo(8, 3);
  });

  it("Earth's equilibrium temperature with A = 0.3 is ≈ 255 K and the calibrated τ gives ≈ 288 K", () => {
    const teq = derived(P({ albedo: 0.3 }), 'teq');
    expect(teq).toBeGreaterThan(254);
    expect(teq).toBeLessThan(256);
    expect(TAU_EARTH).toBeGreaterThan(0.8);
    expect(TAU_EARTH).toBeLessThan(0.9);
    expect(derived(P(), 'ts')).toBeCloseTo(288, 0);
    // No greenhouse: surface = equilibrium.
    expect(derived(P({ tau: 0 }), 'ts')).toBeCloseTo(teq, 9);
  });

  it('the temperature override bypasses the energy balance and is labelled as such', () => {
    const p = P({ tempOverride: true, surfaceTempSet: 400 });
    const ts = planetModel.derived!(p).find((d) => d.key === 'ts')!;
    expect(ts.value).toBe(400);
    expect(ts.provenance).toBe('assumed');
    expect(ts.label).toMatch(/override/i);
  });

  it('solar day ≈ 24 h for a 23.934 h sidereal day; Venus-like retrograde spin gives ≈ 2802 h', () => {
    expect(derived(P({ rotationPeriod: 23.934 }), 'solarDay')).toBeCloseTo(24, 1);
    const venus = derived(P({ rotationPeriod: REFERENCE.venus.rotationH, tilt: REFERENCE.venus.tiltDeg, distance: REFERENCE.venus.aAU }), 'solarDay');
    expect(Math.abs(venus / REFERENCE.venus.solarDayH - 1)).toBeLessThan(0.01);
  });

  it('a tidally locked planet has no solar day', () => {
    expect(derived(P({ tidallyLocked: true }), 'solarDay')).toBe(Infinity);
  });

  it('daily-mean insolation at the equator at an equinox equals S/π', () => {
    const p = P({ observer: 'equator', startSeason: 'march-equinox' });
    const obs = planetModel.observe(planetModel.init(p), p);
    const S = stellarFlux(1, 1);
    expect(obs.declination).toBeCloseTo(0, 9);
    expect(obs.dailyInsolation).toBeCloseTo(S / Math.PI, 6);
    expect(dailyMeanInsolation(S, 0, 0)).toBeCloseTo(S / Math.PI, 9);
    expect(obs.daylight).toBeCloseTo(12, 1);
  });

  it('boiling point of water: 100 °C at 1 atm, none below the triple point', () => {
    expect(waterBoilingPointK(1.01325)).toBeCloseTo(373.15, 0);
    expect(waterBoilingPointK(0.001)).toBeNaN();
  });

  it('warns about rotation faster than breakup, and always notes that stability is not checked', () => {
    const fast = planetModel.warnings!(P({ rotationPeriod: 1 }));
    expect(fast.find((w) => w.id === 'breakup')?.severity).toBe('critical');
    const earth = planetModel.warnings!(P());
    expect(earth.some((w) => w.id === 'breakup')).toBe(false);
    expect(earth.some((w) => w.id === 'not-checked')).toBe(true);
    expect(earth.some((w) => w.id === 'boiling' || w.id === 'frozen')).toBe(false);
  });

  it('flags implausible densities and boiling oceans', () => {
    expect(planetModel.warnings!(P({ mass: 30, radius: 1 })).some((w) => w.id === 'density-high')).toBe(true);
    expect(planetModel.warnings!(P({ mass: 0.05, radius: 2 })).some((w) => w.id === 'density-low')).toBe(true);
    expect(planetModel.warnings!(P({ luminosity: 10 })).some((w) => w.id === 'boiling')).toBe(true);
  });
});

describe('planet model: time evolution', () => {
  it('polar night at 90°N at the northern winter solstice', () => {
    const run = runHeadless(planetModel, { observer: 'pole', startSeason: 'december-solstice', duration: 3 });
    for (const v of run.samples.obs.daylight) expect(v).toBe(0);
    for (const v of run.samples.obs.dailyInsolation) expect(v).toBe(0);
    for (const v of run.samples.obs.elevation) expect(v).toBeLessThan(-23);
    expect(run.events.some((e) => e.id === 'polar-night-start')).toBe(true);
    expect(run.final.sunrises).toBe(0);
  });

  it('completes a year in ≈ 365.25 days, with equinoxes and solstices in order', () => {
    const run = runHeadless(planetModel, { duration: 366, dt: 0.25 });
    const year = run.events.find((e) => e.id === 'year-1');
    expect(year).toBeDefined();
    expect(year!.t / 24).toBeCloseTo(365.25, 0);
    expect(run.final.yearLength).toBeCloseTo(365.25, 0);
    const seasons = run.events.filter((e) => e.id.startsWith('season-')).map((e) => e.label);
    expect(seasons).toEqual(['Northern summer solstice', 'Northern autumn equinox', 'Northern winter solstice', 'Northern spring equinox']);
    // 45°N: about 15.4 h of daylight at the June solstice, 8.6 h in December (geometric, no refraction).
    const day = run.samples.obs.daylight;
    expect(Math.max(...day)).toBeCloseTo(15.4, 1);
    expect(Math.min(...day)).toBeCloseTo(8.6, 0);
    // Noon height at the solstice: 90° − 45° + 23.44°, tracked every step (not limited by recording).
    expect(run.final.elevationMax).toBeCloseTo(68.44, 0);
    expect(run.final.elevationMin).toBeCloseTo(-68.44, 0);
  });

  it('sunrise and sunset at the equator at an equinox are 12 h apart, a solar day apart from the next', () => {
    const run = runHeadless(planetModel, { observer: 'equator', duration: 3, rotationPeriod: 23.934 });
    const t = (id: string) => run.events.find((e) => e.id === id)!.t;
    expect(t('sunset-1') - t('sunrise-1')).toBeCloseTo(12, 1);
    expect(t('sunrise-2') - t('sunrise-1')).toBeCloseTo(24, 1);
    expect(t('sunrise-1')).toBeCloseTo(6, 1); // the run starts at local midnight on the prime meridian
  });

  it('rotating twice as fast halves the solar day', () => {
    const run = runHeadless(planetModel, { observer: 'equator', duration: 3, rotationPeriod: 23.9345 / 2 });
    const t = (id: string) => run.events.find((e) => e.id === id)!.t;
    expect(t('sunrise-2') - t('sunrise-1')).toBeCloseTo(12, 1);
  });

  it('a tidally locked planet without tilt keeps the star fixed in the sky', () => {
    const run = runHeadless(planetModel, { tidallyLocked: true, tilt: 0, observer: 'custom', obsLat: 0, obsLon: 180, duration: 60 });
    for (const v of run.samples.obs.elevation) expect(v).toBeCloseTo(90, 4);
    expect(run.final.sunrises).toBe(0);
    expect(run.events.some((e) => e.id === 'locked')).toBe(true);
    for (const v of run.samples.obs.daylight) expect(v).toBeNaN();
  });

  it('no axial tilt means constant declination and constant daylight', () => {
    const run = runHeadless(planetModel, { tilt: 0, duration: 200, dt: 0.5 });
    for (const v of run.samples.obs.declination) expect(v).toBeCloseTo(0, 9);
    for (const v of run.samples.obs.daylight) expect(v).toBeCloseTo(run.samples.obs.daylight[0], 9);
    expect(run.events.some((e) => e.id.startsWith('season-'))).toBe(false);
  });

  it('never produces non-finite output for extreme inputs', () => {
    const run = runHeadless(planetModel, { mass: 30, radius: 0.1, rotationPeriod: 1, distance: 0.05, starMass: 0.08, luminosity: 1000, tilt: 90, duration: 5 });
    expect(run.numerics.stoppedReason).toMatch(/duration/);
    for (const v of run.samples.obs.elevation) expect(Number.isFinite(v)).toBe(true);
    for (const v of run.samples.obs.insolation) expect(Number.isFinite(v)).toBe(true);
  });

  it('summarizes a run from recorded values', () => {
    const run = runHeadless(planetModel, { duration: 30 });
    const res = planetModel.summarize!(run);
    expect(res.find((r) => r.label.startsWith('Highest star elevation'))?.value).toBeGreaterThan(40);
    expect(res.find((r) => r.label === 'Sunrises at the observation point')?.value).toBe(run.final.sunrises);
  });
});

describe('hypsometry and water coverage', () => {
  // 4 × 2 synthetic grid. Row 1 nodes represent three times the area of row 0 nodes.
  const data = new Int16Array([-100, -100, 0, 100, -100, 50, 50, 200]);

  it('inverts the area-weighted hypsometric curve', () => {
    const uniform = buildHypsometry(data, 4, 2, () => 1);
    expect(waterFractionAtSeaLevel(uniform, 0)).toBeCloseTo(3 / 8, 12);
    expect(seaLevelForWaterFraction(uniform, 3 / 8)).toBeCloseTo(-99, 9);
    expect(seaLevelForWaterFraction(uniform, 0.5)).toBeCloseTo(1, 9);
    expect(seaLevelForWaterFraction(uniform, 7 / 16)).toBeCloseTo(0.5, 9);
    expect(seaLevelForWaterFraction(uniform, 0)).toBe(-100);
    expect(seaLevelForWaterFraction(uniform, 1)).toBe(201);
    const weighted = buildHypsometry(data, 4, 2, (r) => (r === 0 ? 1 : 3));
    expect(waterFractionAtSeaLevel(weighted, 0)).toBeCloseTo(5 / 16, 12);
    for (const f of [0.1, 0.3, 0.55, 0.8, 0.95]) expect(waterFractionAtSeaLevel(weighted, seaLevelForWaterFraction(weighted, f))).toBeCloseTo(f, 9);
  });

  it('reports NaN without the dataset and the computed sea level with it', () => {
    setHypsometry(null);
    expect(derived(P({ water: 50 }), 'seaLevel')).toBeNaN();
    const h = buildHypsometry(data, 4, 2, () => 1);
    setHypsometry(h);
    expect(derived(P({ water: 50 }), 'seaLevel')).toBeCloseTo(1, 9);
    expect(derived(P(), 'oceanToday')).toBeCloseTo(37.5, 9);
  });
});

describe('earth texture', () => {
  const meta: ElevationMeta = {
    file: '', ncols: 8, nrows: 5, lat0: 90, dlat: -45, lon0: -180, dlon: 45, min: -4000, max: 3000,
    sampling: '', dataset: 'synthetic', citation: '', distributor: '', sourceUrl: '', license: '', retrieved: '',
  };
  // Left half deep ocean, right half land at 50 m.
  const data = new Int16Array(40).map((_, i) => (i % 8 < 4 ? -4000 : 50));
  const grid = { meta, ncols: 8, nrows: 5, data };
  const px = (img: ReturnType<typeof renderEarthTexture>, x: number, y: number) => Array.from(img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));

  it('colours water blue and land not blue, and floods low land when sea level rises', () => {
    const img = renderEarthTexture(grid, { width: 64, iceSheets: false, hillshade: false });
    expect(img.height).toBe(32);
    const sea = px(img, 10, 16);
    const land = px(img, 50, 16);
    expect(sea[2]).toBeGreaterThan(sea[0]);
    expect(land[0]).toBeGreaterThan(land[2]);
    const flooded = px(renderEarthTexture(grid, { width: 64, seaLevel: 100, iceSheets: false, hillshade: false }), 50, 16);
    expect(flooded[2]).toBeGreaterThan(flooded[0]);
    const dry = px(renderEarthTexture(grid, { width: 64, water: 'none', iceSheets: false, hillshade: false }), 10, 16);
    expect(dry[0]).toBeGreaterThan(dry[2]);
  });
});

describe('planet experiments', () => {
  it('use valid parameters and unique ids', () => {
    const ids = new Set<string>();
    for (const e of experiments) {
      expect(e.modelId).toBe('planet');
      expect(ids.has(e.id)).toBe(false);
      ids.add(e.id);
      for (const set of [e.params, e.baseline ?? {}]) {
        expect(validateParams(planetModel, set).issues).toEqual([]);
      }
    }
    expect(ids.has('planet-lab')).toBe(true);
  });

  it('stronger-gravity experiment gives the stated hypothetical gravity', () => {
    const e = experiments.find((x) => x.id === 'planet-strong-gravity')!;
    const g = derived(P(e.params), 'gravity');
    expect(g / derived(P(), 'gravity')).toBeCloseTo(5 / 1.5 ** 2, 6);
  });
});
