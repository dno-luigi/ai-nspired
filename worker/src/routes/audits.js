import { json, matchOrigin } from "../lib/http.js";
import { getAudit } from "../lib/audits.js";

/** GET /v1/audit/:id — unguessable id acts as the capability. */
export async function handleAuditGet(id, request, env) {
  const origin = matchOrigin(request, env);
  const record = await getAudit(id, env);
  if (!record) {
    return json({ error: { code: "not_found", message: "No such audit" } }, { status: 404, origin });
  }
  return json(record, { origin });
}

/**
 * POST /v1/audit/store — kept so the current front end does not break.
 *
 * Audits are now stored at generation time, before the `done` frame, so this
 * endpoint must not write again: two writes for one audit would let a client
 * claim an id it did not receive. It acknowledges and points at the real id.
 */
export async function handleAuditStore(request, env) {
  const origin = matchOrigin(request, env);
  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  return json(
    {
      ok: true,
      deprecated: true,
      audit_id: typeof body.audit_id === "string" ? body.audit_id : null,
      note: "Audits are stored at generation time and returned in the `done` frame."
    },
    { status: 202, origin }
  );
}
