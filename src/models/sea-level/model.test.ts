import { afterEach, describe, expect, it } from 'vitest';
import { nodeAreaKm2, type ElevationMeta } from '../../data/elevation';
import { runHeadless } from '../../engine/headless';
import { validateParams } from '../../engine/validation';
import { areaBelow, floodLevels, isInundated, neighbours, presentOcean, type GridShape } from './flood';
import { buildSeaLevelProducts, CLS_EXCLUDED, CLS_LAKE, CLS_LAND, CLS_OCEAN, inundatedArea, type FloodPayload, type GridMeta } from './products';
import { installSeaLevelData, resetSeaLevelData } from './store';
import { seaLevelModel } from './model';
import { experiments } from './experiments';

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const R = 6371.0088;

function cellArea(meta: GridMeta, nrows: number, row: number) {
  return nodeAreaKm2({ meta: meta as ElevationMeta, nrows }, row);
}

/**
 * A 12 × 7 strip: ocean (cols 0–2), coast 2 m (col 3), lowland 5 m (cols 4–5),
 * a 10 m ridge (col 6), an inland basin at −5 m (cols 7–9) and 50 m hills (cols 10–11).
 * Placed over the Nile delta rectangle so region accounting can be checked too.
 */
const STRIP_COLS = [-100, -100, -100, 2, 5, 5, 10, -5, -5, -5, 50, 50];
const stripMeta: GridMeta = { lat0: 31.5, dlat: -0.25, lon0: 29.5, dlon: 0.25 };
function stripPayload(extra: Partial<FloodPayload> = {}): FloodPayload {
  const ncols = 12;
  const nrows = 7;
  const data = new Int16Array(ncols * nrows);
  for (let r = 0; r < nrows; r++) for (let c = 0; c < ncols; c++) data[r * ncols + c] = STRIP_COLS[c];
  return { data, ncols, nrows, meta: stripMeta, seaSeeds: [], inlandWater: [], excludeSouthOf: -Infinity, ...extra };
}
function stripArea(cols: number[]) {
  let a = 0;
  for (let r = 0; r < 7; r++) a += cellArea(stripMeta, 7, r) * cols.length;
  return a;
}

/** Brute force: smallest threshold λ at which a cell is reachable from the ocean through cells with z ≤ λ. */
function bruteForceFloodLevels(elev: ArrayLike<number>, g: GridShape, ocean: Uint8Array): Float64Array {
  const n = g.ncols * g.nrows;
  const out = new Float64Array(n).fill(Infinity);
  const levels = [...new Set(Array.from(elev))].sort((a, b) => a - b);
  const nb = new Int32Array(8);
  for (const lambda of levels) {
    const seen = new Uint8Array(n);
    const stack: number[] = [];
    for (let i = 0; i < n; i++) if (ocean[i]) {
      seen[i] = 1;
      stack.push(i);
    }
    while (stack.length) {
      const c = stack.pop()!;
      const k = neighbours(c, g, nb);
      for (let q = 0; q < k; q++) {
        const j = nb[q];
        if (seen[j] || elev[j] > lambda) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }
    for (let i = 0; i < n; i++) if (!ocean[i] && seen[i] && out[i] === Infinity) out[i] = lambda;
  }
  for (let i = 0; i < n; i++) if (ocean[i]) out[i] = -Infinity;
  return out;
}

afterEach(() => resetSeaLevelData());

describe('priority-flood flood levels', () => {
  it('equal the brute-force minimax spill level on random grids', () => {
    for (const [seed, wrap] of [[1, true], [2, false], [3, true], [4, true], [5, false]] as const) {
      const rand = rng(seed);
      const g: GridShape = { ncols: 17, nrows: 11, wrap };
      const n = g.ncols * g.nrows;
      const elev = new Float32Array(n);
      for (let i = 0; i < n; i++) elev[i] = Math.round((rand() * 60 - 25) * 4) / 4; // many ties
      let seedCell = 0;
      for (let i = 1; i < n; i++) if (elev[i] < elev[seedCell]) seedCell = i;
      const ocean = presentOcean(elev, g, seedCell);
      const fast = floodLevels(elev, g, ocean);
      const slow = bruteForceFloodLevels(elev, g, ocean);
      for (let i = 0; i < n; i++) {
        expect(fast[i]).toBe(slow[i]);
        if (!ocean[i]) expect(fast[i]).toBeGreaterThanOrEqual(elev[i]);
      }
    }
  });

  it('keeps an inland basin below sea level dry until the sea rises above its spill level', () => {
    const p = buildSeaLevelProducts(stripPayload());
    const ncols = 12;
    const at = (c: number) => p.floodLevel[3 * ncols + c];
    expect(p.cls[0]).toBe(CLS_OCEAN);
    expect(at(3)).toBe(2);
    expect(at(5)).toBe(5);
    expect(at(6)).toBe(10);
    expect(at(8)).toBe(10); // basin: spill over the 10 m ridge, not its own −5 m
    expect(p.cls[3 * ncols + 8]).toBe(CLS_LAND);

    // Boundary convention: flooded iff F < L.
    expect(isInundated(10, 10)).toBe(false);
    expect(isInundated(10, 10.01)).toBe(true);
    expect(inundatedArea(p, 0, 'connected')).toBe(0);
    expect(inundatedArea(p, 5, 'connected')).toBeCloseTo(stripArea([3]), 6);
    expect(inundatedArea(p, 5.5, 'connected')).toBeCloseTo(stripArea([3, 4, 5]), 6);
    expect(inundatedArea(p, 10, 'connected')).toBeCloseTo(stripArea([3, 4, 5]), 6);
    expect(inundatedArea(p, 10.5, 'connected')).toBeCloseTo(stripArea([3, 4, 5, 6, 7, 8, 9]), 6);
    // Without the connectivity rule the basin counts as soon as the level exceeds −5 m.
    expect(inundatedArea(p, 0.5, 'any')).toBeCloseTo(stripArea([7, 8, 9]), 6);
    expect(inundatedArea(p, 5.5, 'any')).toBeCloseTo(stripArea([3, 4, 5, 7, 8, 9]), 6);
    expect(p.totals.landBelowSeaLevel).toBeCloseTo(stripArea([7, 8, 9]), 6);
  });

  it('treats masked lake beds as inland water at their surface elevation', () => {
    const p = buildSeaLevelProducts(
      stripPayload({
        inlandWater: [
          { id: 'lake', name: 'Test lake', surface: -4, maxBed: -5, box: { south: 30.4, north: 31.0, west: 31.2, east: 31.8 }, seeds: [{ lat: 30.75, lon: 31.5 }], note: '' },
        ],
      }),
    );
    const lakeCells = [];
    for (let i = 0; i < p.cls.length; i++) if (p.cls[i] === CLS_LAKE) lakeCells.push(i);
    // Box rows 30.5–31.0 (3 rows) × cols 31.25–31.75 (cols 7–9) → 9 lake cells.
    expect(lakeCells.length).toBe(9);
    for (const i of lakeCells) expect(p.floodLevel[i]).toBe(10);
    expect(p.totals.inlandWater).toBeGreaterThan(0);
    // Lake cells are neither land nor counted as inundated under either rule.
    let basinLand = 0;
    for (let i = 0; i < p.cls.length; i++) {
      const c = i % 12;
      if (c >= 7 && c <= 9 && p.cls[i] === CLS_LAND) basinLand += cellArea(stripMeta, 7, Math.floor(i / 12));
    }
    expect(p.totals.landBelowSeaLevel).toBeCloseTo(basinLand, 6);
    expect(p.totals.landBelowSeaLevel).toBeLessThan(stripArea([7, 8, 9]));
    const anyAll = inundatedArea(p, 200, 'any');
    expect(anyAll).toBeCloseTo(p.totals.land, 6);
  });
});

describe('area accounting', () => {
  it('node areas of the 0.25° ETOPO1 layout sum to the sphere (≈ 510.07 million km²)', () => {
    const meta = { lat0: 90, dlat: -0.25, lon0: -180, dlon: 0.25 };
    let total = 0;
    for (let r = 0; r < 721; r++) total += cellArea(meta, 721, r) * 1440;
    expect(total / 1e6).toBeCloseTo(510.07, 2);
    expect(total).toBeCloseTo(4 * Math.PI * R * R, 0);
  });

  it('classifies every cell exactly once and the classes add up to the sphere', () => {
    // A 2° global grid: an ocean world with a continent, a basin and a polar cap.
    const ncols = 180;
    const nrows = 91;
    const meta = { lat0: 90, dlat: -2, lon0: -180, dlon: 2 };
    const data = new Int16Array(ncols * nrows);
    for (let r = 0; r < nrows; r++)
      for (let c = 0; c < ncols; c++) {
        const lat = 90 - 2 * r;
        const lon = -180 + 2 * c;
        let z = -3000;
        if (lat > -40 && lat < 40 && lon > -30 && lon < 60) z = Math.round(200 - Math.hypot(lat, lon - 15) * 3);
        if (lat < -66) z = 1500;
        data[r * ncols + c] = z;
      }
    const p = buildSeaLevelProducts({ data, ncols, nrows, meta, seaSeeds: [], inlandWater: [] });
    const t = p.totals;
    expect(t.sphere).toBeCloseTo(4 * Math.PI * R * R, -1);
    expect(t.ocean + t.land + t.inlandWater + t.excluded).toBeCloseTo(t.sphere, -1);
    expect(t.excluded).toBeGreaterThan(0);
    let cap = 0;
    for (let i = 0; i < p.cls.length; i++) if (p.cls[i] === CLS_EXCLUDED) cap++;
    expect(cap).toBe(ncols * 12); // rows at −68° … −90°
    expect(p.curves.connected.total).toBeCloseTo(t.land, 6);
  });

  it('cumulative curves are monotonic, and connectivity never floods more than the any-land rule', () => {
    const rand = rng(7);
    const ncols = 40;
    const nrows = 20;
    const data = new Int16Array(ncols * nrows);
    for (let i = 0; i < data.length; i++) data[i] = Math.round(rand() * 120 - 30);
    const p = buildSeaLevelProducts({ data, ncols, nrows, meta: { lat0: 50, dlat: -1, lon0: 0, dlon: 1 }, seaSeeds: [], inlandWater: [] });
    let prev = -1;
    for (let L = 0; L <= 100; L += 0.5) {
      const a = inundatedArea(p, L, 'connected');
      expect(a).toBeGreaterThanOrEqual(prev);
      expect(a).toBeLessThanOrEqual(inundatedArea(p, L, 'any') + 1e-9);
      prev = a;
    }
    expect(areaBelow(p.curves.connected, Infinity)).toBeCloseTo(p.totals.land, 6);
  });
});

describe('sea-level model', () => {
  it('rises uniformly to the target and reports areas from the precomputed curve', () => {
    const d = installSeaLevelData({ ...stripPayload(), meta: stripMeta } as never, buildSeaLevelProducts(stripPayload()));
    const run = runHeadless(seaLevelModel, { target: 10.5, rate: 1 });
    expect(run.duration).toBeCloseTo(1050, 6);
    expect(run.final.seaLevel).toBe(10.5);
    expect(run.final.area * 1e6).toBeCloseTo(stripArea([3, 4, 5, 6, 7, 8, 9]), 3);
    expect(run.final.pctLand).toBeCloseTo((100 * stripArea([3, 4, 5, 6, 7, 8, 9])) / d.products.totals.land, 6);
    // Level follows min(target, r·t) with r = 1 m per century.
    const i = run.samples.t.findIndex((t) => t >= 500);
    expect(run.samples.obs.seaLevel[i]).toBeCloseTo(run.samples.t[i] / 100, 9);
    const reached = run.events.find((e) => e.id === 'target-reached');
    expect(reached?.t).toBeCloseTo(1050, 6);
  });

  it('computes region shares and times region events at the exact crossing level', () => {
    installSeaLevelData({ ...stripPayload(), meta: stripMeta } as never, buildSeaLevelProducts(stripPayload()));
    const run = runHeadless(seaLevelModel, { target: 12, rate: 2 });
    // The Nile-delta rectangle covers columns 1–11 of the strip; its land is columns 3–11.
    const land = stripArea([3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(run.final.km2_nile).toBeCloseTo(stripArea([3, 4, 5, 6, 7, 8, 9]), 3);
    expect(run.final.pct_nile).toBeCloseTo((100 * stripArea([3, 4, 5, 6, 7, 8, 9])) / land, 6);
    // 10 % of the land (column 3 alone is 1/9 ≈ 11 %) is passed when the sea rises above 2 m: t = 2 m / (2 m per century).
    const e10 = run.events.find((e) => e.id === 'nile-10');
    expect(e10?.t).toBeCloseTo(100, 6);
    // 50 % needs the ridge and basin (spill level 10 m) → t = 500 yr.
    const e50 = run.events.find((e) => e.id === 'nile-50');
    expect(e50?.t).toBeCloseTo(500, 6);
    // Other inspection regions lie outside this synthetic grid.
    expect(Number.isNaN(run.final.pct_ganges)).toBe(true);
  });

  it('the any-land rule counts the cut-off basin from the start', () => {
    installSeaLevelData({ ...stripPayload(), meta: stripMeta } as never, buildSeaLevelProducts(stripPayload()));
    const a = runHeadless(seaLevelModel, { target: 6, rate: 1, rule: 'connected' });
    const b = runHeadless(seaLevelModel, { target: 6, rate: 1, rule: 'any' });
    expect(b.final.area).toBeGreaterThan(a.final.area);
    expect((b.final.area - a.final.area) * 1e6).toBeCloseTo(stripArea([7, 8, 9]), 3);
  });

  it('never produces non-finite output, with or without the dataset', () => {
    const noData = runHeadless(seaLevelModel, { target: 200, rate: 0.1 });
    expect(noData.duration).toBe(200000);
    for (const v of noData.samples.obs.area) expect(Number.isNaN(v)).toBe(true);
    expect(noData.final.seaLevel).toBe(200);
    installSeaLevelData({ ...stripPayload(), meta: stripMeta } as never, buildSeaLevelProducts(stripPayload()));
    const zero = runHeadless(seaLevelModel, { target: 0 });
    for (const v of zero.samples.obs.area) expect(v).toBe(0);
    expect(zero.events.some((e) => e.id === 'target-reached')).toBe(false);
  });

  it('warns below the grid’s resolution and summarizes from the run', () => {
    expect(seaLevelModel.warnings!({ target: 1, rate: 1, rule: 'connected', duration: 0 }).some((w) => w.id === 'resolution')).toBe(true);
    expect(seaLevelModel.warnings!({ target: 100, rate: 1, rule: 'connected', duration: 0 }).some((w) => w.id === 'resolution')).toBe(false);
    installSeaLevelData({ ...stripPayload(), meta: stripMeta } as never, buildSeaLevelProducts(stripPayload()));
    const run = runHeadless(seaLevelModel, { target: 10.5 });
    const s = seaLevelModel.summarize!(run);
    expect(s.find((k) => k.label === 'Newly inundated land')?.value).toBe(run.final.area);
  });

  it('experiments use valid parameters', () => {
    for (const e of experiments) {
      expect(e.modelId).toBe('sea-level');
      expect(validateParams(seaLevelModel, e.params).issues).toEqual([]);
      if (e.baseline) expect(validateParams(seaLevelModel, e.baseline).issues).toEqual([]);
    }
    expect(experiments.find((e) => e.id === 'sea-level-100m')?.params.target).toBe(100);
  });
});
