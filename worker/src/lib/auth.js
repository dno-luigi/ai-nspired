import { HttpError, safeEqual } from "./http.js";

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Fail closed. If the secret is missing we return an error rather than
 * letting traffic through, because a silently disabled bot check is worse
 * than a loud misconfiguration.
 */
export async function verifyTurnstile(token, ip, env) {
  const secret = env.TURNSTILE_SECRET;
  if (!secret) {
    throw new HttpError(500, "config_error", "TURNSTILE_SECRET is not configured");
  }
  if (!token || typeof token !== "string") {
    throw new HttpError(403, "challenge_required", "Missing challenge token");
  }

  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  if (ip) form.append("remoteip", ip);

  let data;
  try {
    const res = await fetch(VERIFY_URL, { method: "POST", body: form });
    data = await res.json();
  } catch (err) {
    console.error("turnstile_verify_failed", { message: err?.message });
    throw new HttpError(503, "challenge_unavailable", "Could not verify challenge, try again");
  }

  if (!data?.success) {
    throw new HttpError(403, "challenge_failed", "Challenge verification failed", {
      codes: data?.["error-codes"] || []
    });
  }
  return true;
}

/**
 * Admin gate. In production put Cloudflare Access in front of /admin/* and
 * treat this header as defence in depth, not the only lock.
 */
export function requireAdmin(request, env) {
  const configured = env.ADMIN_SECRET;
  if (!configured) {
    throw new HttpError(503, "admin_disabled", "ADMIN_SECRET is not configured");
  }
  const supplied = request.headers.get("x-admin-secret");
  if (!supplied || !safeEqual(supplied, configured)) {
    throw new HttpError(401, "unauthorized", "Invalid admin credentials");
  }
}

export function clientIp(request) {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-real-ip") ||
    "0.0.0.0"
  );
}

/**
 * Engine key gate for switch writes. Fails closed: an unset KEY answers 503
 * rather than leaving the route writable by anyone who finds it.
 */
export function requireKey(request, env) {
  const configured = env.KEY;
  if (!configured) {
    throw new HttpError(503, "key_not_configured", "KEY is not set; switch writes are disabled");
  }
  const supplied = request.headers.get("x-engine-key");
  if (!supplied || !safeEqual(supplied, configured)) {
    throw new HttpError(401, "unauthorized", "Invalid engine key");
  }
}

/**
 * Per-IP daily counter in KV. Deliberately a backstop: KV is eventually
 * consistent and not atomic, so concurrent requests can overshoot. AI Gateway
 * rate limiting is the real ceiling; this exists to stop a single abuser.
 *
 * `capOverride` lets the KV switch win over the deploy-time var, so the cap
 * can be changed from a phone without a redeploy.
 */
export async function enforceDailyLimit(ip, env, capOverride) {
  const cap =
    capOverride === undefined || capOverride === null
      ? Number(env.DAILY_REQUEST_LIMIT || 0)
      : Number(capOverride);
  if (!Number.isFinite(cap) || cap <= 0 || !env.RATE_LIMIT) return;

  const day = new Date().toISOString().slice(0, 10);
  const key = `rl:${ip}:${day}`;
  const current = Number((await env.RATE_LIMIT.get(key)) || 0);

  if (current >= cap) {
    throw new HttpError(429, "rate_limited", "Daily request limit reached");
  }
  // 48h so the key outlives the day boundary it belongs to.
  await env.RATE_LIMIT.put(key, String(current + 1), { expirationTtl: 172800 });
}
