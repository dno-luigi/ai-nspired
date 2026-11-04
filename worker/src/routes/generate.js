import { HttpError, readJson, assertSameOrigin, matchOrigin } from "../lib/http.js";
import { verifyTurnstile, enforceDailyLimit, clientIp } from "../lib/auth.js";
import { triage } from "../lib/triage.js";
import { webSearch, rankSources, buildSourceBlock } from "../lib/search.js";
import { expandTopSources } from "../lib/extract.js";
import { getMode, buildMessages, modeNames } from "../prompts/index.js";
import { streamChat, authorLabel } from "../lib/model.js";
import { sseResponse } from "../lib/sse.js";
import { searchApproved, candidateFromTurn } from "../lib/knowledge.js";
import { storeAudit } from "../lib/audits.js";
import { createTrace } from "../lib/trace.js";
import { getSwitches } from "../lib/switches.js";

/** Legacy `type` values from the previous API shape. Mapped, never trusted. */
const LEGACY_TYPES = { docket: "audit", analysis: "audit", document: "draft" };

/** Parameters that used to be honoured and now are not. Rejected loudly. */
const FORBIDDEN = ["model", "api_key", "preset_id", "provider"];

function normalizeMessages(raw) {
  if (!Array.isArray(raw)) throw new HttpError(400, "invalid_messages", "messages must be an array");
  if (raw.length > 40) throw new HttpError(400, "too_many_messages", "At most 40 turns per request");

  return raw
    .filter((turn) => turn && (turn.role === "user" || turn.role === "assistant"))
    .filter((turn) => typeof turn.content === "string" && turn.content.trim())
    .map((turn) => ({ role: turn.role, content: turn.content.slice(0, 40000) }));
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "user") return messages[i].content;
  }
  return "";
}

function resolveMode(body) {
  const requested = body.mode ?? LEGACY_TYPES[body.type] ?? body.preset;
  const candidate = typeof requested === "string" ? requested : "audit";
  return modeNames().includes(candidate) ? candidate : "audit";
}

export async function handleGenerate(request, env) {
  const origin = assertSameOrigin(request, env);
  const body = await readJson(request);

  for (const key of FORBIDDEN) {
    if (body[key] !== undefined) {
      throw new HttpError(
        400,
        "unsupported_parameter",
        `"${key}" is no longer accepted. The model, provider and prompt are chosen server-side; send "mode" instead.`
      );
    }
  }

  const messages = normalizeMessages(body.messages);
  if (messages.length === 0) throw new HttpError(400, "empty_request", "No user message supplied");

  const modeName = resolveMode(body);
  const mode = getMode(modeName);

  const ip = clientIp(request);
  const token = request.headers.get("x-turnstile-token") || body.turnstileToken;
  await verifyTurnstile(token, ip, env);

  // Server state, not deploy state: the cap and the stage switches are read
  // per request, so one tap in the admin console changes every browser.
  const switches = await getSwitches(env);
  await enforceDailyLimit(ip, env, switches.dailyCap);

  const question = lastUserText(messages);

  return sseResponse(async (emit, signal) => {
    const trace = createTrace();

    // ---- 1. Triage ------------------------------------------------------
    emit("status", { phase: "triage" });
    const t = await triage(question, env);
    trace.add("triage", { domain: t.domain, degraded: t.degraded, urgency: t.urgency });
    emit("status", {
      phase: "triage_done",
      detail: {
        domain: t.domain,
        urgency: t.urgency,
        search: t.needsSearch,
        degraded: t.degraded
      }
    });

    // The UPL gate. A drafting request that looks like a request for
    // representation is downgraded to analysis rather than refused outright,
    // because the person still needs an answer they can use.
    let effectiveMode = mode;
    if (t.uplRisk && modeName === "draft") {
      effectiveMode = getMode("audit");
      trace.add("draft_withheld", { reason: "upl" });
      emit("status", {
        phase: "boundary",
        detail:
          "Drafting withheld: this reads as a request for representation or for a filing. Returning structural analysis instead."
      });
    } else if (modeName === "draft" && !switches.draft) {
      effectiveMode = getMode("audit");
      trace.add("draft_withheld", { reason: "disabled" });
      emit("status", {
        phase: "boundary",
        detail: "Drafting is switched off. Returning structural analysis instead."
      });
    }

    // ---- 2. Grounding ---------------------------------------------------
    let sources = [];
    let sourceBlock = "";
    let pages = [];

    if (effectiveMode.search && t.needsSearch && switches.search) {
      emit("status", { phase: "search", detail: t.domain });
      try {
        const result = await webSearch(question, env);
        if (result.failed) {
          trace.add("search_failed", { reason: "provider" });
          emit("status", { phase: "search_failed", detail: "Search unavailable, answering from knowledge only" });
        } else {
          sources = rankSources(result.items);
          if (sources.length) {
            sourceBlock = buildSourceBlock(sources, env);
            trace.add("search", {
              sources: sources.length,
              authoritative: sources.filter((item) => item.authoritative).length
            });
            emit("sources", {
              items: sources.map((item) => ({ title: item.title, url: item.url }))
            });
            emit("status", { phase: "extract" });
            pages = await expandTopSources(sources, env);
            trace.add("extract", { pages: pages.length });
          }
        }
      } catch (err) {
        // Grounding is an enhancement, not a dependency. Never fail the turn.
        console.error("grounding_failed", { message: err?.message });
        trace.add("search_failed", { reason: "error" });
        emit("status", { phase: "search_failed", detail: "Grounding failed, answering from knowledge only" });
      }
    } else {
      trace.add("search_disabled", {
        reason: !switches.search ? "switch_off" : effectiveMode.search ? "triage" : "mode"
      });
    }

    if (signal.aborted) return;

    // ---- 3. Knowledge base ---------------------------------------------
    let contextBlock = "";
    try {
      const approved = await searchApproved(question, env, 3);
      trace.add("knowledge", { entries: approved.length });
      if (approved.length) {
        contextBlock = approved
          .map((item, index) => `[K${index + 1}] ${item.title} (confidence ${item.confidence.toFixed(2)})\n${item.content.slice(0, 2500)}`)
          .join("\n\n");
      }
    } catch (err) {
      console.error("knowledge_lookup_failed", { message: err?.message });
    }

    // ---- 4. Generation --------------------------------------------------
    const outbound = buildMessages({
      mode: effectiveMode,
      history: messages,
      context: contextBlock,
      sources: sourceBlock,
      pages
    });

    emit("status", { phase: "generate", detail: authorLabel(env) });
    trace.add("generate", { model: authorLabel(env) });

    let full = "";
    let usage = null;

    for await (const chunk of streamChat({
      messages: outbound,
      maxTokens: effectiveMode.maxTokens,
      temperature: effectiveMode.temperature,
      env
    })) {
      if (signal.aborted) return;
      if (chunk.delta) {
        full += chunk.delta;
        emit("delta", { text: chunk.delta });
      }
      if (chunk.usage) usage = chunk.usage;
    }

    if (!full.trim()) {
      emit("error", { code: "empty_completion", message: "The model returned no content" });
      return;
    }

    // ---- 5. Persist -----------------------------------------------------
    const traceView = trace.finish();
    const auditId = crypto.randomUUID();
    try {
      await storeAudit(
        auditId,
        {
          id: auditId,
          mode: modeName,
          question: question.slice(0, 4000),
          answer: full.slice(0, 60000),
          triage: { ...t, pii: t.pii },
          sources: sources.map((item) => ({ title: item.title, url: item.url })),
          usage,
          trace: traceView,
          switches: { search: switches.search, draft: switches.draft, dailyCap: switches.dailyCap },
          createdAt: new Date().toISOString()
        },
        env
      );
    } catch (err) {
      console.error("audit_store_failed", { message: err?.message });
    }

    emit("done", { auditId, mode: modeName, usage, trace: traceView });

    // ---- 6. Candidate ---------------------------------------------------
    // After `done`, so the client is never waiting on this. Awaited anyway so
    // the isolate stays alive long enough to finish the write.
    try {
      const result = await candidateFromTurn(
        { state: question, answer: full, triage: t, sources, mode: modeName, auditId },
        env
      );
      if (result.reason) console.log("candidate_skipped", { reason: result.reason });
    } catch (err) {
      console.error("candidate_write_failed", { message: err?.message });
    }
  }, { origin });
}

export function handlePreflight(request, env) {
  const origin = matchOrigin(request, env);
  return origin ? new Response(null, { status: 204 }) : new Response(null, { status: 403 });
}
