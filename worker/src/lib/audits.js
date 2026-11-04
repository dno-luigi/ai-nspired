import { HttpError } from "./http.js";

const TTL_SECONDS = 60 * 60 * 24 * 30;

export function isValidAuditId(id) {
  return typeof id === "string" && /^[a-f0-9-]{16,64}$/i.test(id);
}

export async function storeAudit(id, record, env) {
  if (!env.AUDITS) throw new HttpError(500, "config_error", "AUDITS binding missing");
  await env.AUDITS.put(`audit:${id}`, JSON.stringify(record), {
    expirationTtl: TTL_SECONDS
  });
  return id;
}

export async function getAudit(id, env) {
  if (!isValidAuditId(id)) return null;
  const raw = await env.AUDITS.get(`audit:${id}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
