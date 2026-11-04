export class HttpError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function origins(env) {
  return String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

/** Returns the request Origin if it is allowlisted, otherwise null. */
export function matchOrigin(request, env) {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  return origins(env).includes(origin) ? origin : null;
}

export function corsHeaders(origin) {
  if (!origin) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-admin-secret,x-turnstile-token",
    "access-control-max-age": "86400",
    vary: "origin"
  };
}

/**
 * Rejects cross-site mutations. A request with no Origin at all (curl, server
 * to server) is rejected too, because nothing legitimate calls this from a
 * shell. Same-origin browser requests still send Origin.
 */
export function assertSameOrigin(request, env) {
  const origin = request.headers.get("origin");
  if (!origin) {
    throw new HttpError(403, "origin_missing", "Origin header required");
  }
  if (!origins(env).includes(origin)) {
    throw new HttpError(403, "origin_rejected", "Origin not allowed");
  }
  return origin;
}

export function json(data, { status = 200, origin = null, headers = {} } = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...corsHeaders(origin),
      ...headers
    }
  });
}

export function errorResponse(err, request, env) {
  const origin = matchOrigin(request, env);
  const status = err instanceof HttpError ? err.status : 500;
  const code = err instanceof HttpError ? err.code : "internal_error";
  // Never leak internals to the client. Log the real thing.
  const message =
    err instanceof HttpError ? err.message : "Request failed";
  if (status >= 500) {
    console.error("request_failed", { code, message: err?.message, stack: err?.stack });
  }
  return json({ error: { code, message, details: err?.details ?? null } }, { status, origin });
}

export async function readJson(request) {
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("not an object");
    }
    return body;
  } catch {
    throw new HttpError(400, "invalid_json", "Body must be a JSON object");
  }
}

/** Constant-time-ish comparison so the admin secret is not timing oracle. */
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
