/**
 * Hydrological-connectivity ("bathtub with connectivity") flood fill on a
 * regular longitude–latitude grid. Pure functions, no DOM: used by the model,
 * the background compute task and the tests.
 *
 * Definitions
 * - Present ocean: cells with elevation < 0 that are connected (8-neighbour,
 *   longitude wraps around) to a seed cell in the open ocean.
 * - Flood level of a non-ocean cell: the lowest sea level at which sea water
 *   can reach it, i.e. the minimum over all paths from the present ocean of
 *   the highest elevation met along the path (the minimax or "spill"
 *   elevation). It is never below the cell's own elevation.
 * - Boundary convention: a cell is inundated at sea level L (metres relative
 *   to present mean sea level) if and only if floodLevel < L. A cell exactly
 *   at the spill elevation is therefore still dry; water must rise above it.
 *
 * The flood levels are computed with the Priority-Flood algorithm of Barnes,
 * Lehman & Mulla (2014), "Priority-Flood: An optimal depression-filling and
 * watershed-labeling algorithm for digital elevation models", Computers &
 * Geosciences 62, 117–127 — a binary min-heap seeded with the ocean shoreline,
 * plus a plain FIFO queue for cells inside depressions (their Algorithm 2).
 * Each cell is queued once, so the cost is O(n log n).
 */

/** Binary min-heap of cell indices keyed by a float priority. */
export class MinHeap {
  private idx: Int32Array;
  private key: Float64Array;
  size = 0;

  constructor(capacity: number) {
    this.idx = new Int32Array(Math.max(1, capacity));
    this.key = new Float64Array(Math.max(1, capacity));
  }

  push(i: number, k: number) {
    if (this.size === this.idx.length) this.grow();
    let pos = this.size++;
    const idx = this.idx;
    const key = this.key;
    while (pos > 0) {
      const parent = (pos - 1) >> 1;
      if (key[parent] <= k) break;
      idx[pos] = idx[parent];
      key[pos] = key[parent];
      pos = parent;
    }
    idx[pos] = i;
    key[pos] = k;
  }

  /** Remove and return the index with the smallest key. Caller checks size > 0. */
  pop(): number {
    const idx = this.idx;
    const key = this.key;
    const top = idx[0];
    const n = --this.size;
    if (n > 0) {
      const li = idx[n];
      const lk = key[n];
      let pos = 0;
      for (;;) {
        let child = 2 * pos + 1;
        if (child >= n) break;
        if (child + 1 < n && key[child + 1] < key[child]) child++;
        if (key[child] >= lk) break;
        idx[pos] = idx[child];
        key[pos] = key[child];
        pos = child;
      }
      idx[pos] = li;
      key[pos] = lk;
    }
    return top;
  }

  peekKey(): number {
    return this.key[0];
  }

  private grow() {
    const ni = new Int32Array(this.idx.length * 2);
    ni.set(this.idx);
    const nk = new Float64Array(this.key.length * 2);
    nk.set(this.key);
    this.idx = ni;
    this.key = nk;
  }
}

export interface GridShape {
  ncols: number;
  nrows: number;
  /** Longitude wraps (column 0 neighbours the last column). Default true. */
  wrap?: boolean;
}

/**
 * Write the 8-neighbour indices of cell i into `out` and return their count.
 * Columns wrap when `wrap` is set; rows do not wrap across the poles.
 */
export function neighbours(i: number, g: GridShape, out: Int32Array): number {
  const { ncols, nrows } = g;
  const wrap = g.wrap !== false;
  const r = (i / ncols) | 0;
  const c = i - r * ncols;
  let n = 0;
  for (let dr = -1; dr <= 1; dr++) {
    const rr = r + dr;
    if (rr < 0 || rr >= nrows) continue;
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      let cc = c + dc;
      if (cc < 0 || cc >= ncols) {
        if (!wrap) continue;
        cc = (cc + ncols) % ncols;
      }
      const j = rr * ncols + cc;
      if (j === i) continue;
      // With very narrow wrapped grids two offsets can land on the same cell.
      let dup = false;
      for (let k = 0; k < n; k++) if (out[k] === j) dup = true;
      if (!dup) out[n++] = j;
    }
  }
  return n;
}

/** Index of the lowest cell (ties: first), skipping blocked cells. */
export function lowestCell(elev: ArrayLike<number>, blocked?: Uint8Array): number {
  let best = -1;
  let bv = Infinity;
  for (let i = 0; i < elev.length; i++) {
    if (blocked && blocked[i]) continue;
    if (elev[i] < bv) {
      bv = elev[i];
      best = i;
    }
  }
  return best;
}

/**
 * Present-day ocean: cells with elevation < 0 connected to one of the `seeds`
 * through other such cells. Seeds that are not below 0 are ignored. Cells
 * flagged in `blocked` (e.g. inland lakes) are never ocean. Returns 1 for
 * ocean, 0 otherwise.
 */
export function presentOcean(elev: ArrayLike<number>, g: GridShape, seeds: number | number[], blocked?: Uint8Array): Uint8Array {
  const n = g.ncols * g.nrows;
  const ocean = new Uint8Array(n);
  const stack = new Int32Array(n);
  const nb = new Int32Array(8);
  let top = 0;
  for (const seed of Array.isArray(seeds) ? seeds : [seeds]) {
    if (seed < 0 || seed >= n || ocean[seed] || !(elev[seed] < 0) || (blocked && blocked[seed])) continue;
    stack[top++] = seed;
    ocean[seed] = 1;
  }
  while (top > 0) {
    const c = stack[--top];
    const k = neighbours(c, g, nb);
    for (let q = 0; q < k; q++) {
      const j = nb[q];
      if (ocean[j] || !(elev[j] < 0) || (blocked && blocked[j])) continue;
      ocean[j] = 1;
      stack[top++] = j;
    }
  }
  return ocean;
}

/**
 * Flood level of every cell: −Infinity for present-ocean cells, otherwise the
 * minimax elevation along the best path from the ocean (≥ the cell's own
 * elevation). Cells that the ocean cannot reach at all (no ocean on the grid)
 * get +Infinity.
 */
export function floodLevels(elev: ArrayLike<number>, g: GridShape, ocean: Uint8Array): Float32Array {
  const n = g.ncols * g.nrows;
  const level = new Float32Array(n).fill(Infinity);
  const closed = new Uint8Array(n);
  const heap = new MinHeap(Math.min(n, 1 << 16));
  const pit = new Int32Array(n);
  let pitHead = 0;
  let pitTail = 0;
  const nb = new Int32Array(8);

  for (let i = 0; i < n; i++) {
    if (ocean[i]) {
      closed[i] = 1;
      level[i] = -Infinity;
    }
  }
  // Seed the queue with the shoreline: non-ocean neighbours of ocean cells.
  for (let i = 0; i < n; i++) {
    if (!ocean[i]) continue;
    const k = neighbours(i, g, nb);
    for (let q = 0; q < k; q++) {
      const j = nb[q];
      if (closed[j]) continue;
      closed[j] = 1;
      level[j] = elev[j];
      heap.push(j, elev[j]);
    }
  }
  while (pitHead < pitTail || heap.size > 0) {
    const c = pitHead < pitTail ? pit[pitHead++] : heap.pop();
    const lc = level[c];
    const k = neighbours(c, g, nb);
    for (let q = 0; q < k; q++) {
      const j = nb[q];
      if (closed[j]) continue;
      closed[j] = 1;
      const ej = elev[j];
      if (ej <= lc) {
        // Inside a depression: water reaching c at level lc also reaches j.
        level[j] = lc;
        pit[pitTail++] = j;
      } else {
        level[j] = ej;
        heap.push(j, ej);
      }
    }
  }
  return level;
}

/** Inundation rule at sea level L (strict: the water must rise above the spill level). */
export function isInundated(floodLevel: number, seaLevel: number): boolean {
  return floodLevel < seaLevel;
}

/**
 * Area-weighted cumulative distribution of a per-cell value, compressed to the
 * distinct values. `areaBelow(curve, L)` is the total area of cells whose value
 * is strictly below L — O(log u) for u distinct values.
 */
export interface CumulativeCurve {
  /** Distinct values in ascending order. */
  values: Float64Array;
  /** cum[k] = total area of cells with value ≤ values[k]. */
  cum: Float64Array;
  /** Total area of all cells included in the curve. */
  total: number;
}

export function buildCurve(cells: Int32Array, value: ArrayLike<number>, areaOf: (cell: number) => number): CumulativeCurve {
  const order = Int32Array.from(cells);
  order.sort((a, b) => value[a] - value[b]);
  const values: number[] = [];
  const cum: number[] = [];
  let acc = 0;
  for (let k = 0; k < order.length; k++) {
    const c = order[k];
    const v = value[c];
    acc += areaOf(c);
    if (values.length && values[values.length - 1] === v) cum[cum.length - 1] = acc;
    else {
      values.push(v);
      cum.push(acc);
    }
  }
  return { values: Float64Array.from(values), cum: Float64Array.from(cum), total: acc };
}

/**
 * The lowest level u such that, once L rises above u, the area below L exceeds
 * `area`; also returns that area. NaN if the curve never exceeds it.
 */
export function crossingLevel(curve: CumulativeCurve, area: number): { level: number; area: number } {
  const c = curve.cum;
  let lo = 0;
  let hi = c.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (c[mid] > area) hi = mid;
    else lo = mid + 1;
  }
  return lo < c.length ? { level: curve.values[lo], area: c[lo] } : { level: NaN, area: NaN };
}

/** Area of cells whose value is strictly below L. */
export function areaBelow(curve: CumulativeCurve, L: number): number {
  const v = curve.values;
  let lo = 0;
  let hi = v.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (v[mid] < L) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 ? curve.cum[lo - 1] : 0;
}
