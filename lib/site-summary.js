// Pulls a rough text summary (title, meta description, first ~1200 chars of
// body text) out of a page's HTML. Carried over unchanged from the original.

export function extractSummary(html) {
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
