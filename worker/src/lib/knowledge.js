import { HttpError } from "./http.js";

/**
 * Candidate -> approval -> confidence pipeline.
 *
 * Every substantive exchange produces a *candidate*, never knowledge. A
 * candidate becomes knowledge only when a named expert approves it, and its
 * confidence starts from the approval rather than from the model's own
 * self-assessment. That is the whole design: the model proposes, a human
 * ratifies, confidence accrues with ratifications.
 *
 * Storage: R2 for the records (they are large and there are many), KV for the
 * index (small, read on every search).
 */

export const PENDING = "pending";
export const APPROVED = "approved";
export const REJECTED = "rejected";

const INDEX_KEY = (status) => `index:${status}`;
const INDEX_TTL = null; // indexes are permanent

const MIN_ANSWER_CHARS = 400;
const APPROVE_CONFIDENCE = 0.9;
const MAX_CONFIDENCE = 0.95;
const CONFIDENCE_STEP = 0.02;

function summary(record) {
  return {
    id: record.id,
    title: record.title,
    domain: record.domain,
    status: record.status,
    confidence: record.confidence,
    approvals: record.approvals?.length || 0,
    createdAt: record.createdAt
  };
}

async function readIndex(env, status) {
  const raw = await env.KNOWLEDGE_INDEX.get(INDEX_KEY(status));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeIndex(env, status, entries) {
  await env.KNOWLEDGE_INDEX.put(INDEX_KEY(status), JSON.stringify(entries));
}

async function addToIndex(env, status, record) {
  const entries = await readIndex(env, status);
  const next = entries.filter((entry) => entry.id !== record.id);
  next.push(summary(record));
  await writeIndex(env, status, next);
}

async function removeFromIndex(env, status, id) {
  const entries = await readIndex(env, status);
  await writeIndex(env, status, entries.filter((entry) => entry.id !== id));
}

export async function getRecord(key, env) {
  const raw = await env.ORP.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(await raw.text());
  } catch {
    return null;
  }
}

async function putRecord(key, record, env) {
  await env.ORP.put(key, JSON.stringify(record));
}

/**
 * Gates, in order of strictness. Each one exists because shipping the wrong
 * thing into a knowledge base is worse than shipping nothing:
 *
 *  - any hard identifier means the turn is never candidated, so a case number
 *    or SSN cannot end up in a shared corpus;
 *  - a UPL-flagged turn is never candidated, because its answer is process
 *    guidance that should not be reused as authority;
 *  - a short answer is never candidated, because there is nothing generalizable.
 */
export async function candidateFromTurn(
  { state, answer, triage, sources, mode, auditId },
  env
) {
  if (triage?.pii?.hasIdentifiers) {
    return { candidate: null, reason: "pii", kinds: triage.pii.kinds };
  }
  if (triage?.uplRisk) return { candidate: null, reason: "upl" };
  if (!answer || answer.length < MIN_ANSWER_CHARS) {
    return { candidate: null, reason: "too_short" };
  }

  const id = `cand_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();

  const record = {
    id,
    status: PENDING,
    title: String(state || "").replace(/\s+/g, " ").slice(0, 120) || "Untitled",
    question: String(state || "").slice(0, 4000),
    answer: answer.slice(0, 14000),
    mode,
    domain: triage?.domain || "other",
    urgency: triage?.urgency || null,
    sourceUrls: (sources || []).map((s) => s.url).slice(0, 10),
    // Not the model's opinion of its own quality. A fixed prior that only an
    // expert approval can raise.
    confidence: 0.75,
    approvals: [],
    auditId: auditId || null,
    createdAt: now,
    updatedAt: now
  };

  await putRecord(`candidate:${id}`, record, env);
  await addToIndex(env, PENDING, record);
  return { candidate: summary(record), reason: null };
}

export async function getCandidate(id, env) {
  // Both sides must be awaited. `a() || b()` compares the promises, not their
  // values, so the fallback to the promoted record never ran and every
  // already-approved candidate answered 404 in the admin console.
  return (await getRecord(`candidate:${id}`, env)) || (await getRecord(`knowledge:${id}`, env));
}

export async function listCandidates(status, env, limit = 50) {
  const entries = await readIndex(env, status);
  return entries
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, limit);
}

/**
 * Single-expert approval promotes the candidate. Further approvals nudge
 * confidence up without ever reaching certainty, because a legal principle
 * that claims 1.0 confidence is lying about the nature of law.
 */
export async function approveCandidate(id, { expert, note } = {}, env) {
  if (!expert || typeof expert !== "string" || expert.trim().length < 2) {
    throw new HttpError(400, "expert_required", "Approval must name the approving expert");
  }

  // getCandidate falls back to the promoted record, so a second expert can
  // add their approval instead of getting a 404 because the candidate key was
  // moved on the first approval.
  const record = await getCandidate(id, env);
  if (!record) throw new HttpError(404, "candidate_not_found", "No such candidate");
  if (record.status === REJECTED) {
    throw new HttpError(409, "already_rejected", "A rejected candidate cannot be approved");
  }

  const now = new Date().toISOString();
  const approvals = Array.isArray(record.approvals) ? record.approvals : [];
  approvals.push({ expert: expert.trim().slice(0, 120), note: String(note || "").slice(0, 1000), at: now });

  const confidence = Math.min(
    APPROVE_CONFIDENCE + CONFIDENCE_STEP * (approvals.length - 1),
    MAX_CONFIDENCE
  );

  const promoted = {
    ...record,
    status: APPROVED,
    confidence,
    approvals,
    updatedAt: now,
    approvedAt: record.approvedAt || now
  };

  await putRecord(`knowledge:${id}`, promoted, env);
  await env.ORP.delete(`candidate:${id}`);
  await removeFromIndex(env, PENDING, id);
  await addToIndex(env, APPROVED, promoted);

  return summary(promoted);
}

export async function rejectCandidate(id, { expert, reason } = {}, env) {
  const record = await getCandidate(id, env);
  if (!record) throw new HttpError(404, "candidate_not_found", "No such candidate");

  const now = new Date().toISOString();
  const rejected = {
    ...record,
    status: REJECTED,
    confidence: 0,
    rejection: {
      expert: String(expert || "unspecified").slice(0, 120),
      reason: String(reason || "").slice(0, 1000),
      at: now
    },
    updatedAt: now
  };

  await putRecord(`candidate:${id}`, rejected, env);
  await removeFromIndex(env, PENDING, id);
  await removeFromIndex(env, APPROVED, id);
  await addToIndex(env, REJECTED, rejected);
  return summary(rejected);
}

/**
 * Retrieval over approved knowledge only. Keyword overlap for now; the hook
 * for embeddings is obvious and deliberately not wired, because a vector
 * search here would add a per-query embedding cost to a stage that currently
 * costs nothing and runs in a few milliseconds.
 */
export async function searchApproved(query, env, limit = 3) {
  const entries = await readIndex(env, APPROVED);
  if (entries.length === 0) return [];

  const terms = String(query || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 3);

  if (terms.length === 0) return [];

  const scored = [];
  // Cap the scan: this runs inline on a request, and the index will grow.
  for (const entry of entries.slice(0, 60)) {
    const record = await getRecord(`knowledge:${entry.id}`, env);
    if (!record) continue;
    const haystack = `${record.title}\n${record.question}\n${record.answer}`.toLowerCase();
    let hits = 0;
    for (const term of terms) if (haystack.includes(term)) hits += 1;
    if (hits === 0) continue;
    scored.push({
      id: record.id,
      title: record.title,
      content: record.answer,
      confidence: record.confidence,
      score: hits / terms.length
    });
  }

  return scored
    .filter((item) => item.score >= 0.34)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
