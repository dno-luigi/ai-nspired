# Truth Engine Worker

Backend for Truth Engine. Replaces the single-file `worker.js` with a
structured project: triage, grounding, generation, and a human-ratified
knowledge pipeline.

## Naming

- **ai-Nspired** — the brand.
- **ai.nspired** — where this Worker lives.
- **i.nspired** — the front end that calls it.

```
request
  └─ origin + Turnstile + daily cap
      └─ clef-flash triage ......... domain, urgency, needs-search, UPL risk, PII
          └─ web search ............ env.AI.websearch(), Ceramic, authority-ranked
              └─ extraction ........ Browser Run markdown, 2 URLs max
                  └─ approved knowledge (keyword retrieval)
                      └─ author ......... OpenRouter via AI Gateway, or Workers AI
                          └─ SSE frames + provenance trace, owned by this Worker
                              └─ candidate ... human approves before it is knowledge
```

## Why it is built this way

**The prompt and model are server-side.** The old design accepted `model`,
`preset` and `api_key` from the request body, which meant anyone with `curl`
could run any model on your OpenRouter balance. Now the client sends a `mode`
name from a fixed allowlist and nothing else. Sending `model`, `api_key`,
`preset_id` or `provider` returns `400 unsupported_parameter` on purpose, so
the lockdown is visible rather than silently ignored.

**Search is Cloudflare-native and provider-pinned.** `env.AI.websearch()` takes
an explicit `provider`, so there is no fallback engine and therefore no silent
cost change. Ceramic is $0.25 per 1,000 requests and supports zero data
retention; Exa is $7.00 and does not.

**Candidates are not knowledge.** Every substantive turn writes a candidate.
Only a named expert approval promotes it, which sets confidence to 0.90, with
+0.02 per additional approval capped at 0.95. The model never sets its own
confidence. Turns containing hard identifiers, or flagged as UPL risk, are
never candidated at all.

**The Worker owns the stream.** Vendors are not piped through. Frames are a
fixed contract, which is what makes sources, phases and clean errors possible.

## Stream contract (stable at `/v1`)

```
event: status   data: {"phase":"triage"|"triage_done"|"search"|"extract"|"generate"|"boundary"|"search_failed","detail":...}
event: sources  data: {"items":[{"title":"...","url":"..."}]}
event: delta    data: {"text":"..."}
event: done     data: {"auditId":"uuid","mode":"audit","usage":{...},"trace":{"entries":[...],"totalMs":4100}}
event: error    data: {"code":"...","message":"..."}
```

`done` and `error` are terminal. A stream that ends without one was cut by
something in the middle; the client should treat that as an error, not a
finished answer.

`trace` is the provenance record: one entry per stage, carrying what the stage
did or why it was skipped (`search_failed`, `search_disabled`, `draft_withheld`,
`triage` with `degraded: true`). It is also stored with the audit, so a
permalink can show it later. Without it a report is either grounded or guessed
and the reader cannot tell which.

`worker/client/client.js` implements both: frames, Turnstile, cancellation and
`describeTrace()` for the one-line provenance strip under an answer.

## Setup

You need an AI Gateway (every account has one named `default`) with credits
loaded, or a provider key stored on the gateway under Provider Keys.

```bash
cd worker
npm install

# 1. Create the five KV namespaces and the R2 bucket.
npx wrangler kv namespace create AUDITS
npx wrangler kv namespace create CONTEXT_STORE
npx wrangler kv namespace create KNOWLEDGE_INDEX
npx wrangler kv namespace create RATE_LIMIT
npx wrangler kv namespace create SETTINGS
npx wrangler r2 bucket create truth-engine-knowledge

# 2. Paste the returned ids into wrangler.jsonc, and set CF_ACCOUNT_ID.
#    Inside a Worker the AI binding needs no token, so there is no
#    Cloudflare API key in this codebase at all.

# 3. Secrets. Never put these in wrangler.jsonc.
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler secret put TURNSTILE_SECRET
npx wrangler secret put ADMIN_SECRET
npx wrangler secret put KEY          # writes the runtime switches

# 4. Local dev.
cp .dev.vars.example .dev.vars   # fill it in, it is gitignored
npm run dev

# 5. Ship.
npm test         # 40 offline tests, no network, no credentials
npm run check    # dry-run bundle, no deploy
npm run deploy
```

`CONTEXT_STORE` is reserved for follow-up memory and is not written yet; keep
it so enabling that later does not need a config change.

## Front-end changes this requires

Three things in the front-end integration will start returning errors, all on
purpose:

1. **Turnstile.** Send the token as the `x-turnstile-token` header or as
   `turnstileToken` in the body. Without it every request is `403`.
2. **`mode` instead of `preset`.** `engine.html` sends `preset: "truth"`. Send
   `mode: "audit"` (or `draft`, or `review`). The legacy value is still accepted
   and mapped, but it is dead weight.
3. **Parse your own frames.** `delta` frames carry `{text}` directly, not
   `choices[0].delta.content`. The old parser will show nothing.
4. **Inventory in the answer, not beside it.** The `done` frame carries the
audit id: read it there, because `/v1/audit/store` returns `202` with a null id
and the old code set `currentAuditId` from it, which silently emptied the
`audit_id` on every follow-up.

Recommended client fix while you are in there: append text into a growing
string and re-render on an animation frame instead of re-parsing the whole
markdown document on every token. The current approach is O(n^2) and it is
visible on a 3,000-token audit.

## Routes

| Method | Path | Auth |
|---|---|---|
| GET | `/health` | none |
| POST | `/api/generate` | Origin + Turnstile + daily cap |
| POST | `/v1/audit` | same, legacy alias |
| POST | `/v1/audit/store` | same, returns `202` and does not write |
| GET | `/v1/audit/:id` | unguessable id as capability, 30-day TTL |
| GET | `/admin/candidates?status=pending` | `x-admin-secret` |
| GET | `/admin/candidates/:id` | `x-admin-secret` |
| POST | `/admin/candidates/:id/approve` | `x-admin-secret` + Origin |
| POST | `/admin/candidates/:id/reject` | `x-admin-secret` + Origin |
| GET | `/v1/modes` | none; ids, labels and capabilities only |
| GET | `/v1/switches` | Origin; current search/draft/cap state |
| POST | `/v1/switches` | `x-engine-key` + Origin |

Put Cloudflare Access in front of `/admin/*` before you use it for real. The
shared secret is defence in depth, not the lock.

## Runtime switches

`search`, `draft` and `dailyCap` live in KV under `settings:switches`, so they
change without a deploy — one tap changes every browser instead of one tab.
Reads are cached 10s per isolate and a writer updates its own isolate
immediately, because KV is eventually consistent for up to 60s.

```bash
curl -X POST https://<worker>/v1/switches \
  -H "origin: https://<front-end>" \
  -H "x-engine-key: $KEY" \
  -d '{"search":false}'
```

With the `SETTINGS` binding absent the defaults in `lib/switches.js` apply, so
the Worker degrades instead of failing. Writes without `KEY` answer `503`, not
`200`: the gate fails closed.

## Cost, per request

| Item | Cost |
|---|---|
| Turnstile | free |
| clef-flash triage, 6k chars in | ~$0.0001 |
| Ceramic search | $0.00025 |
| Browser Run, 2 pages, ~8s | ~$0.0000 (within the 10h/month included) |
| Author, ~6.5k in / 3k out | ~0.6–6.5¢ depending on model |

Search is rounding error. **The author and the injected context are the bill**,
which is why `MAX_SOURCE_CHARS` is 1200 and not 8000. Two full-length Ceramic
descriptions is roughly 4k input tokens against a quarter of a thousandth of a
dollar of search — trimming the excerpt is worth more than any provider choice.

## Configuration that actually matters

| Var | Why |
|---|---|
| `SEARCH_PROVIDER` | `ceramic`. Changing to `exa` multiplies search cost by 28 and loses ZDR. |
| `MAX_SOURCE_CHARS` | The largest single cost lever. 1200 is deliberate. |
| `MAX_BROWSER_URLS` | 2. Browser minutes are the scarce resource on this plan. |
| `MODEL_BACKEND` | `openrouter` or `workersai`. The only file that changes is `lib/model.js`. |
| `DAILY_REQUEST_LIMIT` | Fallback cap. The KV switch overrides it at runtime. |
| `KEY` | Secret. Writes `/v1/switches`; unset means writes are `503`. |

## Before this is trustworthy

- **`npm test` is the floor.** 40 offline tests with `env.AI` and `fetch`
  stubbed cover the triage thresholds and the UPL backstop, the PII screen, the
  candidate gates, confidence accrual, the two-source cap and authority
  ranking, the delta parser across chunk boundaries, the frame contract, the
  switches and the auth gates. None of it needs a network or a credential.

- **Port the real prompt.** `src/prompts/index.js` holds a stand-in written to
  the right rules. Replace `BASE_SYSTEM` with the actual `truth` preset text
  from the OpenRouter dashboard — that text is the product's voice.
- **Calibrate clef-flash.** Feed it a minute order and a hard hypothetical and
  check that `upl_risk` and `domain` land where you expect. A 9B model's
  calibration on legal categories is an empirical question, and the thresholds
  in `lib/triage.js` (`UPL_REFUSE_THRESHOLD`, `SEARCH_THRESHOLD`,
  `CHOICE_CONFIDENCE_FLOOR`) are educated guesses until you measure them.
- **KV index writes are not atomic.** Two simultaneous approvals can lose an
  index entry. Acceptable at your volume; move the indexes to D1 if it is not.
- **No embedding retrieval yet.** `searchApproved()` is keyword overlap. That
  keeps a per-query cost at zero. The hook for vectors is obvious and unwired.
- **`/v1/audit/store` is a no-op** returning `202`. Audits are stored at
  generation time, and a second write would let a client claim an id it was
  never issued.
