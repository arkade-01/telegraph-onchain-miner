// Tiny in-process TTL cache.
//
// Why this matters for ranking: validators probe repeatedly, and a gas price is
// only meaningful once per block. Serving a 2s-old cached answer is both *more
// correct* (same block) and ~10x faster than a fresh RPC round trip.
//
// Enablement is read LAZILY, not at import time: ESM imports hoist above any
// `process.env.NODE_ENV = ...` a test file sets, so a module-load-time constant
// would silently leave the cache on during tests.

const MAX_ENTRIES = Number(process.env.CACHE_MAX_ENTRIES || 5000);

const isEnabled = () =>
  process.env.NODE_ENV !== 'test' && process.env.CACHE_DISABLED !== '1';

const store = new Map(); // key -> { value, expiresAt }

function prune() {
  const now = Date.now();
  for (const [k, v] of store) {
    if (v.expiresAt <= now) store.delete(k);
  }
  // hard cap: drop oldest insertions first (Map preserves insertion order)
  while (store.size > MAX_ENTRIES) {
    store.delete(store.keys().next().value);
  }
}

export function cacheGet(key) {
  if (!isEnabled()) return undefined;
  const hit = store.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt <= Date.now()) {
    store.delete(key);
    return undefined;
  }
  return hit.value;
}

export function cacheSet(key, value, ttlMs) {
  if (!isEnabled() || !ttlMs) return value;
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
  if (store.size % 100 === 0) prune();
  return value;
}

export function cacheClear() {
  store.clear();
}

export const cacheStats = () => ({ enabled: isEnabled(), size: store.size });

/**
 * Cache-aside wrapper.
 *
 * `meta` holds per-REQUEST fields that must never be served stale from a
 * previous caller's request (how this caller's params were resolved, how long
 * this call took). The cached body is the answer; the metadata is refreshed.
 */
export async function withCache(key, ttlMs, producer, meta = {}) {
  const hit = cacheGet(key);
  if (hit !== undefined) {
    return { ...hit, ...meta, cached: true, latency_ms: 0 };
  }

  const value = await producer();
  // Never cache failures (a transient RPC error must not stick) and honour an
  // explicit opt-out (e.g. a still-pending transaction).
  if (value && value.ok && !value.__noCache) cacheSet(key, value, ttlMs);
  if (value && value.__noCache) delete value.__noCache;
  return value;
}
