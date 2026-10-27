/**
 * Module-level cache of the elevation grid and the precomputed flood products,
 * shared by the model (observe) and the view (map, charts). Worker-safe: it
 * never imports the worker client (the worker bundle would then reference
 * itself, which Vite rejects). On the main thread a background runner is
 * injected by ./background.ts; without one the products are computed here.
 */
import { loadElevation, type ElevationGrid } from '../../data/elevation';
import { buildSeaLevelProducts, type FloodPayload, type SeaLevelProducts } from './products';

export interface SeaLevelData {
  grid: Pick<ElevationGrid, 'ncols' | 'nrows' | 'data'> & { meta: ElevationGrid['meta'] | FloodPayload['meta'] };
  products: SeaLevelProducts;
}

export type FloodRunner = (payload: FloodPayload) => Promise<SeaLevelProducts>;

let current: SeaLevelData | null = null;
let pending: Promise<SeaLevelData> | null = null;
let lastError: Error | null = null;
let background: FloodRunner | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

/** Main-thread code registers a runner that executes the compute task in a worker. */
export function setFloodRunner(fn: FloodRunner | null) {
  background = fn;
}

export function getSeaLevelData(): SeaLevelData | null {
  return current;
}

export function getSeaLevelError(): Error | null {
  return lastError;
}

export function subscribeSeaLevel(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Running inside a Web Worker (or Node tests): compute directly. */
function offMainThread(): boolean {
  return typeof document === 'undefined';
}

/**
 * Load the ETOPO1 grid and compute the flood products once. Repeated calls
 * share the same promise; a failure is reported and a later call retries.
 */
export function prepareSeaLevelData(): Promise<SeaLevelData> {
  if (current) return Promise.resolve(current);
  if (!pending) {
    lastError = null;
    notify();
    pending = (async () => {
      const grid = await loadElevation();
      const payload: FloodPayload = {
        data: grid.data,
        ncols: grid.ncols,
        nrows: grid.nrows,
        meta: { lat0: grid.meta.lat0, dlat: grid.meta.dlat, lon0: grid.meta.lon0, dlon: grid.meta.dlon },
      };
      let products: SeaLevelProducts | null = null;
      if (!offMainThread() && background) {
        try {
          products = await background(payload);
        } catch (err) {
          // A worker failure must not make the dataset unusable: fall back below.
          console.warn('Sea-level flood fill in the background failed; computing on the main thread.', err);
        }
      }
      if (!products) products = buildSeaLevelProducts(payload);
      current = { grid, products };
      notify();
      return current;
    })();
    pending.catch((err) => {
      pending = null;
      lastError = err instanceof Error ? err : new Error(String(err));
      notify();
    });
  }
  return pending;
}

/** Install precomputed data directly (tests, or callers that already hold a grid). */
export function installSeaLevelData(grid: SeaLevelData['grid'], products?: SeaLevelProducts): SeaLevelData {
  current = {
    grid,
    products:
      products ??
      buildSeaLevelProducts({ data: grid.data, ncols: grid.ncols, nrows: grid.nrows, meta: grid.meta }),
  };
  pending = Promise.resolve(current);
  lastError = null;
  notify();
  return current;
}

/** Forget cached data (tests). */
export function resetSeaLevelData() {
  current = null;
  pending = null;
  lastError = null;
  notify();
}
