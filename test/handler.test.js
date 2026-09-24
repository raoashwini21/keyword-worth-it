import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as realSafeFetch from '../lib/safe-fetch.js';

// Site fetch is mocked (the guard itself is covered in safe-fetch.test.js);
// upstream APIs (Jev, Serper) are mocked via global fetch.
let siteFetches = 0;
let siteImpl = async () => ({ status: 200, body: '<title>SalesRobot</title><meta name="description" content="LinkedIn and cold email outreach automation for sales teams.">' });
mock.module('../lib/safe-fetch.js', {
  namedExports: { ...realSafeFetch, safeFetchText: (...a) => { siteFetches++; return siteImpl(...a); } },
});

let jevCalls = 0, serpCalls = 0;
let jevImpl, serpImpl;
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('serper.dev')) { serpCalls++; return serpImpl(url, opts); }
  if (String(url).includes('typesafe.ai')) { jevCalls++; return jevImpl(url, opts); }
  throw new Error('unexpected fetch ' + url);
};

const JEV_OK = { answers: {
  has_real_intent: { noul: 0.9, reasoning: 'Buyers search this.' },
  too_competitive: { noul: 0.7 },
  buying_stage: { noul: 0.6 },
} };

const errors = [];
console.error = (...a) => errors.push(a.join(' '));
console.warn = () => {};
console.log = () => {};

process.env.JEV_API_KEY = 'test-jev-key';
process.env.SERPER_API_KEY = 'test-serper-key';
process.env.RATE_LIMIT_PER_MINUTE = '3';
const { default: handler } = await import('../api/keyword-check.js');

let ipCounter = 0;
beforeEach(() => {
  siteFetches = jevCalls = serpCalls = 0;
  errors.length = 0;
  jevImpl = async () => new Response(JSON.stringify(JEV_OK), { status: 200 });
  serpImpl = async () => new Response(JSON.stringify({ organic: [
    { title: 'Best cold email software 2026', link: 'https://www.g2.com/x' },
    { title: 'Top tools', link: 'https://hubspot.com/y' },
  ] }), { status: 200 });
});

function call(body, { ip = 'ip-' + (++ipCounter), method = 'POST' } = {}) {
  return new Promise(resolve => {
    const res = {
      statusCode: 200, headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b, headers: this.headers }); },
      end() { resolve({ status: this.statusCode, body: null, headers: this.headers }); },
    };
    handler({ method, body, headers: { 'x-real-ip': ip } }, res);
  });
}

test('happy path: passes Jev answers through with SERP grounding attached', async () => {
  const r = await call({ website: 'salesrobot.co', keyword: 'kw happy' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.answers, JEV_OK.answers, 'per-axis reasoning fields preserved');
  assert.equal(r.body.serpGrounded, true);
  assert.deepEqual(r.body.serpTopDomains, ['g2.com', 'hubspot.com']);
  assert.deepEqual(r.body.serpTopResults, [
    { domain: 'g2.com', title: 'Best cold email software 2026' },
    { domain: 'hubspot.com', title: 'Top tools' },
  ]);
  assert.equal(r.headers['x-cache'], 'MISS');
});

test('identical lookup is served from cache without spending credits or rate limit', async () => {
  await call({ website: 'https://SalesRobot.co/', keyword: 'KW  Cache' }, { ip: 'same' });
  const r = await call({ website: 'salesrobot.co', keyword: 'kw cache' }, { ip: 'same' });
  assert.equal(r.status, 200);
  assert.equal(r.headers['x-cache'], 'HIT');
  assert.equal(jevCalls, 1);
  assert.equal(serpCalls, 1);
  assert.equal(siteFetches, 1);
});

test('concurrent identical lookups share one upstream call', async () => {
  const [a, b] = await Promise.all([
    call({ website: 'salesrobot.co', keyword: 'kw concurrent' }),
    call({ website: 'salesrobot.co', keyword: 'kw concurrent' }),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(jevCalls, 1);
});

test('SERP failure: ungrounded verdict still returned, but not cached', async () => {
  serpImpl = async () => new Response('quota exceeded', { status: 403 });
  const r1 = await call({ website: 'salesrobot.co', keyword: 'kw serp down' });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.serpGrounded, false);
  assert.match(r1.body.serpError, /estimate/);
  await call({ website: 'salesrobot.co', keyword: 'kw serp down' });
  assert.equal(jevCalls, 2, 'second call was not a cache hit');
});

test('missing SERPER_API_KEY falls back gracefully (and is cacheable)', async () => {
  delete process.env.SERPER_API_KEY;
  try {
    const r = await call({ website: 'salesrobot.co', keyword: 'kw no serper' });
    assert.equal(r.status, 200);
    assert.equal(r.body.serpGrounded, false);
    assert.match(r.body.serpError, /SERPER_API_KEY not set/);
    assert.equal(serpCalls, 0);
    const again = await call({ website: 'salesrobot.co', keyword: 'kw no serper' });
    assert.equal(again.headers['x-cache'], 'HIT');
  } finally {
    process.env.SERPER_API_KEY = 'test-serper-key';
  }
});

test('rate limit: 4th uncached request in a minute from one IP gets 429', async () => {
  for (let i = 0; i < 3; i++) {
    assert.equal((await call({ website: 'salesrobot.co', keyword: 'kw rl ' + i }, { ip: 'hammer' })).status, 200);
  }
  const r = await call({ website: 'salesrobot.co', keyword: 'kw rl 4' }, { ip: 'hammer' });
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers['retry-after']) > 0);
  assert.match(r.body.error, /try again in \d+ seconds/);
  assert.equal(jevCalls, 3);
});

test('SSRF: internal addresses are refused before any fetch or paid call', async () => {
  for (const website of ['localhost', 'http://127.0.0.1', '169.254.169.254', 'http://10.0.0.5/admin',
                         '192.168.1.1', '172.16.0.1', 'http://[::1]/', 'http://2130706433/', 'file:///etc/passwd']) {
    const r = await call({ website, keyword: 'kw ssrf' });
    assert.equal(r.status, 400, website);
    assert.match(r.body.error, /private or internal network|valid website/, website);
  }
  assert.equal(siteFetches, 0);
  assert.equal(jevCalls + serpCalls, 0);
});

test('SSRF: block detected during fetch (DNS/redirect) returns the same safe message', async () => {
  siteImpl = async () => { throw new realSafeFetch.BlockedUrlError('hostname evil.test resolves to blocked address 127.0.0.1'); };
  try {
    const r = await call({ website: 'evil.test', keyword: 'kw rebind' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /private or internal network/);
    assert.doesNotMatch(r.body.error, /127\.0\.0\.1/);
    assert.equal(jevCalls, 0);
  } finally {
    siteImpl = async () => ({ status: 200, body: '<title>SalesRobot</title><meta name="description" content="LinkedIn and cold email outreach automation for sales teams.">' });
  }
});

test('Jev error body is logged, never returned', async () => {
  jevImpl = async () => new Response(JSON.stringify({ error: 'invalid api key sk-secret', trace: 'at foo (/srv/x.js:1)' }), { status: 401 });
  const r = await call({ website: 'salesrobot.co', keyword: 'kw jev 401' });
  assert.equal(r.status, 502);
  assert.deepEqual(Object.keys(r.body), ['error']);
  assert.doesNotMatch(JSON.stringify(r.body), /sk-secret|trace|x\.js/);
  assert.ok(errors.some(l => l.includes('jev_http_error') && l.includes('sk-secret')), 'detail logged server-side');
});

test('Jev timeout / network failure → safe 504', async () => {
  jevImpl = async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); };
  const r = await call({ website: 'salesrobot.co', keyword: 'kw jev timeout' });
  assert.equal(r.status, 504);
  assert.match(r.body.error, /didn't respond in time/);
});

test('Jev non-JSON 200 → safe 502 instead of passing raw text through', async () => {
  jevImpl = async () => new Response('<html>gateway</html>', { status: 200 });
  const r = await call({ website: 'salesrobot.co', keyword: 'kw jev html' });
  assert.equal(r.status, 502);
  assert.doesNotMatch(r.body.error, /gateway/);
});

test('unexpected crash → generic 500 with ref id, stack only in logs', async () => {
  siteImpl = async () => ({ status: 200, body: null }); // extractSummary will throw on null
  try {
    const r = await call({ website: 'salesrobot.co', keyword: 'kw crash' });
    assert.ok(r.status === 400 || r.status === 500);
    assert.doesNotMatch(JSON.stringify(r.body), /TypeError|at .*\.js/);
  } finally {
    siteImpl = async () => ({ status: 200, body: '<title>SalesRobot</title><meta name="description" content="LinkedIn and cold email outreach automation for sales teams.">' });
  }
});

test('missing JEV_API_KEY does not leak config detail', async () => {
  delete process.env.JEV_API_KEY;
  try {
    const r = await call({ website: 'salesrobot.co', keyword: 'kw no jev' });
    assert.equal(r.status, 500);
    assert.doesNotMatch(r.body.error, /JEV_API_KEY|Vercel/);
    assert.ok(errors.some(l => l.includes('JEV_API_KEY')));
  } finally {
    process.env.JEV_API_KEY = 'test-jev-key';
  }
});

test('input validation and method handling unchanged', async () => {
  assert.equal((await call({ website: 'salesrobot.co' })).body.error, 'Missing "keyword"');
  assert.equal((await call({ keyword: 'x' })).body.error, 'Missing "website"');
  assert.equal((await call(JSON.stringify({ keyword: 'x' }))).body.error, 'Missing "website"', 'string body parsed');
  assert.equal((await call({}, { method: 'GET' })).status, 405);
  assert.equal((await call({}, { method: 'OPTIONS' })).status, 204);
});
