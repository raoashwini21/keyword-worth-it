import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../lib/rate-limit.js';
import { createTtlCache } from '../lib/ttl-cache.js';

test('rate limiter allows `limit` hits per window, then reports retry-after', () => {
  const rl = createRateLimiter({ limit: 3, windowMs: 60_000 });
  const t = 1_000_000;
  assert.equal(rl.check('a', t).allowed, true);
  assert.equal(rl.check('a', t + 1000).allowed, true);
  assert.equal(rl.check('a', t + 2000).allowed, true);
  const blocked = rl.check('a', t + 3000);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSec, 57);
  assert.equal(rl.check('b', t + 3000).allowed, true, 'keys are independent');
  assert.equal(rl.check('a', t + 60_001).allowed, true, 'window slides');
});

test('rate limiter bounds memory', () => {
  const rl = createRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 2 });
  rl.check('a'); rl.check('b'); rl.check('c');
  assert.equal(rl.check('a').allowed, true, 'oldest key was evicted');
});

test('ttl cache expires entries and caps size', () => {
  const c = createTtlCache({ ttlMs: 1000, maxEntries: 2 });
  c.set('a', 1, 0);
  assert.equal(c.get('a', 999), 1);
  assert.equal(c.get('a', 1000), undefined);
  c.set('x', 1, 0); c.set('y', 2, 0); c.set('z', 3, 0);
  assert.equal(c.get('x', 1), undefined);
  assert.equal(c.get('z', 1), 3);
});
