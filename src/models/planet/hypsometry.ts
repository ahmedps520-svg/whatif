/**
 * Hypsometry: how Earth's surface area is distributed with elevation.
 *
 * Used by the Planet Lab to turn "water covers X % of the surface" into "sea
 * level would sit Z metres above/below today's" on Earth's real terrain (NOAA
 * ETOPO1, ice surface). Pure functions with no I/O, so they can be tested on a
 * synthetic grid.
 */

export interface Hypsometry {
  /** Lowest elevation in the grid (m). Bin i covers elevations [minElev + i, minElev + i + 1). */
  minElev: number;
  /**
   * cumulative[i] = fraction of the total area whose elevation is below
   * minElev + i. Length = number of 1 m bins + 1; starts at 0 and ends at 1.
   */
  cumulative: Float64Array;
  /** Total area represented by the grid (km² when built with nodeAreaKm2). */
  totalArea: number;
}

/**
 * Build the area-weighted cumulative elevation distribution of a row-major
 * integer elevation grid. `rowArea(row)` gives the area each node in a row
 * represents (e.g. `nodeAreaKm2` from src/data/elevation.ts), which accounts
 * for meridians converging toward the poles.
 */
export function buildHypsometry(data: Int16Array, ncols: number, nrows: number, rowArea: (row: number) => number): Hypsometry {
  if (data.length !== ncols * nrows) throw new Error('Grid size does not match ncols × nrows.');
  if (data.length === 0) throw new Error('Empty elevation grid.');
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const bins = max - min + 1;
  const hist = new Float64Array(bins);
  let total = 0;
  for (let r = 0; r < nrows; r++) {
    const a = rowArea(r);
    if (!(a > 0)) continue;
    const base = r * ncols;
    for (let c = 0; c < ncols; c++) hist[data[base + c] - min] += a;
    total += a * ncols;
  }
  if (!(total > 0)) throw new Error('Elevation grid has no area.');
  const cumulative = new Float64Array(bins + 1);
  let run = 0;
  for (let i = 0; i < bins; i++) {
    run += hist[i];
    cumulative[i + 1] = run / total;
  }
  cumulative[bins] = 1;
  return { minElev: min, cumulative, totalArea: total };
}

/**
 * Fraction of the surface below elevation z (m), i.e. the area an ocean with
 * its surface at z would cover if every low-lying area were flooded. Integer
 * elevations are spread uniformly over their 1 m bin, so the curve is
 * continuous and exact at whole metres.
 */
export function waterFractionAtSeaLevel(h: Hypsometry, z: number): number {
  const n = h.cumulative.length - 1;
  const x = z - h.minElev;
  if (!(x > 0)) return 0;
  if (x >= n) return 1;
  const i = Math.floor(x);
  const f = x - i;
  return h.cumulative[i] + f * (h.cumulative[i + 1] - h.cumulative[i]);
}

/**
 * Inverse of waterFractionAtSeaLevel: the lowest sea level z (m, relative to
 * the grid's datum) at which the given fraction (0–1) of the area is below z.
 * fraction 0 returns the deepest point; fraction 1 returns the top of the
 * highest bin.
 */
export function seaLevelForWaterFraction(h: Hypsometry, fraction: number): number {
  const n = h.cumulative.length - 1;
  if (!Number.isFinite(fraction)) return NaN;
  if (fraction <= 0) return h.minElev;
  if (fraction >= 1) return h.minElev + n;
  // First bin edge whose cumulative value reaches the fraction.
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (h.cumulative[mid] < fraction) lo = mid + 1;
    else hi = mid;
  }
  // cumulative[lo] >= fraction > cumulative[lo - 1]; interpolate within bin lo - 1.
  const i = Math.max(0, lo - 1);
  const a = h.cumulative[i];
  const b = h.cumulative[i + 1];
  const f = b > a ? (fraction - a) / (b - a) : 0;
  return h.minElev + i + f;
}
