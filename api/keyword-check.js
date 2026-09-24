// Vercel serverless function — /api/keyword-check
// Fetches the given website itself (server-side, so no browser CORS issue),
// pulls out a rough text summary, pulls today's real top-10 Google results
// for the keyword (SERP grounding), and asks Jev whether the keyword is
// worth writing about for that specific site — judging competitiveness
// against the actual ranking domains, not a guess from training data.
//
// Hardening on top of the original:
//   - SSRF guard: the site fetch refuses loopback / private / link-local /
//     metadata addresses, re-checked on every redirect hop and at connect time
//     (lib/safe-fetch.js, lib/ip-policy.js).
//   - Per-IP + per-instance rate limit on requests that would spend API
//     credits (lib/rate-limit.js). In-memory: resets on cold start.
//   - 24h cache of identical (website, keyword) lookups, plus de-duplication
//     of identical requests already in flight (lib/ttl-cache.js). In-memory.
//   - Clients only ever get short, safe error messages; full detail is logged
//     server-side with a ref id (lib/log.js).
//
// Response shape on success is unchanged: Jev's JSON, plus serpGrounded,
// serpTopDomains, serpTopResults (today's top 10 as { domain, title }) and
// (if grounding failed) serpError.

import { safeFetchText, assertPublicUrl, BlockedUrlError } from '../lib/safe-fetch.js';
import { createRateLimiter } from '../lib/rate-limit.js';
import { createTtlCache } from '../lib/ttl-cache.js';
import { extractSummary } from '../lib/site-summary.js';
import { fetchSerp } from '../lib/serp.js';
import { createLogger, newRequestId } from '../lib/log.js';

const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
const JEV_TIMEOUT_MS = 25_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const envInt = (name, fallback) => {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// Module scope = shared across warm invocations of this instance only.
const perIpLimiter = createRateLimiter({ limit: envInt('RATE_LIMIT_PER_MINUTE', 5), windowMs: 60_000 });
const globalLimiter = createRateLimiter({ limit: envInt('RATE_LIMIT_GLOBAL_PER_MINUTE', 60), windowMs: 60_000 });
const cache = createTtlCache({ ttlMs: CACHE_TTL_MS, maxEntries: 500 });
const inFlight = new Map(); // cacheKey -> Promise<{ status, body, cacheable }>

// A failure whose message is safe to show the user as-is.
class PublicError extends Error {
  constructor(status, message, headers) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

export default async function handler(req, res) {
  const reqId = newRequestId();
  const log = createLogger(reqId);
  setCors(res);

  try {
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST, OPTIONS');
      throw new PublicError(405, 'Method not allowed');
    }

    const body = parseBody(req.body);
    const keyword = body.keyword ? String(body.keyword).trim().slice(0, 200) : '';
    let website = body.website ? String(body.website).trim().slice(0, 300) : '';

    if (!keyword) throw new PublicError(400, 'Missing "keyword"');
    if (!website) throw new PublicError(400, 'Missing "website"');
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(website) && !/^https?:\/\//i.test(website)) {
      throw new PublicError(400, "That doesn't look like a valid website address. Check the URL and try again.");
    }
    if (!/^https?:\/\//i.test(website)) { website = 'https://' + website; }

    let siteUrl;
    try {
      siteUrl = assertPublicUrl(website);
    } catch (e) {
      log.warn('website_rejected', { website, reason: e.message });
      throw new PublicError(400, blockedMessage(e));
    }
    siteUrl.hash = '';

    // 1. Cache: identical lookups within 24h cost nothing and skip the limiter.
    const cacheKey = JSON.stringify([siteUrl.href, keyword.toLowerCase().replace(/\s+/g, ' ')]);
    const cached = cache.get(cacheKey);
    if (cached) {
      log.info('cache_hit', { website: siteUrl.href, keyword });
      res.setHeader('X-Cache', 'HIT');
      res.status(200).json(cached);
      return;
    }

    // 2. Same lookup already running (double-click, retry)? Share its result.
    let pending = inFlight.get(cacheKey);
    if (pending) {
      log.info('joined_in_flight', { website: siteUrl.href, keyword });
    } else {
      // 3. Rate limit — only requests that will actually spend API credits.
      const ip = clientIp(req);
      for (const [limiter, key, scope] of [[perIpLimiter, ip, 'ip'], [globalLimiter, 'global', 'global']]) {
        const { allowed, retryAfterSec } = limiter.check(key);
        if (!allowed) {
          log.warn('rate_limited', { ip, scope, retryAfterSec });
          throw new PublicError(429,
            "You're checking keywords faster than we can keep up — try again in " + retryAfterSec + ' seconds.',
            { 'Retry-After': String(retryAfterSec) });
        }
      }

      pending = (async () => {
        try {
          const result = await runCheck(siteUrl.href, keyword, log);
          if (result.cacheable) cache.set(cacheKey, result.body);
          return result;
        } finally {
          // Cleared before the promise settles, so no later request can join
          // a finished run and bypass the cache rules above.
          inFlight.delete(cacheKey);
        }
      })();
      inFlight.set(cacheKey, pending);
    }

    const result = await pending;
    res.setHeader('X-Cache', 'MISS');
    res.status(200).json(result.body);
  } catch (err) {
    if (err instanceof PublicError) {
      for (const [k, v] of Object.entries(err.headers || {})) res.setHeader(k, v);
      res.status(err.status).json({ error: err.message });
      return;
    }
    log.error('unhandled_error', { err });
    res.status(500).json({ error: 'Something went wrong on our side. Try again in a moment. (ref ' + reqId + ')' });
  }
}

// The actual check. Returns { body, cacheable } or throws PublicError.
async function runCheck(website, keyword, log) {
  const apiKey = process.env.JEV_API_KEY;
  if (!apiKey) {
    log.error('config_missing', { detail: 'JEV_API_KEY is not set — add it in Vercel > Project > Settings > Environment Variables.' });
    throw new PublicError(500, "The checker isn't configured yet. Try again later.");
  }

  // 1. Fetch the site's HTML and pull a rough text summary out of it.
  let siteSummary = '';
  try {
    const page = await safeFetchText(website, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KeywordCheckBot/1.0)' },
      timeoutMs: 8000,
    });
    siteSummary = extractSummary(page.body);
  } catch (e) {
    if (e instanceof BlockedUrlError) {
      log.warn('website_blocked', { website, reason: e.message });
      throw new PublicError(400, blockedMessage(e));
    }
    log.warn('website_fetch_failed', { website, err: e });
    throw new PublicError(400, "Couldn't fetch that website. Check the URL and try again (some sites block automated visits).");
  }

  if (!siteSummary || siteSummary.length < 40) {
    throw new PublicError(400, "Fetched the page but couldn't find enough readable text on it (it may be a JS-heavy site). Try pasting a different page from the same site, like an About or Product page.");
  }

  // 2. Pull today's real top-10 Google results for the keyword (SERP grounding).
  // Without this, "too competitive" is Jev guessing from training data instead
  // of looking at who's actually ranking right now. Degrades gracefully: if
  // SERPER_API_KEY isn't set or the call fails, we fall back to an ungrounded
  // judgment and say so in the response (`serpGrounded: false`) rather than
  // failing the whole request.
  const serp = await fetchSerp(keyword, log);

  // 3. Ask Jev whether this keyword is worth writing about, given that site
  //    and (when available) the real competitive field.
  const serpBlock = serp.results.length
    ? "\n\nToday's actual top " + serp.results.length + ' Google results for this exact keyword:\n' +
      serp.results.map((r, i) => (i + 1) + '. ' + r.domain + ' — "' + r.title + '"').join('\n')
    : '';

  const competitiveInstructions = serp.results.length
    ? 'Look at the actual list of top-ranking domains and titles given above for this keyword. Judge whether they are large, established, highly authoritative sites (major brands, big media, category leaders) that would make it genuinely hard for a newer or smaller site to reach page one — versus a field with smaller sites, forums, or weaker content a focused new post could realistically outrank.'
    : 'This keyword is so broad, generic, or highly competitive (dominated by large established sites) that a smaller or newer site has little realistic chance of ranking on page one for it.';

  let jevRes;
  try {
    jevRes = await fetch(JEV_URL, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'jev-latest',
        state: {
          message: 'Website summary: "' + siteSummary + '"\n\nCandidate keyword/topic to write a blog post about: "' + keyword + '"' + serpBlock
        },
        questions: {
          has_real_intent: {
            type: 'noul',
            instructions: 'Someone searching this exact keyword actually has the problem or need that the described website/product solves — not just casual curiosity, a different meaning of the term, or an unrelated use case.'
          },
          too_competitive: {
            type: 'noul',
            instructions: competitiveInstructions
          },
          buying_stage: {
            type: 'noul',
            instructions: 'Someone searching this keyword is relatively close to evaluating or buying a solution like this, rather than just doing early, general-purpose learning or awareness research.'
          }
        }
      }),
      signal: AbortSignal.timeout(JEV_TIMEOUT_MS)
    });
  } catch (e) {
    log.error('jev_request_failed', { err: e });
    throw new PublicError(504, "The verdict service didn't respond in time. Try again in a moment.");
  }

  const text = await jevRes.text().catch(e => {
    log.error('jev_body_read_failed', { err: e });
    return '';
  });

  if (!jevRes.ok) {
    log.error('jev_http_error', { status: jevRes.status, body: text.slice(0, 2000) });
    if (jevRes.status === 429) {
      throw new PublicError(503, 'The verdict service is busy right now. Try again in a minute.');
    }
    throw new PublicError(502, 'The verdict service had a problem with that request. Try again in a minute.');
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    log.error('jev_bad_json', { body: text.slice(0, 2000) });
    throw new PublicError(502, 'The verdict service sent back something unreadable. Try again in a minute.');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    log.error('jev_unexpected_shape', { body: text.slice(0, 2000) });
    throw new PublicError(502, 'The verdict service sent back something unreadable. Try again in a minute.');
  }

  // Attach SERP grounding metadata so the frontend can show what the verdict
  // was actually checked against (or be honest that it wasn't).
  data.serpGrounded = serp.results.length > 0;
  data.serpTopDomains = serp.results.slice(0, 5).map(r => r.domain);
  data.serpTopResults = serp.results.map(r => ({ domain: r.domain, title: r.title }));
  if (serp.error) data.serpError = serp.error;

  // Don't pin a transient SERP outage into the cache for 24h — only cache
  // grounded verdicts, or ungrounded ones when grounding is switched off.
  const cacheable = data.serpGrounded || !process.env.SERPER_API_KEY;

  log.info('check_complete', { website, keyword, serpGrounded: data.serpGrounded, cacheable });
  return { body: data, cacheable };
}

function blockedMessage(e) {
  return /invalid URL|missing hostname/.test(e.message)
    ? "That doesn't look like a valid website address. Check the URL and try again."
    : "That address points to a private or internal network, so it can't be checked. Use a public website URL.";
}

function parseBody(raw) {
  if (raw && typeof raw === 'object' && !Buffer.isBuffer(raw)) return raw;
  const str = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw;
  if (typeof str === 'string' && str.trim()) {
    try {
      const parsed = JSON.parse(str);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (e) { /* fall through */ }
  }
  return {};
}

// On Vercel, x-real-ip / x-forwarded-for are set by the edge (client-supplied
// values are overwritten), so they're safe to key the limiter on there.
function clientIp(req) {
  const h = req.headers || {};
  const real = h['x-real-ip'];
  if (typeof real === 'string' && real.trim()) return real.trim();
  const xff = h['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// Defaults to '*' (the original behaviour). Set ALLOWED_ORIGIN to your own
// domain to stop other sites' pages from calling this from visitors' browsers.
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
}
