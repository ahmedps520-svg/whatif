import { SimCore, type CoreOptions } from './core';
import type { ParamValues, RunRecord, SimulationModel } from './types';
import { validateParams } from './validation';

export interface HeadlessOptions extends CoreOptions {
  /** Hard wall-clock limit; the run stops (with a note) when exceeded. */
  timeoutMs?: number;
}

/**
 * Run a model from start to finish without rendering. Used by the worker for
 * baseline runs, comparisons, branch envelopes and challenge verification, and
 * directly by unit tests.
 */
export function runHeadless(model: SimulationModel, params: Partial<ParamValues>, opts: HeadlessOptions = {}): RunRecord {
  const { values } = validateParams(model, params);
  const core = new SimCore(model, values, opts);
  const timeout = opts.timeoutMs ?? 20000;
  const done = core.advanceTo(core.duration, timeout);
  if (!done && !core.finished) {
    core.recordSample(true);
    core.stop(`Stopped after the ${Math.round(timeout / 1000)} s computation limit.`);
  }
  return core.toRecord();
}
