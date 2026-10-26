/**
 * Core contracts of the WHAT IF LAB simulation engine.
 *
 * A model is pure logic: no DOM, no React, no rendering. The same model object
 * runs live in the workspace (SimulationRunner), headless in a Web Worker
 * (runHeadless), and in unit tests. Views live in separate files and only read
 * state produced by the model.
 */
import type { UnitId } from './units';

export type Domain =
  | 'physics'
  | 'astronomy'
  | 'earth'
  | 'biology'
  | 'population'
  | 'economics'
  | 'technology';

export type ParamValue = number | string | boolean;
export type ParamValues = Record<string, ParamValue>;

/**
 * How a parameter change is applied while a run is in progress.
 * - live: the next step uses the new value (logged on the timeline).
 * - initial: defines initial conditions; changing it restarts the run.
 * - spawn: settings for objects the user adds later (e.g. the next launch).
 */
export type ParamKind = 'live' | 'initial' | 'spawn';

interface ParamBase {
  key: string;
  label: string;
  description: string;
  kind: ParamKind;
  /** Panel grouping, e.g. "Environment", "Launch", "Numerics". */
  group?: string;
  /** Hide the control when it has no effect for the current configuration. */
  visibleWhen?: (p: ParamValues) => boolean;
  /** Mark parameters that are calculation settings rather than physical inputs. */
  numerics?: boolean;
}

export interface NumberParamDef extends ParamBase {
  type: 'number';
  /** Unit of the value the model receives. Display units may differ. */
  unit: UnitId;
  min: number;
  max: number;
  step: number;
  default: number;
  scale?: 'linear' | 'log';
  /** Optional named reference values shown as quick picks (e.g. Earth, Mars). */
  marks?: { value: number; label: string }[];
}

export interface ChoiceParamDef extends ParamBase {
  type: 'choice';
  options: { value: string; label: string; description?: string }[];
  default: string;
}

export interface BooleanParamDef extends ParamBase {
  type: 'boolean';
  default: boolean;
}

export type ParamDef = NumberParamDef | ChoiceParamDef | BooleanParamDef;

/**
 * Where a number comes from. The UI labels every value with its provenance so
 * calculations are never confused with data or assumptions.
 */
export type Provenance =
  | 'simulated' // produced by stepping the model forward in time
  | 'derived' // computed in closed form from parameters / state
  | 'data' // read from an external dataset (see DataSource)
  | 'assumed'; // a stated assumption or reference value

export interface ObservableDef {
  key: string;
  label: string;
  unit: UnitId;
  description?: string;
  provenance: Provenance;
  /** Plot by default in the live chart. */
  chart?: boolean;
  /** Chart group: observables sharing a group share an axis/scale. */
  chartGroup?: string;
  /** Show in the live readout panel. Defaults to true. */
  readout?: boolean;
  /** Significant figures for display. */
  sig?: number;
}

export type EventSeverity = 'info' | 'milestone' | 'warning' | 'critical';

export interface SimEvent {
  /** Simulated time at which the event occurred (model time unit). */
  t: number;
  id: string;
  label: string;
  detail?: string;
  severity: EventSeverity;
  /** Where the event came from. */
  source?: 'model' | 'threshold' | 'milestone' | 'user';
}

/** Declarative threshold watched by the engine on every recorded sample. */
export interface ThresholdDef {
  id: string;
  observable: string;
  op: '>' | '<';
  value: number | ((p: ParamValues) => number);
  label: string;
  detail?: (value: number, t: number) => string;
  severity?: EventSeverity;
}

export type AssumptionKind = 'established' | 'simplification' | 'approximation' | 'speculative';

export interface Assumption {
  text: string;
  kind: AssumptionKind;
}

export interface Equation {
  label: string;
  /** Plain-text / unicode formula, e.g. "a = −g − (ρ C_d A / 2m)|v|v". */
  formula: string;
  explanation: string;
}

export interface VariableDefinition {
  symbol: string;
  meaning: string;
  unit?: string;
}

export type ExplanationLevel = 'beginner' | 'intermediate' | 'advanced';

export interface Education {
  objectives: string[];
  background: Record<ExplanationLevel, string>;
  variables: VariableDefinition[];
  guidedSteps: string[];
  questions: string[];
}

export interface DataSource {
  name: string;
  provider: string;
  citation: string;
  url: string;
  license: string;
  notes?: string;
}

/** A quantity computed from parameters only (e.g. surface gravity from mass and radius). */
export interface DerivedQuantity {
  key: string;
  label: string;
  value: number;
  unit: UnitId;
  formula?: string;
  provenance: Provenance;
  sig?: number;
  note?: string;
}

export interface Warning {
  id: string;
  message: string;
  severity: 'info' | 'warning' | 'critical';
}

/** A point on a tracked object's path (recorded with every sample). */
export interface TrackPoint {
  id: string;
  x: number;
  y: number;
  z?: number;
}

export interface TimeConfig {
  /** Unit of model time (the `t` passed around everywhere). */
  unit: UnitId;
  /** Fixed engine step in model time units. */
  dt: number | ((p: ParamValues) => number);
  /** Recording interval in model time units (one chart point / snapshot). */
  sampleInterval: number | ((p: ParamValues) => number);
  /** Default and maximum run duration in model time units. */
  defaultDuration: number | ((p: ParamValues) => number);
  maxDuration: number;
  /** Model time units advanced per real second at 1x playback speed. */
  realtimeRate: number | ((p: ParamValues) => number);
  /** Optional parameter key that holds the run duration. */
  durationParam?: string;
  /** Times at which milestone events are generated from the actual state. */
  milestones?: number[] | ((p: ParamValues) => number[]);
}

export interface SimulationModel<S = any> {
  id: string;
  name: string;
  shortName?: string;
  domain: Domain;
  summary: string;
  /** Visual style hint for the workspace layout. */
  viewKind: '2d' | '3d' | 'map' | 'chart';
  params: ParamDef[];
  observables: ObservableDef[];
  time: TimeConfig;
  /** Keys of observables plotted against the baseline run by default. */
  primaryObservables?: string[];

  /**
   * Load or compute datasets the model needs (e.g. elevation grids) before
   * `init`. Called by the workspace and by the background worker; must cache
   * its result so repeated calls are cheap. `init` may assume it resolved.
   */
  prepare?(): Promise<void>;
  /** Build the initial state from (validated) parameter values. Must be deterministic. */
  init(p: ParamValues): S;
  /** Advance the state in place by dt model time units. */
  step(s: S, p: ParamValues, dt: number): void;
  /** Read current observable values. Must not mutate state. */
  observe(s: S, p: ParamValues): Record<string, number>;
  /** Deep copy for snapshots and scrubbing. */
  clone(s: S): S;
  /** Current model time of the state. */
  time_of(s: S): number;

  /** Model-specific event detection, called after each recorded sample. */
  detectEvents?(prev: Record<string, number> | null, cur: Record<string, number>, s: S, p: ParamValues): SimEvent[];
  /** Declarative thresholds evaluated on recorded samples. */
  thresholds?: ThresholdDef[];
  /** Describe a milestone from the actual state at time t. */
  describeMilestone?(t: number, obs: Record<string, number>, p: ParamValues): { label: string; detail?: string };
  /** Return a reason string when the run has naturally finished. */
  finished?(s: S, p: ParamValues): string | null;
  /** Positions of tracked objects, recorded with each sample (trails, trajectories). */
  tracks?(s: S, p: ParamValues): TrackPoint[];
  /** Quantities computed directly from parameters. */
  derived?(p: ParamValues): DerivedQuantity[];
  /** Validity warnings for a configuration (e.g. "planet would break apart"). */
  warnings?(p: ParamValues): Warning[];
  /** Apply a user action (e.g. "launch") to the state. Actions are recorded for replay. */
  actions?: ModelAction[];
  applyAction?(s: S, p: ParamValues, actionId: string): SimEvent | null;
  /** Key numerical results for the results page, computed from the recorded run. */
  summarize?(run: RunRecord): KeyResult[];

  assumptions: Assumption[];
  limitations: string[];
  equations: Equation[];
  education: Education;
  dataSources?: DataSource[];
}

export interface ModelAction {
  id: string;
  label: string;
  description: string;
}

export interface KeyResult {
  label: string;
  value: number | string;
  unit?: UnitId;
  provenance: Provenance;
  sig?: number;
  note?: string;
}

/** Column-oriented recording of a run. Plain data: safe to store and transfer. */
export interface RunSamples {
  t: number[];
  obs: Record<string, number[]>;
}

export interface RunTracks {
  [id: string]: { t: number[]; x: number[]; y: number[]; z: number[] };
}

export interface ParamChange {
  t: number;
  key: string;
  value: ParamValue;
}

export interface ActionRecord {
  t: number;
  actionId: string;
}

export interface RunNumerics {
  steps: number;
  dt: number;
  sampleInterval: number;
  wallMs: number;
  stoppedReason: string;
}

export interface RunRecord {
  modelId: string;
  params: ParamValues;
  duration: number;
  samples: RunSamples;
  tracks: RunTracks;
  events: SimEvent[];
  paramChanges: ParamChange[];
  actions: ActionRecord[];
  final: Record<string, number>;
  numerics: RunNumerics;
}
