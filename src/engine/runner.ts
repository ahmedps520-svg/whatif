import { SimCore } from './core';
import type { ParamValue, ParamValues, SimulationModel } from './types';
import { resolve } from './validation';

export type RunStatus = 'ready' | 'running' | 'paused' | 'finished';

export const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 100] as const;

/**
 * LiveRunner drives a SimCore from the animation loop. Simulation time is
 * decoupled from frame rate: each frame converts elapsed wall time into a
 * target model time and takes as many fixed steps as the frame budget allows.
 * If the budget runs out the run falls behind real time (reported as `lagging`)
 * instead of freezing the page.
 */
export class LiveRunner<S = any> {
  model: SimulationModel<S>;
  core: SimCore<S>;
  status: RunStatus = 'ready';
  speed = 1;
  /** Index of the sample being viewed, or null for the live head. */
  viewIndex: number | null = null;
  lagging = false;
  /** Increments whenever anything visible changes; React subscribes to it. */
  version = 0;
  private listeners = new Set<() => void>();
  private frameBudgetMs = 10;

  constructor(model: SimulationModel<S>, params: ParamValues) {
    this.model = model;
    this.core = new SimCore(model, params, { keepSnapshots: true, maxSamples: 3000 });
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    this.version++;
    for (const l of this.listeners) l();
  }

  get params(): ParamValues {
    return this.core.params;
  }

  get time(): number {
    return this.viewIndex === null ? this.core.time : this.core.samples.t[this.viewIndex];
  }

  /** The state to render: the live head or a recorded snapshot while scrubbing. */
  get viewState(): S {
    if (this.viewIndex === null) return this.core.state;
    return this.core.snapshots[this.viewIndex] ?? this.core.state;
  }

  get viewParams(): ParamValues {
    if (this.viewIndex === null) return this.core.params;
    return this.core.sampleParams[this.viewIndex] ?? this.core.params;
  }

  get realtimeRate(): number {
    return resolve(this.model.time.realtimeRate, this.core.params);
  }

  play() {
    if (this.core.finished) return;
    if (this.viewIndex !== null) {
      // Resuming from the past: restore that snapshot and discard later recording.
      this.core.truncateTo(this.viewIndex);
      this.viewIndex = null;
    }
    this.status = 'running';
    this.emit();
  }

  pause() {
    if (this.status === 'running') this.status = 'paused';
    this.emit();
  }

  toggle() {
    if (this.status === 'running') this.pause();
    else this.play();
  }

  reset(params?: ParamValues) {
    this.core = new SimCore(this.model, params ?? this.core.initialParams, { keepSnapshots: true, maxSamples: 3000 });
    this.status = 'ready';
    this.viewIndex = null;
    this.lagging = false;
    this.emit();
  }

  /** Advance by exactly one recording interval. */
  stepForward() {
    if (this.viewIndex !== null) {
      if (this.viewIndex < this.core.sampleCount - 1) {
        this.viewIndex++;
        if (this.viewIndex === this.core.sampleCount - 1) this.viewIndex = null;
        this.emit();
        return;
      }
      this.viewIndex = null;
    }
    if (this.core.finished) return;
    if (this.status === 'running') this.status = 'paused';
    this.core.advanceTo(this.core.time + this.core.sampleInterval, 200);
    this.core.recordSample(true);
    if (this.core.finished) this.status = 'finished';
    else if (this.status === 'ready') this.status = 'paused';
    this.emit();
  }

  stepBack() {
    const head = this.core.sampleCount - 1;
    const cur = this.viewIndex ?? head;
    if (cur <= 0) return;
    this.viewIndex = cur - 1;
    if (this.status === 'running') this.status = 'paused';
    this.emit();
  }

  setSpeed(speed: number) {
    this.speed = speed;
    this.emit();
  }

  /** Jump to the recorded sample nearest to model time t (restores a saved state). */
  seekTime(t: number) {
    const ts = this.core.samples.t;
    if (!ts.length) return;
    let lo = 0;
    let hi = ts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ts[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0 && Math.abs(ts[lo - 1] - t) < Math.abs(ts[lo] - t)) lo--;
    this.seekIndex(lo);
  }

  seekIndex(i: number) {
    const head = this.core.sampleCount - 1;
    if (this.status === 'running') this.status = 'paused';
    this.viewIndex = i >= head ? null : Math.max(0, i);
    this.emit();
  }

  goLive() {
    this.viewIndex = null;
    this.emit();
  }

  /**
   * Change a parameter. Live params apply from the current time; initial
   * conditions restart the run with the new value.
   * Returns 'reset' when a restart happened.
   */
  setParam(key: string, value: ParamValue): 'live' | 'reset' | 'spawn' {
    const def = this.model.params.find((p) => p.key === key);
    if (!def) return 'live';
    if (def.kind === 'initial' || this.status === 'ready') {
      this.reset({ ...this.core.initialParams, [key]: value });
      return 'reset';
    }
    if (this.viewIndex !== null) {
      this.core.truncateTo(this.viewIndex);
      this.viewIndex = null;
    }
    this.core.setParam(key, value);
    this.emit();
    return def.kind === 'spawn' ? 'spawn' : 'live';
  }

  action(actionId: string) {
    if (this.viewIndex !== null) {
      this.core.truncateTo(this.viewIndex);
      this.viewIndex = null;
    }
    this.core.applyAction(actionId);
    if (this.status === 'finished' && !this.core.finished) this.status = 'paused';
    if (this.status === 'ready') this.status = 'running';
    this.emit();
  }

  /** Called every animation frame with the elapsed wall time in seconds. */
  tick(realDt: number) {
    if (this.status !== 'running') return;
    const dtClamped = Math.min(realDt, 0.1); // a background tab must not trigger a huge catch-up
    const target = this.core.time + dtClamped * this.realtimeRate * this.speed;
    const reached = this.core.advanceTo(target, this.frameBudgetMs);
    this.lagging = !reached;
    if (this.core.finished) this.status = 'finished';
    this.emit();
  }

  /** Stop a run that is taking too long; the recording so far is kept. */
  stop() {
    this.core.recordSample(true);
    this.core.stop('Stopped by the user.');
    this.status = 'finished';
    this.emit();
  }
}
