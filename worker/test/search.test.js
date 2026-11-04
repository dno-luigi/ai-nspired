import test from "node:test";
import assert from "node:assert/strict";
import { rankSources, buildSourceBlock, webSearch, isAuthoritative } from "../src/lib/search.js";

const item = (url, authoritative = isAuthoritative(url)) => ({
  url,
  title: url,
  description: "x".repeat(10),
  authoritative
});

test("two sources per query per audit is what gets requested", async () => {
  const calls = [];
  const env = {
    SEARCH_PROVIDER: "ceramic",
    AI_GATEWAY_ID: "truth",
    AI: {
      websearch: async (args) => {
        calls.push(args);
        return new Response(
          JSON.stringify({
            items: [
              { url: "https://courtlistener.com/a", title: "A", description: "d" },
              { url: "https://courtlistener.com/b", title: "B", description: "d" }
            ],
            metadata: { latencyMs: 12, requestId: "r1" }
          }),
          { status: 200 }
        );
      }
    }
  };

  const result = await webSearch("eviction notice", env);

  assert.equal(calls[0].limit, 2);
  assert.equal(calls[0].provider, "ceramic");
  assert.equal(result.failed, false);
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].authoritative, true);
  // byokAlias is deliberately absent: omitting it bills credits instead of
  // failing the request when a provider key is missing.
  assert.equal("byokAlias" in calls[0], false);
});

test("a provider failure is reported, not thrown", async () => {
  const env = {
    SEARCH_PROVIDER: "ceramic",
    AI: { websearch: async () => new Response("nope", { status: 500 }) }
  };

  const result = await webSearch("query", env);

  assert.equal(result.failed, true);
  assert.deepEqual(result.items, []);
});

test("authoritative sources win and the cap still applies", () => {
  const items = [
    item("https://blog.example.com/x", false),
    item("https://courtlistener.com/a", true),
    item("https://law.justia.com/b", true)
  ];

  const ranked = rankSources(items);

  assert.equal(ranked.length, 2);
  assert.equal(ranked.every((entry) => entry.authoritative), true);
});

test("when nothing is authoritative the set is kept rather than emptied", () => {
  const ranked = rankSources([item("https://blog.example.com/x", false)]);
  assert.equal(ranked.length, 1);
});

test("only .gov and the listed legal hosts count as authoritative", () => {
  assert.equal(isAuthoritative("https://www.courtlistener.com/opinion/1"), true);
  assert.equal(isAuthoritative("https://www.uscourts.gov/rules"), true);
  assert.equal(isAuthoritative("https://example.com/legal-blog"), false);
  assert.equal(isAuthoritative("not a url"), false);
});

test("source excerpts are truncated hard", () => {
  const block = buildSourceBlock(
    [{ url: "https://a.gov/x", title: "Order", description: "y".repeat(4000) }],
    { MAX_SOURCE_CHARS: "100" }
  );

  assert.ok(block.includes("…"));
  assert.ok(block.length < 600);
});
