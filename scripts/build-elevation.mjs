// Builds the elevation grid used by the Sea Level and Planet Lab experiments.
//
// Source: NOAA ETOPO1 Global Relief Model (Ice Surface, grid-registered),
// served by NOAA CoastWatch ERDDAP (dataset id "etopo180").
// We take every 15th 1-arc-minute node (a 0.25 degree point sample, NOT an
// area average) and store it as little-endian Int16 metres, gzip-compressed.
//
// Usage:
//   node scripts/build-elevation.mjs                 # download from ERDDAP
//   node scripts/build-elevation.mjs path/to/file.asc  # use a local ESRI ASCII grid
import { gzipSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'public', 'data');
const SOURCE_URL =
  'https://coastwatch.pfeg.noaa.gov/erddap/griddap/etopo180.esriAscii?altitude%5B(-90):15:(90)%5D%5B(-180):15:(180)%5D';

async function loadAscii() {
  const local = process.argv[2];
  if (local) return readFileSync(local, 'utf8');
  console.log('Downloading', SOURCE_URL);
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`ERDDAP request failed: ${res.status}`);
  return await res.text();
}

const text = await loadAscii();
const lines = text.split(/\r?\n/);
const header = {};
let i = 0;
for (; i < 6; i++) {
  const [k, v] = lines[i].trim().split(/\s+/);
  header[k.toLowerCase()] = Number(v);
}
const ncolsIn = header.ncols;
const nrows = header.nrows;
if (ncolsIn !== 1441 || nrows !== 721 || header.cellsize !== 0.25) {
  throw new Error(`Unexpected grid header ${JSON.stringify(header)}`);
}
// ESRI ASCII rows run north to south. The last column (lon = +180) duplicates
// lon = -180, so it is dropped to give a seamless 1440-column wrap.
const ncols = 1440;
const grid = new Int16Array(ncols * nrows);
let min = Infinity;
let max = -Infinity;
for (let r = 0; r < nrows; r++) {
  const vals = lines[i + r].trim().split(/\s+/);
  if (vals.length !== ncolsIn) throw new Error(`Row ${r} has ${vals.length} values`);
  for (let c = 0; c < ncols; c++) {
    const v = Number(vals[c]);
    if (!Number.isFinite(v) || v === header.nodata_value) throw new Error(`Missing value at ${r},${c}`);
    grid[r * ncols + c] = v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
}

mkdirSync(outDir, { recursive: true });
const bytes = Buffer.from(grid.buffer);
writeFileSync(join(outDir, 'etopo1-025.i16.gz'), gzipSync(bytes, { level: 9 }));
const meta = {
  file: 'etopo1-025.i16.gz',
  format: 'gzip-compressed little-endian Int16, metres relative to mean sea level, row-major',
  ncols,
  nrows,
  lat0: 90,
  dlat: -0.25,
  lon0: -180,
  dlon: 0.25,
  min,
  max,
  sampling: 'Point sample of every 15th 1-arc-minute node (0.25 degree spacing); values are not area averages.',
  dataset: 'ETOPO1 Global Relief Model, Ice Surface, grid-registered (NOAA NGDC/NCEI)',
  citation:
    'Amante, C. and B. W. Eakins, 2009. ETOPO1 1 Arc-Minute Global Relief Model: Procedures, Data Sources and Analysis. NOAA Technical Memorandum NESDIS NGDC-24.',
  distributor: 'NOAA CoastWatch ERDDAP, dataset etopo180',
  sourceUrl: SOURCE_URL,
  license:
    'NOAA data; may be used and redistributed for free. Not intended for legal use and provided without warranty (see dataset licence text).',
  retrieved: new Date().toISOString().slice(0, 10),
};
writeFileSync(join(outDir, 'etopo1-025.json'), JSON.stringify(meta, null, 2) + '\n');
console.log(`Wrote ${ncols}x${nrows} grid (min ${min} m, max ${max} m), ${bytes.length} bytes raw`);
