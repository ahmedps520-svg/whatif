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
}

let nextId = 1;
const pending = new Map<number, Pending>();
const idle: Worker[] = [];
const MAX_WORKERS = Math.max(1, Math.min(3, (globalThis.navigator?.hardwareConcurrency ?? 2) - 1));
let liveWorkers = 0;
const queue: (() => void)[] = [];

function workersSupported(): boolean {
  return typeof Worker !== 'undefined';
}

function createWorker(): Worker {
  const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  liveWorkers++;
  w.onmessage = (ev: MessageEvent<WorkerResponse>) => {
    const m = ev.data;
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    release(w);
    if (m.type === 'done') p.resolve(m.result);
    else p.reject(new Error(m.message));
  };
  w.onerror = (ev) => {
    for (const [id, p] of pending) {
      if (p.worker === w) {
        pending.delete(id);
        p.reject(new Error(ev.message || 'Worker failed'));
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

function submit<T>(build: (id: number) => WorkerRequest): Job<T> {
  const id = nextId++;
  let cancelled = false;
  let worker: Worker | null = null;
  let rejectFn: (e: Error) => void = () => {};
  const promise = new Promise<T>((resolve, reject) => {
    rejectFn = reject;
    acquire().then((w) => {
      if (cancelled) {
        release(w);
        return;
      }
      worker = w;
      pending.set(id, { resolve, reject, worker: w });
      w.postMessage(build(id));
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

/** Run a model headless in a background worker (falls back to the main thread). */
export function runInBackground(modelId: string, params: Partial<ParamValues>, opts?: HeadlessOptions): Job<RunRecord> {
  if (!workersSupported()) {
    const model = getModel(modelId);
    if (!model) return { promise: Promise.reject(new Error(`Unknown model ${modelId}`)), cancel: () => {} };
    return { promise: Promise.resolve(model.prepare?.()).then(() => runHeadless(model, params, opts)), cancel: () => {} };
  }
  return submit<RunRecord>((id) => ({ type: 'run', id, modelId, params, opts, dataBase: getDataBase() }));
}

/** Run a registered compute task in a background worker. */
export function computeInBackground<T>(task: string, payload: unknown): Job<T> {
  if (!workersSupported()) {
    return {
      promise: import('./computeTasks').then(() => computeTasks[task](payload) as T),
      cancel: () => {},
    };
  }
  return submit<T>((id) => ({ type: 'compute', id, task, payload, dataBase: getDataBase() }));
}
