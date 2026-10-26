import type { LiveRunner } from '../engine/runner';
import type { RunRecord } from '../engine/types';

export interface Overlays {
  /** Show measurement annotations (distances, apex markers, labels). */
  measurements: boolean;
  /** Show velocity / force vectors where the view supports them. */
  vectors: boolean;
}

/**
 * Props every model view receives. Views render `runner.viewState` (the live
 * head or a scrubbed snapshot) on their own animation loop. They must never
 * advance simulation time themselves. For direct manipulation (e.g. picking an
 * observation point on a globe) a view may call `runner.setParam(key, value)`;
 * the parameter panel reflects the change automatically.
 */
export interface ModelViewProps<S = any> {
  runner: LiveRunner<S>;
  /** Headless run with the experiment's baseline parameters, if available. */
  baseline: RunRecord | null;
  overlays: Overlays;
  /** Changes whenever the runner emits; use for React-rendered parts of a view. */
  version: number;
  /** Increment to request "reset camera" in 2D/3D views. */
  cameraResetKey: number;
}
