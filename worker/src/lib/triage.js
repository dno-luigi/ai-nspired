/**
 * clef-flash triage. This runs before anything else and decides what the rest
 * of the pipeline is allowed to do. It is a 9B decision model: it returns
 * probabilities, never prose, so every answer is treated as advisory and the
 * Worker enforces its own thresholds and backstops.
 */

export const DOMAINS = [
  "family",
  "criminal",
  "civil",
  "contract",
  "housing",
  "employment",
  "procedural",
  "other"
];

/** Below this, we do not trust the classification and fall back to "other". */
const CHOICE_CONFIDENCE_FLOOR = 0.4;
/** Above this, treat the request as a UPL risk and refuse the draft path. */
const UPL_REFUSE_THRESHOLD = 0.75;
/** Above this, ground the answer in web sources. */
const SEARCH_THRESHOLD = 0.5;

const QUESTIONS = {
  domain: {
    type: "choice",
    instructions:
      "Which area of law best describes this request? Choose the single most specific option.",
    criteria: {
      family: "Divorce, custody, support, guardianship, adoption",
      criminal: "Charges, plea, sentencing, probation, arrest, search",
      civil: "Torts, negligence, property damage, personal injury, defamation",
      contract: "Agreements, breach, damages, sales, services, non-compete",
      housing: "Eviction, lease, habitability, security deposit, foreclosure",
      employment: "Wages, termination, discrimination, unemployment, classification",
      procedural: "Filing rules, deadlines, service, jurisdiction, court format",
      other: "Anything that does not clearly fit the categories above"
    }
  },
  needs_web_search: {
    type: "noul",
    instructions:
      "Does answering this well require current statutes, recently decided cases, or citations that are not already present in the state? Answer yes for questions about what the law currently says."
  },
  upl_risk: {
    type: "noul",
    instructions:
      "Is the author asking for legal representation, or for a document to be filed with a court on their behalf, rather than for information about their situation?"
  },
  urgency: {
    type: "score",
    instructions: "How time critical is this request?",
    criteria: ["No stated deadline", "Within 30 days", "Within 7 days", "Within 48 hours"]
  }
};

const UPL_PATTERN =
  /represent me|appear (in court )?(on my behalf|for me)|file (this|it) (for me|on my behalf)|draft (my|the) (motion|pleading|brief|complaint) (to file|for filing)|you are my (attorney|lawyer)/i;

const IDENTIFIER_PATTERNS = {
  ssn: /\b\d{3}-\d{2}-\d{4}\b/,
  phone: /\b(?:\+1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/,
  email: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  caseNumber:
    /\b(?:case|docket|no\.?)\s*(?:#|number|no\.?)?\s*[:#]?\s*[A-Z0-9][A-Z0-9:\-]{4,}\b/i,
  streetAddress: /\b\d{1,5}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,3}\s+(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|ct|court|way|pl|place)\b/i
};

function asProbability(answer) {
  if (typeof answer === "number") return clamp01(answer);
  if (answer && typeof answer === "object") {
    if (typeof answer.probability === "number") return clamp01(answer.probability);
    if (typeof answer.yes === "number") return clamp01(answer.yes);
    if (typeof answer.probabilities === "object" && answer.probabilities) {
      const yes = answer.probabilities.yes ?? answer.probabilities.true;
      if (typeof yes === "number") return clamp01(yes);
    }
  }
  return 0;
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * The choice and score answer shapes are not pinned down in the docs, so this
 * reads every plausible shape rather than trusting one. Returns { value, confidence }.
 */
function asChoice(answer, allowed) {
  if (typeof answer === "string" && allowed.includes(answer)) {
    return { value: answer, confidence: 1 };
  }
  if (answer && typeof answer === "object") {
    if (typeof answer.choice === "string" && allowed.includes(answer.choice)) {
      return { value: answer.choice, confidence: 1 };
    }
    if (typeof answer.option === "string" && allowed.includes(answer.option)) {
      return { value: answer.option, confidence: 1 };
    }
    const probs = answer.probabilities;
    if (probs && typeof probs === "object") {
      const ranked = Object.entries(probs)
        .filter(([key]) => allowed.includes(key))
        .sort((a, b) => Number(b[1]) - Number(a[1]));
      if (ranked.length) {
        return { value: ranked[0][0], confidence: clamp01(Number(ranked[0][1])) };
      }
    }
  }
  return { value: null, confidence: 0 };
}

function asScoreLabel(answer, criteria) {
  let index = null;
  if (typeof answer === "number") index = Math.round(answer);
  else if (answer && typeof answer === "object" && typeof answer.score === "number") {
    index = Math.round(answer.score);
  }
  if (index === null || !Number.isFinite(index)) return criteria[0];
  return criteria[Math.min(Math.max(index, 0), criteria.length - 1)];
}

export function screenPii(text) {
  const found = [];
  for (const [name, pattern] of Object.entries(IDENTIFIER_PATTERNS)) {
    if (pattern.test(text)) found.push(name);
  }
  return { hasIdentifiers: found.length > 0, kinds: found };
}

/** Regex backstop for the UPL classifier. A probability is not a guarantee. */
export function uplPatternHit(text) {
  return UPL_PATTERN.test(text);
}

/**
 * Always resolves. A triage failure degrades to safe defaults rather than
 * failing the user's request, because search and generation can still work.
 */
export async function triage(state, env) {
  const trimmed = String(state || "").slice(0, 6000);
  const fallback = {
    domain: "other",
    domainConfidence: 0,
    needsSearch: true,
    searchConfidence: 0,
    uplRisk: uplPatternHit(trimmed),
    uplConfidence: 0,
    urgency: "No stated deadline",
    pii: screenPii(trimmed),
    degraded: true
  };

  let answers;
  try {
    const response = await env.AI.run("@cf/cloudflare/clef-flash", {
      model: "clef-flash",
      state: trimmed,
      questions: QUESTIONS
    });
    answers = response?.answers;
  } catch (err) {
    console.error("triage_failed", { message: err?.message });
    return fallback;
  }

  if (!answers || typeof answers !== "object") return fallback;

  const domain = asChoice(answers.domain, DOMAINS);
  const searchConfidence = asProbability(answers.needs_web_search);
  const uplConfidence = asProbability(answers.upl_risk);

  return {
    domain:
      domain.value && domain.confidence >= CHOICE_CONFIDENCE_FLOOR
        ? domain.value
        : "other",
    domainConfidence: domain.confidence,
    needsSearch: searchConfidence >= SEARCH_THRESHOLD,
    searchConfidence,
    // Either signal is enough to trip the gate. Fail safe, not fast.
    uplRisk: uplConfidence >= UPL_REFUSE_THRESHOLD || uplPatternHit(trimmed),
    uplConfidence,
    urgency: asScoreLabel(answers.urgency, QUESTIONS.urgency.criteria),
    pii: screenPii(trimmed),
    degraded: false
  };
}
