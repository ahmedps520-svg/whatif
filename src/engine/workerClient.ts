import type { HeadlessOptions } from './headless';
import { runHeadless } from './headless';
import type { ParamValues, RunRecord } from './types';
import type { WorkerRequest, WorkerResponse } from './worker';
import { getModel } from '../models/registry';
import { computeTasks } from './computeRegistry';
import { getDataBase } from '../data/elevation';

export interface Job<T> {
  promise: Promise<T>;
  /** Abort the computation. The promise rejects with a CancelledError. */
  cancel: () => void;
}

export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'CancelledError';
  }
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  worker: Worker;
  /** Main-thread fallback if the worker cannot run at all (e.g. a host's security policy blocks it). */
  fallback: () => Promise<unknown>;
}

let nextId = 1;
const pending = new Map<number, Pending>();
const idle: Worker[] = [];
const MAX_WORKERS = Math.max(1, Math.min(3, (globalThis.navigator?.hardwareConcurrency ?? 2) - 1));
let liveWorkers = 0;
const queue: (() => void)[] = [];

/** Set when workers turn out to be unusable here; later jobs then run on the main thread. */
let workersBroken = false;
/** Whether any worker has ever answered — distinguishes "cannot load" from a job failing. */
let workerEverAnswered = false;

function workersSupported(): boolean {
  return typeof Worker !== 'undefined' && !workersBroken;
}

function createWorker(): Worker {
  const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  liveWorkers++;
  w.onmessage = (ev: MessageEvent<WorkerResponse>) => {
    workerEverAnswered = true;
    const m = ev.data;
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    release(w);
    if (m.type === 'done') p.resolve(m.result);
    else p.reject(new Error(m.message));
  };
  w.onerror = (ev) => {
    ev.preventDefault?.();
    // A worker that never answered most likely could not load (blocked by the host): fall back.
    const fallBack = !workerEverAnswered;
    if (fallBack) workersBroken = true;
    for (const [id, p] of pending) {
      if (p.worker === w) {
        pending.delete(id);
        if (fallBack) p.fallback().then(p.resolve, p.reject);
        else p.reject(new Error(ev.message || 'Worker failed'));
      }
    }
    w.terminate();
    liveWorkers--;
    drain();
  };
  return w;
}

function acquire(): Promise<Worker> {
  return new Promise((resolve) => {
    const tryGet = () => {
      const w = idle.pop();
      if (w) return resolve(w);
      if (liveWorkers < MAX_WORKERS) return resolve(createWorker());
      queue.push(tryGet);
    };
    tryGet();
  });
}

function release(w: Worker) {
  idle.push(w);
  drain();
}

function drain() {
  const next = queue.shift();
  if (next) next();
}

function submit<T>(build: (id: number) => WorkerRequest, fallback: () => Promise<T>): Job<T> {
  const id = nextId++;
  let cancelled = false;
  let worker: Worker | null = null;
  let rejectFn: (e: Error) => void = () => {};
  const promise = new Promise<T>((resolve, reject) => {
    rejectFn = reject;
    if (!workersSupported()) {
      fallback().then(resolve, reject);
      return;
    }
    let acquired: Promise<Worker>;
    try {
      acquired = acquire();
    } catch {
      workersBroken = true;
      fallback().then(resolve, reject);
      return;
    }
    acquired
      .then((w) => {
        if (cancelled) {
          release(w);
          return;
        }
        worker = w;
        pending.set(id, { resolve, reject, worker: w, fallback });
        w.postMessage(build(id));
      })
      .catch(() => {
        workersBroken = true;
        fallback().then(resolve, reject);
      });
  });
  return {
    promise,
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      if (worker && pending.has(id)) {
        // The only way to stop a busy worker is to terminate it.
        pending.delete(id);
        worker.terminate();
        liveWorkers--;
        drain();
      }
      rejectFn(new CancelledError());
    },
  };
}

function runHere(modelId: string, params: Partial<ParamValues>, opts?: HeadlessOptions): Promise<RunRecord> {
  const model = getModel(modelId);
  if (!model) return Promise.reject(new Error(`Unknown model ${modelId}`));
  // Yield first so the UI can paint before a main-thread computation.
  return new Promise((r) => setTimeout(r, 0))
    .then(() => model.prepare?.())
    .then(() => runHeadless(model, params, opts));
}

/** Run a model headless in a background worker (falls back to the main thread). */
export function runInBackground(modelId: string, params: Partial<ParamValues>, opts?: HeadlessOptions): Job<RunRecord> {
  return submit<RunRecord>((id) => ({ type: 'run', id, modelId, params, opts, dataBase: getDataBase() }), () => runHere(modelId, params, opts));
}

/** Run a registered compute task in a background worker (falls back to the main thread). */
export function computeInBackground<T>(task: string, payload: unknown): Job<T> {
  return submit<T>(
    (id) => ({ type: 'compute', id, task, payload, dataBase: getDataBase() }),
    () => import('./computeTasks').then(() => computeTasks[task](payload) as T),
  );
}
