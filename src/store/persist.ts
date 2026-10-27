/**
 * Durable storage. IndexedDB is the primary store (large quota, survives
 * reloads); localStorage is the fallback; if neither is available the app
 * runs from memory and tells the user that nothing will persist.
 */
export type StorageBackend = 'indexeddb' | 'localstorage' | 'memory';

export const STORES = ['experiments', 'collections', 'kv'] as const;
export type StoreName = (typeof STORES)[number];

const DB_NAME = 'what-if-lab';
const DB_VERSION = 1;
const LS_PREFIX = 'whatif:';

let backend: StorageBackend = 'memory';
let db: IDBDatabase | null = null;
const memory: Record<StoreName, Map<string, unknown>> = {
  experiments: new Map(),
  collections: new Map(),
  kv: new Map(),
};
let lastError: string | null = null;

export function storageBackend(): StorageBackend {
  return backend;
}

export function storageError(): string | null {
  return lastError;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      for (const s of STORES) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
}

function lsAvailable(): boolean {
  try {
    const k = `${LS_PREFIX}__probe`;
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    return true;
  } catch {
    return false;
  }
}

/** Open storage and load every record into memory. Call once at startup. */
export async function initPersistence(): Promise<StorageBackend> {
  try {
    if (typeof indexedDB !== 'undefined') {
      db = await Promise.race([
        openDb(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('IndexedDB timed out')), 4000)),
      ]);
      for (const s of STORES) {
        const all = await idbAll(s);
        for (const [k, v] of all) memory[s].set(k, v);
      }
      backend = 'indexeddb';
      return backend;
    }
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    db = null;
  }
  if (lsAvailable()) {
    backend = 'localstorage';
    for (const s of STORES) {
      const prefix = `${LS_PREFIX}${s}:`;
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key?.startsWith(prefix)) continue;
        try {
          memory[s].set(key.slice(prefix.length), JSON.parse(localStorage.getItem(key)!));
        } catch {
          /* skip corrupt entries */
        }
      }
    }
    return backend;
  }
  backend = 'memory';
  return backend;
}

function idbAll(store: StoreName): Promise<[string, unknown][]> {
  return new Promise((resolve, reject) => {
    const tx = db!.transaction(store, 'readonly');
    const os = tx.objectStore(store);
    const out: [string, unknown][] = [];
    const req = os.openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (c) {
        out.push([String(c.key), c.value]);
        c.continue();
      } else resolve(out);
    };
    req.onerror = () => reject(req.error);
  });
}

function idbWrite(store: StoreName, key: string, value: unknown | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db!.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    if (value === undefined) os.delete(key);
    else os.put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
  });
}

export function all<T>(store: StoreName): T[] {
  return [...memory[store].values()] as T[];
}

export function get<T>(store: StoreName, key: string): T | undefined {
  return memory[store].get(key) as T | undefined;
}

type ErrorListener = (message: string) => void;
const errorListeners = new Set<ErrorListener>();
export function onStorageError(fn: ErrorListener): () => void {
  errorListeners.add(fn);
  return () => {
    errorListeners.delete(fn);
  };
}

function reportError(err: unknown) {
  const msg =
    err instanceof DOMException && err.name === 'QuotaExceededError'
      ? 'Storage is full. Delete or export older experiments to free space.'
      : `Could not save: ${err instanceof Error ? err.message : String(err)}`;
  lastError = msg;
  for (const l of errorListeners) l(msg);
}

/** Write-through put. Memory updates immediately; the durable write is async. */
export function put(store: StoreName, key: string, value: unknown) {
  // Structured clone keeps stored data independent of live objects.
  const copy = JSON.parse(JSON.stringify(value));
  memory[store].set(key, copy);
  if (backend === 'indexeddb') idbWrite(store, key, copy).catch(reportError);
  else if (backend === 'localstorage') {
    try {
      localStorage.setItem(`${LS_PREFIX}${store}:${key}`, JSON.stringify(copy));
    } catch (err) {
      reportError(err);
    }
  }
}

export function remove(store: StoreName, key: string) {
  memory[store].delete(key);
  if (backend === 'indexeddb') idbWrite(store, key, undefined).catch(reportError);
  else if (backend === 'localstorage') {
    try {
      localStorage.removeItem(`${LS_PREFIX}${store}:${key}`);
    } catch (err) {
      reportError(err);
    }
  }
}
