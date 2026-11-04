/**
 * Browser Run extraction. Only used when a snippet is not enough, because
 * browser time is the scarce resource: 10 hours/month on Workers Paid.
 */

const ACTION = "markdown";

export async function fetchMarkdown(url, env) {
  if (!env.BROWSER) return null;

  const timeoutMs = 12000;
  let timer;
  try {
    const work = env.BROWSER.quickAction(ACTION, { url });
    work.catch?.(() => {}); // avoid an unhandled rejection if the race loses

    const raced = await Promise.race([
      work,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      })
    ]);

    if (!raced) {
      console.error("browser_timeout", { url });
      return null;
    }

    const text =
      typeof raced === "string" ? raced : await new Response(raced).text();

    const maxChars = Number(env.MAX_PAGE_CHARS || 6000);
    const cleaned = text.trim();
    return {
      url,
      markdown: cleaned.length > maxChars ? `${cleaned.slice(0, maxChars)}…` : cleaned,
      truncated: cleaned.length > maxChars
    };
  } catch (err) {
    console.error("browser_extract_failed", { url, message: err?.message });
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Expands the top N authoritative sources. Failures are dropped, not fatal:
 * the author still gets the snippets.
 */
export async function expandTopSources(items, env) {
  const budget = Math.min(Math.max(Number(env.MAX_BROWSER_URLS || 2), 0), 3);
  if (budget === 0) return [];

  const targets = items.filter((item) => item.authoritative).slice(0, budget);
  if (targets.length === 0) return [];

  const pages = await Promise.all(targets.map((item) => fetchMarkdown(item.url, env)));
  return pages.filter(Boolean);
}
