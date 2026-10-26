import type {
  ActionRecord,
  ParamChange,
  ParamValue,
  ParamValues,
  RunRecord,
  RunSamples,
  RunTracks,
  SimEvent,
  SimulationModel,
} from './types';
import { resolve } from './validation';

export interface CoreOptions {
  /** Run length in model time units. Defaults to the model's default duration. */
  duration?: number;
  /** Keep a full state snapshot per sample so the timeline can be scrubbed. */
  keepSnapshots?: boolean;
  /** When exceeded, the recording is decimated by 2 and the sample interval doubled. */
  maxSamples?: number;
  /** Actions and parameter changes to replay at their recorded times (headless reproduction). */
  replayActions?: ActionRecord[];
  replayParamChanges?: ParamChange[];
}

const EPS = 1e-9;

/**
 * SimCore advances a model with a fixed time step and records everything the
 * UI needs: column samples of every observable, tracked object paths, events,
 * parameter changes and user actions. It is shared by the live runner and the
 * headless (worker) runner so both produce identical recordings.
 */
export class SimCore<S = any> {
  readonly model: SimulationModel<S>;
  params: ParamValues;
  /** Parameters in force at t = 0 (what a reset restores). */
  readonly initialParams: ParamValues;
  state: S;
  readonly dt: number;
  sampleInterval: number;
  readonly duration: number;
  readonly maxSamples: number;
  readonly keepSnapshots: boolean;

  samples: RunSamples;
  tracks: RunTracks = {};
  events: SimEvent[] = [];
  paramChanges: ParamChange[] = [];
  actions: ActionRecord[] = [];
  snapshots: S[] = [];
  /** Params in force at each sample (for scrubbing back through live changes). */
  sampleParams: ParamValues[] = [];

  steps = 0;
  wallMs = 0;
  stoppedReason: string | null = null;
  stoppedBy: 'model' | 'engine' | null = null;

  private nextSampleT: number;
  private prevObs: Record<string, number> | null = null;
  private firedThresholds = new Set<string>();
  private milestones: number[];
  private replayActions: ActionRecord[];
  private replayParamChanges: ParamChange[];

  constructor(model: SimulationModel<S>, params: ParamValues, opts: CoreOptions = {}) {
    this.model = model;
    this.params = { ...params };
    this.initialParams = { ...params };
    this.dt = Math.max(resolve(model.time.dt, params), 1e-12);
    this.sampleInterval = Math.max(resolve(model.time.sampleInterval, params), this.dt);
    const durationFromParam = model.time.durationParam ? Number(params[model.time.durationParam]) : NaN;
    const requested = opts.duration ?? (Number.isFinite(durationFromParam) ? durationFromParam : resolve(model.time.defaultDuration, params));
    this.duration = Math.min(Math.max(requested, this.dt), model.time.maxDuration);
    this.maxSamples = opts.maxSamples ?? 4000;
    this.keepSnapshots = opts.keepSnapshots ?? false;
    this.milestones = [...(model.time.milestones ? resolve(model.time.milestones, params) : [])]
      .filter((m) => m > 0 && m <= this.duration + EPS)
      .sort((a, b) => a - b);
    this.replayActions = [...(opts.replayActions ?? [])].sort((a, b) => a.t - b.t);
    this.replayParamChanges = [...(opts.replayParamChanges ?? [])].sort((a, b) => a.t - b.t);

    this.samples = { t: [], obs: {} };
    for (const o of model.observables) this.samples.obs[o.key] = [];

    this.state = model.init(this.params);
    this.nextSampleT = this.time;
    this.recordSample();
  }

  get time(): number {
    return this.model.time_of(this.state);
  }

  get finished(): boolean {
    return this.stoppedReason !== null;
  }

  get sampleCount(): number {
    return this.samples.t.length;
  }

  /**
   * Advance until model time reaches `target`, the run finishes, or the wall
   * clock budget (ms) is spent. Returns true if the target was reached.
   */
  advanceTo(target: number, budgetMs = Infinity): boolean {
    if (this.finished) return true;
    const start = performance.now();
    const end = Math.min(target, this.duration);
    let checks = 0;
    while (this.time < end - EPS) {
      if (!this.stepOnce()) return true;
      if (++checks % 64 === 0 && performance.now() - start > budgetMs) {
        this.wallMs += performance.now() - start;
        return false;
      }
    }
    if (this.time >= this.duration - EPS && !this.finished) {
      this.recordSample(true);
      this.stop('Reached the configured duration.');
    }
    this.wallMs += performance.now() - start;
    return true;
  }

  /** One fixed engine step plus any due recording. Returns false when the run stopped. */
  private stepOnce(): boolean {
    this.applyReplays();
    try {
      this.model.step(this.state, this.params, this.dt);
    } catch (err) {
      this.addEvent({
        t: this.time,
        id: 'engine-error',
        label: 'Simulation stopped: the model raised an error',
        detail: err instanceof Error ? err.message : String(err),
        severity: 'critical',
        source: 'model',
      });
      this.stop('The model raised an error.');
      return false;
    }
    this.steps++;
    const t = this.time;
    if (t >= this.nextSampleT - EPS || this.milestoneDue(t)) {
      this.recordSample();
      if (this.finished) return false;
    }
    return true;
  }

  private milestoneDue(t: number): boolean {
    return this.milestones.length > 0 && t >= this.milestones[0] - EPS;
  }

  private applyReplays() {
    const t = this.time;
    while (this.replayParamChanges.length && this.replayParamChanges[0].t <= t + EPS) {
      const c = this.replayParamChanges.shift()!;
      this.setParam(c.key, c.value);
    }
    while (this.replayActions.length && this.replayActions[0].t <= t + EPS) {
      const a = this.replayActions.shift()!;
      this.applyAction(a.actionId);
    }
  }

  /** Record a sample now. `force` records even if no sample is due. */
  recordSample(force = false) {
    const t = this.time;
    const last = this.samples.t[this.samples.t.length - 1];
    if (last !== undefined && Math.abs(last - t) < EPS) {
      // Never duplicate a timestamp. A forced sample (e.g. after a user action)
      // replaces the existing one so the snapshot matches the recorded state.
      if (!force) return;
      this.popLastSample();
    }
    const obs = this.model.observe(this.state, this.params);

    for (const o of this.model.observables) {
      const v = obs[o.key];
      if (v !== undefined && !Number.isFinite(v) && !Number.isNaN(v)) {
        // Infinity signals numerical blow-up. NaN is allowed and means "not applicable".
        this.addEvent({
          t,
          id: 'numerical-instability',
          label: `Numerical instability: ${o.label} became non-finite`,
          detail: 'The run was stopped to protect the results. A smaller time step or less extreme parameters may help.',
          severity: 'critical',
          source: 'model',
        });
        this.stop('Numerical instability detected.');
        return;
      }
    }

    this.samples.t.push(t);
    for (const o of this.model.observables) this.samples.obs[o.key].push(obs[o.key] ?? NaN);
    if (this.model.tracks) {
      for (const p of this.model.tracks(this.state, this.params)) {
        let tr = this.tracks[p.id];
        if (!tr) tr = this.tracks[p.id] = { t: [], x: [], y: [], z: [] };
        tr.t.push(t);
        tr.x.push(p.x);
        tr.y.push(p.y);
        tr.z.push(p.z ?? 0);
      }
    }
    while (this.nextSampleT <= t + EPS) this.nextSampleT += this.sampleInterval;

    // Detect before snapshotting: models may drain pending events from state,
    // and a snapshot must not carry events that were already reported.
    this.detect(obs, t);
    this.prevObs = obs;
    if (this.keepSnapshots) {
      this.snapshots.push(this.model.clone(this.state));
      this.sampleParams.push({ ...this.params });
    }

    const reason = this.model.finished?.(this.state, this.params) ?? null;
    if (reason) this.stop(reason, 'model');
    if (this.samples.t.length > this.maxSamples) this.decimate();
  }

  private detect(obs: Record<string, number>, t: number) {
    // Milestones describe the actual state, so labels can never contradict the calculation.
    while (this.milestoneDue(t)) {
      const m = this.milestones.shift()!;
      const d = this.model.describeMilestone?.(m, obs, this.params);
      if (d) this.addEvent({ t, id: `milestone-${m}`, label: d.label, detail: d.detail, severity: 'milestone', source: 'milestone' });
    }
    for (const th of this.model.thresholds ?? []) {
      if (this.firedThresholds.has(th.id)) continue;
      const v = obs[th.observable];
      if (v === undefined || Number.isNaN(v)) continue;
      const limit = resolve(th.value, this.params);
      const prev = this.prevObs?.[th.observable];
      const now = th.op === '>' ? v > limit : v < limit;
      const before = prev === undefined || Number.isNaN(prev) ? false : th.op === '>' ? prev > limit : prev < limit;
      if (now && !before) {
        this.firedThresholds.add(th.id);
        this.addEvent({
          t,
          id: th.id,
          label: th.label,
          detail: th.detail?.(v, t),
          severity: th.severity ?? 'warning',
          source: 'threshold',
        });
      }
    }
    for (const e of this.model.detectEvents?.(this.prevObs, obs, this.state, this.params) ?? []) this.addEvent(e);
  }

  private decimate() {
    const keep = (_: unknown, i: number) => i % 2 === 0 || i === this.samples.t.length - 1;
    this.samples.t = this.samples.t.filter(keep);
    for (const k of Object.keys(this.samples.obs)) this.samples.obs[k] = this.samples.obs[k].filter(keep);
    if (this.keepSnapshots) {
      const n = this.snapshots.length;
      const k2 = (_: unknown, i: number) => i % 2 === 0 || i === n - 1;
      this.snapshots = this.snapshots.filter(k2);
      this.sampleParams = this.sampleParams.filter(k2);
    }
    for (const tr of Object.values(this.tracks)) {
      const n = tr.t.length;
      const k3 = (_: unknown, i: number) => i % 2 === 0 || i === n - 1;
      tr.t = tr.t.filter(k3);
      tr.x = tr.x.filter(k3);
      tr.y = tr.y.filter(k3);
      tr.z = tr.z.filter(k3);
    }
    this.sampleInterval *= 2;
  }

  addEvent(e: SimEvent) {
    this.events.push(e);
  }

  stop(reason: string, by: 'model' | 'engine' = 'engine') {
    if (!this.stoppedReason) {
      this.stoppedReason = reason;
      this.stoppedBy = by;
    }
  }

  /** A model-declared finish (e.g. "everything at rest") can be resumed by a user action. */
  resumeIfModelFinished(): boolean {
    if (this.stoppedBy === 'model' && this.time < this.duration - EPS) {
      this.stoppedReason = null;
      this.stoppedBy = null;
      return true;
    }
    return false;
  }

  private popLastSample() {
    const i = this.samples.t.length - 1;
    if (i < 0) return;
    const t = this.samples.t[i];
    this.samples.t.length = i;
    for (const k of Object.keys(this.samples.obs)) this.samples.obs[k].length = i;
    if (this.keepSnapshots) {
      this.snapshots.length = i;
      this.sampleParams.length = i;
    }
    for (const [id, tr] of Object.entries(this.tracks)) {
      const n = tr.t.length;
      if (n && Math.abs(tr.t[n - 1] - t) < EPS) {
        tr.t.length = n - 1;
        tr.x.length = n - 1;
        tr.y.length = n - 1;
        tr.z.length = n - 1;
        if (n === 1) delete this.tracks[id];
      }
    }
  }

  /** Apply a parameter change at the current time. Initial-condition params are not handled here. */
  setParam(key: string, value: ParamValue) {
    if (this.params[key] === value) return;
    this.params = { ...this.params, [key]: value };
    this.paramChanges.push({ t: this.time, key, value });
    const def = this.model.params.find((p) => p.key === key);
    if (def && def.kind === 'live') {
      this.addEvent({
        t: this.time,
        id: `param-${key}-${this.paramChanges.length}`,
        label: `${def.label} changed to ${typeof value === 'number' ? Number(value.toPrecision(4)) : String(value)}`,
        severity: 'info',
        source: 'user',
      });
    }
  }

  applyAction(actionId: string): SimEvent | null {
    if (!this.model.applyAction) return null;
    this.resumeIfModelFinished();
    const e = this.model.applyAction(this.state, this.params, actionId);
    this.actions.push({ t: this.time, actionId });
    if (e) this.addEvent({ ...e, source: e.source ?? 'user' });
    // Record immediately so new objects appear on tracks and charts.
    this.recordSample(true);
    return e;
  }

  /**
   * Restore the snapshot at sample `index` and discard everything recorded
   * after it. Used when the user resumes from a scrubbed point in the past.
   */
  truncateTo(index: number) {
    if (!this.keepSnapshots) throw new Error('truncateTo requires snapshots');
    const i = Math.max(0, Math.min(index, this.samples.t.length - 1));
    const t = this.samples.t[i];
    this.state = this.model.clone(this.snapshots[i]);
    this.params = { ...this.sampleParams[i] };
    this.samples.t.length = i + 1;
    for (const k of Object.keys(this.samples.obs)) this.samples.obs[k].length = i + 1;
    this.snapshots.length = i + 1;
    this.sampleParams.length = i + 1;
    for (const [id, tr] of Object.entries(this.tracks)) {
      let n = tr.t.length;
      while (n > 0 && tr.t[n - 1] > t + EPS) n--;
      if (n === 0) delete this.tracks[id];
      else {
        tr.t.length = n;
        tr.x.length = n;
        tr.y.length = n;
        tr.z.length = n;
      }
    }
    this.events = this.events.filter((e) => e.t <= t + EPS);
    this.paramChanges = this.paramChanges.filter((c) => c.t <= t + EPS);
    this.actions = this.actions.filter((a) => a.t <= t + EPS);
    this.firedThresholds = new Set(this.events.filter((e) => e.source === 'threshold').map((e) => e.id));
    const allMilestones = this.model.time.milestones ? resolve(this.model.time.milestones, this.initialParams) : [];
    this.milestones = allMilestones.filter((m) => m > t + EPS && m <= this.duration + EPS).sort((a, b) => a - b);
    this.prevObs = this.lastObs();
    this.nextSampleT = t + this.sampleInterval;
    this.stoppedReason = null;
    this.stoppedBy = null;
  }

  lastObs(): Record<string, number> {
    const i = this.samples.t.length - 1;
    const out: Record<string, number> = {};
    for (const k of Object.keys(this.samples.obs)) out[k] = this.samples.obs[k][i];
    return out;
  }

  obsAt(i: number): Record<string, number> {
    const out: Record<string, number> = {};
    for (const k of Object.keys(this.samples.obs)) out[k] = this.samples.obs[k][i];
    return out;
  }

  toRecord(): RunRecord {
    return {
      modelId: this.model.id,
      params: { ...this.initialParams },
      duration: this.duration,
      samples: { t: [...this.samples.t], obs: Object.fromEntries(Object.entries(this.samples.obs).map(([k, v]) => [k, [...v]])) },
      tracks: Object.fromEntries(
        Object.entries(this.tracks).map(([k, v]) => [k, { t: [...v.t], x: [...v.x], y: [...v.y], z: [...v.z] }]),
      ),
      events: [...this.events],
      paramChanges: [...this.paramChanges],
      actions: [...this.actions],
      final: this.lastObs(),
      numerics: {
        steps: this.steps,
        dt: this.dt,
        sampleInterval: this.sampleInterval,
        wallMs: Math.round(this.wallMs),
        stoppedReason: this.stoppedReason ?? 'Stopped by the user before the configured duration.',
      },
    };
  }
}
