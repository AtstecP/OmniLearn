/*
 * Show-saved-data-first cache. The last workspace response per subject (and the
 * subject list) is kept in IndexedDB, keyed by account id so another user on the
 * same browser never sees it. The app paints from it at once, then fetches fresh
 * data and replaces it. IndexedDB holds far more than localStorage (about 5 MB),
 * so big subjects are cached too. Everything is best effort: storage can be full,
 * blocked or empty, and then the app simply loads as before (an in-memory copy
 * still serves the current tab).
 */
const DB_NAME = "learnify-cache";
const STORE = "kv";
const VERSION = 2;
const LEGACY_PREFIX = "learnify.cache."; // the old localStorage cache

const mem = new Map<string, unknown>();
let dbp: Promise<IDBDatabase | null> | null = null;

const key = (userId: string, name: string) => `${userId}.${name}`;

function db(): Promise<IDBDatabase | null> {
  if (dbp) return dbp;
  dbp = new Promise(resolve => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  // The old localStorage entries are no longer used: free their space once.
  try { for (const k of Object.keys(localStorage)) if (k.startsWith(LEGACY_PREFIX)) localStorage.removeItem(k); } catch { /* ignore */ }
  return dbp;
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return db().then(d => new Promise<T | undefined>(resolve => {
    if (!d) return resolve(undefined);
    try {
      const tx = d.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req ? (req.result as T) : undefined);
      tx.onerror = tx.onabort = () => resolve(undefined);
    } catch { resolve(undefined); }
  }));
}

export async function cacheGet<T>(userId: string, name: string): Promise<T | null> {
  const k = key(userId, name);
  if (mem.has(k)) return mem.get(k) as T;
  try {
    const v: any = await run("readonly", s => s.get(k));
    if (v && v.v === VERSION) { if (!mem.has(k)) mem.set(k, v.data); return v.data as T; }
  } catch { /* ignore */ }
  return null;
}

export function cacheSet(userId: string, name: string, data: unknown) {
  const k = key(userId, name);
  mem.set(k, data);
  void run("readwrite", s => s.put({ v: VERSION, at: Date.now(), data }, k));
}

export function cacheDrop(userId: string, name: string) {
  const k = key(userId, name);
  mem.delete(k);
  void run("readwrite", s => s.delete(k));
}

/** Remove every cached response (sign-out, account reset, expired session). */
export function cacheClear() {
  mem.clear();
  void run("readwrite", s => s.clear());
}
