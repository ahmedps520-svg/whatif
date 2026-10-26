/**
 * Loader for the bundled NOAA ETOPO1 0.25° elevation grid (see
 * scripts/build-elevation.mjs and public/data/etopo1-025.json).
 */
import type { DataSource } from '../engine/types';

export interface ElevationMeta {
  file: string;
  ncols: number;
  nrows: number;
  lat0: number;
  dlat: number;
  lon0: number;
  dlon: number;
  min: number;
  max: number;
  sampling: string;
  dataset: string;
  citation: string;
  distributor: string;
  sourceUrl: string;
  license: string;
  retrieved: string;
}

export interface ElevationGrid {
  meta: ElevationMeta;
  ncols: number;
  nrows: number;
  /** Row-major metres, row 0 = latitude 90°N, column 0 = longitude 180°W. */
  data: Int16Array;
}

export const ETOPO_SOURCE: DataSource = {
  name: 'ETOPO1 Global Relief Model (Ice Surface), sampled every 0.25°',
  provider: 'NOAA National Centers for Environmental Information (formerly NGDC), via NOAA CoastWatch ERDDAP',
  citation:
    'Amante, C. and B. W. Eakins, 2009. ETOPO1 1 Arc-Minute Global Relief Model: Procedures, Data Sources and Analysis. NOAA Technical Memorandum NESDIS NGDC-24.',
  url: 'https://www.ngdc.noaa.gov/mgg/global/global.html',
  license: 'NOAA data, free to use and redistribute; not intended for legal use and provided without warranty.',
  notes:
    'Point samples (not area averages) of the 1-arc-minute grid. Elevations are relative to mean sea level; the Antarctic and Greenland values are the top of the ice.',
};

let dataBase: string | null = null;

/**
 * Base URL of the app (where /data lives). Defaults to the page's base URI.
 * The background worker receives it from the main thread, because a worker's
 * own location points at the bundled script, not the app root.
 */
export function setDataBase(url: string) {
  dataBase = url;
}

export function getDataBase(): string {
  if (dataBase) return dataBase;
  if (typeof document !== 'undefined') return document.baseURI;
  throw new Error('Data base URL is not set in this context.');
}

function dataUrl(file: string): string {
  return new URL(`data/${file}`, getDataBase()).toString();
}

async function gunzipIfNeeded(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const head = new Uint8Array(buf, 0, 2);
  if (head[0] !== 0x1f || head[1] !== 0x8b) return buf; // already decoded by the server
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot decompress the elevation dataset (DecompressionStream is unavailable).');
  }
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return await new Response(stream).arrayBuffer();
}

let cached: Promise<ElevationGrid> | null = null;

/** Load (once) and decode the elevation grid. */
export function loadElevation(): Promise<ElevationGrid> {
  if (!cached) {
    cached = (async () => {
      const metaRes = await fetch(dataUrl('etopo1-025.json'));
      if (!metaRes.ok) throw new Error(`Could not load elevation metadata (${metaRes.status}).`);
      const meta = (await metaRes.json()) as ElevationMeta;
      const res = await fetch(dataUrl(meta.file));
      if (!res.ok) throw new Error(`Could not load elevation data (${res.status}).`);
      const raw = await gunzipIfNeeded(await res.arrayBuffer());
      const data = new Int16Array(raw);
      if (data.length !== meta.ncols * meta.nrows) throw new Error('Elevation data has an unexpected size.');
      return { meta, ncols: meta.ncols, nrows: meta.nrows, data };
    })();
    cached.catch(() => {
      cached = null; // allow a retry after a failure
    });
  }
  return cached;
}

export function rowLat(g: Pick<ElevationGrid, 'meta'>, row: number): number {
  return g.meta.lat0 + row * g.meta.dlat;
}

export function colLon(g: Pick<ElevationGrid, 'meta'>, col: number): number {
  return g.meta.lon0 + col * g.meta.dlon;
}

/** Nearest grid sample for a latitude/longitude in degrees. */
export function elevationAt(g: ElevationGrid, lat: number, lon: number): number {
  const row = Math.round((lat - g.meta.lat0) / g.meta.dlat);
  let col = Math.round((lon - g.meta.lon0) / g.meta.dlon) % g.ncols;
  if (col < 0) col += g.ncols;
  const r = Math.max(0, Math.min(g.nrows - 1, row));
  return g.data[r * g.ncols + col];
}

const R_EARTH_KM = 6371.0088;

/**
 * Surface area (km²) represented by one grid node in a row, on a sphere of
 * mean Earth radius. Nodes are grid-registered, so polar rows cover half-cells.
 */
export function nodeAreaKm2(g: Pick<ElevationGrid, 'meta' | 'nrows'>, row: number): number {
  const lat = rowLat(g, row);
  const half = Math.abs(g.meta.dlat) / 2;
  const top = Math.min(90, lat + half);
  const bottom = Math.max(-90, lat - half);
  const dLon = (Math.abs(g.meta.dlon) * Math.PI) / 180;
  return R_EARTH_KM * R_EARTH_KM * dLon * (Math.sin((top * Math.PI) / 180) - Math.sin((bottom * Math.PI) / 180));
}
