import type { ParamValues, RunRecord } from '../engine/types';
import { observable, useObservable } from './observable';
import * as db from './persist';

/** A saved experiment: configuration, optional recorded results, notes and tags. */
export interface SavedExperiment {
  id: string;
  name: string;
  /** The original question this run explores. */
  question: string;
  /** Catalog experiment id, or null for a custom scenario from the builder. */
  experimentId: string | null;
  modelId: string;
  params: ParamValues;
  /** Baseline parameters used for comparison (null if none). */
  baseline: ParamValues | null;
  baselineLabel?: string;
  createdAt: number;
  updatedAt: number;
  notes: string;
  tags: string[];
  collectionIds: string[];
  /** Recorded run (downsampled for storage). */
  result: RunRecord | null;
  /** Metadata for builder-created scenarios. */
  custom?: { domain: string; description?: string; duration?: number; ranges?: Record<string, [number, number]> };
}

export interface Collection {
  id: string;
  name: string;
  description: string;
  createdAt: number;
  /** Library experiment ids included directly (e.g. a lesson plan). */
  experimentIds: string[];
}

export function newId(prefix = ''): string {
  const rnd = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return prefix + rnd;
}

const experiments = observable<SavedExperiment[]>([]);
const collections = observable<Collection[]>([]);

const DEFAULT_COLLECTIONS: Omit<Collection, 'id' | 'createdAt'>[] = [
  { name: 'Space Experiments', description: 'Orbits, planets and moons.', experimentIds: [] },
  { name: 'Physics Tests', description: 'Gravity, motion and energy.', experimentIds: [] },
  { name: 'Impossible Scenarios', description: 'Things reality will not let you do.', experimentIds: [] },
  { name: 'School Projects', description: 'Runs to present or hand in.', experimentIds: [] },
  { name: 'Favorite Discoveries', description: 'Results worth revisiting.', experimentIds: [] },
];

function sortExperiments(list: SavedExperiment[]) {
  return [...list].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function initHistory() {
  experiments.set(sortExperiments(db.all<SavedExperiment>('experiments')));
  let cols = db.all<Collection>('collections');
  if (!cols.length && !db.get('kv', 'collectionsSeeded')) {
    const now = Date.now();
    cols = DEFAULT_COLLECTIONS.map((c, i) => ({ ...c, id: newId('col-'), createdAt: now + i }));
    for (const c of cols) db.put('collections', c.id, c);
    db.put('kv', 'collectionsSeeded', true);
  }
  collections.set([...cols].sort((a, b) => a.createdAt - b.createdAt));
}

export function useExperiments() {
  return useObservable(experiments);
}

export function useCollections() {
  return useObservable(collections);
}

export function getExperiments() {
  return experiments.get();
}

export function getSaved(id: string) {
  return experiments.get().find((e) => e.id === id);
}

/**
 * Reduce a run to at most `maxPoints` samples per series (always keeping the
 * first and last) so saved results stay small. Events are kept in full.
 */
export function compactRun(run: RunRecord, maxPoints = 600): RunRecord {
  const n = run.samples.t.length;
  const stride = Math.max(1, Math.ceil(n / maxPoints));
  const pick = <T,>(arr: T[]) => arr.filter((_, i) => i % stride === 0 || i === arr.length - 1);
  const tracks: RunRecord['tracks'] = {};
  for (const [id, tr] of Object.entries(run.tracks)) {
    const s = Math.max(1, Math.ceil(tr.t.length / maxPoints));
    const p = <T,>(arr: T[]) => arr.filter((_, i) => i % s === 0 || i === arr.length - 1);
    tracks[id] = { t: p(tr.t), x: p(tr.x), y: p(tr.y), z: p(tr.z) };
  }
  const round = (v: number) => (Number.isFinite(v) ? Number(v.toPrecision(7)) : v);
  return {
    ...run,
    samples: {
      t: pick(run.samples.t).map(round),
      obs: Object.fromEntries(Object.entries(run.samples.obs).map(([k, v]) => [k, pick(v).map(round)])),
    },
    tracks,
  };
}

export function saveExperiment(e: Omit<SavedExperiment, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): SavedExperiment {
  const now = Date.now();
  const existing = e.id ? getSaved(e.id) : undefined;
  const rec: SavedExperiment = {
    ...e,
    id: e.id ?? newId('exp-'),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    result: e.result ? compactRun(e.result) : null,
  };
  db.put('experiments', rec.id, rec);
  experiments.set((list) => sortExperiments([rec, ...list.filter((x) => x.id !== rec.id)]));
  return rec;
}

export function updateExperiment(id: string, patch: Partial<SavedExperiment>) {
  const cur = getSaved(id);
  if (!cur) return;
  const next = { ...cur, ...patch, id, updatedAt: Date.now() };
  db.put('experiments', id, next);
  experiments.set((list) => sortExperiments(list.map((x) => (x.id === id ? next : x))));
}

export function duplicateExperiment(id: string): SavedExperiment | undefined {
  const cur = getSaved(id);
  if (!cur) return;
  const { id: _old, createdAt: _c, updatedAt: _u, ...rest } = cur;
  return saveExperiment({ ...rest, name: `${cur.name} (copy)` });
}

export function deleteExperiment(id: string) {
  db.remove('experiments', id);
  experiments.set((list) => list.filter((x) => x.id !== id));
}

export function importExperiments(records: unknown): number {
  const arr = Array.isArray(records) ? records : [records];
  let n = 0;
  for (const r of arr) {
    if (!r || typeof r !== 'object') continue;
    const x = r as Partial<SavedExperiment>;
    if (typeof x.modelId !== 'string' || typeof x.params !== 'object' || x.params === null) continue;
    saveExperiment({
      name: String(x.name ?? 'Imported experiment'),
      question: String(x.question ?? ''),
      experimentId: typeof x.experimentId === 'string' ? x.experimentId : null,
      modelId: x.modelId,
      params: x.params as ParamValues,
      baseline: (x.baseline as ParamValues) ?? null,
      baselineLabel: x.baselineLabel,
      notes: String(x.notes ?? ''),
      tags: Array.isArray(x.tags) ? x.tags.map(String) : [],
      collectionIds: [],
      result: (x.result as RunRecord) ?? null,
      custom: x.custom,
    });
    n++;
  }
  return n;
}

export function createCollection(name: string, description = ''): Collection {
  const c: Collection = { id: newId('col-'), name: name.trim() || 'Untitled collection', description, createdAt: Date.now(), experimentIds: [] };
  db.put('collections', c.id, c);
  collections.set((list) => [...list, c]);
  return c;
}

export function updateCollection(id: string, patch: Partial<Collection>) {
  collections.set((list) =>
    list.map((c) => {
      if (c.id !== id) return c;
      const next = { ...c, ...patch, id };
      db.put('collections', id, next);
      return next;
    }),
  );
}

export function deleteCollection(id: string) {
  db.remove('collections', id);
  collections.set((list) => list.filter((c) => c.id !== id));
  for (const e of experiments.get()) {
    if (e.collectionIds.includes(id)) updateExperiment(e.id, { collectionIds: e.collectionIds.filter((c) => c !== id) });
  }
}

export function toggleInCollection(expId: string, colId: string) {
  const e = getSaved(expId);
  if (!e) return;
  const has = e.collectionIds.includes(colId);
  updateExperiment(expId, { collectionIds: has ? e.collectionIds.filter((c) => c !== colId) : [...e.collectionIds, colId] });
}

export function toggleLibraryInCollection(experimentId: string, colId: string) {
  const c = collections.get().find((x) => x.id === colId);
  if (!c) return;
  const has = c.experimentIds.includes(experimentId);
  updateCollection(colId, { experimentIds: has ? c.experimentIds.filter((x) => x !== experimentId) : [...c.experimentIds, experimentId] });
}
