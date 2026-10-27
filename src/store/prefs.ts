import type { UnitSystem } from '../engine/units';
import type { ExplanationLevel } from '../engine/types';
import { observable, useObservable } from './observable';
import * as db from './persist';

export interface Prefs {
  sound: boolean;
  volume: number;
  units: UnitSystem;
  level: ExplanationLevel;
  educationMode: boolean;
  reduceMotion: boolean;
  aiEnabled: boolean;
  aiModel: string;
  /** Persist the API key on this device (otherwise it lives only for this tab session). */
  rememberKey: boolean;
  onboarded: boolean;
}

const DEFAULTS: Prefs = {
  sound: false,
  volume: 0.5,
  units: 'metric',
  level: 'intermediate',
  educationMode: false,
  reduceMotion: false,
  aiEnabled: false,
  aiModel: 'claude-opus-5-5',
  rememberKey: false,
  onboarded: false,
};

const prefs = observable<Prefs>(DEFAULTS);

export function initPrefs() {
  const saved = db.get<Partial<Prefs>>('kv', 'prefs');
  const reduce = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  prefs.set({ ...DEFAULTS, reduceMotion: reduce, ...(saved ?? {}) });
}

export function getPrefs() {
  return prefs.get();
}

export function setPrefs(patch: Partial<Prefs>) {
  prefs.set((p) => {
    const next = { ...p, ...patch };
    db.put('kv', 'prefs', next);
    return next;
  });
}

export function usePrefs() {
  return useObservable(prefs);
}

const KEY_NAME = 'whatif:anthropic-key';

/** The API key is kept out of IndexedDB records and exports. */
export function getApiKey(): string {
  try {
    return sessionStorage.getItem(KEY_NAME) ?? localStorage.getItem(KEY_NAME) ?? '';
  } catch {
    return '';
  }
}

export function setApiKey(key: string, remember: boolean) {
  try {
    sessionStorage.removeItem(KEY_NAME);
    localStorage.removeItem(KEY_NAME);
    if (!key) return;
    if (remember) localStorage.setItem(KEY_NAME, key);
    else sessionStorage.setItem(KEY_NAME, key);
  } catch {
    /* storage unavailable: key stays unset */
  }
}
