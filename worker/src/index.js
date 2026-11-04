import { json, errorResponse, matchOrigin, corsHeaders } from "./lib/http.js";
import { handleGenerate } from "./routes/generate.js";
import { handleAuditGet, handleAuditStore } from "./routes/audits.js";
import { handleList, handleDetail, handleApprove, handleReject } from "./routes/knowledge.js";
import { handleModes } from "./routes/modes.js";
import { handleSwitchesGet, handleSwitchesPost } from "./routes/switches.js";
import { getSwitches } from "./lib/switches.js";
import { modeNames } from "./prompts/index.js";

const ID_PATTERN = /^[A-Za-z0-9_-]{4,80}$/;
const AUDIT_PATTERN = /^\/v1\/audit\/([A-Za-z0-9-]{16,64})$/;
const ADMIN_PATTERN = /^\/admin\/candidates\/([A-Za-z0-9_-]{4,80})(?:\/(approve|reject))?$/;

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const origin = matchOrigin(request, env);

    if (request.method === "OPTIONS") {
      if (!origin) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    try {
      if (pathname === "/health") {
        // One call that identifies which deploy is answering and how it is set.
        return json(
          {
            ok: true,
            backend: env.MODEL_BACKEND || "openrouter",
            modes: modeNames(),
            switches: await getSwitches(env)
          },
          { origin }
        );
      }

      if (request.method === "GET" && pathname === "/v1/modes") {
        return await handleModes(request, env);
      }

      if (pathname === "/v1/switches") {
        if (request.method === "GET") return await handleSwitchesGet(request, env);
        if (request.method === "POST") return await handleSwitchesPost(request, env);
      }

      if (request.method === "POST" && (pathname === "/api/generate" || pathname === "/v1/audit")) {
        return await handleGenerate(request, env);
      }

      if (request.method === "POST" && pathname === "/v1/audit/store") {
        return await handleAuditStore(request, env);
      }

      const auditMatch = pathname.match(AUDIT_PATTERN);
      if (request.method === "GET" && auditMatch) {
        return await handleAuditGet(auditMatch[1], request, env);
      }

      if (pathname === "/admin/candidates" && request.method === "GET") {
        return await handleList(request, env);
      }

      const adminMatch = pathname.match(ADMIN_PATTERN);
      if (adminMatch) {
        const [, id, action] = adminMatch;
        if (!ID_PATTERN.test(id)) {
          return json({ error: { code: "bad_id", message: "Invalid id" } }, { status: 400, origin });
        }
        if (!action && request.method === "GET") return await handleDetail(id, request, env);
        if (action === "approve" && request.method === "POST") return await handleApprove(id, request, env);
        if (action === "reject" && request.method === "POST") return await handleReject(id, request, env);
      }

      return json({ error: { code: "not_found", message: "No such route" } }, { status: 404, origin });
    } catch (err) {
      return errorResponse(err, request, env);
    }
  }
};
