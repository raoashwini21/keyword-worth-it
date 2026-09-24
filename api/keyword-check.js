// Vercel serverless function — /api/keyword-check
// Fetches the given website itself (server-side, so no browser CORS issue),
// pulls out a rough text summary, pulls today's real top-10 Google results
// for the keyword (SERP grounding), and asks Jev whether the keyword is
// worth writing about for that specific site — judging competitiveness
// against the actual ranking domains, not a guess from training data.

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const body = req.body || {};
  const keyword = body.keyword ? String(body.keyword).trim().slice(0, 200) : '';
  let website = body.website ? String(body.website).trim().slice(0, 300) : '';

  if (!keyword) { res.status(400).json({ error: 'Missing "keyword"' }); return; }
  if (!website) { res.status(400).json({ error: 'Missing "website"' }); return; }
  if (!/^https?:\/\//i.test(website)) { website = 'https://' + website; }

  const apiKey = process.env.JEV_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Server is missing JEV_API_KEY — set it in Vercel > Project > Settings > Environment Variables.' });
    return;
  }

  // 1. Fetch the site's HTML and pull a rough text summary out of it.
  let siteSummary = '';
  try {
    const siteRes = await fetch(website, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KeywordCheckBot/1.0)' },
      signal: AbortSignal.timeout(8000)
    });
    const html = await siteRes.text();
    siteSummary = extractSummary(html);
  } catch (e) {
    res.status(400).json({ error: "Couldn't fetch that website. Check the URL and try again (some sites block automated visits)." });
    return;
  }

  if (!siteSummary || siteSummary.length < 40) {
    res.status(400).json({ error: "Fetched the page but couldn't find enough readable text on it (it may be a JS-heavy site). Try pasting a different page from the same site, like an About or Product page." });
    return;
  }

  // 2. Pull today's real top-10 Google results for the keyword (SERP grounding).
  // Without this, "too competitive" is Jev guessing from training data instead
  // of looking at who's actually ranking right now. Degrades gracefully: if
  // SERPER_API_KEY isn't set or the call fails, we fall back to an ungrounded
  // judgment and say so in the response (`serpGrounded: false`) rather than
  // failing the whole request.
  const serp = await fetchSerp(keyword);

  // 3. Ask Jev whether this keyword is worth writing about, given that site
  //    and (when available) the real competitive field.
  const serpBlock = serp.results.length
    ? "\n\nToday's actual top " + serp.results.length + ' Google results for this exact keyword:\n' +
      serp.results.map((r, i) => (i + 1) + '. ' + r.domain + ' — "' + r.title + '"').join('\n')
    : '';

  const competitiveInstructions = serp.results.length
    ? 'Look at the actual list of top-ranking domains and titles given above for this keyword. Judge whether they are large, established, highly authoritative sites (major brands, big media, category leaders) that would make it genuinely hard for a newer or smaller site to reach page one — versus a field with smaller sites, forums, or weaker content a focused new post could realistically outrank.'
    : 'This keyword is so broad, generic, or highly competitive (dominated by large established sites) that a smaller or newer site has little realistic chance of ranking on page one for it.';

  const jevRes = await fetch('https://api.typesafe.ai/v1/systemone', {
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
    })
  });

  const text = await jevRes.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }

  if (!jevRes.ok) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(jevRes.status).json(data);
    return;
  }

  // Attach SERP grounding metadata so the frontend can show what the verdict
  // was actually checked against (or be honest that it wasn't).
  data.serpGrounded = serp.results.length > 0;
  data.serpTopDomains = serp.results.slice(0, 5).map(r => r.domain);
  if (serp.error) data.serpError = serp.error;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json(data);
}

// Fetches today's organic Google results for `keyword` via Serper.dev
// (https://serper.dev — cheap, simple JSON API). Set SERPER_API_KEY in
// Vercel's env vars to enable grounding; if it's missing or the call fails,
// this returns an empty result set and the caller falls back to an
// ungrounded (training-data-only) competitiveness judgment.
async function fetchSerp(keyword) {
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
    return { results: [], error: "Couldn't reach the SERP lookup in time — competitiveness is an estimate, not checked against live results." };
  }
}

function domainFrom(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (e) {
    return '';
  }
}

function extractSummary(html) {
  // Strip script/style blocks entirely.
  let cleaned = html.replace(/<script[\s\S]*?<\/script>/gi, ' ')
                     .replace(/<style[\s\S]*?<\/style>/gi, ' ');

  const titleMatch = cleaned.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const descMatch = cleaned.match(/<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["']/i)
                  || cleaned.match(/<meta[^>]+content=["']([\s\S]*?)["'][^>]+name=["']description["']/i);
  const ogDescMatch = cleaned.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([\s\S]*?)["']/i);

  const title = titleMatch ? decodeEntities(titleMatch[1]).trim() : '';
  const description = descMatch ? decodeEntities(descMatch[1]).trim() : (ogDescMatch ? decodeEntities(ogDescMatch[1]).trim() : '');

  // Strip remaining tags to get rough body text, collapse whitespace.
  const bodyText = decodeEntities(cleaned.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1200);

  const parts = [];
  if (title) parts.push('Title: ' + title);
  if (description) parts.push('Description: ' + description);
  if (bodyText) parts.push('Page text: ' + bodyText);

  return parts.join('\n').slice(0, 1800);
}

function decodeEntities(str) {
  return String(str)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}
