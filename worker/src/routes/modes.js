import { json, matchOrigin } from "../lib/http.js";
import { getMode, modeNames } from "../prompts/index.js";

/**
 * GET /v1/modes
 *
 * Mirrors the ai-Ncards `/api/presets` rule: ids, names and capabilities only.
 * No prompt text, no model slug, nothing a client could use to reconstruct how
 * an answer is produced. This exists so the front end stops hardcoding
 * audit|draft|review in three places and drifting when a mode is added.
 */
export async function handleModes(request, env) {
  const origin = matchOrigin(request, env);
  return json(
    {
      modes: modeNames().map((id) => {
        const mode = getMode(id);
        return {
          id,
          label: mode.label,
          search: Boolean(mode.search),
          maxTokens: mode.maxTokens
        };
      })
    },
    { origin }
  );
}
