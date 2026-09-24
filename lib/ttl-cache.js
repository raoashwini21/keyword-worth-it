// Small in-memory TTL cache with a size cap (oldest entries evicted first).
//
// CAVEAT: like the rate limiter, this lives in one serverless instance's
// memory — it's empty after a cold start and not shared between parallel
// instances, so some repeat lookups will still spend API credits. Upstash
// Redis (SET key value EX 86400) is the drop-in upgrade if that matters.

export function createTtlCache({ ttlMs, maxEntries = 500 }) {
  const entries = new Map(); // key -> { value, expiresAt }

  return {
    get(key, now = Date.now()) {
      const hit = entries.get(key);
      if (!hit) return undefined;
      if (hit.expiresAt <= now) {
        entries.delete(key);
        return undefined;
      }
      return hit.value;
    },
    set(key, value, now = Date.now()) {
      entries.delete(key);
      entries.set(key, { value, expiresAt: now + ttlMs });
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    },
    get size() { return entries.size; },
  };
}
