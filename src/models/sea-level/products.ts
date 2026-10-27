/**
 * Everything the sea-level model precomputes from the elevation grid: inland
 * water masks, the present ocean, per-cell flood levels and area-weighted
 * cumulative curves (globally and per inspection region). Pure and worker-safe:
 * this runs in the background compute task 'sea-level-flood'.
 */
import { nodeAreaKm2, type ElevationMeta } from '../../data/elevation';
import { areaBelow, buildCurve, floodLevels, lowestCell, neighbours, presentOcean, type CumulativeCurve, type GridShape } from './flood';

export interface LatLonBox {
  south: number;
  north: number;
  west: number;
  east: number;
}

/**
 * Lakes whose bed (not surface) is stored in ETOPO1. Without a mask their lake
 * beds would look like dry land below the lake surface, and parts of them even
 * like land below sea level. A cell is lake when it lies inside `box`, its
 * dataset elevation is ≤ `maxBed` (a threshold just below the water surface)
 * and it is 8-connected to one of the `seeds` through such cells. In the flood
 * fill a lake cell takes the elevation of its water surface.
 */
export interface InlandWaterBody {
  id: string;
  name: string;
  /** Approximate water-surface elevation, m above mean sea level. */
  surface: number;
  /** Cells at or below this dataset elevation (m) are treated as lake bed. */
  maxBed: number;
  box: LatLonBox;
  seeds: { lat: number; lon: number }[];
  note: string;
}

export const INLAND_WATER: InlandWaterBody[] = [
  {
    id: 'caspian',
    name: 'Caspian Sea',
    surface: -28,
    maxBed: -29,
    box: { south: 36.5, north: 47.5, west: 46.5, east: 55.0 },
    seeds: [{ lat: 42.0, lon: 50.5 }],
    note: 'Surface ≈ −28 m (it has varied between about −26 and −29 m over the past century). Cells at or below −29 m connected to the deep middle basin count as sea bed; the surrounding Caspian lowland above that stays land.',
  },
  {
    id: 'kara-bogaz-gol',
    name: 'Kara-Bogaz-Gol lagoon (Caspian)',
    surface: -28,
    maxBed: -28,
    box: { south: 40.4, north: 42.2, west: 52.6, east: 55.0 },
    seeds: [{ lat: 41.25, lon: 53.5 }],
    note: 'A shallow, evaporating lagoon fed from the Caspian through a narrow strait; the grid shows it as a flat surface at −28 m.',
  },
  {
    id: 'superior',
    name: 'Lake Superior',
    surface: 183,
    maxBed: 182,
    box: { south: 46.3, north: 49.1, west: -92.3, east: -84.3 },
    seeds: [{ lat: 47.75, lon: -87.0 }],
    note: 'Surface ≈ 183 m.',
  },
  {
    id: 'michigan-huron',
    name: 'Lakes Michigan and Huron',
    surface: 176,
    maxBed: 175,
    box: { south: 41.6, north: 46.3, west: -88.1, east: -79.6 },
    seeds: [
      { lat: 44.0, lon: -87.0 },
      { lat: 44.75, lon: -82.25 },
      { lat: 45.25, lon: -81.0 },
    ],
    note: 'One water body joined at the Straits of Mackinac; surface ≈ 176 m. Includes Georgian Bay.',
  },
  {
    id: 'erie',
    name: 'Lake Erie',
    surface: 174,
    maxBed: 173,
    box: { south: 41.3, north: 42.95, west: -83.6, east: -78.8 },
    seeds: [{ lat: 42.25, lon: -81.0 }],
    note: 'Surface ≈ 174 m.',
  },
  {
    id: 'ontario',
    name: 'Lake Ontario',
    surface: 75,
    maxBed: 74,
    box: { south: 43.15, north: 44.3, west: -79.95, east: -75.9 },
    seeds: [{ lat: 43.6, lon: -77.75 }],
    note: 'Surface ≈ 75 m.',
  },
];

/**
 * Seas joined to the open ocean only through straits much narrower than the
 * 0.25° (≈ 28 km) grid spacing. In the point-sampled grid these straits are
 * "land", so without an extra seed each sea would look like a dry basin below
 * sea level. The open ocean itself is seeded from the deepest grid node.
 */
export interface SeaSeed {
  name: string;
  lat: number;
  lon: number;
  note: string;
}

export const EXTRA_SEA_SEEDS: SeaSeed[] = [
  { name: 'Black Sea, Sea of Marmara and Sea of Azov', lat: 43.0, lon: 34.0, note: 'Joined to the Mediterranean through the Bosporus and Dardanelles and to the Sea of Azov through the Kerch Strait, each only a few kilometres wide.' },
  { name: 'Lake Maracaibo', lat: 9.75, lon: -71.5, note: 'A brackish, tidal inlet joined to the Gulf of Venezuela by a narrow strait.' },
  { name: 'Strait of Georgia (Salish Sea)', lat: 49.25, lon: -123.75, note: 'Behind Vancouver Island; its connecting passages are narrower than the grid spacing.' },
  { name: 'Northern Strait of Georgia', lat: 49.75, lon: -124.75, note: 'As above.' },
  { name: 'Puget Sound', lat: 47.5, lon: -122.5, note: 'Joined to the Strait of Juan de Fuca through narrow channels.' },
  { name: 'Strait of Magellan', lat: -52.75, lon: -70.5, note: 'Narrow channels at the tip of South America.' },
  { name: 'Gulf of Corinth', lat: 38.25, lon: 22.5, note: 'Joined to the Ionian Sea through the ≈2 km Rio–Antirrio strait.' },
  { name: 'Seto Inland Sea', lat: 34.25, lon: 133.5, note: 'Parts are joined to the Pacific only through narrow straits.' },
];

/**
 * Approximate lat/lon rectangles around well-known low-lying areas. They are
 * NOT political or geological boundaries: each includes some higher ground and
 * sea, and only grid cells classified as present land inside the rectangle count.
 */
export interface InspectionRegion extends LatLonBox {
  id: string;
  name: string;
  short: string;
}

export const REGIONS: InspectionRegion[] = [
  { id: 'ganges', name: 'Ganges–Brahmaputra delta (Bangladesh, West Bengal)', short: 'Ganges delta', south: 21.5, north: 25.5, west: 88.0, east: 92.5 },
  { id: 'netherlands', name: 'Netherlands and adjacent North Sea coast', short: 'Netherlands', south: 50.75, north: 53.75, west: 3.25, east: 7.25 },
  { id: 'florida', name: 'Florida peninsula', short: 'Florida', south: 24.5, north: 30.75, west: -83.75, east: -79.75 },
  { id: 'nile', name: 'Nile delta', short: 'Nile delta', south: 30.0, north: 31.6, west: 29.75, east: 32.5 },
  { id: 'mekong', name: 'Mekong delta', short: 'Mekong delta', south: 8.5, north: 11.25, west: 104.5, east: 107.0 },
  { id: 'mississippi', name: 'Mississippi delta and Louisiana coast', short: 'Mississippi delta', south: 28.75, north: 31.0, west: -93.75, east: -88.75 },
  { id: 'amazon', name: 'Lower and central Amazon lowlands', short: 'Amazon lowlands', south: -4.5, north: 0.5, west: -67.0, east: -49.5 },
  { id: 'north-china', name: 'North China Plain', short: 'North China Plain', south: 34.0, north: 40.0, west: 114.0, east: 119.5 },
  { id: 'west-siberia', name: 'West Siberian Plain', short: 'West Siberia', south: 55.0, north: 67.0, west: 62.0, east: 86.0 },
];

/**
 * South of this latitude the ETOPO1 ice-surface grid records floating ice
 * shelves (e.g. the Ross and Ronne–Filchner shelves) as "land" a few metres
 * to ~100 m above sea level, indistinguishable here from grounded ice. Those
 * cells are excluded from all land and inundation totals.
 */
export const ANTARCTIC_CUTOFF_LAT = -60;

/** Cell classes. */
export const CLS_LAND = 0;
export const CLS_OCEAN = 1;
export const CLS_LAKE = 2;
export const CLS_EXCLUDED = 3;

export type GridMeta = Pick<ElevationMeta, 'lat0' | 'dlat' | 'lon0' | 'dlon'>;

export interface FloodPayload {
  /** Row-major elevations (m), row 0 = lat0. */
  data: ArrayLike<number>;
  ncols: number;
  nrows: number;
  meta: GridMeta;
  /** Override the main ocean seed (cell index). Defaults to the lowest non-lake cell. */
  seed?: number;
  /** Override the extra sea seeds (tests). */
  seaSeeds?: SeaSeed[];
  /** Override the inland water list (tests). */
  inlandWater?: InlandWaterBody[];
  /** Override the inspection regions (tests). */
  regions?: InspectionRegion[];
  /** Override the excluded polar cutoff (tests). Use -Infinity to assess every cell. */
  excludeSouthOf?: number;
}

export interface RegionProducts {
  id: string;
  /** Present land area inside the rectangle (km²). */
  landArea: number;
  landCells: number;
  connected: CumulativeCurve;
  any: CumulativeCurve;
}

export interface SeaLevelProducts {
  ncols: number;
  nrows: number;
  meta: GridMeta;
  /** Per cell: 0 land, 1 present ocean, 2 inland water (masked lake), 3 land south of the Antarctic cutoff. */
  cls: Uint8Array;
  /** Per cell: 0, or 1 + index into the inland water list. */
  lake: Uint8Array;
  /** Per cell flood level (m): −Infinity for present ocean; see flood.ts. */
  floodLevel: Float32Array;
  /** Area of one cell in each row (km²). */
  rowArea: Float64Array;
  seed: number;
  /** Assessed land cells: area below a sea level under each connectivity rule. */
  curves: { connected: CumulativeCurve; any: CumulativeCurve };
  regions: RegionProducts[];
  totals: {
    /** Sum of every node's area (km²): the sphere. */
    sphere: number;
    ocean: number;
    inlandWater: number;
    /** Present land outside the excluded polar cap (km²). */
    land: number;
    /** Land south of the Antarctic cutoff (km²), not assessed. */
    excluded: number;
    /** Present land below 0 m that is not connected to the ocean (km²). */
    landBelowSeaLevel: number;
    lakes: { id: string; area: number; cells: number }[];
  };
  inlandWater: InlandWaterBody[];
  seaSeeds: SeaSeed[];
  regionDefs: InspectionRegion[];
  computeMs: number;
}

export function cellIndex(meta: GridMeta, ncols: number, nrows: number, lat: number, lon: number): number {
  const row = Math.max(0, Math.min(nrows - 1, Math.round((lat - meta.lat0) / meta.dlat)));
  let col = Math.round((lon - meta.lon0) / meta.dlon) % ncols;
  if (col < 0) col += ncols;
  return row * ncols + col;
}

function inBox(b: LatLonBox, lat: number, lon: number): boolean {
  return lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Build every precomputed product. Cost: one priority flood plus a few sorts. */
export function buildSeaLevelProducts(input: FloodPayload): SeaLevelProducts {
  const t0 = now();
  const { ncols, nrows, meta, data } = input;
  const n = ncols * nrows;
  if (data.length !== n) throw new Error('Elevation grid has an unexpected size.');
  const g: GridShape = { ncols, nrows, wrap: true };
  const lat = (r: number) => meta.lat0 + r * meta.dlat;
  const lon = (c: number) => meta.lon0 + c * meta.dlon;
  const lakes = input.inlandWater ?? INLAND_WATER;
  const regionDefs = input.regions ?? REGIONS;
  const cutoff = input.excludeSouthOf ?? ANTARCTIC_CUTOFF_LAT;

  const rowArea = new Float64Array(nrows);
  const areaMeta = { meta: meta as ElevationMeta, nrows };
  for (let r = 0; r < nrows; r++) rowArea[r] = nodeAreaKm2(areaMeta, r);
  const areaOf = (cell: number) => rowArea[(cell / ncols) | 0];

  // 1. Inland water bodies with stored bathymetry (seeded region growing inside a box).
  // Growth may pass through cells already claimed by an earlier body (e.g. the
  // part of Kara-Bogaz-Gol that the Caspian mask reaches through its strait)
  // but only labels unclaimed cells.
  const lake = new Uint8Array(n);
  const visited = new Uint8Array(n);
  const nb = new Int32Array(8);
  lakes.forEach((w, k) => {
    visited.fill(0);
    const stack: number[] = [];
    for (const s of w.seeds) {
      const i = cellIndex(meta, ncols, nrows, s.lat, s.lon);
      if (!visited[i] && data[i] <= w.maxBed) {
        visited[i] = 1;
        if (!lake[i]) lake[i] = k + 1;
        stack.push(i);
      }
    }
    while (stack.length) {
      const c = stack.pop()!;
      const m = neighbours(c, g, nb);
      for (let q = 0; q < m; q++) {
        const j = nb[q];
        if (visited[j] || data[j] > w.maxBed) continue;
        const r = (j / ncols) | 0;
        if (!inBox(w.box, lat(r), lon(j - r * ncols))) continue;
        visited[j] = 1;
        if (!lake[j]) lake[j] = k + 1;
        stack.push(j);
      }
    }
  });

  // 2. Effective elevation: lake cells sit at their water surface.
  const elevEff = new Float32Array(n);
  for (let i = 0; i < n; i++) elevEff[i] = lake[i] ? lakes[lake[i] - 1].surface : data[i];

  // 3. Present ocean, connected to the deepest non-lake cell (or a given seed)
  //    or to one of the documented narrow-strait seas.
  const seed = input.seed ?? lowestCell(data, lake);
  const seaSeeds = input.seaSeeds ?? EXTRA_SEA_SEEDS;
  const ocean = presentOcean(data, g, [seed, ...seaSeeds.map((s) => cellIndex(meta, ncols, nrows, s.lat, s.lon))], lake);

  // 4. Flood levels (Priority-Flood from the whole ocean shoreline).
  const floodLevel = floodLevels(elevEff, g, ocean);

  // 5. Classes and accounting.
  const cls = new Uint8Array(n);
  let sphere = 0;
  let oceanArea = 0;
  let lakeArea = 0;
  let landArea = 0;
  let excluded = 0;
  let landBelowSeaLevel = 0;
  const lakeTotals = lakes.map((w) => ({ id: w.id, area: 0, cells: 0 }));
  const landCells: number[] = [];
  for (let r = 0; r < nrows; r++) {
    const a = rowArea[r];
    const south = lat(r) < cutoff;
    for (let c = 0; c < ncols; c++) {
      const i = r * ncols + c;
      sphere += a;
      if (ocean[i]) {
        cls[i] = CLS_OCEAN;
        oceanArea += a;
      } else if (lake[i]) {
        cls[i] = CLS_LAKE;
        lakeArea += a;
        lakeTotals[lake[i] - 1].area += a;
        lakeTotals[lake[i] - 1].cells++;
      } else if (south) {
        cls[i] = CLS_EXCLUDED;
        excluded += a;
      } else {
        cls[i] = CLS_LAND;
        landArea += a;
        landCells.push(i);
        if (data[i] < 0) landBelowSeaLevel += a;
      }
    }
  }

  // 6. Cumulative curves: area below a level under each rule.
  const land = Int32Array.from(landCells);
  const curves = {
    connected: buildCurve(land, floodLevel, areaOf),
    any: buildCurve(land, data, areaOf),
  };
  const regions: RegionProducts[] = regionDefs.map((reg) => {
    const cells: number[] = [];
    for (let k = 0; k < land.length; k++) {
      const i = land[k];
      const r = (i / ncols) | 0;
      if (inBox(reg, lat(r), lon(i - r * ncols))) cells.push(i);
    }
    const arr = Int32Array.from(cells);
    const connected = buildCurve(arr, floodLevel, areaOf);
    return { id: reg.id, landArea: connected.total, landCells: arr.length, connected, any: buildCurve(arr, data, areaOf) };
  });

  return {
    ncols,
    nrows,
    meta: { lat0: meta.lat0, dlat: meta.dlat, lon0: meta.lon0, dlon: meta.dlon },
    cls,
    lake,
    floodLevel,
    rowArea,
    seed,
    curves,
    regions,
    totals: { sphere, ocean: oceanArea, inlandWater: lakeArea, land: landArea, excluded, landBelowSeaLevel, lakes: lakeTotals },
    inlandWater: lakes,
    seaSeeds,
    regionDefs,
    computeMs: now() - t0,
  };
}

export type ConnectivityRule = 'connected' | 'any';

/** Newly inundated land area (km²) at sea level L under a rule. */
export function inundatedArea(p: SeaLevelProducts, L: number, rule: ConnectivityRule): number {
  return areaBelow(rule === 'any' ? p.curves.any : p.curves.connected, L);
}

export function regionInundatedArea(r: RegionProducts, L: number, rule: ConnectivityRule): number {
  return areaBelow(rule === 'any' ? r.any : r.connected, L);
}
