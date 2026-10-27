import type { RunRecord } from '../engine/types';
import { observable, useObservable } from './observable';
import * as db from './persist';

/**
 * Local usage history. There is no server: "trending" and "popular" in the
 * UI are computed from this device's activity only, and labelled that way.
 */
export interface Activity {
  recent: { experimentId: string; at: number }[];
  /** Completed runs per catalog experiment id. */
  runs: Record<string, number>;
  /** Completed runs per model id. */
  modelRuns: Record<string, number>;
  /** Completed runs per category. */
  categoryRuns: Record<string, number>;
  comparisons: number;
  builderScenarios: number;
  assistantQuestions: number;
  scienceViews: number;
  challenges: Record<string, { passedAt: number; attempts: number }>;
  unlocked: Record<string, number>;
  discoveries: Record<string, number>;
}

const EMPTY: Activity = {
  recent: [],
  runs: {},
  modelRuns: {},
  categoryRuns: {},
  comparisons: 0,
  builderScenarios: 0,
  assistantQuestions: 0,
  scienceViews: 0,
  challenges: {},
  unlocked: {},
  discoveries: {},
};

const activity = observable<Activity>(EMPTY);

export function initActivity() {
  activity.set({ ...EMPTY, ...(db.get<Partial<Activity>>('kv', 'activity') ?? {}) });
}

export function useActivity() {
  return useObservable(activity);
}

export function getActivity() {
  return activity.get();
}

function update(fn: (a: Activity) => Activity) {
  activity.set((a) => {
    const next = fn(a);
    db.put('kv', 'activity', next);
    return next;
  });
}

export function noteOpened(experimentId: string) {
  update((a) => ({
    ...a,
    recent: [{ experimentId, at: Date.now() }, ...a.recent.filter((r) => r.experimentId !== experimentId)].slice(0, 24),
  }));
}

export function noteRunCompleted(experimentId: string | null, modelId: string, category: string | null) {
  update((a) => ({
    ...a,
    runs: experimentId ? { ...a.runs, [experimentId]: (a.runs[experimentId] ?? 0) + 1 } : a.runs,
    modelRuns: { ...a.modelRuns, [modelId]: (a.modelRuns[modelId] ?? 0) + 1 },
    categoryRuns: category ? { ...a.categoryRuns, [category]: (a.categoryRuns[category] ?? 0) + 1 } : a.categoryRuns,
  }));
}

export function noteCounter(key: 'comparisons' | 'builderScenarios' | 'assistantQuestions' | 'scienceViews') {
  update((a) => ({ ...a, [key]: a[key] + 1 }));
}

export function noteChallenge(id: string, passed: boolean) {
  update((a) => {
    const cur = a.challenges[id] ?? { passedAt: 0, attempts: 0 };
    return { ...a, challenges: { ...a.challenges, [id]: { attempts: cur.attempts + 1, passedAt: passed && !cur.passedAt ? Date.now() : cur.passedAt } } };
  });
}

export function markUnlocked(kind: 'unlocked' | 'discoveries', id: string): boolean {
  if (activity.get()[kind][id]) return false;
  update((a) => ({ ...a, [kind]: { ...a[kind], [id]: Date.now() } }));
  return true;
}

export function resetActivity() {
  activity.set(EMPTY);
  db.put('kv', 'activity', EMPTY);
}

export type { RunRecord };
