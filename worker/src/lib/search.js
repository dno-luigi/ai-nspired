/**
 * Cloudflare Web Search API, plus the domain filtering it does not do.
 *
 * The request accepts only query/provider/limit/byokAlias. There is no
 * include_domains, so authority filtering happens here, in code, where it is
 * testable. Costs: ceramic $0.25/1k, linkup $5/1k, exa $7/1k.
 */

/** Hosts we consider primary authority. Suffix match, so *.gov and *.us courts work. */
const AUTHORITY_SUFFIXES = [
  ".gov",
  ".gov.uk",
  "courtlistener.com",
  "law.justia.com",
  "casetext.com",
  "anylaw.com",
  "leg.state.fl.us",
  "leginfo.legislature.ca.gov",
  "ncleg.gov",
  "texas.public.law",
  "nycourts.gov",
  "supreme.justia.com"
];

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function isAuthoritative(url) {
  const host = hostOf(url);
  if (!host) return false;
  if (host === "gov" || host.endsWith(".gov")) return true;
  return AUTHORITY_SUFFIXES.some((suffix) => host === suffix || host.endsWith(suffix));
}

/**
 * Calls the search provider and normalizes the result.
 * Returns { items, provider, latencyMs, requestId }.
 */
export async function webSearch(query, env, { limit } = {}) {
  const gatewayId = env.AI_GATEWAY_ID || "default";
  const provider = env.SEARCH_PROVIDER || "ceramic";
  const requested = Number(limit ?? env.SEARCH_LIMIT ?? 2);
  // The API rejects anything above 10. We ask for two per query per audit.
  const capped = Math.min(Math.max(Math.trunc(requested) || 2, 1), 10);

  const response = await env.AI.websearch({
    gatewayId,
    query: String(query || "").slice(0, 1024),
    provider,
    limit: capped
    // byokAlias deliberately omitted: omitting it bills AI Gateway credits,
    // and setting one that is not configured fails the request outright.
  });

  if (!response?.ok) {
    const detail = await response.text().catch(() => "");
    console.error("websearch_error", { status: response?.status, detail: detail.slice(0, 400) });
    return { items: [], provider, latencyMs: null, requestId: null, failed: true };
  }

  const data = await response.json();
  const items = Array.isArray(data?.items) ? data.items : [];

  return {
    items: items
      .filter((item) => item && typeof item.url === "string")
      .map((item) => ({
        url: item.url,
        title: String(item.title || hostOf(item.url) || item.url).slice(0, 200),
        description: String(item.description || ""),
        authoritative: isAuthoritative(item.url)
      })),
    provider,
    latencyMs: data?.metadata?.latencyMs ?? null,
    requestId: data?.metadata?.requestId ?? null,
    failed: false
  };
}

/**
 * Prefer authority. If nothing in the result set is authoritative we keep the
 * whole set rather than returning nothing, because a broad question about an
 * unfamiliar area would otherwise leave the author with no sources at all.
 * Defaults to two, matching SEARCH_LIMIT: two sources per query per audit.
 */
export function rankSources(items, limit = 2) {
  const authoritative = items.filter((item) => item.authoritative);
  const pool = authoritative.length > 0 ? authoritative : items;
  return pool.slice(0, limit);
}

/**
 * Truncation is the real cost control, not provider choice. A Ceramic
 * description can run to 8000 characters; two of those is ~4k input tokens.
 * 1200 chars keeps the useful sentence or two and nothing else.
 */
export function buildSourceBlock(items, env) {
  const maxChars = Number(env.MAX_SOURCE_CHARS || 1200);
  return items
    .map((item, index) => {
      const body = item.description.length > maxChars
        ? `${item.description.slice(0, maxChars).trim()}…`
        : item.description.trim();
      return [
        `[S${index + 1}] ${item.title}`,
        `URL: ${item.url}`,
        `Accessed: ${new Date().toISOString().slice(0, 10)}`,
        body ? `Excerpt: ${body}` : "Excerpt: (none returned)"
      ].join("\n");
    })
    .join("\n\n");
}
