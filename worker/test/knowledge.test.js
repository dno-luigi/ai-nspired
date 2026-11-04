import test from "node:test";
import assert from "node:assert/strict";
import {
  candidateFromTurn,
  approveCandidate,
  rejectCandidate,
  getCandidate,
  searchApproved,
  PENDING,
  APPROVED,
  REJECTED
} from "../src/lib/knowledge.js";

function memoryEnv() {
  const kv = new Map();
  const r2 = new Map();

  return {
    KNOWLEDGE_INDEX: {
      async get(key) {
        return kv.has(key) ? kv.get(key) : null;
      },
      async put(key, value) {
        kv.set(key, value);
      }
    },
    ORP: {
      async put(key, value) {
        r2.set(key, value);
      },
      async get(key) {
        return r2.has(key) ? { text: async () => r2.get(key) } : null;
      },
      async delete(key) {
        r2.delete(key);
      }
    }
  };
}

const LONG_ANSWER =
  "The court must give notice before ruling on a dispositive motion. ".repeat(12);

const CLEAN_TRIAGE = {
  pii: { hasIdentifiers: false, kinds: [] },
  uplRisk: false,
  domain: "housing",
  urgency: "Within 30 days"
};

async function seed(env, overrides = {}) {
  return candidateFromTurn(
    {
      state:
        overrides.state ??
        "My landlord withheld the security deposit without an itemized list.",
      answer: overrides.answer ?? LONG_ANSWER,
      triage: overrides.triage ?? CLEAN_TRIAGE,
      sources: [{ url: "https://example.gov/x" }],
      mode: "audit",
      auditId: "audit-1"
    },
    env
  );
}

test("a substantive turn becomes a pending candidate with a fixed prior", async () => {
  const env = memoryEnv();
  const { candidate, reason } = await seed(env);

  assert.equal(reason, null);
  assert.equal(candidate.status, PENDING);
  assert.equal(candidate.confidence, 0.75);

  const stored = await getCandidate(candidate.id, env);
  assert.ok(stored.answer.length > 400);
});

test("hard identifiers, UPL risk and short answers are never candidated", async () => {
  const env = memoryEnv();

  const pii = await seed(env, {
    triage: { ...CLEAN_TRIAGE, pii: { hasIdentifiers: true, kinds: ["ssn"] } }
  });
  assert.equal(pii.reason, "pii");

  const upl = await seed(env, { triage: { ...CLEAN_TRIAGE, uplRisk: true } });
  assert.equal(upl.reason, "upl");

  const short = await seed(env, { answer: "too short" });
  assert.equal(short.reason, "too_short");
});

test("approval requires a named expert", async () => {
  const env = memoryEnv();
  const { candidate } = await seed(env);

  await assert.rejects(
    () => approveCandidate(candidate.id, {}, env),
    (err) => err.status === 400
  );
});

test("approval promotes to 0.90 and further approvals accrue", async () => {
  const env = memoryEnv();
  const { candidate } = await seed(env);

  const first = await approveCandidate(candidate.id, { expert: "R. Vega" }, env);
  assert.equal(first.status, APPROVED);
  assert.equal(first.confidence, 0.9);

  // The second expert must not get a 404 just because the candidate key moved.
  const second = await approveCandidate(candidate.id, { expert: "M. Okafor" }, env);
  assert.equal(second.status, APPROVED);
  assert.equal(second.confidence, 0.92);
  assert.equal(second.approvals, 2);
});

test("a rejected candidate cannot be approved afterwards", async () => {
  const env = memoryEnv();
  const { candidate } = await seed(env);

  const rejected = await rejectCandidate(
    candidate.id,
    { expert: "R. Vega", reason: "overbroad" },
    env
  );
  assert.equal(rejected.status, REJECTED);

  await assert.rejects(
    () => approveCandidate(candidate.id, { expert: "R. Vega" }, env),
    (err) => err.status === 409
  );
});

test("retrieval only returns approved knowledge", async () => {
  const env = memoryEnv();
  const { candidate } = await seed(env);

  assert.deepEqual(await searchApproved("landlord security deposit", env), []);

  await approveCandidate(candidate.id, { expert: "R. Vega" }, env);

  const hits = await searchApproved("landlord security deposit", env);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].confidence, 0.9);
});
