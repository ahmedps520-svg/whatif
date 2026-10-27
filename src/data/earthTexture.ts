/**
 * Earth surface texture from elevation, for globes and flat maps.
 *
 * `renderEarthTexture` turns the NOAA ETOPO1 grid (see ./elevation.ts) into an
 * equirectangular RGBA image for a chosen sea level. The colouring is
 * ILLUSTRATIVE and derived from elevation only — it is not land cover: green
 * does not mean vegetation, tan does not mean desert, and the ice tint is a
 * simple latitude/elevation rule (Antarctica south of 60°S, Greenland above
 * 1000 m), not mapped glaciers. Say so wherever the texture is shown.
 *
 * Image layout: row 0 is 90°N, column 0 starts at 180°W, pixel centres at
 * ((i + ½)·360/W − 180, 90 − (j + ½)·180/H). With three.js, wrap it in a
 * CanvasTexture (flipY = true, the default) and it maps directly onto a
 * SphereGeometry: longitude 0° lands on +X, 90°E on −Z, north pole on +Y.
 *
 * The module is pure except for the thin canvas helpers at the end, so the
 * colouring can run in tests or a worker.
 */
import type { ElevationGrid } from './elevation';

export type RGB = readonly [number, number, number];

/** How to draw areas below the chosen sea level. */
export type WaterAppearance = 'liquid' | 'ice' | 'none';

export interface EarthTextureOptions {
  /** Output width in pixels (height = width / 2). Default: the grid's column count, capped at 2048. */
  width?: number;
  /** Sea level relative to present mean sea level (m). Default 0. */
  seaLevel?: number;
  /**
   * 'liquid' (default) draws water by depth; 'ice' draws it as frozen sea;
   * 'none' draws empty, dry ocean basins.
   */
  water?: WaterAppearance;
  /** Pale ice tint for Antarctica (south of 60°S) and high Greenland. Default true. */
  iceSheets?: boolean;
  /** Subtle relief shading from the elevation gradient (light from the north-west). Default true. */
  hillshade?: boolean;
  /**
   * If set, land that is above present sea level but below the chosen one is
   * painted with this colour instead of as water (e.g. to highlight flooding).
   */
  floodColor?: RGB | null;
}

export interface RGBAImage {
  width: number;
  height: number;
  /** Row-major RGBA bytes, row 0 = north. */
  data: Uint8ClampedArray<ArrayBuffer>;
}

/** Largest texture width produced (mobile GPUs handle 2048 reliably). */
export const MAX_TEXTURE_WIDTH = 2048;

type Stop = readonly [number, RGB];

/** Water by depth below the chosen sea level (m): light shelf blue → dark navy. */
const OCEAN: readonly Stop[] = [
  [0, [64, 120, 158]],
  [150, [46, 98, 140]],
  [1000, [28, 70, 114]],
  [4000, [15, 45, 84]],
  [8000, [8, 25, 54]],
];
/** Land by height above the chosen sea level (m): muted green-olive → tan → grey. */
const LAND: readonly Stop[] = [
  [0, [96, 112, 72]],
  [400, [118, 124, 82]],
  [1000, [148, 137, 98]],
  [2000, [158, 141, 113]],
  [3500, [142, 134, 127]],
  [5000, [178, 177, 175]],
];
const FROZEN_SEA: readonly Stop[] = [
  [0, [200, 214, 226]],
  [4000, [170, 188, 206]],
];
const DRY_BASIN: readonly Stop[] = [
  [0, [114, 102, 88]],
  [4000, [80, 72, 64]],
  [8000, [60, 54, 50]],
];
const ICE_SHEET: RGB = [222, 230, 236];
const SEAFLOOR_GREY: RGB = [122, 116, 108];

function ramp(stops: readonly Stop[], x: number): [number, number, number] {
  if (x <= stops[0][0]) return [...stops[0][1]];
  for (let k = 1; k < stops.length; k++) {
    const [x1, c1] = stops[k];
    if (x <= x1) {
      const [x0, c0] = stops[k - 1];
      const f = (x - x0) / (x1 - x0);
      return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f];
    }
  }
  return [...stops[stops.length - 1][1]];
}

function mix(a: readonly number[], b: RGB, f: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/** Simple ice-sheet rule (approximate; not mapped glacier outlines). */
export function isIceSheet(lat: number, lon: number, elevation: number): boolean {
  if (elevation < 0) return false;
  if (lat < -60) return true;
  return lat > 59.5 && lon > -74 && lon < -10 && elevation >= 1000;
}

/**
 * Colour (0–255 floats) for one point, before relief shading. `kind` says which
 * class it fell into so callers can decide whether to shade it.
 */
export function elevationColor(
  elevation: number,
  lat: number,
  lon: number,
  opts: Pick<EarthTextureOptions, 'seaLevel' | 'water' | 'iceSheets' | 'floodColor'> = {},
): { rgb: [number, number, number]; kind: 'water' | 'land' | 'ice' | 'basin' } {
  const sea = opts.seaLevel ?? 0;
  const water = opts.water ?? 'liquid';
  const depth = sea - elevation;
  if (depth > 0) {
    if (water === 'none') return { rgb: ramp(DRY_BASIN, depth), kind: 'basin' };
    if (opts.floodColor && elevation >= 0) return { rgb: [...opts.floodColor], kind: 'water' };
    return { rgb: ramp(water === 'ice' ? FROZEN_SEA : OCEAN, depth), kind: 'water' };
  }
  if ((opts.iceSheets ?? true) && isIceSheet(lat, lon, elevation)) return { rgb: [...ICE_SHEET], kind: 'ice' };
  const land = ramp(LAND, elevation - sea);
  // Exposed former sea floor (below present sea level, above the chosen one).
  return { rgb: elevation < 0 ? mix(land, SEAFLOOR_GREY, 0.45) : land, kind: 'land' };
}

type GridLike = Pick<ElevationGrid, 'meta' | 'ncols' | 'nrows' | 'data'>;

/** Render the equirectangular RGBA texture. Pure: no DOM access. */
export function renderEarthTexture(grid: GridLike, opts: EarthTextureOptions = {}): RGBAImage {
  const width = Math.max(16, Math.min(MAX_TEXTURE_WIDTH, Math.round(opts.width ?? Math.min(grid.ncols, MAX_TEXTURE_WIDTH))));
  const height = Math.max(8, Math.round(width / 2));
  const out = new Uint8ClampedArray(width * height * 4);
  const { ncols, nrows, data } = grid;
  const { lat0, dlat, lon0, dlon } = grid.meta;
  const shadeOn = opts.hillshade ?? true;
  const colorOpts = { seaLevel: opts.seaLevel ?? 0, water: opts.water ?? 'liquid', iceSheets: opts.iceSheets ?? true, floodColor: opts.floodColor ?? null };
  const R = 6371008.8; // m
  const dy = Math.abs(dlat) * (Math.PI / 180) * R;
  const northStep = dlat < 0 ? -1 : 1; // row offset toward north
  const at = (r: number, c: number) => {
    const rr = r < 0 ? 0 : r >= nrows ? nrows - 1 : r;
    let cc = c % ncols;
    if (cc < 0) cc += ncols;
    return data[rr * ncols + cc];
  };

  for (let j = 0; j < height; j++) {
    const lat = 90 - ((j + 0.5) * 180) / height;
    let fr = (lat - lat0) / dlat;
    if (fr < 0) fr = 0;
    if (fr > nrows - 1) fr = nrows - 1;
    const r0 = Math.floor(fr);
    const r1 = Math.min(r0 + 1, nrows - 1);
    const wr = fr - r0;
    const rn = Math.round(fr);
    const dx = Math.max(0.05, Math.cos((lat * Math.PI) / 180)) * Math.abs(dlon) * (Math.PI / 180) * R;
    for (let i = 0; i < width; i++) {
      const lon = ((i + 0.5) * 360) / width - 180;
      let fc = (lon - lon0) / dlon;
      fc = ((fc % ncols) + ncols) % ncols;
      const c0 = Math.floor(fc);
      const c1 = (c0 + 1) % ncols;
      const wc = fc - c0;
      const e =
        (at(r0, c0) * (1 - wc) + at(r0, c1) * wc) * (1 - wr) + (at(r1, c0) * (1 - wc) + at(r1, c1) * wc) * wr;
      const { rgb, kind } = elevationColor(e, lat, lon, colorOpts);
      let shade = 1;
      if (shadeOn && kind !== 'water') {
        const cn = Math.round(fc);
        const gx = (at(rn, cn + 1) - at(rn, cn - 1)) / (2 * dx);
        const gy = (at(rn + northStep, cn) - at(rn - northStep, cn)) / (2 * dy);
        // Lambert-like shading with light from the north-west.
        const k = kind === 'ice' ? 2.5 : 5;
        shade = Math.max(0.72, Math.min(1.28, 1 + k * (gx - gy)));
      }
      const o = (j * width + i) * 4;
      out[o] = rgb[0] * shade;
      out[o + 1] = rgb[1] * shade;
      out[o + 2] = rgb[2] * shade;
      out[o + 3] = 255;
    }
  }
  return { width, height, data: out };
}

function hex(c: readonly number[]): string {
  return '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
}

export interface LegendEntry {
  key: 'deep' | 'shelf' | 'lowland' | 'upland' | 'high' | 'ice' | 'seafloor' | 'frozen' | 'dry';
  label: string;
  color: string;
}

/** Legend swatches matching the texture colours. */
export const EARTH_TEXTURE_LEGEND: readonly LegendEntry[] = [
  { key: 'deep', label: 'Deep ocean (4 km+)', color: hex(ramp(OCEAN, 4000)) },
  { key: 'shelf', label: 'Shallow sea (< 150 m)', color: hex(ramp(OCEAN, 60)) },
  { key: 'lowland', label: 'Lowland (0–400 m)', color: hex(ramp(LAND, 200)) },
  { key: 'upland', label: 'Upland (1–2 km)', color: hex(ramp(LAND, 1500)) },
  { key: 'high', label: 'High mountains (3.5 km+)', color: hex(ramp(LAND, 4200)) },
  { key: 'ice', label: 'Ice sheet (approximate rule)', color: hex(ICE_SHEET) },
  { key: 'seafloor', label: 'Exposed former sea floor', color: hex(mix(ramp(LAND, 200), SEAFLOOR_GREY, 0.45)) },
  { key: 'frozen', label: 'Frozen sea', color: hex(ramp(FROZEN_SEA, 2000)) },
  { key: 'dry', label: 'Dry ocean basin', color: hex(ramp(DRY_BASIN, 2000)) },
];

/** Legend entries relevant to a set of options. */
export function earthTextureLegend(opts: Pick<EarthTextureOptions, 'seaLevel' | 'water' | 'iceSheets'> = {}): LegendEntry[] {
  const water = opts.water ?? 'liquid';
  const keys = new Set<LegendEntry['key']>(['lowland', 'upland', 'high']);
  if (water === 'liquid') keys.add('deep').add('shelf');
  if (water === 'ice') keys.add('frozen');
  if (water === 'none') keys.add('dry');
  if (opts.iceSheets ?? true) keys.add('ice');
  if (water !== 'none' && (opts.seaLevel ?? 0) < 0) keys.add('seafloor');
  return EARTH_TEXTURE_LEGEND.filter((e) => keys.has(e.key));
}

// ---------------------------------------------------------------------------
// Thin canvas helpers (browser only)
// ---------------------------------------------------------------------------

/** Copy an RGBA image into a (new or given) canvas. */
export function imageToCanvas(img: RGBAImage, canvas?: HTMLCanvasElement): HTMLCanvasElement {
  const c = canvas ?? document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D canvas is unavailable.');
  ctx.putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
  return c;
}

/** Render the texture straight into a canvas (e.g. for THREE.CanvasTexture). */
export function earthTextureCanvas(grid: GridLike, opts: EarthTextureOptions = {}, canvas?: HTMLCanvasElement): HTMLCanvasElement {
  return imageToCanvas(renderEarthTexture(grid, opts), canvas);
}
