import { json, readJson, assertSameOrigin, matchOrigin } from "../lib/http.js";
import { requireKey } from "../lib/auth.js";
import { getSwitches, setSwitches } from "../lib/switches.js";

/** GET /v1/switches — public read so the UI can show the current state. */
export async function handleSwitchesGet(request, env) {
  const origin = matchOrigin(request, env);
  const switches = await getSwitches(env);
  return json({ switches }, { origin });
}

/**
 * POST /v1/switches — writes need KEY, and the gate fails closed: an unset
 * KEY answers 503 rather than leaving the switches writable by anyone.
 */
export async function handleSwitchesPost(request, env) {
  const origin = assertSameOrigin(request, env);
  requireKey(request, env);
  const body = await readJson(request);
  const result = await setSwitches(body, env, {
    updatedBy: request.headers.get("x-engine-actor") || "key holder"
  });
  return json({ ok: true, ...result }, { origin });
}
