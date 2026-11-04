/**
 * The model seam. Everything upstream of this file produces messages; only
 * this file knows who the author is. Swapping MODEL_BACKEND to "workersai"
 * is the whole migration if OpenRouter ever stops being the answer.
 */

const OPENROUTER_FALLBACK = "anthropic/claude-sonnet-4.6";

export function authorLabel(env) {
  return env.MODEL_BACKEND === "workersai"
    ? env.WORKERS_AI_MODEL || "workers-ai"
    : env.OPENROUTER_MODEL || OPENROUTER_FALLBACK;
}

/**
 * Streams a chat completion. Yields objects of the shape
 * { delta?: string, usage?: object, model?: string }.
 */
export async function* streamChat({ messages, maxTokens = 3000, temperature = 0.2, env }) {
  if (env.MODEL_BACKEND === "workersai") {
    yield* streamWorkersAi({ messages, maxTokens, temperature, env });
    return;
  }
  yield* streamOpenRouter({ messages, maxTokens, temperature, env });
}

async function* streamOpenRouter({ messages, maxTokens, temperature, env }) {
  if (!env.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not configured");
  }
  if (!env.CF_ACCOUNT_ID || env.CF_ACCOUNT_ID.startsWith("REPLACE_")) {
    throw new Error("CF_ACCOUNT_ID is not configured");
  }

  const gatewayId = env.AI_GATEWAY_ID || "default";
  const url =
    `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${gatewayId}` +
    `/openrouter/v1/chat/completions`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "content-type": "application/json",
      "http-referer": env.SITE_URL || "https://ai-n.org",
      "x-title": "Truth Engine"
    },
    body: JSON.stringify({
      model: env.OPENROUTER_MODEL || OPENROUTER_FALLBACK,
      messages,
      stream: true,
      max_tokens: maxTokens,
      temperature,
      usage: { include: true }
    })
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("author_http_error", { status: res.status, detail: detail.slice(0, 500) });
    throw new Error(`Author request failed (${res.status})`);
  }

  yield* parseDeltaStream(res.body);
}

async function* streamWorkersAi({ messages, maxTokens, temperature, env }) {
  const model = env.WORKERS_AI_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
  const stream = await env.AI.run(
    model,
    { messages, stream: true, max_tokens: maxTokens, temperature },
    { gateway: { id: env.AI_GATEWAY_ID || "default" } }
  );
  yield* parseDeltaStream(stream);
}

/**
 * One parser for both backends: OpenAI-compatible SSE either way. This handles
 * chunk boundaries properly, which the previous client-side parser did not,
 * because it buffers on newline instead of assuming one chunk is one event.
 */
export async function* parseDeltaStream(body) {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line || !line.startsWith("data:")) continue;

        const payload = line.slice(5).trim();
        if (payload === "[DONE]") return;

        let parsed;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue;
        }

        if (parsed?.error) {
          throw new Error(parsed.error?.message || "Upstream stream error");
        }
        const delta = parsed?.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta) yield { delta };
        if (parsed?.usage) yield { usage: parsed.usage };
      }
    }

    // Trailing frame with no newline.
    const tail = buffer.trim();
    if (tail.startsWith("data:")) {
      const payload = tail.slice(5).trim();
      if (payload && payload !== "[DONE]") {
        try {
          const parsed = JSON.parse(payload);
          const delta = parsed?.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta) yield { delta };
          if (parsed?.usage) yield { usage: parsed.usage };
        } catch {
          /* ignore malformed tail */
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
}
