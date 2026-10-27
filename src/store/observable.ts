import { useSyncExternalStore } from 'react';

/** Tiny observable value with a React hook. */
export interface Observable<T> {
  get(): T;
  set(next: T | ((prev: T) => T)): void;
  subscribe(fn: () => void): () => void;
}

export function observable<T>(initial: T): Observable<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      value = typeof next === 'function' ? (next as (p: T) => T)(value) : next;
      for (const l of listeners) l();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

export function useObservable<T>(o: Observable<T>): T {
  return useSyncExternalStore(o.subscribe, o.get, o.get);
}
