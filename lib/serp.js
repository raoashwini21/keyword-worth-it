// Fetches today's organic Google results for `keyword` via Serper.dev
// (https://serper.dev — cheap, simple JSON API). Set SERPER_API_KEY in
// Vercel's env vars to enable grounding; if it's missing or the call fails,
// this returns an empty result set and the caller falls back to an
// ungrounded (training-data-only) competitiveness judgment.
//
// Behaviour and messages carried over unchanged from the original; the only
// addition is server-side logging of the underlying failure.

export async function fetchSerp(keyword, log) {
  const serperKey = process.env.SERPER_API_KEY;
  if (!serperKey) {
    return { results: [], error: 'SERPER_API_KEY not set — competitiveness is an estimate, not checked against live results.' };
  }
  try {
    const r = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': serperKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ q: keyword, num: 10 }),
      signal: AbortSignal.timeout(6000)
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      log?.warn('serp_http_error', { status: r.status, body: detail.slice(0, 1000) });
      return { results: [], error: 'SERP lookup failed (' + r.status + ') — competitiveness is an estimate, not checked against live results.' };
    }
    const json = await r.json();
    const organic = Array.isArray(json.organic) ? json.organic : [];
    const results = organic.slice(0, 10).map(item => ({
      title: String(item.title || '').slice(0, 140),
      domain: domainFrom(item.link || ''),
      snippet: String(item.snippet || '').slice(0, 200)
    })).filter(r => r.domain);
    return { results };
  } catch (e) {
    log?.warn('serp_request_failed', { err: e });
    return { results: [], error: "Couldn't reach the SERP lookup in time — competitiveness is an estimate, not checked against live results." };
  }
}

export function domainFrom(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (e) {
    return '';
  }
}
