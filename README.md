# keyword-worth-it
Paste a website + keyword, get back the search result it would actually become. Checks real intent, buying stage, and today's actual top-10 competition via live SERP data - before you spend hours writing a post that was never going to rank. Verdict: Write it, Skip it, Long shot, or Maybe.

## Layout

| Path | What it is |
| --- | --- |
| `index.html` | The whole frontend: query bar, fake search snippet, verdict stamp, verdict logic, per-axis reasoning display. |
| `api/keyword-check.js` | Vercel serverless function: fetch site → Serper top-10 → Jev verdict. |
| `lib/safe-fetch.js`, `lib/ip-policy.js` | SSRF-guarded fetch of the user-supplied website. |
| `lib/rate-limit.js`, `lib/ttl-cache.js` | In-memory rate limiter and 24h result cache. |
| `lib/serp.js`, `lib/site-summary.js` | Serper.dev grounding and HTML → text summary (unchanged from the original). |
| `lib/log.js` | Structured server-side logs with a per-request ref id. |

## Environment variables (Vercel → Project → Settings → Environment Variables)

| Name | Required | Default | Purpose |
| --- | --- | --- | --- |
| `JEV_API_KEY` | yes | — | Jev (api.typesafe.ai) key. |
| `SERPER_API_KEY` | no | — | Enables live top-10 grounding. Without it, competition is an estimate and the UI says so. |
| `RATE_LIMIT_PER_MINUTE` | no | `5` | Uncached checks allowed per IP per minute. |
| `RATE_LIMIT_GLOBAL_PER_MINUTE` | no | `60` | Uncached checks allowed per minute across all IPs (per instance) — a backstop against IP rotation. |
| `ALLOWED_ORIGIN` | no | `*` | CORS origin. Set to your own domain (e.g. `https://keyword-worth-it.vercel.app`) so other sites can't call the API from their visitors' browsers. |

## Protections

- **SSRF:** the site fetch only allows http/https on default ports, no `user:pass@`, and refuses any
  address in loopback, private (10/8, 172.16/12, 192.168/16), link-local / cloud metadata
  (169.254/16, fd00:ec2::254), CGNAT, multicast, reserved or IPv6-embedded-IPv4 equivalents.
  The check runs on the exact IP at connect time and again on every redirect hop, so DNS
  rebinding and "public page redirects to 169.254.169.254" are both covered. Bodies are capped at 1 MB.
- **Rate limit:** per-IP and per-instance sliding window on requests that would spend API credits.
  Cache hits don't count. Over-limit requests get `429` + `Retry-After`.
- **Cache:** identical (website, keyword) lookups are served from memory for 24h (`X-Cache: HIT`),
  and identical requests already in flight share one upstream call. Verdicts made while Serper was
  failing are *not* cached, so a transient outage doesn't pin an ungrounded answer for a day.
- **Errors:** clients only ever get a short `{ "error": "..." }`. Upstream bodies, stack traces and
  config problems are logged server-side (Vercel → Logs) as JSON with a `reqId`; 5xx messages
  include `ref <reqId>` so a user report can be matched to the log line.

### ⚠️ In-memory limits aren't airtight

The rate limiter and cache live in the serverless instance's memory. They **reset on every cold
start**, and parallel instances each keep their own counts, so the real ceiling can be a multiple
of the configured one and some repeat lookups will still spend credits. This stops casual abuse
and accidental hammering, not a determined attacker.

The real fix is a shared store: **[Upstash Redis](https://upstash.com)** (free tier, one-click Vercel
integration) with `@upstash/ratelimit` for the limiter and `SET key value EX 86400` for the cache.
Both modules expose small interfaces (`check(key)`, `get/set`) so they can be swapped without
touching the handler. Also worth setting a hard monthly spend cap on the Jev and Serper dashboards.

## Tests

```
npm test
```

Node ≥ 22.3 (uses the built-in test runner with module mocks; no dependencies).
