import test from "node:test";
import assert from "node:assert/strict";
import { triage, screenPii, uplPatternHit } from "../src/lib/triage.js";

const answersEnv = (answers) => ({ AI: { run: async () => ({ answers }) } });

test("reads probabilistic answers and classifies a domain", async () => {
  const env = answersEnv({
    domain: { probabilities: { family: 0.82, civil: 0.1 } },
    needs_web_search: { probability: 0.9 },
    upl_risk: { probability: 0.05 },
    urgency: { score: 2 }
  });

  const t = await triage("How do I respond to a custody modification motion?", env);

  assert.equal(t.domain, "family");
  assert.equal(t.needsSearch, true);
  assert.equal(t.uplRisk, false);
  assert.equal(t.urgency, "Within 7 days");
  assert.equal(t.degraded, false);
  assert.equal(t.pii.hasIdentifiers, false);
});

test("a low-confidence domain falls back to other", async () => {
  const t = await triage(
    "question text",
    answersEnv({
      domain: { probabilities: { family: 0.3 } },
      needs_web_search: { probability: 0.1 },
      upl_risk: { probability: 0 },
      urgency: { score: 0 }
    })
  );

  assert.equal(t.domain, "other");
  assert.equal(t.needsSearch, false);
});

test("the search threshold is inclusive at 0.5", async () => {
  const t = await triage(
    "question text",
    answersEnv({
      domain: { choice: "civil" },
      needs_web_search: { probability: 0.5 },
      upl_risk: { probability: 0 },
      urgency: { score: 0 }
    })
  );

  assert.equal(t.needsSearch, true);
});

test("a UPL probability above the threshold trips the gate", async () => {
  const t = await triage(
    "please represent me in this matter",
    answersEnv({
      domain: { choice: "civil" },
      needs_web_search: { probability: 0.2 },
      upl_risk: { probabilities: { yes: 0.9 } },
      urgency: { score: 0 }
    })
  );

  assert.equal(t.uplRisk, true);
  assert.ok(t.uplConfidence >= 0.75);
});

test("the regex backstop catches phrasing the model scores low", async () => {
  const t = await triage(
    "file this for me tomorrow",
    answersEnv({
      domain: { choice: "procedural" },
      needs_web_search: { probability: 0.2 },
      upl_risk: { probability: 0.01 },
      urgency: { score: 0 }
    })
  );

  assert.equal(t.uplRisk, true);
  assert.equal(uplPatternHit("draft my motion to file"), true);
  assert.equal(uplPatternHit("what is the deadline for a reply"), false);
});

test("a triage failure degrades instead of failing the request", async () => {
  const t = await triage("anything at all", {
    AI: {
      run: async () => {
        throw new Error("boom");
      }
    }
  });

  assert.equal(t.degraded, true);
  assert.equal(t.domain, "other");
  assert.equal(t.needsSearch, true);
});

test("a missing AI binding degrades the same way", async () => {
  const t = await triage("anything at all", {});
  assert.equal(t.degraded, true);
});

test("the PII screen names every identifier kind it finds", () => {
  const { hasIdentifiers, kinds } = screenPii("SSN 123-45-6789, call (305) 555-1212, mail a@b.com");

  assert.equal(hasIdentifiers, true);
  for (const kind of ["ssn", "phone", "email"]) {
    assert.ok(kinds.includes(kind), `missing ${kind}`);
  }
});

test("an ordinary legal question is not flagged as PII", () => {
  const { hasIdentifiers } = screenPii("My landlord withheld the deposit without an itemized statement.");
  assert.equal(hasIdentifiers, false);
});
