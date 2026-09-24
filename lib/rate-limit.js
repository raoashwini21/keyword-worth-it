// In-memory sliding-window rate limiter.
//
// CAVEAT: state lives in this serverless instance's memory. It resets on every
// cold start, and when the platform runs several instances in parallel each
// one keeps its own counts — so the effective limit can be a multiple of the
// configured one. It stops casual abuse and runaway scripts; it is not
// airtight. For a real shared limit, back this with Upstash Redis
// (@upstash/ratelimit, free tier) — same check(key) shape.

export function createRateLimiter({ limit, windowMs, maxKeys = 10_000 }) {
  const hits = new Map(); // key -> ascending array of hit timestamps

  return {
    // Records a hit for `key` if allowed. Returns { allowed, retryAfterSec }.
    check(key, now = Date.now()) {
      const cutoff = now - windowMs;
      let stamps = hits.get(key) || [];
      if (stamps.length && stamps[0] <= cutoff) stamps = stamps.filter(t => t > cutoff);

      if (stamps.length >= limit) {
        hits.set(key, stamps);
        const retryAfterSec = Math.max(1, Math.ceil((stamps[0] + windowMs - now) / 1000));
        return { allowed: false, retryAfterSec };
      }

      stamps.push(now);
      // Re-insert so Map order approximates least-recently-seen first.
      hits.delete(key);
      hits.set(key, stamps);
      while (hits.size > maxKeys) hits.delete(hits.keys().next().value);
      return { allowed: true, retryAfterSec: 0 };
    },
  };
}
