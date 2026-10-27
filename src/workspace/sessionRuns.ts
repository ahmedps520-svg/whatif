import type { ParamValues, RunRecord } from '../engine/types';
import { newId } from '../store/history';

/** Completed runs from this browser session (not yet saved), for the results page. */
export interface SessionRun {
  id: string;
  experimentId: string | null;
  modelId: string;
  question: string;
  name: string;
  record: RunRecord;
  baseline: RunRecord | null;
  baselineParams: ParamValues | null;
  baselineLabel?: string;
  experimentAssumptions?: string[];
  createdAt: number;
  savedId?: string;
}

const runs = new Map<string, SessionRun>();

export function putSessionRun(r: Omit<SessionRun, 'id' | 'createdAt'>): SessionRun {
  const s: SessionRun = { ...r, id: newId('run-'), createdAt: Date.now() };
  runs.set(s.id, s);
  if (runs.size > 30) runs.delete(runs.keys().next().value!);
  return s;
}

export function getSessionRun(id: string): SessionRun | undefined {
  return runs.get(id);
}

export function listSessionRuns(): SessionRun[] {
  return [...runs.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export function markSessionSaved(id: string, savedId: string) {
  const r = runs.get(id);
  if (r) r.savedId = savedId;
}
