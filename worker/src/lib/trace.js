/**
 * Provenance trace.
 *
 * Every stage records what it did or why it was skipped. The old pipeline
 * emitted `search_failed` and then threw the information away, so a finished
 * audit could not say whether it was grounded or guessed. The trace rides on
 * the `done` frame and is stored with the audit, which is what makes a report
 * citable instead of just plausible.
 *
 * Entries are `{ stage, detail, ms }` where `detail` is a plain object so the
 * client can format it rather than parse a sentence.
 */

export const STAGES = [
  "triage",
  "draft_withheld",
  "search",
  "search_failed",
  "search_disabled",
  "extract",
  "knowledge",
  "generate"
];

export function createTrace() {
  const startedAt = Date.now();
  const entries = [];

  return {
    add(stage, detail = null) {
      entries.push({ stage, detail: detail ?? null, ms: Date.now() - startedAt });
      return this;
    },

    entries() {
      return entries.map((entry) => ({ ...entry }));
    },

    /** Final view: entries plus wall time. Call once, after the last `add`. */
    finish() {
      return {
        entries: entries.map((entry) => ({ ...entry })),
        totalMs: Date.now() - startedAt
      };
    }
  };
}
