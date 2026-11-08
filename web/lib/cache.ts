/*
 * Show-saved-data-first cache. The last workspace response per subject (and the
 * subject list) is kept in localStorage, keyed by account id so another user on
 * the same browser never sees it. The app paints from it at once, then fetches
 * fresh data and replaces it. Everything is best effort: storage can be full,
 * blocked or empty, and then the app simply loads as before.
 */
const PREFIX = "learnify.cache.";
const VERSION = 1;

const k = (userId: string, name: string) => `${PREFIX}${userId}.${name}`;

export function cacheGet<T>(userId: string, name: string): T | null {
  try {
    const raw = localStorage.getItem(k(userId, name));
    if (!raw) return null;
    const v = JSON.parse(raw);
    return v && v.v === VERSION ? (v.data as T) : null;
  } catch { return null; }
}

export function cacheSet(userId: string, name: string, data: unknown) {
  try { localStorage.setItem(k(userId, name), JSON.stringify({ v: VERSION, at: Date.now(), data })); }
  catch { /* quota or blocked: skip */ }
}

export function cacheDrop(userId: string, name: string) {
  try { localStorage.removeItem(k(userId, name)); } catch { /* ignore */ }
}

/** Remove every cached response (sign-out, account reset, expired session). */
export function cacheClear() {
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith(PREFIX)) localStorage.removeItem(key);
  } catch { /* ignore */ }
}
