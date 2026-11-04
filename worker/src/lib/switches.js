import { HttpError } from "./http.js";

/**
 * Runtime switches: server state, not deploy state.
 *
 * Changing search, drafting or the daily cap used to require editing
 * wrangler.jsonc and deploying. These live in KV so one tap changes every
 * browser at once, which matters when the operator is on a phone.
 *
 * KV is eventually consistent — up to 60s — so every read is cached for only
 * 10s and a writer updates its own isolate immediately.
 */

const STORAGE_KEY = "settings:switches";
const CACHE_MS = 10_000;
const CAP_MIN = 0;
const CAP_MAX = 10_000;

export const DEFAULTS = Object.freeze({ search: true, draft: true, dailyCap: 60 });

let cache = { at: 0, value: null };

/** Test hook and the writer's own invalidation. */
export function clearSwitchCache() {
  cache = { at: 0, value: null };
}

function normalize(raw) {
  const out = { ...DEFAULTS };
  if (!raw || typeof raw !== "object") return out;

  if (typeof raw.search === "boolean") out.search = raw.search;
  if (typeof raw.draft === "boolean") out.draft = raw.draft;

  if (raw.dailyCap !== undefined && raw.dailyCap !== null) {
    const cap = Number(raw.dailyCap);
    if (Number.isFinite(cap)) {
      out.dailyCap = Math.min(Math.max(Math.trunc(cap), CAP_MIN), CAP_MAX);
    }
  }

  return out;
}

function meta(raw) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  if (typeof raw.updatedAt === "string") out.updatedAt = raw.updatedAt;
  if (typeof raw.updatedBy === "string") out.updatedBy = raw.updatedBy.slice(0, 120);
  return out;
}

/**
 * Never throws on a missing or broken binding: with SETTINGS unbound the
 * defaults apply, so the Worker degrades instead of failing the request.
 */
export async function getSwitches(env, { fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && cache.value && now - cache.at < CACHE_MS) return cache.value;

  if (!env?.SETTINGS) {
    cache = { at: now, value: { ...DEFAULTS } };
    return cache.value;
  }

  let raw = null;
  try {
    raw = await env.SETTINGS.get(STORAGE_KEY, "json");
  } catch (err) {
    console.error("switches_read_failed", { message: err?.message });
    raw = null;
  }

  const value = normalize(raw);
  cache = { at: now, value };
  return value;
}

/** Merges a patch over current values, writes, and refreshes this isolate. */
export async function setSwitches(patch, env, { updatedBy = "unspecified" } = {}) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new HttpError(400, "invalid_switches", "Body must be an object");
  }
  for (const key of Object.keys(patch)) {
    if (!["search", "draft", "dailyCap", "updatedBy"].includes(key)) {
      throw new HttpError(400, "unknown_switch", `Unknown switch "${key}"`);
    }
  }
  if (patch.search !== undefined && typeof patch.search !== "boolean") {
    throw new HttpError(400, "invalid_switch", "search must be true or false");
  }
  if (patch.draft !== undefined && typeof patch.draft !== "boolean") {
    throw new HttpError(400, "invalid_switch", "draft must be true or false");
  }
  if (patch.dailyCap !== undefined && !Number.isFinite(Number(patch.dailyCap))) {
    throw new HttpError(400, "invalid_switch", "dailyCap must be a number");
  }

  if (!env?.SETTINGS) {
    throw new HttpError(503, "settings_unbound", "SETTINGS KV namespace is not configured");
  }

  const current = await getSwitches(env, { fresh: true });
  const merged = normalize({ ...current, ...patch, updatedBy: patch.updatedBy ?? updatedBy });
  const next = {
    ...merged,
    updatedAt: new Date().toISOString(),
    updatedBy: String(patch.updatedBy ?? updatedBy).slice(0, 120)
  };

  await env.SETTINGS.put(STORAGE_KEY, JSON.stringify(next));
  cache = { at: Date.now(), value: merged };
  return { switches: merged, ...meta(next) };
}
