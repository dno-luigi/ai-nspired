import { json, readJson, assertSameOrigin, matchOrigin, errorResponse } from "../lib/http.js";
import { requireAdmin } from "../lib/auth.js";
import {
  PENDING,
  APPROVED,
  REJECTED,
  listCandidates,
  getCandidate,
  approveCandidate,
  rejectCandidate
} from "../lib/knowledge.js";

const STATUSES = [PENDING, APPROVED, REJECTED];

/** GET /admin/candidates?status=pending */
export async function handleList(request, env) {
  requireAdmin(request, env);
  const url = new URL(request.url);
  const status = url.searchParams.get("status") || PENDING;
  if (!STATUSES.includes(status)) {
    return json({ error: { code: "bad_status", message: `status must be one of ${STATUSES.join(", ")}` } }, {
      status: 400,
      origin: matchOrigin(request, env)
    });
  }
  const limit = Math.min(Number(url.searchParams.get("limit") || 50), 200);
  const items = await listCandidates(status, env, limit);
  return json({ status, count: items.length, items }, { origin: matchOrigin(request, env) });
}

/** GET /admin/candidates/:id */
export async function handleDetail(id, request, env) {
  requireAdmin(request, env);
  const record = await getCandidate(id, env);
  if (!record) {
    return json({ error: { code: "not_found", message: "No such candidate" } }, {
      status: 404,
      origin: matchOrigin(request, env)
    });
  }
  return json(record, { origin: matchOrigin(request, env) });
}

/** POST /admin/candidates/:id/approve  { expert, note } */
export async function handleApprove(id, request, env) {
  requireAdmin(request, env);
  assertSameOrigin(request, env);
  const body = await readJson(request);
  const result = await approveCandidate(id, body, env);
  return json({ ok: true, candidate: result }, { origin: matchOrigin(request, env) });
}

/** POST /admin/candidates/:id/reject  { expert, reason } */
export async function handleReject(id, request, env) {
  requireAdmin(request, env);
  assertSameOrigin(request, env);
  const body = await readJson(request);
  const result = await rejectCandidate(id, body, env);
  return json({ ok: true, candidate: result }, { origin: matchOrigin(request, env) });
}

export { errorResponse };
