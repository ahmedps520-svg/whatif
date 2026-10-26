/// <reference lib="webworker" />
// Background worker: runs models headless so long computations never block the UI.
import { runHeadless, type HeadlessOptions } from './headless';
import { getModel } from '../models/registry';
import { computeTasks } from './computeRegistry';
import './computeTasks';
import type { ParamValues } from './types';
import { setDataBase } from '../data/elevation';

export type WorkerRequest =
  | { type: 'run'; id: number; modelId: string; params: Partial<ParamValues>; opts?: HeadlessOptions; dataBase: string }
  | { type: 'compute'; id: number; task: string; payload: unknown; dataBase: string };

export type WorkerResponse =
  | { type: 'done'; id: number; result: unknown }
  | { type: 'error'; id: number; message: string };

const post = (m: WorkerResponse) => (self as unknown as Worker).postMessage(m);

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  try {
    setDataBase(msg.dataBase);
    if (msg.type === 'run') {
      const model = getModel(msg.modelId);
      if (!model) throw new Error(`Unknown model ${msg.modelId}`);
      await model.prepare?.();
      post({ type: 'done', id: msg.id, result: runHeadless(model, msg.params, msg.opts) });
    } else {
      const fn = computeTasks[msg.task];
      if (!fn) throw new Error(`Unknown compute task ${msg.task}`);
      post({ type: 'done', id: msg.id, result: await fn(msg.payload) });
    }
  } catch (err) {
    post({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) });
  }
};
