/**
 * Truth Engine client — the only module that knows the wire format.
 *
 * Framework-agnostic on purpose: no imports, no build step, so i.nspired can
 * drop it into whatever bundle it ends up with. It exists because the old
 * front end's parser was the source of four silent failures:
 *
 *   1. it looked for `data: {"choices":[...]}` and the Worker sends named
 *      `event: delta` frames, so answers rendered as nothing;
 *   2. it read the audit id from /v1/audit/store, which is now a 202 no-op, so
 *      every follow-up went out with an empty id;
 *   3. it never sent a Turnstile token, which the Worker fails closed on;
 *   4. it had no cancellation path, so a dropped stream left the UI spinning.
 *
 * All four are fixed here, in one place, instead of in each page.
 */

function parseFrame(raw) {
  let event = "message";
  const dataLines = [];

  for (const line of raw.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }

  if (dataLines.length === 0) return null;

  const payload = dataLines.join("\n");
  if (payload === "[DONE]") return { event: "done", data: {} };

  try {
    return { event, data: JSON.parse(payload) };
  } catch {
    return null;
  }
}

/** Buffers on a blank line, not on a chunk, because one chunk is not one frame. */
async function* readFrames(body) {
  if (!body) return;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

      let split;
      while ((split = buffer.indexOf("\n\n")) !== -1) {
        const frame = parseFrame(buffer.slice(0, split));
        buffer = buffer.slice(split + 2);
        if (frame) yield frame;
      }
    }

    const tail = parseFrame(buffer.trim());
    if (tail) yield tail;
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
}

export function createClient({ baseUrl, getTurnstileToken = async () => null, fetchImpl } = {}) {
  if (!baseUrl) throw new Error("createClient needs a baseUrl");
  const base = String(baseUrl).replace(/\/+$/, "");
  const doFetch = fetchImpl || (typeof fetch === "function" ? fetch : null);
  if (!doFetch) throw new Error("No fetch implementation available");

  async function request(path, { method = "GET", body, signal, challenge = false } = {}) {
    const headers = {};
    if (body !== undefined) headers["content-type"] = "application/json";

    if (challenge) {
      const token = await getTurnstileToken();
      if (token) headers["x-turnstile-token"] = token;
    }

    const res = await doFetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      credentials: "same-origin"
    });

    if (!res.ok) {
      let detail = null;
      try {
        detail = await res.json();
      } catch {
        /* empty or non-JSON body — the Worker answers 403 with no body on a
           rejected origin, so status is all we have */
      }
      const err = new Error(detail?.error?.message || `Request failed (${res.status})`);
      err.status = res.status;
      err.code = detail?.error?.code || "http_error";
      throw err;
    }

    return res;
  }

  /**
   * Runs one audit. Resolves with the answer, sources, id and trace; throws on
   * an `error` frame or a stream that ends without `done`.
   */
  async function audit({ mode = "audit", messages, signal, onEvent } = {}) {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error("messages must be a non-empty array");
    }

    const res = await request("/v1/audit", {
      method: "POST",
      body: { mode, messages },
      signal,
      challenge: true
    });

    let text = "";
    let sources = [];
    let doneFrame = null;

    for await (const frame of readFrames(res.body)) {
      if (onEvent) onEvent(frame.event, frame.data);

      if (frame.event === "delta") {
        text += frame.data?.text || "";
      } else if (frame.event === "sources") {
        sources = frame.data?.items || [];
      } else if (frame.event === "done") {
        doneFrame = frame.data;
      } else if (frame.event === "error") {
        const err = new Error(frame.data?.message || "Generation failed");
        err.code = frame.data?.code || "stream_error";
        err.partial = { text, sources };
        throw err;
      }
    }

    if (!doneFrame) {
      const err = new Error("Stream ended before the audit finished");
      err.code = "truncated";
      err.partial = { text, sources };
      throw err;
    }

    return {
      text,
      sources,
      auditId: doneFrame.auditId,
      mode: doneFrame.mode,
      usage: doneFrame.usage ?? null,
      trace: doneFrame.trace ?? null,
      permalink: `${base}/v1/audit/${doneFrame.auditId}`
    };
  }

  return {
    baseUrl: base,
    audit,
    getModes: async () => (await request("/v1/modes")).json(),
    getSwitches: async () => (await request("/v1/switches")).json(),
    getAudit: async (id, { signal } = {}) => {
      if (!/^[a-f0-9-]{16,64}$/i.test(String(id || ""))) throw new Error("Invalid audit id");
      return (await request(`/v1/audit/${id}`, { signal })).json();
    },
    permalink: (id) => `${base}/v1/audit/${id}`
  };
}

/**
 * One line of provenance for under the answer:
 * "2 sources (2 primary) · 2 pages expanded · triage degraded · 4.1s"
 */
export function describeTrace(trace) {
  const entries = trace?.entries || [];
  const byStage = Object.create(null);
  for (const entry of entries) byStage[entry.stage] = entry;

  const bits = [];
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  const search = byStage.search?.detail;
  if (search?.sources) {
    const primary = search.authoritative ?? 0;
    bits.push(`${plural(search.sources, "source")}${primary ? ` (${primary} primary)` : " (none primary)"}`);
  }
  if (byStage.search_failed) bits.push("grounding failed");
  if (byStage.search_disabled) bits.push("search off");
  if (byStage.draft_withheld) {
    bits.push(byStage.draft_withheld.detail?.reason === "disabled" ? "drafting off" : "draft withheld");
  }
  const pages = byStage.extract?.detail?.pages;
  if (pages) bits.push(`${plural(pages, "page")} expanded`);
  const knowledge = byStage.knowledge?.detail?.entries;
  if (knowledge) bits.push(`${knowledge} from knowledge base`);
  if (byStage.triage?.detail?.degraded) bits.push("triage degraded");
  if (typeof trace?.totalMs === "number") bits.push(`${(trace.totalMs / 1000).toFixed(1)}s`);

  return bits.join(" · ");
}
