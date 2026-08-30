// src/worker.mjs
import { DurableObject } from "cloudflare:workers";

// src/llm-router.mjs
var CF_AI_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";
var OPENROUTER_MODEL = "@preset/truth";
var TASK_BACKEND = {
  classify: "cf",
  ocr: "cf",
  compliance: "cf",
  proposePrinciples: "cf",
  instruct_simple: "cf",
  instruct_complex: "openrouter",
  deepQuery: "openrouter",
  deepAudit: "openrouter",
  analyzeGap: "openrouter",
  generate: "openrouter"
};
var LLMRouter = class {
  constructor(cfAI, openrouterKey, openrouterBaseUrl = "https://openrouter.ai/api/v1") {
    this.cfAI = cfAI;
    this.openrouterKey = openrouterKey;
    this.openrouterBaseUrl = openrouterBaseUrl;
  }
  async callCfAI(messages, options = {}) {
    const response = await this.cfAI.run(CF_AI_MODEL, {
      messages,
      max_tokens: options.maxTokens || 2048,
      temperature: options.temperature ?? 0.3,
      stream: false
    });
    return response?.response || "";
  }
  async callOpenRouter(messages, options = {}) {
    const response = await fetch(`${this.openrouterBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.openrouterKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages,
        max_tokens: options.maxTokens || 4096,
        temperature: options.temperature ?? 0.3
      })
    });
    const data = await response.json();
    return data?.choices?.[0]?.message?.content || "";
  }
  async call(task, messages, options = {}) {
    const backend = TASK_BACKEND[task] || "cf";
    try {
      if (backend === "cf") {
        return await this.callCfAI(messages, options);
      } else {
        return await this.callOpenRouter(messages, options);
      }
    } catch (err) {
      const fallback = backend === "cf" ? "openrouter" : "cf";
      try {
        if (fallback === "openrouter") {
          return await this.callOpenRouter(messages, options);
        } else {
          return await this.callCfAI(messages, options);
        }
      } catch (fallbackErr) {
        throw new Error(`LLM backend failed: ${err.message}, fallback also failed: ${fallbackErr.message}`);
      }
    }
  }
  async classify(content, domainHints = []) {
    const prompt = [
      { role: "system", content: 'You are a domain classifier. Given content, return a JSON object with "domain" (one of: general, legal, educational, medical, technical) and "principles" (array of 1-3 concise principle statements that should govern this content). Return ONLY valid JSON, no markdown.' },
      { role: "user", content: `Classify this content and propose governing principles:

${content.slice(0, 3e3)}` }
    ];
    const raw = await this.call("classify", prompt);
    try {
      const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      return JSON.parse(cleaned);
    } catch {
      return { domain: "general", principles: [] };
    }
  }
  async ocr(bytes, mimeType) {
    const input = { image: [...new Uint8Array(bytes)] };
    const response = await this.cfAI.run(CF_AI_MODEL, {
      messages: [
        { role: "system", content: "Extract all visible text from this image. Return only the text, no commentary." }
      ],
      ...input
    });
    return response?.response || "";
  }
  async checkCompliance(content, principles) {
    const principleList = principles.map((p, i) => `[${i + 1}] (${p.domainTag}) ${p.text}`).join("\n");
    const prompt = [
      { role: "system", content: 'You are a compliance checker. Given content and a list of principles, check if the content complies with each principle. Return a JSON object with "violations" (array of {principleIndex, description}) and "suggestions" (array of {principleIndex, suggestion}). Return ONLY valid JSON.' },
      { role: "user", content: `Content:
${content.slice(0, 3e3)}

Principles:
${principleList}` }
    ];
    const raw = await this.call("compliance", prompt);
    try {
      const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      return JSON.parse(cleaned);
    } catch {
      return { violations: [], suggestions: [] };
    }
  }
  async proposePrinciples(content, domain) {
    const prompt = [
      { role: "system", content: `You are a principle proposal engine for the "${domain}" domain. Given content, propose 2-4 concise governing principles that should be extracted and ratified. Each principle should be a clear, actionable constraint. Return a JSON array of objects with "text" (the principle statement) and "rationale" (why this principle matters). Return ONLY valid JSON.` },
      { role: "user", content: `Extract governing principles from this ${domain} content:

${content.slice(0, 3e3)}` }
    ];
    const raw = await this.call("proposePrinciples", prompt);
    try {
      const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      return JSON.parse(cleaned);
    } catch {
      return [];
    }
  }
  async routeInstruct(prompt, principles, isComplex = false) {
    const task = isComplex ? "instruct_complex" : "instruct_simple";
    const principleList = principles.map((p, i) => `[${i + 1}] (${p.domainTag}) ${p.text}`).join("\n");
    const messages = [
      { role: "system", content: `You are a domain-bound generation engine. Generate output that strictly adheres to the following governing principles:

${principleList}

If the output would violate any principle, refuse and explain why.` },
      { role: "user", content: prompt }
    ];
    return await this.call(task, messages);
  }
  async deepQuery(query, principles, cards) {
    const principleList = principles.map((p, i) => `[${i + 1}] (${p.domainTag}) ${p.text} [weight: ${p.confidenceWeight}]`).join("\n");
    const cardList = cards.map((c, i) => `[Card ${i + 1}] (${c.type}) ${c.title}: ${c.content?.slice(0, 500) || ""}`).join("\n");
    const messages = [
      { role: "system", content: `You are a truth-engine query processor. Given a query, governing principles, and workspace content, rank relevant results by relevance and principle alignment. Return a JSON array of objects with "sourceType" (principle|card), "sourceId", "relevance" (0-1), "snippet" (relevant excerpt), "confidence" ({base, total}). Return ONLY valid JSON.` },
      { role: "user", content: `Query: ${query}

Active Principles:
${principleList}

Workspace Content:
${cardList}` }
    ];
    const raw = await this.call("deepQuery", messages);
    try {
      const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      return JSON.parse(cleaned);
    } catch {
      return [];
    }
  }
  async deepAudit(cards, principles, scope) {
    const principleList = principles.map((p, i) => `[${i + 1}] (${p.domainTag}) ${p.text} [weight: ${p.confidenceWeight}]`).join("\n");
    const cardList = cards.map((c, i) => `[Card ${i + 1}] (${c.type}) ${c.title}:
${c.content?.slice(0, 1e3) || "(empty)"}`).join("\n\n");
    const scopeDesc = scope === "full" ? "Perform a comprehensive analysis including citation verification, structural completeness, and logical consistency." : "Perform a compliance-only check against the principles.";
    const messages = [
      { role: "system", content: `You are a truth-engine audit system. Audit the following cards against the governing principles. ${scopeDesc}

Return a JSON object with:
- "findings": array of {cardId, severity (info|warning|violation), principleId, principleText, description, suggestion, confidence (0-1)}
- "principleCoverage": {total, satisfied, violated, unaddressed}
- "overallConfidence": 0-1
- "status": "pass"|"conditional"|"fail"

Return ONLY valid JSON.` },
      { role: "user", content: `Cards to audit:

${cardList}

Governing Principles:
${principleList}` }
    ];
    const raw = await this.call("deepAudit", messages);
    try {
      const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      return JSON.parse(cleaned);
    } catch {
      return { findings: [], principleCoverage: { total: principles.length, satisfied: 0, violated: 0, unaddressed: principles.length }, overallConfidence: 0, status: "fail" };
    }
  }
  async analyzeGap(baseScore, expertScore, cardContent) {
    const messages = [
      { role: "system", content: 'You are a gap analyst. Given a BASE confidence score, an expert-adjusted score, and the card content, explain why the expert judged differently. Return a JSON object with "explanation", "keyFactors" (array), and "learningPoint" (what the system should learn). Return ONLY valid JSON.' },
      { role: "user", content: `BASE score: ${baseScore}
Expert score: ${expertScore}
Differential: ${expertScore - baseScore}

Card content:
${cardContent?.slice(0, 2e3) || "(empty)"}` }
    ];
    const raw = await this.call("analyzeGap", messages);
    try {
      const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      return JSON.parse(cleaned);
    } catch {
      return { explanation: "Gap analysis unavailable", keyFactors: [], learningPoint: "" };
    }
  }
};

// src/domains.mjs
var DOMAINS = {
  general: { label: "General", tier: "base", color: "#888" },
  legal: { label: "Legal", tier: "domain", color: "#4ab8ff" },
  educational: { label: "Education", tier: "domain", color: "#8aff4a" },
  medical: { label: "Medical", tier: "domain", color: "#ff4a8a" },
  technical: { label: "Technical", tier: "domain", color: "#c14aff" }
};
var DOMAIN_LIST = Object.keys(DOMAINS);
function isValidDomain(domain) {
  return domain in DOMAINS;
}
var KvKeys = {
  principles: (d) => `domain:${d}:principles`,
  stack: (d) => `domain:${d}:stack`,
  searchCache: (d, hash) => `domain:${d}:search:${hash}`,
  queryCache: (d, qid) => `domain:${d}:query:${qid}`,
  auditCache: (d, aid) => `domain:${d}:audit:${aid}`,
  registry: () => "domains:registry",
  domainStats: (d) => `domain:${d}:stats`
};
var R2Paths = {
  import: (domain, id, file) => `${domain}/imports/${id}/${file}`,
  snapshot: (domain, cardId, ts) => `${domain}/snapshots/${cardId}/${ts}`,
  template: (domain, tid) => `${domain}/templates/${tid}`,
  export: (domain, wsId) => `${domain}/exports/${wsId}.json`,
  listPrefix: (domain, type) => `${domain}/${type}/`
};
function createDomainStack(primary = "general", secondary = [], sourceCardId = null) {
  return {
    primary: isValidDomain(primary) ? primary : "general",
    secondary: secondary.filter(isValidDomain),
    activatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    sourceCardId
  };
}
function getActiveDomains(stack) {
  if (!stack) return ["general"];
  return [stack.primary, ...stack.secondary || []];
}

// src/worker.mjs
var INDEX_HTML = `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Truth Engine — Workspace</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          colors: {
            accent: '#ff6b1a',
            'accent-hover': '#ff8533',
            panel: '#1a1a2e',
            'panel-light': '#22223a',
            canvas: '#0d0d1a',
          },
        },
      },
    };
  </script>
  <style>
    body { background: #0d0d1a; color: #e0e0e0; font-family: 'Inter', system-ui, sans-serif; }
    .card-window { position: absolute; min-width: 280px; max-width: 480px; background: #1a1a2e; border: 1px solid #2a2a4a; border-radius: 10px; box-shadow: 0 8px 32px rgba(0,0,0,0.5); transition: box-shadow 0.2s; display: flex; flex-direction: column; overflow: hidden; }
    .card-window.browser-card { max-width: 640px; min-width: 400px; }
    .card-window:hover { box-shadow: 0 8px 40px rgba(255,107,26,0.15); border-color: #ff6b1a55; }
    .card-header { cursor: grab; user-select: none; -webkit-user-select: none; touch-action: none; padding: 8px 12px; background: #22223a; border-radius: 10px 10px 0 0; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #2a2a4a; }
    .card-header:active { cursor: grabbing; }
    .card-type-badge { font-size: 10px; padding: 2px 8px; border-radius: 4px; font-weight: 600; text-transform: uppercase; }
    .badge-browser { background: #1a4a6a; color: #4ab8ff; }
    .badge-document { background: #2a3a1a; color: #8aff4a; }
    .badge-instruct { background: #4a2a1a; color: #ff8a4a; }
    .badge-import { background: #3a1a4a; color: #c14aff; }
    .badge-search { background: #1a3a3a; color: #4affc8; }
    .badge-query { background: #1a2a4a; color: #4a9fff; }
    .badge-audit { background: #4a1a2a; color: #ff4a6a; }
    .badge-domain { background: #2a2a1a; color: #c8c84a; }
    .audit-pass { border-left: 3px solid #4aff8a; }
    .audit-conditional { border-left: 3px solid #ffaa4a; }
    .audit-fail { border-left: 3px solid #ff4a4a; }
    .audit-finding { padding: 6px 8px; margin: 4px 0; background: #0d0d1a; border-radius: 4px; font-size: 11px; border-left: 2px solid #2a2a4a; }
    .audit-finding.violation { border-left-color: #ff4a4a; }
    .audit-finding.warning { border-left-color: #ffaa4a; }
    .audit-finding.info { border-left-color: #4a9fff; }
    .audit-coverage { display: flex; gap: 12px; padding: 6px 0; font-size: 11px; }
    .audit-coverage .cov-item { display: flex; align-items: center; gap: 4px; }
    .audit-coverage .cov-dot { width: 8px; height: 8px; border-radius: 50%; }
    .query-result { padding: 6px 8px; margin: 4px 0; background: #0d0d1a; border-radius: 4px; font-size: 11px; border-left: 2px solid #4a9fff; cursor: pointer; }
    .query-result:hover { border-left-color: #ff6b1a; background: #111122; }
    .query-result .result-type { font-size: 9px; text-transform: uppercase; color: #888; }
    .query-result .result-snippet { color: #aaa; margin-top: 2px; }
    .query-result .result-relevance { font-size: 10px; color: #4aff8a; float: right; }
    .domain-stack-panel { display: flex; gap: 6px; align-items: center; padding: 4px 0; flex-wrap: wrap; }
    .domain-chip { padding: 2px 8px; border-radius: 4px; font-size: 10px; font-weight: 600; cursor: pointer; border: 1px solid #2a2a4a; }
    .domain-chip.primary { border-color: #ff6b1a; background: #ff6b1a22; color: #ff6b1a; }
    .domain-chip.secondary { border-color: #2a2a4a; background: #22223a; color: #888; }
    .domain-chip:hover { border-color: #ff6b1a; }
    .domain-asset-item { display: flex; justify-content: space-between; align-items: center; padding: 4px 8px; background: #0d0d1a; border-radius: 4px; font-size: 11px; margin: 2px 0; }
    .domain-asset-item .asset-name { color: #4ab8ff; }
    .domain-asset-item .asset-size { color: #888; font-size: 10px; }
    .card-content { padding: 10px 12px; flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; }
    .card-content > textarea { width: 100%; background: #0d0d1a; color: #e0e0e0; border: 1px solid #2a2a4a; border-radius: 6px; padding: 8px 10px; font-size: 13px; font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace; resize: vertical; min-height: 100px; line-height: 1.6; tab-size: 2; flex: 1; }
    .card-content textarea:focus { outline: none; border-color: #ff6b1a; }
    .card-toolbar { display: flex; gap: 4px; padding: 4px 0; flex-wrap: wrap; align-items: center; }
    .card-toolbar .sep { width: 1px; height: 16px; background: #2a2a4a; margin: 0 2px; }
    .card-toolbar button { padding: 2px 7px; background: transparent; border: 1px solid #2a2a4a; border-radius: 4px; color: #888; font-size: 10px; cursor: pointer; transition: all 0.15s; line-height: 1.4; }
    .card-toolbar button:hover { border-color: #ff6b1a; color: #ff6b1a; }
    .card-toolbar button.active { background: #ff6b1a22; border-color: #ff6b1a; color: #ff6b1a; }
    .card-toolbar button[title]::after { content: attr(title); }
    .browser-viewer { width: 100%; min-height: 200px; flex: 1; border: 1px solid #2a2a4a; border-radius: 6px; overflow: hidden; background: #fff; position: relative; }
    .browser-viewer iframe { width: 100%; height: 100%; position: absolute; top: 0; left: 0; border: none; }
    .browser-bar { display: flex; align-items: center; gap: 6px; padding: 4px 8px; background: #1a1a2e; border-bottom: 1px solid #2a2a4a; font-size: 10px; }
    .browser-bar .url-display { flex: 1; background: #0d0d1a; border: 1px solid #2a2a4a; border-radius: 4px; padding: 2px 6px; color: #4ab8ff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .browser-bar button { padding: 2px 6px; background: #22223a; border: 1px solid #2a2a4a; border-radius: 3px; color: #888; font-size: 9px; cursor: pointer; }
    .browser-bar button:hover { color: #ff6b1a; border-color: #ff6b1a; }
    .md-preview { background: #0d0d1a; color: #d0d0d0; border: 1px solid #2a2a4a; border-radius: 6px; padding: 10px 12px; font-size: 13px; line-height: 1.7; min-height: 100px; overflow-y: auto; white-space: pre-wrap; word-wrap: break-word; }
    .md-preview h1 { font-size: 20px; font-weight: 700; margin: 8px 0 4px; color: #fff; }
    .md-preview h2 { font-size: 17px; font-weight: 600; margin: 8px 0 4px; color: #fff; }
    .md-preview h3 { font-size: 15px; font-weight: 600; margin: 6px 0 3px; color: #e0e0e0; }
    .md-preview p { margin: 4px 0; }
    .md-preview code { background: #22223a; padding: 1px 5px; border-radius: 3px; font-family: 'SF Mono', monospace; font-size: 12px; color: #ff8a4a; }
    .md-preview pre { background: #111122; border: 1px solid #2a2a4a; border-radius: 6px; padding: 10px; margin: 6px 0; overflow-x: auto; }
    .md-preview pre code { background: none; padding: 0; color: #e0e0e0; }
    .md-preview blockquote { border-left: 3px solid #ff6b1a; padding-left: 10px; margin: 6px 0; color: #aaa; }
    .md-preview ul, .md-preview ol { padding-left: 20px; margin: 4px 0; }
    .md-preview li { margin: 2px 0; }
    .md-preview a { color: #4ab8ff; text-decoration: none; }
    .md-preview a:hover { text-decoration: underline; }
    .md-preview hr { border: none; border-top: 1px solid #2a2a4a; margin: 8px 0; }
    .md-preview table { border-collapse: collapse; margin: 6px 0; width: 100%; }
    .md-preview th, .md-preview td { border: 1px solid #2a2a4a; padding: 4px 8px; text-align: left; font-size: 12px; }
    .md-preview th { background: #22223a; }
    .md-preview strong { color: #fff; }
    .md-preview em { color: #ccc; font-style: italic; }
    .card-url { font-size: 10px; color: #4ab8ff; word-break: break-all; margin-bottom: 4px; }
    .ctrl-btn { display: flex; align-items: center; gap: 6px; padding: 8px 16px; background: #22223a; border: 1px solid #2a2a4a; border-radius: 8px; color: #e0e0e0; font-size: 13px; font-weight: 500; cursor: pointer; transition: all 0.15s; }
    .ctrl-btn:hover { background: #2a2a4a; border-color: #ff6b1a; color: #ff6b1a; }
    .action-btn { padding: 6px 12px; background: #ff6b1a; color: #0d0d1a; border: none; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer; }
    .action-btn:hover { background: #ff8533; }
    .action-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .selected { border-color: #ff6b1a !important; box-shadow: 0 0 0 2px #ff6b1a55; }
    .rel-link { font-size: 10px; color: #ff6b1a99; }
    #canvas { position: relative; width: 100%; height: calc(100vh - 60px); min-width: 140vw; min-height: 140vh; overflow: auto; }
    .topbar { height: 60px; display: flex; align-items: center; justify-content: space-between; padding: 0 20px; background: #1a1a2e; border-bottom: 1px solid #2a2a4a; }
    .logo { font-size: 18px; font-weight: 700; letter-spacing: 2px; }
    .logo span { color: #ff6b1a; }
    .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center; z-index: 100; }
    .modal { background: #1a1a2e; border: 1px solid #2a2a4a; border-radius: 12px; padding: 24px; width: 480px; max-width: 90vw; }
    .modal input, .modal textarea, .modal select { width: 100%; background: #0d0d1a; color: #e0e0e0; border: 1px solid #2a2a4a; border-radius: 6px; padding: 8px 10px; font-size: 13px; }
    .modal input:focus, .modal textarea:focus { outline: none; border-color: #ff6b1a; }
    .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid #2a2a4a; border-top-color: #ff6b1a; border-radius: 50%; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .presence-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #4aff8a; margin-right: 4px; }
    .remote-cursor { position: absolute; width: 12px; height: 12px; border-radius: 50%; border: 2px solid #ff6b1a; pointer-events: none; z-index: 50; transition: all 0.1s ease; }
    .ws-status { font-size: 10px; padding: 2px 6px; border-radius: 4px; }
    .ws-connected { background: #1a4a2a; color: #4aff8a; }
    .ws-disconnected { background: #4a1a1a; color: #ff4a4a; }
    .ws-connecting { background: #4a3a1a; color: #ffaa4a; }
    .toast-container { position: fixed; bottom: 20px; right: 20px; z-index: 200; display: flex; flex-direction: column; gap: 8px; pointer-events: none; }
    .toast { padding: 10px 16px; border-radius: 8px; font-size: 13px; font-weight: 500; pointer-events: auto; animation: toastIn 0.25s ease, toastOut 0.3s ease 2.7s forwards; display: flex; align-items: center; gap: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.4); }
    .toast-success { background: #1a4a2a; color: #4aff8a; border: 1px solid #2a6a3a; }
    .toast-info { background: #1a3a5a; color: #4ab8ff; border: 1px solid #2a5a7a; }
    .toast-error { background: #4a1a1a; color: #ff4a4a; border: 1px solid #6a2a2a; }
    .toast-processing { background: #4a3a1a; color: #ffaa4a; border: 1px solid #6a5a2a; }
    .toast-warning { background: #4a3a1a; color: #ffaa4a; border: 1px solid #6a5a2a; }
    @keyframes toastIn { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes toastOut { from { opacity: 1; } to { opacity: 0; transform: translateY(-10px); } }
    .drop-overlay { position: fixed; inset: 0; background: rgba(255,107,26,0.08); border: 3px dashed #ff6b1a; z-index: 150; display: flex; align-items: center; justify-content: center; pointer-events: none; }
    .drop-overlay-text { font-size: 22px; font-weight: 700; color: #ff6b1a; background: #1a1a2e; padding: 16px 32px; border-radius: 12px; border: 1px solid #ff6b1a55; }
    .file-upload-input { display: none; }
    .paste-hint { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: #1a1a2e; border: 1px solid #2a2a4a; border-radius: 8px; padding: 8px 16px; font-size: 11px; color: #888; z-index: 50; pointer-events: none; opacity: 0; transition: opacity 0.3s; }
    .paste-hint.visible { opacity: 1; }
    /* Docking zones */
    .dock-zone { position: absolute; background: rgba(255,107,26,0.15); border: 2px dashed #ff6b1a; border-radius: 4px; z-index: 5; pointer-events: none; opacity: 0; transition: opacity 0.15s; }
    .dock-zone.active { opacity: 1; }
    .dock-zone-left { left: -12px; top: 10%; width: 10px; height: 80%; }
    .dock-zone-right { right: -12px; top: 10%; width: 10px; height: 80%; }
    .dock-zone-top { top: -12px; left: 10%; width: 80%; height: 10px; }
    .dock-zone-bottom { bottom: -12px; left: 10%; width: 80%; height: 10px; }
    .card-window.docked { border-color: #ff6b1a; box-shadow: 0 0 0 2px #ff6b1a44, 0 8px 32px rgba(0,0,0,0.5); }
    .cluster-group { position: absolute; border: 1px solid #ff6b1a33; border-radius: 12px; background: rgba(255,107,26,0.03); pointer-events: none; }
    /* Resize handle */
    .resize-handle { position: absolute; bottom: 0; right: 0; width: 24px; height: 24px; cursor: nwse-resize; touch-action: none; z-index: 10; }
    .resize-handle::after { content: ''; position: absolute; bottom: 3px; right: 3px; width: 8px; height: 8px; border-right: 2px solid #4a4a6a; border-bottom: 2px solid #4a4a6a; }
    .resize-handle:hover::after { border-color: #ff6b1a; }
    /* SearchCard */
    .search-results { max-height: 250px; overflow-y: auto; margin-top: 6px; }
    .search-result-item { padding: 6px 8px; border: 1px solid #2a2a4a; border-radius: 4px; margin-bottom: 4px; cursor: pointer; font-size: 12px; transition: all 0.15s; }
    .search-result-item:hover { border-color: #ff6b1a; background: #22223a; }
    .search-result-item .result-title { color: #4ab8ff; font-weight: 500; }
    .search-result-item .result-snippet { color: #888; font-size: 11px; margin-top: 2px; }
    /* Principle indicators */
    .principle-badge { display: inline-flex; align-items: center; gap: 3px; padding: 1px 6px; border-radius: 3px; font-size: 9px; font-weight: 600; margin-left: 4px; }
    .principle-auto { background: #1a4a2a; color: #4aff8a; }
    .principle-expert { background: #4a3a1a; color: #ffaa4a; }
    .principle-conflict { background: #4a1a1a; color: #ff4a4a; }
    /* Dock edge indicators */
    .card-edge-dock { position: absolute; width: 4px; background: #ff6b1a; border-radius: 2px; z-index: 5; pointer-events: none; }
    .edge-dock-left { left: -2px; top: 10%; height: 80%; }
    .edge-dock-right { right: -2px; top: 10%; height: 80%; }
    .edge-dock-top { top: -2px; left: 10%; width: 80%; height: 4px; }
    .edge-dock-bottom { bottom: -2px; left: 10%; width: 80%; height: 4px; }
    .split-view { display: flex; gap: 0; flex: 1; min-height: 0; }
    .split-view .split-left, .split-view .split-right { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    .split-view .split-divider { width: 1px; background: #2a2a4a; cursor: col-resize; flex-shrink: 0; }
    .split-view .split-right { border-left: 1px solid #2a2a4a; overflow-y: auto; }
    .picker-list { max-height: 350px; overflow-y: auto; }
    .picker-item { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid #2a2a4a; border-radius: 6px; margin-bottom: 6px; cursor: pointer; transition: all 0.15s; }
    .picker-item:hover { border-color: #ff6b1a; background: #22223a; }
    .picker-item.selected { border-color: #4aff8a; background: #1a4a2a22; }
    .picker-item .picker-title { flex: 1; color: #e0e0e0; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .picker-item .picker-meta { font-size: 10px; color: #888; flex-shrink: 0; }
    .picker-item .picker-badge { font-size: 9px; padding: 1px 6px; border-radius: 3px; font-weight: 600; text-transform: uppercase; }
    .picker-actions { display: flex; gap: 8px; margin-top: 12px; justify-content: flex-end; }
    .card-flip-container { perspective: 1000px; }
    .card-flip-inner { position: relative; width: 100%; transition: transform 0.6s; transform-style: preserve-3d; }
    .card-flip-inner.flipped { transform: rotateY(180deg); }
    .card-flip-front, .card-flip-back { backface-visibility: hidden; }
    .card-flip-back { position: absolute; top: 0; left: 0; width: 100%; transform: rotateY(180deg); }
    .flip-btn { font-size: 10px; padding: 3px 8px; background: #2a2a4a; color: #ff6b1a; border: 1px solid #4a4a6a; border-radius: 4px; cursor: pointer; flex-shrink: 0; }
    .flip-btn:hover { background: #3a3a5a; }
    .elevate-btn { font-size: 10px; padding: 3px 8px; background: #2a4a2a; color: #4aff8a; border: 1px solid #4a6a4a; border-radius: 4px; cursor: pointer; flex-shrink: 0; }
    .elevate-btn:hover { background: #3a5a3a; }
  </style>
</head>
<body>
  <div class="topbar">
    <div class="logo">TRUTH<span>·</span>ENGINE</div>
    <div class="flex gap-2">
      <button class="ctrl-btn" onclick="createCard('Browser')">🌐 Browser</button>
      <button class="ctrl-btn" onclick="createCard('Document')">📄 Document</button>
      <button class="ctrl-btn" onclick="createCard('Instruct')">⚡ Instruct</button>
      <button class="ctrl-btn" onclick="createCard('Import')">📎 Import</button>
      <button class="ctrl-btn" onclick="createCard('Search')">🔍 Search</button>
      <span class="sep" style="width:1px;height:20px;background:#2a2a4a;margin:0 4px;"></span>
      <button class="ctrl-btn" onclick="openTabList('Query')" style="border-color:#1a2a4a;color:#4a9fff;">🔎 Queries</button>
      <button class="ctrl-btn" onclick="openTabList('Audit')" style="border-color:#4a1a2a;color:#ff4a6a;">🔍 Audits</button>
      <button class="ctrl-btn" onclick="openTabList('eitl')" style="border-color:#2a1a4a;color:#c84aff;">⚙ EITL</button>
      <button class="ctrl-btn" onclick="promptDomain()" style="border-color:#2a2a1a;color:#c8c84a;">🌍 Domain</button>
    </div>
    <div class="flex gap-2 items-center">
      <span id="wsStatus" class="ws-status ws-connecting">connecting…</span>
      <span id="presence" class="text-xs text-gray-500"></span>
      <span id="status" class="text-xs text-gray-500"></span>
      <button class="ctrl-btn" onclick="openManipulate()">⚙ Merge / Distill</button>
    </div>
  </div>
  <div id="canvas"></div>
  <div id="fetchModal" class="modal-overlay" style="display:none;">
    <div class="modal">
      <h2 class="text-lg font-bold mb-4">🌐 Browser Card — Fetch URL</h2>
      <p class="text-xs text-gray-400 mb-3">Enter a URL. The Worker fetches it, parses the content with HTMLRewriter, and creates a Browser card.</p>
      <input id="fetchUrl" type="url" placeholder="https://example.com/article" class="mb-4" />
      <div class="flex justify-end gap-2">
        <button class="ctrl-btn" onclick="closeFetch()">Cancel</button>
        <button id="fetchBtn" class="action-btn" onclick="runFetch()">Fetch</button>
      </div>
    </div>
  </div>
  <div id="searchModal" class="modal-overlay" style="display:none;">
    <div class="modal">
      <h2 class="text-lg font-bold mb-4">🔍 Search Card</h2>
      <p class="text-xs text-gray-400 mb-3">Type a query. Results render inside the card. Click a result to materialize it as a Browser or Document card.</p>
      <input id="searchQuery" type="text" placeholder="Search query..." class="mb-4" />
      <div id="searchResults" class="search-results" style="display:none;"></div>
      <div class="flex justify-end gap-2">
        <button class="ctrl-btn" onclick="closeSearch()">Cancel</button>
        <button id="searchBtn" class="action-btn" onclick="runSearch()">Search</button>
      </div>
    </div>
  </div>
  <div id="principleModal" class="modal-overlay" style="display:none;">
    <div class="modal">
      <h2 class="text-lg font-bold mb-4">🔧 Principle Ratification</h2>
      <p class="text-xs text-gray-400 mb-3">The ambient LLM has proposed a new principle. Review and approve, edit, or kill it.</p>
      <div id="principlePreview" class="text-sm mb-3 p-3 bg-slate-950 border border-slate-800 rounded"></div>
      <div class="flex items-center gap-2 mb-3">
        <label class="text-xs text-gray-400">Domain:</label>
        <select id="principleDomain" class="flex-1">
          <option value="universal">Universal (auto-ratify)</option>
          <option value="ethical">Ethical (auto-ratify)</option>
          <option value="legal">Legal (axiom sleeve)</option>
          <option value="educational">Educational (axiom sleeve)</option>
        </select>
      </div>
      <label class="text-xs text-gray-400">Edit text (optional)</label>
      <textarea id="principleEditText" rows="2" class="mb-3"></textarea>
      <div class="flex justify-end gap-2">
        <button class="ctrl-btn" style="border-color:#ff4a4a;color:#ff4a4a;" onclick="killPrinciple()">Kill</button>
        <button class="ctrl-btn" onclick="closePrinciple()">Cancel</button>
        <button class="action-btn" onclick="ratifyPrinciple('approve')">Ratify</button>
      </div>
    </div>
  </div>
  <div id="eitlReviewModal" class="modal-overlay" style="display:none;">
    <div class="modal">
      <h2 class="text-lg font-bold mb-4">📋 EITL Expert Review</h2>
      <p class="text-xs text-gray-400 mb-3">Review the output against the logged principles. Elevate, adjust, or remand.</p>
      <div id="eitlReviewContent" class="text-sm mb-3 p-3 bg-slate-950 border border-slate-800 rounded" style="max-height:200px;overflow-y:auto;white-space:pre-wrap;"></div>
      <label class="text-xs text-gray-400">Expert comment (optional)</label>
      <textarea id="eitlReviewComment" rows="2" class="mb-3" placeholder="Note for the gap log..."></textarea>
      <div class="flex justify-end gap-2">
        <button class="ctrl-btn" style="border-color:#ff4a4a;color:#ff4a4a;" onclick="submitEitlReview('remand')">Remand</button>
        <button class="ctrl-btn" onclick="closeExpertReview()">Cancel</button>
        <button class="ctrl-btn" onclick="submitEitlReview('adjust')">Adjust</button>
        <button class="action-btn" onclick="submitEitlReview('elevate')">Elevate</button>
      </div>
    </div>
  </div>
  <div id="manipulateModal" class="modal-overlay" style="display:none;">
    <div class="modal">
      <h2 class="text-lg font-bold mb-4">Card Manipulation Engine</h2>
      <p class="text-xs text-gray-400 mb-3">Select cards on the canvas first, then choose an action.</p>
      <div id="selectedCount" class="text-sm mb-3"></div>
      <label class="text-xs text-gray-400">Action</label>
      <select id="actionSelect" class="w-full mb-3">
        <option value="merge">Merge — combine into one coherent doc</option>
        <option value="distill">Distill — extract essential truths</option>
        <option value="combine">Combine — unified synthesis</option>
        <option value="rewrite">Rewrite — transform per instruction</option>
      </select>
      <label class="text-xs text-gray-400">Instruction (optional)</label>
      <textarea id="manipulatePrompt" rows="3" class="mb-4" placeholder="e.g., Focus on technical accuracy and remove redundancy"></textarea>
      <div class="flex justify-end gap-2">
        <button class="ctrl-btn" onclick="closeManipulate()">Cancel</button>
        <button id="runBtn" class="action-btn" onclick="runManipulate()">Run</button>
      </div>
    </div>
  </div>
  <input id="fileUpload" class="file-upload-input" type="file" accept=".md,.markdown,.txt,.html,.htm,.docx,.pdf,.png,.jpg,.jpeg,.gif,.webp,.bmp,.svg" multiple />
  <div id="dropOverlay" class="drop-overlay" style="display:none;">
    <div class="drop-overlay-text">📄 Drop files to import</div>
  </div>
  <div id="toastContainer" class="toast-container"></div>
  <div id="pasteHint" class="paste-hint">Paste MD, HTML, DOCX, PDF, or images anywhere to create a card</div>
  <script>
    let cards = [];
    let selectedIds = new Set();
    let cardCounter = 0;
    let clusters = {}; // { clusterId: [cardId, ...] }
    let principles = []; // Principle engine store
    let wsParam = new URLSearchParams(location.search).get('ws') || 'default';
    const API = (path) => \`/api\${path}?ws=\${wsParam}\`;
    let ws = null;
    let wsReconnectTimer = null;
    let remoteCursors = {};
    let dockingActive = false;

    function connectWS() {
      setWsStatus('connecting');
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(\`\${protocol}//\${location.host}/api/ws?ws=\${wsParam}\`);
      ws.onopen = () => { setWsStatus('connected'); if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; } };
      ws.onmessage = (event) => { handleMessage(JSON.parse(event.data)); };
      ws.onclose = () => { setWsStatus('disconnected'); wsReconnectTimer = setTimeout(connectWS, 3000); };
      ws.onerror = () => { setWsStatus('disconnected'); };
    }

    function setWsStatus(state) {
      const el = document.getElementById('wsStatus');
      el.className = \`ws-status ws-\${state}\`;
      el.textContent = state;
    }

    function handleMessage(msg) {
      switch (msg.type) {
        case 'cards': cards = msg.cards; renderCards(); break;
        case 'principles': principles = msg.principles || []; renderPrincipleBadges(); break;
        case 'clusters': clusters = msg.clusters || {}; break;
        case 'card_created':
          if (!cards.find(c => c.id === msg.card.id)) {
            cards.push(msg.card); renderCard(msg.card, cardCounter * 30 + 40, cardCounter * 30 + 40); cardCounter++; updateStatus();
          } break;
        case 'card_updated': { const idx = cards.findIndex(c => c.id === msg.card.id); if (idx !== -1) { cards[idx] = msg.card; updateCardDOM(msg.card); } break; }
        case 'card_deleted': cards = cards.filter(c => c.id !== msg.id); selectedIds.delete(msg.id); const el = document.getElementById(\`card-\${msg.id}\`); if (el) el.remove(); updateStatus(); break;
        case 'presence': document.getElementById('presence').innerHTML = msg.count > 0 ? \`<span class="presence-dot"></span>\${msg.count} live\` : ''; break;
        case 'cursor': updateRemoteCursor(msg.clientId, msg.x, msg.y); break;
        case 'principle_proposed': showPrincipleProposal(msg.principle); break;
      }
    }

    function sendWS(msg) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); }

    function updateRemoteCursor(clientId, x, y) {
      if (!remoteCursors[clientId]) {
        const el = document.createElement('div'); el.className = 'remote-cursor'; document.getElementById('canvas').appendChild(el);
        remoteCursors[clientId] = { el, x, y };
      }
      const rc = remoteCursors[clientId];
      rc.el.style.left = \`\${x}px\`; rc.el.style.top = \`\${y}px\`;
      clearTimeout(rc.timeout); rc.timeout = setTimeout(() => { rc.el.remove(); delete remoteCursors[clientId]; }, 3000);
    }

    let cursorThrottle = null;
    document.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      if (cursorThrottle) return;
      cursorThrottle = setTimeout(() => {
        const canvas = document.getElementById('canvas'); if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        sendWS({ type: 'cursor', x: e.clientX - rect.left, y: e.clientY - rect.top, cardId: '' });
        cursorThrottle = null;
      }, 100);
    });

    async function init() {
      document.getElementById('status').textContent = 'Loading…';
      connectWS();
      await loadCards();
      await loadPrinciples();
      if (cards.length === 0) {
        await createCard('Instruct', 'Welcome', 'Truth Engine workspace initialized.\\n\\nFeatures:\\n• Browser cards — fetch & parse live web pages\\n• Document / Instruct / Import / Search cards\\n• Snap-based docking & fused card clusters\\n• Merge / Distill / Combine / Rewrite with AI\\n• Principle engine with EITL ratification\\n• Real-time multi-user sync via WebSocket\\n\\nShare this URL with ?ws=<name> to collaborate.');
      }
      autoNumberDocuments();
      setInterval(() => sendWS({ type: 'ping' }), 30000);
    }

    async function loadCards() { const res = await fetch(API('/cards')); cards = await res.json(); renderCards(); }

    async function createCard(type, title, content) {
      if (type && typeof type === 'object') {
        const cardObj = type;
        const extra = { ...cardObj }; const { id, ...fields } = extra; delete fields.type; delete fields.title; delete fields.content;
        const res = await fetch(API('/cards'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: cardObj.type, title: cardObj.title, content: cardObj.content || '', ...fields }) });
        const card = await res.json();
        if (!cards.find(c => c.id === card.id)) { cards.push(card); renderCard(card, cardCounter * 30 + 40, cardCounter * 30 + 40); cardCounter++; updateStatus(); }
        if ((cardObj.type === 'Import') && cardObj.content) { classifyImportContent(card.id, cardObj.content); }
        return card;
      }
      if (type === 'Browser' && !title) { openFetch(); return; }
      if (type === 'Search' && !title) { openSearch(); return; }
      if (type === 'Import' && !title) { document.getElementById('fileUpload').click(); return; }
      const res = await fetch(API('/cards'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, title: title || \`\${type} Card\`, content: content || '' }) });
      const card = await res.json();
      if (!cards.find(c => c.id === card.id)) { cards.push(card); renderCard(card, cardCounter * 30 + 40, cardCounter * 30 + 40); cardCounter++; updateStatus(); }
      if (type === 'Import' && content) { classifyImportContent(card.id, content); }
      return card;
    }

    async function updateCard(id, patch) { await fetch(API(\`/cards/\${id}\`), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }); }
    async function deleteCard(id) { await fetch(API(\`/cards/\${id}\`), { method: 'DELETE' }); }

    function openFetch() { document.getElementById('fetchModal').style.display = 'flex'; document.getElementById('fetchUrl').focus(); }
    function closeFetch() { document.getElementById('fetchModal').style.display = 'none'; }

    async function runFetch() {
      const url = document.getElementById('fetchUrl').value.trim(); if (!url) return;
      const btn = document.getElementById('fetchBtn'); btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Fetching…';
      try {
        const res = await fetch(API('/fetch'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
        const card = await res.json();
        if (res.ok) { closeFetch(); document.getElementById('fetchUrl').value = ''; } else { alert('Error: ' + (card.error || 'Unknown')); }
      } catch (err) { alert('Fetch failed: ' + err.message); }
      finally { btn.disabled = false; btn.textContent = 'Fetch'; }
    }

    document.addEventListener('DOMContentLoaded', () => { document.getElementById('fetchUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') runFetch(); }); });

    function renderCards() {
      const canvas = document.getElementById('canvas');
      const positions = {};
      document.querySelectorAll('.card-window').forEach(el => { positions[el.dataset.id] = { left: el.style.left, top: el.style.top }; });
      canvas.innerHTML = ''; cardCounter = 0;
      cards.forEach((card) => {
        const pos = positions[card.id] || { left: \`\${cardCounter * 30 + 40}px\`, top: \`\${cardCounter * 30 + 40}px\` };
        renderCard(card, parseFloat(pos.left) || cardCounter * 30 + 40, parseFloat(pos.top) || cardCounter * 30 + 40); cardCounter++;
      });
      updateStatus();
    }

    function renderCard(card, x, y) {
      const canvas = document.getElementById('canvas');
      const el = document.createElement('div');
      el.id = \`card-\${card.id}\`;
      el.style.left = \`\${x}px\`; el.style.top = \`\${y}px\`; el.dataset.id = card.id;
      el.dataset.rawHtml = card.rawHtml ? '1' : '0';
      const badgeClass = \`badge-\${card.type.toLowerCase()}\`;
      const isBrowser = card.type === 'Browser';
      const isSearch = card.type === 'Search';
      const isImport = card.type === 'Import';
      el.className = \`card-window\${isBrowser ? ' browser-card' : ''}\`;
      if (card.width) el.style.width = \`\${card.width}px\`;
      if (card.height) el.style.minHeight = \`\${card.height}px\`;

      // Docking zones
      el.innerHTML = \`
        <div class="dock-zone dock-zone-left" data-dock="left"></div>
        <div class="dock-zone dock-zone-right" data-dock="right"></div>
        <div class="dock-zone dock-zone-top" data-dock="top"></div>
        <div class="dock-zone dock-zone-bottom" data-dock="bottom"></div>
      \`;

      const fmtBar = \`
        <div class="card-toolbar fmt-bar" data-fmtbar="\${card.id}">
          <button onclick="fmtBold('\${card.id}')" title="B"><b>B</b></button>
          <button onclick="fmtItalic('\${card.id}')" title="I"><i>I</i></button>
          <button onclick="fmtStrike('\${card.id}')" title="S"><s>S</s></button>
          <span class="sep"></span>
          <button onclick="fmtHeading('\${card.id}',1)" title="H1">H1</button>
          <button onclick="fmtHeading('\${card.id}',2)" title="H2">H2</button>
          <button onclick="fmtHeading('\${card.id}',3)" title="H3">H3</button>
          <span class="sep"></span>
          <button onclick="fmtList('\${card.id}')" title="UL">• List</button>
          <button onclick="fmtOList('\${card.id}')" title="OL">1. List</button>
          <button onclick="fmtQuote('\${card.id}')" title="Quote">&gt;</button>
          <span class="sep"></span>
          <button onclick="fmtCode('\${card.id}')" title="Code">&lt;/&gt;</button>
          <button onclick="fmtCodeBlock('\${card.id}')" title="Block">{ }</button>
          <span class="sep"></span>
          <button onclick="fmtLink('\${card.id}')" title="Link">🔗</button>
          <button onclick="fmtImage('\${card.id}')" title="Image">🖼</button>
          <button onclick="fmtHr('\${card.id}')" title="HR">―</button>
        </div>
      \`;

      let contentHtml;
      if (isSearch) {
        contentHtml = \`
          <div style="padding:4px 0;">
            <div style="display:flex;gap:6px;margin-bottom:6px;">
              <input type="text" data-search-input="\${card.id}" placeholder="Search query..." style="flex:1;background:#0d0d1a;color:#e0e0e0;border:1px solid #2a2a4a;border-radius:4px;padding:4px 8px;font-size:12px;" />
              <button onclick="runCardSearch('\${card.id}')" style="padding:4px 10px;background:#ff6b1a;color:#0d0d1a;border:none;border-radius:4px;font-size:11px;font-weight:600;cursor:pointer;">Go</button>
            </div>
            <div class="search-results" data-search-results="\${card.id}"></div>
          </div>
        \`;
      } else if (isImport) {
        contentHtml = \`
          <div class="border-2 border-dashed border-slate-700 p-6 text-center">
            <div class="text-sm text-slate-400 mb-2">Drop files here or paste content</div>
            <div class="text-xs text-slate-500">Classifies incoming content and proposes principle activations</div>
            <button onclick="document.getElementById('fileUpload').click()" style="margin-top:8px;padding:4px 12px;background:#2a2a4a;border:1px solid #4a4a6a;border-radius:4px;color:#e0e0e0;font-size:11px;cursor:pointer;">Browse Files</button>
          </div>
          <div data-import-classification="\${card.id}" style="margin-top:8px;"></div>
        \`;
      } else if (card.type === 'Instruct') {
        const activePrinciples = principles.filter(p => {
          if (p.domainTag === 'universal' || p.domainTag === 'ethical') return true;
          return card.domains && card.domains.includes(p.domainTag);
        });
        const principleContext = activePrinciples.map(p => '• [' + p.domainTag + '] ' + p.text).join('\\n');
        contentHtml = \`
          <div style="padding:4px 0;">
            <div style="margin-bottom:6px;padding:6px 8px;background:#111122;border:1px solid #2a2a4a;border-radius:4px;font-size:10px;color:#888;">
              <span style="color:#ff8a4a;font-weight:600;">Principle Stack Active:</span> \${activePrinciples.length} principles bound
            </div>
            <textarea data-content="\${card.id}" placeholder="Enter instruction...\\n\\nThe ambient LLM will route this through the active principle stack. Output is domain-bound before it exists." style="width:100%;background:#0d0d1a;color:#e0e0e0;border:1px solid #2a2a4a;border-radius:6px;padding:8px 10px;font-size:13px;font-family:'SF Mono','Fira Code',monospace;resize:vertical;min-height:80px;line-height:1.6;tab-size:2;"></textarea>
            <div style="display:flex;gap:6px;margin-top:6px;">
              <button onclick="runInstruct('\${card.id}')" class="action-btn" style="flex:1;">Generate</button>
              <button onclick="checkPrincipleCompliance('\${card.id}')" class="ctrl-btn" style="flex:1;font-size:11px;padding:4px 8px;">Check Compliance</button>
            </div>
            <div data-instruct-output="\${card.id}" style="margin-top:8px;"></div>
          </div>
        \`;
      } else if (card.type === 'Document' && card.splitView) {
        contentHtml = \`
          <div class="split-view" data-splitview="\${card.id}">
            <div class="split-left" style="padding-right:4px;">
              <div class="card-toolbar" style="margin-bottom:0;">
                <button class="active" data-mode="split" onclick="toggleCardMode('\${card.id}','split')">Split</button>
                <button data-mode="edit" onclick="toggleCardMode('\${card.id}','edit')">Edit</button>
                <button data-mode="preview" onclick="toggleCardMode('\${card.id}','preview')">Preview</button>
              </div>
              \${fmtBar}
              <textarea data-content="\${card.id}" placeholder="Drafting surface...—left pane: write. Right pane: live render." style="width:100%;background:#0d0d1a;color:#e0e0e0;border:1px solid #2a2a4a;border-radius:6px;padding:8px 10px;font-size:13px;font-family:'SF Mono','Fira Code',monospace;min-height:200px;line-height:1.6;tab-size:2;resize:vertical;"></textarea>
            </div>
            <div class="split-divider"></div>
            <div class="split-right md-preview" data-preview="\${card.id}" style="padding:10px 12px;min-height:200px;"></div>
          </div>
        \`;
      } else if (isBrowser) {
        const proxyUrl = card.url ? \`/api/proxy?url=\${encodeURIComponent(card.url)}\` : '';
        contentHtml = \`
          <div class="browser-bar" style="margin-bottom:6px;">
            <input type="text" class="url-input" data-url-input="\${card.id}" value="\${escapeHtml(card.url || '')}" placeholder="Enter URL and press Enter…" style="flex:1;background:#0d0d1a;color:#4ab8ff;border:1px solid #2a2a4a;border-radius:4px;padding:3px 8px;font-size:11px;font-family:monospace;" />
            <button onclick="browserNavigate('\${card.id}')" style="padding:3px 8px;background:#ff6b1a;color:#0d0d1a;border:none;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;">Go</button>
            <button onclick="openBrowserFullscreen('\${card.id}')" title="Open full screen" style="padding:3px 8px;background:#22223a;color:#4ab8ff;border:1px solid #2a2a4a;border-radius:4px;font-size:10px;cursor:pointer;">⛶</button>
          </div>
          \${proxyUrl ? \`<div class="browser-viewer"><iframe data-browser-frame="\${card.id}" sandbox="allow-scripts allow-forms allow-popups allow-same-origin" src="\${proxyUrl}" style="width:100%;height:100%;border:none;"></iframe></div>\` : \`<div style="padding:20px;text-align:center;color:#666;font-size:12px;">Enter a URL above and press Go</div>\`}
          <details style="margin-top:6px;">
            <summary style="cursor:pointer;color:#888;font-size:11px;">Extracted content</summary>
            <div class="card-toolbar" style="margin-top:4px;margin-bottom:0;">
              <button class="active" data-mode="edit" onclick="toggleCardMode('\${card.id}','edit')">Edit</button>
              <button data-mode="preview" onclick="toggleCardMode('\${card.id}','preview')">Preview</button>
            </div>
            \${fmtBar}
            <textarea data-content="\${card.id}" style="display:none;" placeholder="Extracted content…">\${escapeHtml(card.content)}</textarea>
            <div class="md-preview" data-preview="\${card.id}" style="display:none;"></div>
          </details>
        \`;
      } else if (card.type === 'Query') {
        const results = card.results || [];
        const domainLabel = card.domainStack?.primary || card.domains?.[0] || 'general';
        contentHtml = \`
          <div style="padding:4px 0;">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
              <span style="font-size:10px;color:#888;">Domain:</span>
              <span class="domain-chip primary" style="font-size:9px;">\${domainLabel}</span>
              <span style="font-size:10px;color:#888;margin-left:auto;">Coverage:</span>
              <span style="font-size:11px;color:#4aff8a;font-weight:600;">\${Math.round((card.coverageScore || 0) * 100)}%</span>
            </div>
            <div style="font-size:10px;color:#888;margin-bottom:4px;">\${results.length} result(s) · \${(card.principlesApplied || []).length} principles applied</div>
            <div class="query-results" data-query-results="\${card.id}">
              \${results.map((r, i) => \`
                <div class="query-result" onclick="materializeQueryResult('\${card.id}', \${i})">
                  <div style="display:flex;justify-content:space-between;">
                    <span class="result-type">\${r.sourceType}</span>
                    <span class="result-relevance">\${Math.round((r.relevance || 0) * 100)}%</span>
                  </div>
                  <div class="result-snippet">\${escapeHtml((r.snippet || '').slice(0, 120))}\${(r.snippet || '').length > 120 ? '...' : ''}</div>
                </div>
              \`).join('')}
            </div>
            <div style="margin-top:6px;display:flex;gap:6px;">
              <button onclick="rerunQuery('\${card.id}')" class="ctrl-btn" style="flex:1;font-size:11px;padding:4px 8px;">Re-run</button>
            </div>
          </div>
        \`;
      } else if (card.type === 'Audit') {
        const findings = card.findings || [];
        const cov = card.principleCoverage || { total: 0, satisfied: 0, violated: 0, unaddressed: 0 };
        const statusColor = card.status === 'pass' ? '#4aff8a' : card.status === 'conditional' ? '#ffaa4a' : '#ff4a4a';
        contentHtml = \`
          <div style="padding:4px 0;" class="audit-\${card.status || 'fail'}">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
              <span style="font-size:12px;font-weight:700;color:\${statusColor};text-transform:uppercase;">\${card.status || 'fail'}</span>
              <span style="font-size:11px;color:#888;">Confidence:</span>
              <span style="font-size:11px;color:\${statusColor};font-weight:600;">\${Math.round((card.overallConfidence || 0) * 100)}%</span>
              <span style="font-size:10px;color:#888;margin-left:auto;">Scope: \${card.auditScope || 'compliance'}</span>
            </div>
            <div class="audit-coverage">
              <div class="cov-item"><div class="cov-dot" style="background:#4aff8a;"></div> \${cov.satisfied} satisfied</div>
              <div class="cov-item"><div class="cov-dot" style="background:#ffaa4a;"></div> \${cov.violated} partial</div>
              <div class="cov-item"><div class="cov-dot" style="background:#ff4a4a;"></div> \${cov.unaddressed} unaddressed</div>
            </div>
            <div style="font-size:10px;color:#888;margin:4px 0;">\${findings.length} finding(s)</div>
            <div class="audit-findings" data-audit-findings="\${card.id}" style="max-height:200px;overflow-y:auto;">
              \${findings.slice(0, 20).map(f => \`
                <div class="audit-finding \${f.severity}">
                  <div style="display:flex;justify-content:space-between;">
                    <span style="font-weight:600;color:\${f.severity === 'violation' ? '#ff4a4a' : f.severity === 'warning' ? '#ffaa4a' : '#4a9fff'};">\${f.severity.toUpperCase()}</span>
                    <span style="color:#888;font-size:10px;">\${Math.round((f.confidence || 0) * 100)}%</span>
                  </div>
                  <div style="color:#ccc;margin:2px 0;">\${escapeHtml(f.description)}</div>
                  \${f.suggestion ? \`<div style="color:#888;font-size:10px;">Suggestion: \${escapeHtml(f.suggestion)}</div>\` : ''}
                </div>
              \`).join('')}
              \${findings.length > 20 ? \`<div style="text-align:center;color:#888;font-size:10px;padding:4px;">+\${findings.length - 20} more findings</div>\` : ''}
            </div>
            <div style="margin-top:6px;display:flex;gap:6px;">
              <button onclick="reAudit('\${card.id}')" class="ctrl-btn" style="flex:1;font-size:11px;padding:4px 8px;">Re-audit</button>
              <button onclick="exportAudit('\${card.id}')" class="ctrl-btn" style="flex:1;font-size:11px;padding:4px 8px;">Export</button>
            </div>
          </div>
        \`;
      } else if (card.type === 'DomainBrowser') {
        const assets = card.assets || [];
        const dMeta = { general: {color:'#888'}, legal: {color:'#4ab8ff'}, educational: {color:'#8aff4a'}, medical: {color:'#ff4a8a'}, technical: {color:'#c14aff'} };
        const dColor = dMeta[card.domain]?.color || '#888';
        contentHtml = \`
          <div style="padding:4px 0;">
            <div style="display:flex;gap:6px;margin-bottom:6px;">
              <button onclick="switchDomainView('\${card.id}','assets')" class="ctrl-btn" style="font-size:10px;padding:3px 8px;\${card.view === 'assets' ? 'border-color:#ff6b1a;color:#ff6b1a;' : ''}">Assets</button>
              <button onclick="switchDomainView('\${card.id}','principles')" class="ctrl-btn" style="font-size:10px;padding:3px 8px;\${card.view === 'principles' ? 'border-color:#ff6b1a;color:#ff6b1a;' : ''}">Principles</button>
              <button onclick="switchDomainView('\${card.id}','stack')" class="ctrl-btn" style="font-size:10px;padding:3px 8px;\${card.view === 'stack' ? 'border-color:#ff6b1a;color:#ff6b1a;' : ''}">Stack</button>
            </div>
            <div data-domain-view="\${card.id}">
              \${card.view === 'assets' ? \`
                <div style="font-size:10px;color:#888;margin-bottom:4px;">\${assets.length} asset(s) in \${card.domain}</div>
                \${assets.map(a => \`
                  <div class="domain-asset-item">
                    <span class="asset-name">\${a.key.split('/').pop()}</span>
                    <span class="asset-size">\${a.size ? Math.round(a.size / 1024) + 'KB' : ''}</span>
                  </div>
                \`).join('')}
                \${assets.length === 0 ? '<div style="color:#666;font-size:11px;text-align:center;padding:8px;">No assets</div>' : ''}
              \` : card.view === 'principles' ? \`
                <div style="font-size:10px;color:#888;margin-bottom:4px;">\${card.principleCount || 0} principle(s) for \${card.domain}</div>
                <button onclick="syncDomainPrinciples('\${card.domain}')" class="ctrl-btn" style="font-size:10px;padding:3px 8px;margin-bottom:6px;">Sync to KV</button>
              \` : \`
                <div style="font-size:11px;color:#ccc;">
                  <div>Primary: <span class="domain-chip primary">\${card.activeStack?.primary || card.domain}</span></div>
                  \${card.activeStack?.secondary?.length ? \`<div style="margin-top:4px;">Secondary: \${card.activeStack.secondary.map(s => \`<span class="domain-chip secondary">\${s}</span>\`).join(' ')}</div>\` : ''}
                </div>
              \`}
            </div>
            <div style="margin-top:6px;">
              <button onclick="uploadToDomain('\${card.id}', '\${card.domain}')" class="ctrl-btn" style="font-size:10px;padding:3px 8px;width:100%;">Upload Asset</button>
            </div>
          </div>
        \`;
      } else {
        contentHtml = \`
          <div class="card-toolbar" style="margin-bottom:0;">
            <button class="active" data-mode="edit" onclick="toggleCardMode('\${card.id}','edit')">Edit</button>
            <button data-mode="preview" onclick="toggleCardMode('\${card.id}','preview')">Preview</button>
          </div>
          \${fmtBar}
          <textarea data-content="\${card.id}" placeholder="Enter content…">\${escapeHtml(card.content)}</textarea>
          <div class="md-preview" data-preview="\${card.id}" style="display:none;"></div>
        \`;
      }

      // Principle badges for active card
      const principleHtml = getCardPrincipleBadges(card);
      const domainSelector = (card.type === 'Document' || card.type === 'Instruct') ? \`
        <select data-domain-select="\${card.id}" style="font-size:9px;padding:1px 4px;background:#0d0d1a;color:#888;border:1px solid #2a2a4a;border-radius:3px;cursor:pointer;" onchange="setDomain('\${card.id}', this.value)">
          <option value="general" \${(!card.domains || card.domains[0] === 'general') ? 'selected' : ''}>General</option>
          <option value="legal" \${card.domains && card.domains[0] === 'legal' ? 'selected' : ''}>Legal</option>
          <option value="educational" \${card.domains && card.domains[0] === 'educational' ? 'selected' : ''}>Edu</option>
          <option value="medical" \${card.domains && card.domains[0] === 'medical' ? 'selected' : ''}>Med</option>
          <option value="technical" \${card.domains && card.domains[0] === 'technical' ? 'selected' : ''}>Tech</option>
        </select>
      \` : '';
      const eitlBtn = (card.type === 'Document' || card.type === 'Instruct') ? \`<button onclick="openExpertReview('\${card.id}')" style="font-size:9px;padding:1px 4px;background:#4a3a1a;border:1px solid #6a5a2a;border-radius:3px;color:#ffaa4a;cursor:pointer;">EITL</button>\` : '';

      el.innerHTML += \`
        <div class="card-header">
          <div class="flex items-center gap-2 flex-1">
            <span class="card-type-badge \${badgeClass}">\${card.type}</span>
            <input class="card-title bg-transparent text-sm font-semibold text-white outline-none w-full" value="\${escapeHtml(card.title)}" data-title="\${card.id}" />
            \${domainSelector}
            \${eitlBtn}
            \${principleHtml}
          </div>
          <button class="text-gray-500 hover:text-blue-400 text-sm ml-1" title="Fullscreen" onclick="openCardFullscreen('\${card.id}')">⛶</button>
          <button class="text-gray-500 hover:text-red-400 text-sm ml-2" onclick="deleteCard('\${card.id}')">✕</button>
        </div>
        <div class="card-content">
          \${contentHtml}
          \${card.relationships.length ? \`<div class="mt-2 rel-link">↳ derived from: \${card.relationships.length} card(s)</div>\` : ''}
        </div>
        <div class="resize-handle" data-resize="\${card.id}"></div>
      \`;
      canvas.appendChild(el);

      // Attach event listeners
      el.addEventListener('click', (e) => { if (['TEXTAREA','INPUT','BUTTON','A','IFRAME','DETAILS','SUMMARY','SELECT'].includes(e.target.tagName)) return; toggleSelect(card.id); });
      const titleInput = el.querySelector(\`[data-title="\${card.id}"]\`);
      titleInput.addEventListener('change', () => updateCard(card.id, { title: titleInput.value }));

      // Search card enter key
      if (isSearch) {
        const searchInput = el.querySelector(\`[data-search-input="\${card.id}"]\`);
        if (searchInput) {
          searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') runCardSearch(card.id); });
        }
      }

      // Browser URL bar enter key
      if (isBrowser) {
        const urlInput = el.querySelector(\`[data-url-input="\${card.id}"]\`);
        if (urlInput) {
          urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') browserNavigate(card.id); });
        }
      }

      const contentArea = el.querySelector(\`[data-content="\${card.id}"]\`);
      if (contentArea) {
        let debounce;
        contentArea.addEventListener('input', () => {
          clearTimeout(debounce);
          debounce = setTimeout(() => updateCard(card.id, { content: contentArea.value }), 600);
          // Live split view rendering
          const preview = el.querySelector(\`[data-preview="\${card.id}"]\`);
          if (preview && card.splitView) { preview.innerHTML = renderMarkdown(contentArea.value); }
          // Live instruct principle check
          if (card.type === 'Instruct') { /* content typed, no auto-action */ }
        });
        contentArea.addEventListener('keydown', (e) => {
          if (e.key === 'Tab') {
            e.preventDefault();
            const start = contentArea.selectionStart;
            const end = contentArea.selectionEnd;
            contentArea.value = contentArea.value.substring(0, start) + '  ' + contentArea.value.substring(end);
            contentArea.selectionStart = contentArea.selectionEnd = start + 2;
          }
        });
      }

      // Phase 3: Setup split view for Document cards
      if (card.splitView && card.type === 'Document') {
        setupSplitViewLiveRendering(card.id);
      }

      makeDraggable(el);
      makeResizable(el, card.id);
    }

    function updateCardDOM(card) {
      const el = document.getElementById(\`card-\${card.id}\`);
      if (!el) { renderCard(card, cardCounter * 30 + 40, cardCounter * 30 + 40); cardCounter++; return; }
      const titleInput = el.querySelector(\`[data-title="\${card.id}"]\`);
      const contentArea = el.querySelector(\`[data-content="\${card.id}"]\`);
      const preview = el.querySelector(\`[data-preview="\${card.id}"]\`);
      if (titleInput && document.activeElement !== titleInput) titleInput.value = card.title;
      if (contentArea && document.activeElement !== contentArea) {
        contentArea.value = card.content || '';
        if (preview && preview.style.display !== 'none') {
          preview.innerHTML = renderMarkdown(card.content || '');
        }
      }
    }

    function toggleSelect(id) { if (selectedIds.has(id)) selectedIds.delete(id); else selectedIds.add(id); document.getElementById(\`card-\${id}\`).classList.toggle('selected', selectedIds.has(id)); }
    function updateStatus() { document.getElementById('status').textContent = \`\${cards.length} cards · \${selectedIds.size} selected\`; }

    let dragState = null; // { type: 'drag', el, dx, dy } | { type: 'resize', el, cardId, sx, sy, sw, sh }

    function makeDraggable(el) {
      const header = el.querySelector('.card-header');
      if (!header) return;
      header.addEventListener('touchstart', (e) => {
        const t = e.touches[0]; if (!t) return;
        if (['INPUT','BUTTON','SELECT','TEXTAREA'].includes(e.target.tagName)) return;
        const rect = el.getBoundingClientRect();
        dragState = { type: 'drag', el, dx: t.clientX - rect.left, dy: t.clientY - rect.top };
        showDockZones(el.dataset.id);
      }, { passive: false });
      header.addEventListener('touchmove', (e) => {
        if (!dragState || dragState.type !== 'drag' || dragState.el !== el) return;
        const t = e.touches[0];
        dragState.el.style.left = \`\${t.clientX - dragState.dx}px\`;
        dragState.el.style.top = \`\${t.clientY - dragState.dy}px\`;
        highlightNearestDock(dragState.el.dataset.id, t.clientX, t.clientY);
        e.preventDefault();
      }, { passive: false });
      header.addEventListener('touchend', (e) => {
        if (!dragState || dragState.type !== 'drag' || dragState.el !== el) return;
        const t = e.changedTouches[0];
        hideDockZones();
        tryDock(el.dataset.id, t ? t.clientX : dragState.el.getBoundingClientRect().left, t ? t.clientY : dragState.el.getBoundingClientRect().top);
        dragState = null;
      });
      header.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (['INPUT','BUTTON','SELECT','TEXTAREA'].includes(e.target.tagName)) return;
        const rect = el.getBoundingClientRect();
        dragState = { type: 'drag', el, dx: e.clientX - rect.left, dy: e.clientY - rect.top };
        e.preventDefault();
        showDockZones(el.dataset.id);
      });
      header.addEventListener('mousemove', (e) => {
        if (!dragState || dragState.type !== 'drag' || dragState.el !== el) return;
        dragState.el.style.left = \`\${e.clientX - dragState.dx}px\`;
        dragState.el.style.top = \`\${e.clientY - dragState.dy}px\`;
        highlightNearestDock(dragState.el.dataset.id, e.clientX, e.clientY);
      });
      header.addEventListener('mouseup', (e) => {
        if (!dragState || dragState.type !== 'drag' || dragState.el !== el) return;
        hideDockZones();
        tryDock(el.dataset.id, e.clientX, e.clientY);
        dragState = null;
      });
    }

    function makeResizable(el, cardId) {
      const handle = el.querySelector(\`[data-resize="\${cardId}"]\`);
      if (!handle) return;
      handle.addEventListener('touchstart', (e) => {
        const t = e.touches[0]; if (!t) return;
        const rect = el.getBoundingClientRect();
        dragState = { type: 'resize', el, cardId, sx: t.clientX, sy: t.clientY, sw: rect.width, sh: rect.height };
        e.preventDefault();
        e.stopPropagation();
      }, { passive: false });
      handle.addEventListener('touchmove', (e) => {
        if (!dragState || dragState.type !== 'resize' || dragState.cardId !== cardId) return;
        const t = e.touches[0];
        applyResize(t.clientX, t.clientY);
        e.preventDefault();
      }, { passive: false });
      handle.addEventListener('touchend', () => { finishResize(cardId); });
      handle.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        const rect = el.getBoundingClientRect();
        dragState = { type: 'resize', el, cardId, sx: e.clientX, sy: e.clientY, sw: rect.width, sh: rect.height };
        e.preventDefault();
        e.stopPropagation();
      });
      handle.addEventListener('mousemove', (e) => { if (dragState && dragState.type === 'resize' && dragState.cardId === cardId) applyResize(e.clientX, e.clientY); });
      handle.addEventListener('mouseup', (e) => { if (e.button === 0) finishResize(cardId); });
    }

    function applyResize(cx, cy) {
      if (!dragState || dragState.type !== 'resize') return;
      const newW = Math.max(280, dragState.sw + (cx - dragState.sx));
      const newH = Math.max(200, dragState.sh + (cy - dragState.sy));
      dragState.el.style.maxWidth = 'none';
      dragState.el.style.width = \`\${newW}px\`;
      dragState.el.style.minHeight = \`\${newH}px\`;
    }
    function finishResize(cardId) {
      if (!dragState || dragState.type !== 'resize' || dragState.cardId !== cardId) return;
      const card = cards.find(c => c.id === cardId);
      if (card) { const rect = dragState.el.getBoundingClientRect(); updateCard(cardId, { width: rect.width, height: Math.max(200, rect.height) }); }
      dragState = null;
    }

    function showDockZones(excludeId) {
      document.querySelectorAll('.card-window').forEach(el => {
        if (el.dataset.id === excludeId) return;
        el.querySelectorAll('.dock-zone').forEach(z => z.classList.add('active'));
      });
    }
    function hideDockZones() {
      document.querySelectorAll('.dock-zone').forEach(z => z.classList.remove('active'));
      document.querySelectorAll('.card-window').forEach(el => el.classList.remove('docked'));
    }
    function highlightNearestDock(dragId, mx, my) {
      document.querySelectorAll('.card-window').forEach(el => {
        if (el.dataset.id === dragId) return;
        el.classList.remove('docked');
        const rect = el.getBoundingClientRect();
        const zones = [
          { edge: 'left', cx: rect.left - 10, cy: rect.top + rect.height/2 },
          { edge: 'right', cx: rect.right + 10, cy: rect.top + rect.height/2 },
          { edge: 'top', cx: rect.left + rect.width/2, cy: rect.top - 10 },
          { edge: 'bottom', cx: rect.left + rect.width/2, cy: rect.bottom + 10 },
        ];
        for (const z of zones) {
          if (Math.abs(mx - z.cx) < 25 && Math.abs(my - z.cy) < 25) { el.classList.add('docked'); break; }
        }
      });
    }
    function tryDock(dragId, mx, my) {
      let bestTarget = null, bestEdge = null, bestDist = 30;
      document.querySelectorAll('.card-window').forEach(el => {
        if (el.dataset.id === dragId) return;
        const rect = el.getBoundingClientRect();
        const zones = [
          { edge: 'left', cx: rect.left - 10, cy: rect.top + rect.height/2 },
          { edge: 'right', cx: rect.right + 10, cy: rect.top + rect.height/2 },
          { edge: 'top', cx: rect.left + rect.width/2, cy: rect.top - 10 },
          { edge: 'bottom', cx: rect.left + rect.width/2, cy: rect.bottom + 10 },
        ];
        for (const z of zones) {
          const dist = Math.hypot(mx - z.cx, my - z.cy);
          if (dist < bestDist) { bestDist = dist; bestTarget = el.dataset.id; bestEdge = z.edge; }
        }
      });
      if (bestTarget) {
        sendWS({ type: 'card:dock', sourceId: dragId, targetId: bestTarget, edge: bestEdge });
        const source = cards.find(c => c.id === dragId);
        const target = cards.find(c => c.id === bestTarget);
        if (source && target) {
          const tRect = document.getElementById(\`card-\${bestTarget}\`)?.getBoundingClientRect();
          const dragEl = document.getElementById(\`card-\${dragId}\`);
          if (tRect && dragEl) {
            let newX, newY;
            switch(bestEdge) {
              case 'left': newX = tRect.left - dragEl.offsetWidth - 8; newY = tRect.top; break;
              case 'right': newX = tRect.right + 8; newY = tRect.top; break;
              case 'top': newX = tRect.left; newY = tRect.top - dragEl.offsetHeight - 8; break;
              case 'bottom': newX = tRect.left; newY = tRect.bottom + 8; break;
            }
            dragEl.style.left = \`\${newX}px\`; dragEl.style.top = \`\${newY}px\`;
            updateCard(dragId, { x: newX, y: newY, dockedTo: bestTarget, dockEdge: bestEdge });
          }
        }
      }
    }

    function autoNumberDocuments() {
      const sorted = cards.filter(c => c.type === 'Document').sort((a, b) => {
        const ay = a.y || 0, by = b.y || 0;
        if (ay === by) return (a.x || 0) - (b.x || 0);
        return ay - by;
      });
      sorted.forEach((card, idx) => {
        const el = document.getElementById(\`card-\${card.id}\`);
        if (!el) return;
        const badge = el.querySelector('.card-type-badge');
        if (badge) badge.textContent = \`Doc \${idx + 1}\`;
      });
    }

    function openManipulate() { if (selectedIds.size === 0) { alert('Select at least one card on the canvas first.'); return; } document.getElementById('selectedCount').textContent = \`\${selectedIds.size} card(s) selected.\`; document.getElementById('manipulateModal').style.display = 'flex'; }
    function closeManipulate() { document.getElementById('manipulateModal').style.display = 'none'; }

    async function runManipulate() {
      const action = document.getElementById('actionSelect').value;
      const promptText = document.getElementById('manipulatePrompt').value;
      const btn = document.getElementById('runBtn');
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Processing…';
      try {
        const res = await fetch(API('/cards/manipulate'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, cardIds: [...selectedIds], promptText }) });
        const newCard = await res.json();
        if (res.ok) { closeManipulate(); } else { alert('Error: ' + (newCard.error || 'Unknown')); }
      } catch (err) { alert('Request failed: ' + err.message); }
      finally { btn.disabled = false; btn.textContent = 'Run'; }
    }

    function escapeHtml(str) { const div = document.createElement('div'); div.textContent = str || ''; return div.innerHTML; }

    // ── Markdown → HTML Renderer (for preview) ──
    function renderMarkdown(md) {
      let html = escapeHtml(md);
      // Code blocks (must be first to protect content)
      html = html.replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g, '<pre><code>$2</code></pre>');
      // Inline code
      html = html.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
      // Headings
      html = html.replace(/^###### (.+)$/gm, '<h6>$1</h6>');
      html = html.replace(/^##### (.+)$/gm, '<h5>$1</h5>');
      html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
      html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
      html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
      html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
      // Bold and italic
      html = html.replace(/\\*\\*\\*(.+?)\\*\\*\\*/g, '<strong><em>$1</em></strong>');
      html = html.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
      html = html.replace(/\\*(.+?)\\*/g, '<em>$1</em>');
      // Links and images
      html = html.replace(/!\\[([^\\]]*)\\]\\(([^)]+)\\)/g, '<img src="$2" alt="$1" style="max-width:100%;border-radius:4px;">');
      html = html.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2" target="_blank">$1</a>');
      // Blockquotes
      html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
      // Horizontal rules
      html = html.replace(/^