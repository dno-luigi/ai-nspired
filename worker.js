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
    #canvas { position: relative; width: 100%; height: calc(100vh - 60px); overflow: auto; }
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
    const API = (path) => \\\`/api\\\${path}?ws=\\\${wsParam}\\\`;
    let ws = null;
    let wsReconnectTimer = null;
    let remoteCursors = {};
    let dockingActive = false;

    function connectWS() {
      setWsStatus('connecting');
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(\\\`\\\${protocol}//\\\${location.host}/api/ws?ws=\\\${wsParam}\\\`);
      ws.onopen = () => { setWsStatus('connected'); if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; } };
      ws.onmessage = (event) => { handleMessage(JSON.parse(event.data)); };
      ws.onclose = () => { setWsStatus('disconnected'); wsReconnectTimer = setTimeout(connectWS, 3000); };
      ws.onerror = () => { setWsStatus('disconnected'); };
    }

    function setWsStatus(state) {
      const el = document.getElementById('wsStatus');
      el.className = \\\`ws-status ws-\\\${state}\\\`;
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
        case 'card_deleted': cards = cards.filter(c => c.id !== msg.id); selectedIds.delete(msg.id); const el = document.getElementById(\\\`card-\\\${msg.id}\\\`); if (el) el.remove(); updateStatus(); break;
        case 'presence': document.getElementById('presence').innerHTML = msg.count > 0 ? \\\`<span class="presence-dot"></span>\\\${msg.count} live\\\` : ''; break;
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
      rc.el.style.left = \\\`\\\${x}px\\\`; rc.el.style.top = \\\`\\\${y}px\\\`;
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
        await createCard('Instruct', 'Welcome', 'Truth Engine workspace initialized.\\\\n\\\\nFeatures:\\\\n• Browser cards — fetch & parse live web pages\\\\n• Document / Instruct / Import / Search cards\\\\n• Snap-based docking & fused card clusters\\\\n• Merge / Distill / Combine / Rewrite with AI\\\\n• Principle engine with EITL ratification\\\\n• Real-time multi-user sync via WebSocket\\\\n\\\\nShare this URL with ?ws=<name> to collaborate.');
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
      const res = await fetch(API('/cards'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, title: title || \\\`\\\${type} Card\\\`, content: content || '' }) });
      const card = await res.json();
      if (!cards.find(c => c.id === card.id)) { cards.push(card); renderCard(card, cardCounter * 30 + 40, cardCounter * 30 + 40); cardCounter++; updateStatus(); }
      if (type === 'Import' && content) { classifyImportContent(card.id, content); }
      return card;
    }

    async function updateCard(id, patch) { await fetch(API(\\\`/cards/\\\${id}\\\`), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }); }
    async function deleteCard(id) { await fetch(API(\\\`/cards/\\\${id}\\\`), { method: 'DELETE' }); }

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
        const pos = positions[card.id] || { left: \\\`\\\${cardCounter * 30 + 40}px\\\`, top: \\\`\\\${cardCounter * 30 + 40}px\\\` };
        renderCard(card, parseFloat(pos.left) || cardCounter * 30 + 40, parseFloat(pos.top) || cardCounter * 30 + 40); cardCounter++;
      });
      updateStatus();
    }

    function renderCard(card, x, y) {
      const canvas = document.getElementById('canvas');
      const el = document.createElement('div');
      el.id = \\\`card-\\\${card.id}\\\`;
      el.style.left = \\\`\\\${x}px\\\`; el.style.top = \\\`\\\${y}px\\\`; el.dataset.id = card.id;
      el.dataset.rawHtml = card.rawHtml ? '1' : '0';
      const badgeClass = \\\`badge-\\\${card.type.toLowerCase()}\\\`;
      const isBrowser = card.type === 'Browser';
      const isSearch = card.type === 'Search';
      const isImport = card.type === 'Import';
      el.className = \\\`card-window\\\${isBrowser ? ' browser-card' : ''}\\\`;
      if (card.width) el.style.width = \\\`\\\${card.width}px\\\`;
      if (card.height) el.style.minHeight = \\\`\\\${card.height}px\\\`;

      // Docking zones
      el.innerHTML = \\\`
        <div class="dock-zone dock-zone-left" data-dock="left"></div>
        <div class="dock-zone dock-zone-right" data-dock="right"></div>
        <div class="dock-zone dock-zone-top" data-dock="top"></div>
        <div class="dock-zone dock-zone-bottom" data-dock="bottom"></div>
      \\\`;

      const fmtBar = \\\`
        <div class="card-toolbar fmt-bar" data-fmtbar="\\\${card.id}">
          <button onclick="fmtBold('\\\${card.id}')" title="B"><b>B</b></button>
          <button onclick="fmtItalic('\\\${card.id}')" title="I"><i>I</i></button>
          <button onclick="fmtStrike('\\\${card.id}')" title="S"><s>S</s></button>
          <span class="sep"></span>
          <button onclick="fmtHeading('\\\${card.id}',1)" title="H1">H1</button>
          <button onclick="fmtHeading('\\\${card.id}',2)" title="H2">H2</button>
          <button onclick="fmtHeading('\\\${card.id}',3)" title="H3">H3</button>
          <span class="sep"></span>
          <button onclick="fmtList('\\\${card.id}')" title="UL">• List</button>
          <button onclick="fmtOList('\\\${card.id}')" title="OL">1. List</button>
          <button onclick="fmtQuote('\\\${card.id}')" title="Quote">&gt;</button>
          <span class="sep"></span>
          <button onclick="fmtCode('\\\${card.id}')" title="Code">&lt;/&gt;</button>
          <button onclick="fmtCodeBlock('\\\${card.id}')" title="Block">{ }</button>
          <span class="sep"></span>
          <button onclick="fmtLink('\\\${card.id}')" title="Link">🔗</button>
          <button onclick="fmtImage('\\\${card.id}')" title="Image">🖼</button>
          <button onclick="fmtHr('\\\${card.id}')" title="HR">―</button>
        </div>
      \\\`;

      let contentHtml;
      if (isSearch) {
        contentHtml = \\\`
          <div style="padding:4px 0;">
            <div style="display:flex;gap:6px;margin-bottom:6px;">
              <input type="text" data-search-input="\\\${card.id}" placeholder="Search query..." style="flex:1;background:#0d0d1a;color:#e0e0e0;border:1px solid #2a2a4a;border-radius:4px;padding:4px 8px;font-size:12px;" />
              <button onclick="runCardSearch('\\\${card.id}')" style="padding:4px 10px;background:#ff6b1a;color:#0d0d1a;border:none;border-radius:4px;font-size:11px;font-weight:600;cursor:pointer;">Go</button>
            </div>
            <div class="search-results" data-search-results="\\\${card.id}"></div>
          </div>
        \\\`;
      } else if (isImport) {
        contentHtml = \\\`
          <div class="border-2 border-dashed border-slate-700 p-6 text-center">
            <div class="text-sm text-slate-400 mb-2">Drop files here or paste content</div>
            <div class="text-xs text-slate-500">Classifies incoming content and proposes principle activations</div>
            <button onclick="document.getElementById('fileUpload').click()" style="margin-top:8px;padding:4px 12px;background:#2a2a4a;border:1px solid #4a4a6a;border-radius:4px;color:#e0e0e0;font-size:11px;cursor:pointer;">Browse Files</button>
          </div>
          <div data-import-classification="\\\${card.id}" style="margin-top:8px;"></div>
        \\\`;
      } else if (card.type === 'Instruct') {
        const activePrinciples = principles.filter(p => {
          if (p.domainTag === 'universal' || p.domainTag === 'ethical') return true;
          return card.domains && card.domains.includes(p.domainTag);
        });
        const principleContext = activePrinciples.map(p => '• [' + p.domainTag + '] ' + p.text).join('\\\\n');
        contentHtml = \\\`
          <div style="padding:4px 0;">
            <div class="card-toolbar" style="margin-bottom:0;">
              <button class="active" data-mode="edit" onclick="toggleCardMode('\\\${card.id}','edit')">Edit</button>
              <button data-mode="preview" onclick="toggleCardMode('\\\${card.id}','preview')">Preview</button>
            </div>
            \\\${fmtBar}
            <div style="margin-bottom:6px;padding:6px 8px;background:#111122;border:1px solid #2a2a4a;border-radius:4px;font-size:10px;color:#888;">
              <span style="color:#ff8a4a;font-weight:600;">Principle Stack Active:</span> \\\${activePrinciples.length} principles bound
            </div>
            <textarea data-content="\\\${card.id}" placeholder="Enter instruction...\\\\n\\\\nThe ambient LLM will route this through the active principle stack. Output is domain-bound before it exists.">\\\${escapeHtml(card.content || '')}</textarea>
            <div class="md-preview" data-preview="\\\${card.id}" style="display:none;"></div>
            <div style="display:flex;gap:6px;margin-top:6px;">
              <button onclick="runInstruct('\\\${card.id}')" class="action-btn" style="flex:1;">Generate</button>
              <button onclick="checkPrincipleCompliance('\\\${card.id}')" class="ctrl-btn" style="flex:1;font-size:11px;padding:4px 8px;">Check Compliance</button>
            </div>
            <div data-instruct-output="\\\${card.id}" style="margin-top:8px;"></div>
          </div>
        \\\`;
      } else if (card.type === 'Document' && card.splitView) {
        contentHtml = \\\`
          <div class="split-view" data-splitview="\\\${card.id}">
            <div class="split-left" style="padding-right:4px;">
              <div class="card-toolbar" style="margin-bottom:0;">
                <button class="active" data-mode="split" onclick="toggleCardMode('\\\${card.id}','split')">Split</button>
                <button data-mode="edit" onclick="toggleCardMode('\\\${card.id}','edit')">Edit</button>
                <button data-mode="preview" onclick="toggleCardMode('\\\${card.id}','preview')">Preview</button>
              </div>
              \\\${fmtBar}
              <textarea data-content="\\\${card.id}" placeholder="Drafting surface...—left pane: write. Right pane: live render." style="width:100%;background:#0d0d1a;color:#e0e0e0;border:1px solid #2a2a4a;border-radius:6px;padding:8px 10px;font-size:13px;font-family:'SF Mono','Fira Code',monospace;min-height:200px;line-height:1.6;tab-size:2;resize:vertical;"></textarea>
            </div>
            <div class="split-divider"></div>
            <div class="split-right md-preview" data-preview="\\\${card.id}" style="padding:10px 12px;min-height:200px;"></div>
          </div>
        \\\`;
      } else if (isBrowser) {
        const proxyUrl = card.url ? \\\`/api/proxy?url=\\\${encodeURIComponent(card.url)}\\\` : '';
        contentHtml = \\\`
          <div class="browser-bar" style="margin-bottom:6px;">
            <input type="text" class="url-input" data-url-input="\\\${card.id}" value="\\\${escapeHtml(card.url || '')}" placeholder="Enter URL and press Enter…" style="flex:1;background:#0d0d1a;color:#4ab8ff;border:1px solid #2a2a4a;border-radius:4px;padding:3px 8px;font-size:11px;font-family:monospace;" />
            <button onclick="browserNavigate('\\\${card.id}')" style="padding:3px 8px;background:#ff6b1a;color:#0d0d1a;border:none;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;">Go</button>
            <button onclick="openBrowserFullscreen('\\\${card.id}')" title="Open full screen" style="padding:3px 8px;background:#22223a;color:#4ab8ff;border:1px solid #2a2a4a;border-radius:4px;font-size:10px;cursor:pointer;">⛶</button>
          </div>
          \\\${proxyUrl ? \\\`<div class="browser-viewer"><iframe data-browser-frame="\\\${card.id}" sandbox="allow-scripts allow-forms allow-popups allow-same-origin" src="\\\${proxyUrl}" style="width:100%;height:100%;border:none;"></iframe></div>\\\` : \\\`<div style="padding:20px;text-align:center;color:#666;font-size:12px;">Enter a URL above and press Go</div>\\\`}
          <details style="margin-top:6px;">
            <summary style="cursor:pointer;color:#888;font-size:11px;">Extracted content</summary>
            <div class="card-toolbar" style="margin-top:4px;margin-bottom:0;">
              <button class="active" data-mode="edit" onclick="toggleCardMode('\\\${card.id}','edit')">Edit</button>
              <button data-mode="preview" onclick="toggleCardMode('\\\${card.id}','preview')">Preview</button>
            </div>
            \\\${fmtBar}
            <textarea data-content="\\\${card.id}" style="display:none;" placeholder="Extracted content…">\\\${escapeHtml(card.content)}</textarea>
            <div class="md-preview" data-preview="\\\${card.id}" style="display:none;"></div>
          </details>
        \\\`;
      } else if (card.type === 'Query') {
        const results = card.results || [];
        const domainLabel = card.domainStack?.primary || card.domains?.[0] || 'general';
        contentHtml = \\\`
          <div style="padding:4px 0;">
            <div class="card-toolbar" style="margin-bottom:0;">
              <button class="active" data-mode="edit" onclick="toggleCardMode('\\\${card.id}','edit')">Edit</button>
              <button data-mode="preview" onclick="toggleCardMode('\\\${card.id}','preview')">Preview</button>
            </div>
            \\\${fmtBar}
            <textarea data-content="\\\${card.id}" placeholder="Query notes…">\\\${escapeHtml(card.content || '')}</textarea>
            <div class="md-preview" data-preview="\\\${card.id}" style="display:none;"></div>
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
              <span style="font-size:10px;color:#888;">Domain:</span>
              <span class="domain-chip primary" style="font-size:9px;">\\\${domainLabel}</span>
              <span style="font-size:10px;color:#888;margin-left:auto;">Coverage:</span>
              <span style="font-size:11px;color:#4aff8a;font-weight:600;">\\\${Math.round((card.coverageScore || 0) * 100)}%</span>
            </div>
            <div style="font-size:10px;color:#888;margin-bottom:4px;">\\\${results.length} result(s) · \\\${(card.principlesApplied || []).length} principles applied</div>
            <div class="query-results" data-query-results="\\\${card.id}">
              \\\${results.map((r, i) => \\\`
                <div class="query-result" onclick="materializeQueryResult('\\\${card.id}', \\\${i})">
                  <div style="display:flex;justify-content:space-between;">
                    <span class="result-type">\\\${r.sourceType}</span>
                    <span class="result-relevance">\\\${Math.round((r.relevance || 0) * 100)}%</span>
                  </div>
                  <div class="result-snippet">\\\${escapeHtml((r.snippet || '').slice(0, 120))}\\\${(r.snippet || '').length > 120 ? '...' : ''}</div>
                </div>
              \\\`).join('')}
            </div>
            <div style="margin-top:6px;display:flex;gap:6px;">
              <button onclick="rerunQuery('\\\${card.id}')" class="ctrl-btn" style="flex:1;font-size:11px;padding:4px 8px;">Re-run</button>
            </div>
          </div>
        \\\`;
      } else if (card.type === 'Audit') {
        const findings = card.findings || [];
        const cov = card.principleCoverage || { total: 0, satisfied: 0, violated: 0, unaddressed: 0 };
        const statusColor = card.status === 'pass' ? '#4aff8a' : card.status === 'conditional' ? '#ffaa4a' : '#ff4a4a';
        contentHtml = \\\`
          <div style="padding:4px 0;" class="audit-\\\${card.status || 'fail'}">
            <div class="card-toolbar" style="margin-bottom:0;">
              <button class="active" data-mode="edit" onclick="toggleCardMode('\\\${card.id}','edit')">Edit</button>
              <button data-mode="preview" onclick="toggleCardMode('\\\${card.id}','preview')">Preview</button>
            </div>
            \\\${fmtBar}
            <textarea data-content="\\\${card.id}" placeholder="Audit notes…">\\\${escapeHtml(card.content || '')}</textarea>
            <div class="md-preview" data-preview="\\\${card.id}" style="display:none;"></div>
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
              <span style="font-size:12px;font-weight:700;color:\\\${statusColor};text-transform:uppercase;">\\\${card.status || 'fail'}</span>
              <span style="font-size:11px;color:#888;">Confidence:</span>
              <span style="font-size:11px;color:\\\${statusColor};font-weight:600;">\\\${Math.round((card.overallConfidence || 0) * 100)}%</span>
              <span style="font-size:10px;color:#888;margin-left:auto;">Scope: \\\${card.auditScope || 'compliance'}</span>
            </div>
            <div class="audit-coverage">
              <div class="cov-item"><div class="cov-dot" style="background:#4aff8a;"></div> \\\${cov.satisfied} satisfied</div>
              <div class="cov-item"><div class="cov-dot" style="background:#ffaa4a;"></div> \\\${cov.violated} partial</div>
              <div class="cov-item"><div class="cov-dot" style="background:#ff4a4a;"></div> \\\${cov.unaddressed} unaddressed</div>
            </div>
            <div style="font-size:10px;color:#888;margin:4px 0;">\\\${findings.length} finding(s)</div>
            <div class="audit-findings" data-audit-findings="\\\${card.id}" style="max-height:200px;overflow-y:auto;">
              \\\${findings.slice(0, 20).map(f => \\\`
                <div class="audit-finding \\\${f.severity}">
                  <div style="display:flex;justify-content:space-between;">
                    <span style="font-weight:600;color:\\\${f.severity === 'violation' ? '#ff4a4a' : f.severity === 'warning' ? '#ffaa4a' : '#4a9fff'};">\\\${f.severity.toUpperCase()}</span>
                    <span style="color:#888;font-size:10px;">\\\${Math.round((f.confidence || 0) * 100)}%</span>
                  </div>
                  <div style="color:#ccc;margin:2px 0;">\\\${escapeHtml(f.description)}</div>
                  \\\${f.suggestion ? \\\`<div style="color:#888;font-size:10px;">Suggestion: \\\${escapeHtml(f.suggestion)}</div>\\\` : ''}
                </div>
              \\\`).join('')}
              \\\${findings.length > 20 ? \\\`<div style="text-align:center;color:#888;font-size:10px;padding:4px;">+\\\${findings.length - 20} more findings</div>\\\` : ''}
            </div>
            <div style="margin-top:6px;display:flex;gap:6px;">
              <button onclick="reAudit('\\\${card.id}')" class="ctrl-btn" style="flex:1;font-size:11px;padding:4px 8px;">Re-audit</button>
              <button onclick="exportAudit('\\\${card.id}')" class="ctrl-btn" style="flex:1;font-size:11px;padding:4px 8px;">Export</button>
            </div>
          </div>
        \\\`;
      } else if (card.type === 'DomainBrowser') {
        const assets = card.assets || [];
        const dMeta = { general: {color:'#888'}, legal: {color:'#4ab8ff'}, educational: {color:'#8aff4a'}, medical: {color:'#ff4a8a'}, technical: {color:'#c14aff'} };
        const dColor = dMeta[card.domain]?.color || '#888';
        contentHtml = \\\`
          <div style="padding:4px 0;">
            <div style="display:flex;gap:6px;margin-bottom:6px;">
              <button onclick="switchDomainView('\\\${card.id}','assets')" class="ctrl-btn" style="font-size:10px;padding:3px 8px;\\\${card.view === 'assets' ? 'border-color:#ff6b1a;color:#ff6b1a;' : ''}">Assets</button>
              <button onclick="switchDomainView('\\\${card.id}','principles')" class="ctrl-btn" style="font-size:10px;padding:3px 8px;\\\${card.view === 'principles' ? 'border-color:#ff6b1a;color:#ff6b1a;' : ''}">Principles</button>
              <button onclick="switchDomainView('\\\${card.id}','stack')" class="ctrl-btn" style="font-size:10px;padding:3px 8px;\\\${card.view === 'stack' ? 'border-color:#ff6b1a;color:#ff6b1a;' : ''}">Stack</button>
            </div>
            <div data-domain-view="\\\${card.id}">
              \\\${card.view === 'assets' ? \\\`
                <div style="font-size:10px;color:#888;margin-bottom:4px;">\\\${assets.length} asset(s) in \\\${card.domain}</div>
                \\\${assets.map(a => \\\`
                  <div class="domain-asset-item">
                    <span class="asset-name">\\\${a.key.split('/').pop()}</span>
                    <span class="asset-size">\\\${a.size ? Math.round(a.size / 1024) + 'KB' : ''}</span>
                  </div>
                \\\`).join('')}
                \\\${assets.length === 0 ? '<div style="color:#666;font-size:11px;text-align:center;padding:8px;">No assets</div>' : ''}
              \\\` : card.view === 'principles' ? \\\`
                <div style="font-size:10px;color:#888;margin-bottom:4px;">\\\${card.principleCount || 0} principle(s) for \\\${card.domain}</div>
                <button onclick="syncDomainPrinciples('\\\${card.domain}')" class="ctrl-btn" style="font-size:10px;padding:3px 8px;margin-bottom:6px;">Sync to KV</button>
              \\\` : \\\`
                <div style="font-size:11px;color:#ccc;">
                  <div>Primary: <span class="domain-chip primary">\\\${card.activeStack?.primary || card.domain}</span></div>
                  \\\${card.activeStack?.secondary?.length ? \\\`<div style="margin-top:4px;">Secondary: \\\${card.activeStack.secondary.map(s => \\\`<span class="domain-chip secondary">\\\${s}</span>\\\`).join(' ')}</div>\\\` : ''}
                </div>
              \\\`}
            </div>
            <div style="margin-top:6px;">
              <button onclick="uploadToDomain('\\\${card.id}', '\\\${card.domain}')" class="ctrl-btn" style="font-size:10px;padding:3px 8px;width:100%;">Upload Asset</button>
            </div>
          </div>
        \\\`;
      } else {
        contentHtml = \\\`
          <div class="card-toolbar" style="margin-bottom:0;">
            <button class="active" data-mode="edit" onclick="toggleCardMode('\\\${card.id}','edit')">Edit</button>
            <button data-mode="preview" onclick="toggleCardMode('\\\${card.id}','preview')">Preview</button>
          </div>
          \\\${fmtBar}
          <textarea data-content="\\\${card.id}" placeholder="Enter content…">\\\${escapeHtml(card.content)}</textarea>
          <div class="md-preview" data-preview="\\\${card.id}" style="display:none;"></div>
        \\\`;
      }

      // Principle badges for active card
      const principleHtml = getCardPrincipleBadges(card);
      const domainSelector = (card.type === 'Document' || card.type === 'Instruct') ? \\\`
        <select data-domain-select="\\\${card.id}" style="font-size:9px;padding:1px 4px;background:#0d0d1a;color:#888;border:1px solid #2a2a4a;border-radius:3px;cursor:pointer;" onchange="setDomain('\\\${card.id}', this.value)">
          <option value="general" \\\${(!card.domains || card.domains[0] === 'general') ? 'selected' : ''}>General</option>
          <option value="legal" \\\${card.domains && card.domains[0] === 'legal' ? 'selected' : ''}>Legal</option>
          <option value="educational" \\\${card.domains && card.domains[0] === 'educational' ? 'selected' : ''}>Edu</option>
          <option value="medical" \\\${card.domains && card.domains[0] === 'medical' ? 'selected' : ''}>Med</option>
          <option value="technical" \\\${card.domains && card.domains[0] === 'technical' ? 'selected' : ''}>Tech</option>
        </select>
      \\\` : '';
      const eitlBtn = (card.type === 'Document' || card.type === 'Instruct') ? \\\`<button onclick="openExpertReview('\\\${card.id}')" style="font-size:9px;padding:1px 4px;background:#4a3a1a;border:1px solid #6a5a2a;border-radius:3px;color:#ffaa4a;cursor:pointer;">EITL</button>\\\` : '';

      el.innerHTML += \\\`
        <div class="card-header">
          <div class="flex items-center gap-2 flex-1">
            <span class="card-type-badge \\\${badgeClass}">\\\${card.type}</span>
            <input class="card-title bg-transparent text-sm font-semibold text-white outline-none w-full" value="\\\${escapeHtml(card.title)}" data-title="\\\${card.id}" />
            \\\${domainSelector}
            \\\${eitlBtn}
            \\\${principleHtml}
          </div>
          <button class="text-gray-500 hover:text-blue-400 text-sm ml-1" title="Fullscreen" onclick="openCardFullscreen('\\\${card.id}')">⛶</button>
          <button class="text-gray-500 hover:text-red-400 text-sm ml-2" onclick="deleteCard('\\\${card.id}')">✕</button>
        </div>
        <div class="card-content">
          \\\${contentHtml}
          \\\${card.relationships.length ? \\\`<div class="mt-2 rel-link">↳ derived from: \\\${card.relationships.length} card(s)</div>\\\` : ''}
        </div>
        <div class="resize-handle" data-resize="\\\${card.id}"></div>
      \\\`;
      canvas.appendChild(el);

      // Attach event listeners
      el.addEventListener('click', (e) => { if (['TEXTAREA','INPUT','BUTTON','A','IFRAME','DETAILS','SUMMARY','SELECT'].includes(e.target.tagName)) return; toggleSelect(card.id); });
      const titleInput = el.querySelector(\\\`[data-title="\\\${card.id}"]\\\`);
      titleInput.addEventListener('change', () => updateCard(card.id, { title: titleInput.value }));

      // Search card enter key
      if (isSearch) {
        const searchInput = el.querySelector(\\\`[data-search-input="\\\${card.id}"]\\\`);
        if (searchInput) {
          searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') runCardSearch(card.id); });
        }
      }

      // Browser URL bar enter key
      if (isBrowser) {
        const urlInput = el.querySelector(\\\`[data-url-input="\\\${card.id}"]\\\`);
        if (urlInput) {
          urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') browserNavigate(card.id); });
        }
      }

      const contentArea = el.querySelector(\\\`[data-content="\\\${card.id}"]\\\`);
      if (contentArea) {
        let debounce;
        contentArea.addEventListener('input', () => {
          clearTimeout(debounce);
          debounce = setTimeout(() => updateCard(card.id, { content: contentArea.value }), 600);
          // Live split view rendering
          const preview = el.querySelector(\\\`[data-preview="\\\${card.id}"]\\\`);
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
      const el = document.getElementById(\\\`card-\\\${card.id}\\\`);
      if (!el) { renderCard(card, cardCounter * 30 + 40, cardCounter * 30 + 40); cardCounter++; return; }
      const titleInput = el.querySelector(\\\`[data-title="\\\${card.id}"]\\\`);
      const contentArea = el.querySelector(\\\`[data-content="\\\${card.id}"]\\\`);
      const preview = el.querySelector(\\\`[data-preview="\\\${card.id}"]\\\`);
      if (titleInput && document.activeElement !== titleInput) titleInput.value = card.title;
      if (contentArea && document.activeElement !== contentArea) {
        contentArea.value = card.content || '';
        if (preview && preview.style.display !== 'none') {
          preview.innerHTML = renderMarkdown(card.content || '');
        }
      }
    }

    function toggleSelect(id) { if (selectedIds.has(id)) selectedIds.delete(id); else selectedIds.add(id); document.getElementById(\\\`card-\\\${id}\\\`).classList.toggle('selected', selectedIds.has(id)); }
    function updateStatus() { document.getElementById('status').textContent = \\\`\\\${cards.length} cards · \\\${selectedIds.size} selected\\\`; }

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
        dragState.el.style.left = \\\`\\\${t.clientX - dragState.dx}px\\\`;
        dragState.el.style.top = \\\`\\\${t.clientY - dragState.dy}px\\\`;
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
        dragState.el.style.left = \\\`\\\${e.clientX - dragState.dx}px\\\`;
        dragState.el.style.top = \\\`\\\${e.clientY - dragState.dy}px\\\`;
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
      const handle = el.querySelector(\\\`[data-resize="\\\${cardId}"]\\\`);
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
      dragState.el.style.width = \\\`\\\${newW}px\\\`;
      dragState.el.style.minHeight = \\\`\\\${newH}px\\\`;
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
          const tRect = document.getElementById(\\\`card-\\\${bestTarget}\\\`)?.getBoundingClientRect();
          const dragEl = document.getElementById(\\\`card-\\\${dragId}\\\`);
          if (tRect && dragEl) {
            let newX, newY;
            switch(bestEdge) {
              case 'left': newX = tRect.left - dragEl.offsetWidth - 8; newY = tRect.top; break;
              case 'right': newX = tRect.right + 8; newY = tRect.top; break;
              case 'top': newX = tRect.left; newY = tRect.top - dragEl.offsetHeight - 8; break;
              case 'bottom': newX = tRect.left; newY = tRect.bottom + 8; break;
            }
            dragEl.style.left = \\\`\\\${newX}px\\\`; dragEl.style.top = \\\`\\\${newY}px\\\`;
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
        const el = document.getElementById(\\\`card-\\\${card.id}\\\`);
        if (!el) return;
        const badge = el.querySelector('.card-type-badge');
        if (badge) badge.textContent = \\\`Doc \\\${idx + 1}\\\`;
      });
    }

    function openManipulate() { if (selectedIds.size === 0) { alert('Select at least one card on the canvas first.'); return; } document.getElementById('selectedCount').textContent = \\\`\\\${selectedIds.size} card(s) selected.\\\`; document.getElementById('manipulateModal').style.display = 'flex'; }
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
      html = html.replace(/\\\`\\\`\\\`(\\\\w*)\\\\n([\\\\s\\\\S]*?)\\\`\\\`\\\`/g, '<pre><code>$2</code></pre>');
      // Inline code
      html = html.replace(/\\\`([^\\\`]+)\\\`/g, '<code>$1</code>');
      // Headings
      html = html.replace(/^###### (.+)$/gm, '<h6>$1</h6>');
      html = html.replace(/^##### (.+)$/gm, '<h5>$1</h5>');
      html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
      html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
      html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
      html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
      // Bold and italic
      html = html.replace(/\\\\*\\\\*\\\\*(.+?)\\\\*\\\\*\\\\*/g, '<strong><em>$1</em></strong>');
      html = html.replace(/\\\\*\\\\*(.+?)\\\\*\\\\*/g, '<strong>$1</strong>');
      html = html.replace(/\\\\*(.+?)\\\\*/g, '<em>$1</em>');
      // Links and images
      html = html.replace(/!\\\\[([^\\\\]]*)\\\\]\\\\(([^)]+)\\\\)/g, '<img src="$2" alt="$1" style="max-width:100%;border-radius:4px;">');
      html = html.replace(/\\\\[([^\\\\]]+)\\\\]\\\\(([^)]+)\\\\)/g, '<a href="$2" target="_blank">$1</a>');
      // Blockquotes
      html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
      // Horizontal rules
      html = html.replace(/^---$/gm, '<hr>');
      // Unordered lists
      html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
      html = html.replace(/(<li>.*<\\\\/li>\\\\n?)+/g, '<ul>$&</ul>');
      // Ordered lists
      html = html.replace(/^\\\\d+\\\\. (.+)$/gm, '<li>$1</li>');
      // Tables
      html = html.replace(/^\\\\|(.+)\\\\|$/gm, (match, content) => {
        const cells = content.split('|').map(c => c.trim());
        if (cells.every(c => c.match(/^[-:]+$/))) return '';
        const tag = 'td';
        return '<tr>' + cells.map(c => \\\`<\\\${tag}>\\\${c}</\\\${tag}>\\\`).join('') + '</tr>';
      });
      html = html.replace(/(<tr>.*<\\\\/tr>\\\\n?)+/g, '<table>$&</table>');
      // Paragraphs (double newline)
      html = html.replace(/\\\\n\\\\n/g, '</p><p>');
      html = '<p>' + html + '</p>';
      // Single newlines to <br>
      html = html.replace(/\\\\n/g, '<br>');
      // Clean up empty paragraphs and nested tags
      html = html.replace(/<p><\\\\/p>/g, '');
      html = html.replace(/<p>(<h[1-6]>)/g, '$1');
      html = html.replace(/(<\\\\/h[1-6]>)<\\\\/p>/g, '$1');
      html = html.replace(/<p>(<pre>)/g, '$1');
      html = html.replace(/(<\\\\/pre>)<\\\\/p>/g, '$1');
      html = html.replace(/<p>(<ul>)/g, '$1');
      html = html.replace(/(<\\\\/ul>)<\\\\/p>/g, '$1');
      html = html.replace(/<p>(<table>)/g, '$1');
      html = html.replace(/(<\\\\/table>)<\\\\/p>/g, '$1');
      html = html.replace(/<p>(<hr>)<\\\\/p>/g, '$1');
      html = html.replace(/<p>(<blockquote>)/g, '$1');
      html = html.replace(/(<\\\\/blockquote>)<\\\\/p>/g, '$1');
      return html;
    }

    // ── Card Mode Toggle (Edit / Preview / Split) ──
    function toggleCardMode(cardId, mode) {
      const el = document.getElementById(\\\`card-\\\${cardId}\\\`);
      if (!el) return;
      const textarea = el.querySelector(\\\`[data-content="\\\${cardId}"]\\\`);
      const preview = el.querySelector(\\\`[data-preview="\\\${cardId}"]\\\`);
      const fmtBar = el.querySelector(\\\`[data-fmtbar="\\\${cardId}"]\\\`);
      if (!textarea || !preview) return;
      const buttons = el.querySelectorAll('.card-toolbar button');
      buttons.forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
      if (mode === 'split') {
        textarea.style.display = 'block';
        preview.style.display = 'block';
        if (fmtBar) fmtBar.style.display = 'flex';
        preview.innerHTML = renderMarkdown(textarea.value);
        updateCard(cardId, { splitView: true });
      } else if (mode === 'preview') {
        textarea.style.display = 'none';
        preview.style.display = 'block';
        if (fmtBar) fmtBar.style.display = 'none';
        preview.innerHTML = renderMarkdown(textarea.value);
        updateCard(cardId, { splitView: false });
      } else {
        textarea.style.display = 'block';
        preview.style.display = 'none';
        if (fmtBar) fmtBar.style.display = 'flex';
        textarea.focus();
        updateCard(cardId, { splitView: false });
      }
    }

    // ── Format Toolbar Actions ──
    function getCardTextarea(cardId) {
      const el = document.getElementById(\\\`card-\\\${cardId}\\\`);
      return el ? el.querySelector(\\\`[data-content="\\\${cardId}"]\\\`) : null;
    }

    function fmtInsert(cardId, before, after, placeholder) {
      const ta = getCardTextarea(cardId);
      if (!ta) return;
      // Switch to edit mode first
      const el = document.getElementById(\\\`card-\\\${cardId}\\\`);
      const editBtn = el?.querySelector('[data-mode="edit"]');
      if (editBtn && !editBtn.classList.contains('active')) editBtn.click();
      ta.focus();
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const selected = ta.value.substring(start, end);
      const text = selected || placeholder || '';
      const insertion = before + text + (after || '');
      ta.value = ta.value.substring(0, start) + insertion + ta.value.substring(end);
      if (selected) {
        ta.selectionStart = start + before.length;
        ta.selectionEnd = start + before.length + text.length;
      } else {
        ta.selectionStart = start + before.length;
        ta.selectionEnd = start + before.length + (placeholder || '').length;
      }
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function fmtBold(cardId) { fmtInsert(cardId, '**', '**', 'bold text'); }
    function fmtItalic(cardId) { fmtInsert(cardId, '*', '*', 'italic text'); }
    function fmtStrike(cardId) { fmtInsert(cardId, '~~', '~~', 'strikethrough'); }
    function fmtCode(cardId) { fmtInsert(cardId, '\\\`', '\\\`', 'code'); }
    function fmtLink(cardId) { fmtInsert(cardId, '[', '](https://)', 'link text'); }
    function fmtImage(cardId) { fmtInsert(cardId, '![', '](https://)', 'alt text'); }
    function fmtHr(cardId) { fmtInsert(cardId, '\\\\n\\\\n---\\\\n\\\\n', '', ''); }
    function fmtQuote(cardId) { fmtInsert(cardId, '\\\\n> ', '\\\\n', 'quote'); }
    function fmtCodeBlock(cardId) { fmtInsert(cardId, '\\\\n\\\`\\\`\\\`\\\\n', '\\\\n\\\`\\\`\\\`\\\\n', 'code block'); }
    function fmtList(cardId) { fmtInsert(cardId, '\\\\n- ', '\\\\n', 'list item'); }
    function fmtOList(cardId) { fmtInsert(cardId, '\\\\n1. ', '\\\\n', 'list item'); }
    function fmtHeading(cardId, level) {
      const prefix = '#'.repeat(level) + ' ';
      fmtInsert(cardId, '\\\\n' + prefix, '\\\\n', 'heading');
    }

    // ── Browser Navigation ──
    function browserNavigate(cardId) {
      const el = document.getElementById(\\\`card-\\\${cardId}\\\`);
      if (!el) return;
      const urlInput = el.querySelector(\\\`[data-url-input="\\\${cardId}"]\\\`);
      if (!urlInput) return;
      let url = urlInput.value.trim();
      if (!url) return;
      if (!url.match(/^https?:\\\\/\\\\//)) url = 'https://' + url;
      urlInput.value = url;
      // Update the iframe
      const frame = el.querySelector(\\\`[data-browser-frame="\\\${cardId}"]\\\`);
      if (frame) {
        frame.src = \\\`/api/proxy?url=\\\${encodeURIComponent(url)}\\\`;
      } else {
        // Create iframe if it doesn't exist
        const viewer = el.querySelector('.browser-viewer');
        if (viewer) {
          viewer.innerHTML = \\\`<iframe data-browser-frame="\\\${cardId}" sandbox="allow-scripts allow-forms allow-popups allow-same-origin" src="/api/proxy?url=\\\${encodeURIComponent(url)}" style="width:100%;height:100%;border:none;"></iframe>\\\`;
        }
      }
      // Save URL to card
      updateCard(cardId, { url });
    }

    function openBrowserFullscreen(cardId) {
      const card = cards.find(c => c.id === cardId);
      if (!card || !card.url) { showToast('No URL to open', 'warning'); return; }
      const proxyUrl = \\\`/api/proxy?url=\\\${encodeURIComponent(card.url)}&ws=\\\${wsParam}\\\`;
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:#0d0d1a;z-index:200;display:flex;flex-direction:column;';
      overlay.innerHTML = \\\`
        <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:#1a1a2e;border-bottom:1px solid #2a2a4a;">
          <span style="color:#4ab8ff;font-size:12px;font-family:monospace;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">\\\${escapeHtml(card.url)}</span>
          <button onclick="this.closest('[style*=fixed]').remove()" style="padding:4px 12px;background:#4a1a1a;color:#ff4a4a;border:1px solid #6a2a2a;border-radius:4px;font-size:12px;cursor:pointer;">Close</button>
        </div>
        <iframe src="\\\${proxyUrl}" sandbox="allow-scripts allow-forms allow-popups allow-same-origin" style="flex:1;width:100%;border:none;background:#fff;"></iframe>
      \\\`;
      document.body.appendChild(overlay);
    }

    function openCardFullscreen(cardId) {
      const card = cards.find(c => c.id === cardId);
      if (!card) { showToast('Card not found', 'warning'); return; }
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:#0d0d1a;z-index:200;display:flex;flex-direction:column;';
      const isMarkdown = card.type === 'Document' || card.type === 'Import' || card.type === 'Search';
      const bodyHtml = isMarkdown
        ? \\\`<div class="md-preview" style="flex:1;overflow:auto;padding:24px 32px;">\\\${renderMarkdown(card.content || '')}</div>\\\`
        : \\\`<pre style="flex:1;overflow:auto;padding:24px 32px;color:#e0e0e0;font-family:monospace;font-size:13px;white-space:pre-wrap;word-wrap:break-word;">\\\${escapeHtml(card.content || '')}</pre>\\\`;
      overlay.innerHTML = \\\`
        <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:#1a1a2e;border-bottom:1px solid #2a2a4a;">
          <span class="card-type-badge badge-\\\${card.type.toLowerCase()}">\\\${card.type}</span>
          <span style="color:#ccc;font-size:13px;font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">\\\${escapeHtml(card.title)}</span>
          <button onclick="openCardFullscreenEdit('\\\${card.id}')" style="padding:4px 12px;background:#22223a;color:#4ab8ff;border:1px solid #2a2a4a;border-radius:4px;font-size:12px;cursor:pointer;">Edit</button>
          <button onclick="this.closest('[style*=fixed]').remove()" style="padding:4px 12px;background:#4a1a1a;color:#ff4a4a;border:1px solid #6a2a2a;border-radius:4px;font-size:12px;cursor:pointer;">Close</button>
        </div>
        \\\${bodyHtml}
      \\\`;
      document.body.appendChild(overlay);
    }

    function openCardFullscreenEdit(cardId) {
      const card = cards.find(c => c.id === cardId);
      if (!card) return;
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:#0d0d1a;z-index:200;display:flex;flex-direction:column;';
      overlay.innerHTML = \\\`
        <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:#1a1a2e;border-bottom:1px solid #2a2a4a;">
          <span style="color:#ccc;font-size:13px;font-weight:600;flex:1;">Edit \\\${escapeHtml(card.title)}</span>
          <button onclick="this.closest('[style*=fixed]').remove()" style="padding:4px 12px;background:#4a1a1a;color:#ff4a4a;border:1px solid #6a2a2a;border-radius:4px;font-size:12px;cursor:pointer;">Close</button>
        </div>
        <textarea data-fullscreen-edit="\\\${card.id}" style="flex:1;width:100%;background:#0d0d1a;color:#e0e0e0;border:none;padding:16px 20px;font-size:14px;font-family:'SF Mono','Fira Code',monospace;line-height:1.7;resize:none;outline:none;">\\\${escapeHtml(card.content || '')}</textarea>
      \\\`;
      document.body.appendChild(overlay);
      const ta = overlay.querySelector(\\\`[data-fullscreen-edit="\\\${card.id}"]\\\`);
      ta.focus();
      let debounce;
      ta.addEventListener('input', () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => updateCard(card.id, { content: ta.value }), 400);
      });
    }

    // ── Toast Notifications ──
    function showToast(message, type = 'info') {
      const container = document.getElementById('toastContainer');
      const toast = document.createElement('div');
      toast.className = \\\`toast toast-\\\${type}\\\`;
      const icons = { success: '✓', error: '✕', info: 'ℹ', processing: '⟳' };
      toast.innerHTML = \\\`<span>\\\${icons[type] || 'ℹ'}</span> \\\${escapeHtml(message)}\\\`;
      container.appendChild(toast);
      setTimeout(() => toast.remove(), 3200);
    }
    function showSpinner(msg) { showToast(msg || 'Working...', 'processing'); }
    function hideSpinner() {}

    // ── HTML → Markdown Converter ──
    function htmlToMarkdown(html) {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      function convertNode(node) {
        if (node.nodeType === 3) {
          return node.textContent.replace(/\\\\s+/g, ' ');
        }
        if (node.nodeType !== 1) return '';
        const tag = node.tagName.toLowerCase();
        const inner = Array.from(node.childNodes).map(convertNode).join('');
        switch (tag) {
          case 'h1': return \\\`\\\\n# \\\${inner.trim()}\\\\n\\\`;
          case 'h2': return \\\`\\\\n## \\\${inner.trim()}\\\\n\\\`;
          case 'h3': return \\\`\\\\n### \\\${inner.trim()}\\\\n\\\`;
          case 'h4': return \\\`\\\\n#### \\\${inner.trim()}\\\\n\\\`;
          case 'h5': return \\\`\\\\n##### \\\${inner.trim()}\\\\n\\\`;
          case 'h6': return \\\`\\\\n###### \\\${inner.trim()}\\\\n\\\`;
          case 'p': return \\\`\\\\n\\\${inner.trim()}\\\\n\\\`;
          case 'br': return '\\\\n';
          case 'strong': case 'b': return \\\`**\\\${inner.trim()}**\\\`;
          case 'em': case 'i': return \\\`*\\\${inner.trim()}*\\\`;
          case 'code': return \\\`\\\\\\\`\\\${inner}\\\\\\\`\\\`;
          case 'pre': return \\\`\\\\n\\\\\\\`\\\\\\\`\\\\\\\`\\\\n\\\${inner.trim()}\\\\n\\\\\\\`\\\\\\\`\\\\\\\`\\\\n\\\`;
          case 'a': { const href = node.getAttribute('href'); return href ? \\\`[\\\${inner.trim()}](\\\${href})\\\` : inner; }
          case 'img': { const alt = node.getAttribute('alt') || 'image'; const src = node.getAttribute('src') || ''; return \\\`![\\\${alt}](\\\${src})\\\`; }
          case 'ul': return '\\\\n' + inner + '\\\\n';
          case 'ol': return '\\\\n' + inner + '\\\\n';
          case 'li': {
            const parent = node.parentElement;
            if (parent && parent.tagName.toLowerCase() === 'ol') {
              const idx = Array.from(parent.children).indexOf(node) + 1;
              return \\\`\\\${idx}. \\\${inner.trim()}\\\\n\\\`;
            }
            return \\\`- \\\${inner.trim()}\\\\n\\\`;
          }
          case 'blockquote': return '\\\\n> ' + inner.trim().replace(/\\\\n/g, '\\\\n> ') + '\\\\n';
          case 'hr': return '\\\\n---\\\\n';
          case 'table': {
            const rows = Array.from(node.querySelectorAll('tr'));
            if (rows.length === 0) return inner;
            let md = '\\\\n';
            rows.forEach((row, ri) => {
              const cells = Array.from(row.querySelectorAll('th, td')).map(c => c.textContent.trim());
              md += '| ' + cells.join(' | ') + ' |\\\\n';
              if (ri === 0) md += '| ' + cells.map(() => '---').join(' | ') + ' |\\\\n';
            });
            return md + '\\\\n';
          }
          case 'div': case 'section': case 'article': case 'main': case 'span': case 'mark': case 'del': case 's': case 'u': case 'sub': case 'sup': case 'small': case 'strong': case 'em':
            return inner;
          case 'script': case 'style': case 'nav': case 'footer': case 'header': case 'aside': case 'form': case 'input': case 'button': case 'select': case 'textarea':
            return '';
          default: return inner;
        }
      }
      let md = Array.from(doc.body.childNodes).map(convertNode).join('');
      md = md.replace(/\\\\n{3,}/g, '\\\\n\\\\n').replace(/[ \\\\t]+/g, ' ').trim();
      return md;
    }

    // ── Image Compression ──
    function compressImage(file, maxWidth = 1200, quality = 0.85) {
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
          const img = new Image();
          img.onload = () => {
            if (img.width <= maxWidth && file.size < 2 * 1024 * 1024) {
              resolve(e.target.result);
              return;
            }
            const canvas = document.createElement('canvas');
            const scale = img.width > maxWidth ? maxWidth / img.width : 1;
            canvas.width = img.width * scale;
            canvas.height = img.height * scale;
            canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL('image/jpeg', quality));
          };
          img.src = e.target.result;
        };
        reader.readAsDataURL(file);
      });
    }

    // ── File Processing (frontend) ──
    async function processFile(file) {
      const name = file.name || 'Pasted file';
      const type = file.type || '';
      const ext = name.split('.').pop().toLowerCase();

      if (type.startsWith('image/') || ['png','jpg','jpeg','gif','webp','bmp','svg'].includes(ext)) {
        showToast('Processing image…', 'processing');
        const dataUrl = await compressImage(file);
        const base64 = dataUrl.split(',')[1];
        await createCard('Document', name, \\\`![\\\${name}](\\\${dataUrl})\\\`);
        showToast('Image imported', 'success');
        return;
      }

      if (type === 'text/markdown' || type === 'text/x-markdown' || ext === 'md' || ext === 'markdown') {
        const text = await file.text();
        const card = await createCard('Document', name, text);
        showToast('Markdown imported', 'success');
        return;
      }

      if (type === 'text/html' || ext === 'html' || ext === 'htm') {
        const html = await file.text();
        const md = htmlToMarkdown(html);
        const card = await createCard('Document', name, md);
        showToast('HTML imported as Markdown', 'success');
        return;
      }

      if (type === 'text/plain' || ext === 'txt') {
        const text = await file.text();
        await createCard('Document', name, text);
        showToast('Text imported', 'success');
        return;
      }

      if (type === 'application/pdf' || ext === 'pdf' ||
          type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || ext === 'docx') {
        showToast(\\\`Processing \\\${ext.toUpperCase()} — this may take a moment…\\\`, 'processing');
        try {
          const base64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result.split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(file);
          });
          const res = await fetch(API('/import'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: name, mimeType: type || (ext === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), data: base64 })
          });
          const card = await res.json();
          if (res.ok) {
            showToast(\\\`\\\${ext.toUpperCase()} imported successfully\\\`, 'success');
          } else {
            showToast(\\\`Import failed: \\\${card.error}\\\`, 'error');
          }
        } catch (err) {
          showToast(\\\`Import failed: \\\${err.message}\\\`, 'error');
        }
        return;
      }

      showToast(\\\`Unsupported file type: \\\${type || ext}\\\`, 'error');
    }

    // ── Paste Handler ──
    document.addEventListener('paste', async (e) => {
      const active = document.activeElement;
      const isEditing = active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT');
      const clipboardData = e.clipboardData;
      if (!clipboardData) return;

      // Files on clipboard (images, documents) — FileList is always truthy, must check length
      const files = clipboardData.files;
      if (files && files.length > 0) {
        e.preventDefault();
        for (const file of files) {
          await processFile(file);
        }
        return;
      }

      // Rich HTML paste INTO a textarea — convert to markdown and insert
      if (isEditing && active.tagName === 'TEXTAREA') {
        const html = clipboardData.getData('text/html');
        if (html && html.trim().length > 10) {
          e.preventDefault();
          const md = htmlToMarkdown(html);
          if (md.trim().length > 0) {
            const start = active.selectionStart;
            const end = active.selectionEnd;
            const before = active.value.substring(0, start);
            const after = active.value.substring(end);
            active.value = before + md + after;
            active.selectionStart = active.selectionEnd = start + md.length;
            active.dispatchEvent(new Event('input', { bubbles: true }));
          }
          return;
        }
        // Plain text paste into textarea — let browser handle it normally
        return;
      }

      // HTML content outside textarea — create a new card
      const html = clipboardData.getData('text/html');
      if (html && html.trim().length > 10 && !isEditing) {
        e.preventDefault();
        const md = htmlToMarkdown(html);
        if (md.trim().length > 0) {
          const title = extractTitleFromHtml(html) || 'Pasted Content';
          await createCard('Document', title, md);
          showToast('Content imported as Markdown', 'success');
        }
        return;
      }

      // Plain text outside textarea — create a new card
      if (!isEditing) {
        const text = clipboardData.getData('text/plain');
        if (text && text.trim().length > 0) {
          e.preventDefault();
          const title = text.split('\\\\n')[0].slice(0, 60).trim() || 'Pasted Text';
          await createCard('Document', title, text);
          showToast('Text imported', 'success');
        }
      }
    });

    function extractTitleFromHtml(html) {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const h1 = doc.querySelector('h1');
      if (h1) return h1.textContent.trim().slice(0, 60);
      const b = doc.querySelector('b, strong');
      if (b && b.textContent.trim().length > 3) return b.textContent.trim().slice(0, 60);
      const first = doc.body.textContent.trim().split('\\\\n')[0];
      return first ? first.slice(0, 60).trim() : null;
    }

    // --- Search Card ---
    function openSearch() { document.getElementById('searchModal').style.display = 'flex'; document.getElementById('searchQuery').focus(); }
    function closeSearch() { document.getElementById('searchModal').style.display = 'none'; }
    async function runSearch() {
      const q = document.getElementById('searchQuery').value.trim(); if (!q) return;
      const btn = document.getElementById('searchBtn'); btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
      try {
        const res = await fetch(API('/search'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q }) });
        const results = await res.json();
        const container = document.getElementById('searchResults'); container.style.display = 'block';
        container.innerHTML = (results.hits || []).map(r => \\\`
          <div class="search-result-item" onclick="materializeSearchResult('\\\${escapeHtml(r.title)}', '\\\${escapeHtml(r.snippet || '')}')">
            <div class="result-title">\\\${escapeHtml(r.title)}</div>
            <div class="result-snippet">\\\${escapeHtml((r.snippet || '').slice(0, 120))}</div>
          </div>
        \\\`).join('') || '<div class="text-xs text-gray-500 p-2">No results</div>';
      } catch(e) { showToast('Search failed: ' + e.message, 'error'); }
      finally { btn.disabled = false; btn.textContent = 'Search'; }
    }
    function materializeSearchResult(title, snippet) {
      closeSearch();
      createCard('Document', title, snippet);
    }
    async function runCardSearch(cardId) {
      const el = document.getElementById(\\\`card-\\\${cardId}\\\`);
      const input = el?.querySelector(\\\`[data-search-input="\\\${cardId}"]\\\`);
      const results = el?.querySelector(\\\`[data-search-results="\\\${cardId}"]\\\`);
      if (!input || !results) return;
      const q = input.value.trim(); if (!q) return;
      try {
        const res = await fetch(API('/search'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q }) });
        const data = await res.json();
        results.innerHTML = (data.hits || []).map(r => \\\`
          <div class="search-result-item" onclick="materializeSearchResult('\\\${escapeHtml(r.title)}', '\\\${escapeHtml(r.snippet || '')}')">
            <div class="result-title">\\\${escapeHtml(r.title)}</div>
            <div class="result-snippet">\\\${escapeHtml((r.snippet || '').slice(0, 120))}</div>
          </div>
        \\\`).join('') || '<div class="text-xs text-gray-500 p-2">No results</div>';
      } catch(e) { results.innerHTML = '<div class="text-xs text-red-400 p-2">Search failed</div>'; }
    }

    // --- Principle Engine (frontend) ---
    let pendingPrinciple = null;
    function showPrincipleProposal(principle) {
      pendingPrinciple = principle;
      document.getElementById('principlePreview').textContent = principle.text;
      document.getElementById('principleEditText').value = principle.text;
      document.getElementById('principleDomain').value = principle.domainTag || 'legal';
      document.getElementById('principleModal').style.display = 'flex';
    }
    function closePrinciple() { document.getElementById('principleModal').style.display = 'none'; pendingPrinciple = null; }
    function killPrinciple() {
      if (!pendingPrinciple) return;
      fetch(API('/principles/kill'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: pendingPrinciple.id }) })
        .then(r => r.json()).then(data => {
          if (data.immutable) { showToast('Constitutional immutability: this principle cannot be removed', 'error'); return; }
          showToast('Principle killed', 'info');
        });
      closePrinciple();
    }
    async function ratifyPrinciple(action) {
      if (!pendingPrinciple) return;
      const editedText = document.getElementById('principleEditText').value.trim();
      const domain = document.getElementById('principleDomain').value;
      const res = await fetch(API('/principles'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        id: pendingPrinciple.id, text: editedText || pendingPrinciple.text, domainTag: domain,
        sourceCardId: pendingPrinciple.sourceCardId, sourceCitation: pendingPrinciple.sourceCitation,
        ratificationStatus: (domain === 'universal' || domain === 'ethical') ? 'auto' : 'expert',
        action
      })});
      if (res.ok) { showToast('Principle ratified', 'success'); closePrinciple(); loadPrinciples(); }
      else { showToast('Ratification failed', 'error'); }
    }
    async function loadPrinciples() {
      try { const res = await fetch(API('/principles')); const data = await res.json(); principles = data.principles || []; renderPrincipleBadges(); } catch {}
    }
    function getCardPrincipleBadges(card) {
      const applicable = principles.filter(p => {
        if (p.domainTag === 'universal' || p.domainTag === 'ethical') return true;
        return card.domains && card.domains.includes(p.domainTag);
      });
      if (applicable.length === 0) return '';
      const autoCount = applicable.filter(p => p.ratificationStatus === 'auto').length;
      const expertCount = applicable.filter(p => p.ratificationStatus === 'expert').length;
      let html = '';
      if (autoCount) html += \\\`<span class="principle-badge principle-auto">✓ \\\${autoCount}</span>\\\`;
      if (expertCount) html += \\\`<span class="principle-badge principle-expert">★ \\\${expertCount}</span>\\\`;
      return html;
    }
    function renderPrincipleBadges() {
      document.querySelectorAll('.card-window').forEach(el => {
        const card = cards.find(c => c.id === el.dataset.id);
        if (!card) return;
        const header = el.querySelector('.card-header .flex');
        if (!header) return;
        const existing = header.querySelector('.principle-badge');
        if (existing) existing.parentElement.removeChild(existing);
        const html = getCardPrincipleBadges(card);
        if (html) { const span = document.createElement('span'); span.innerHTML = html; header.appendChild(span); }
      });
    }

    // --- Import card classification ---
    async function classifyImportContent(cardId, content) {
      try {
        const res = await fetch(API('/classify'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cardId, content: content.slice(0, 2000) }) });
        const data = await res.json();
        const el = document.querySelector(\\\`[data-import-classification="\\\${cardId}"]\\\`);
        if (el && data.classification) {
          el.innerHTML = \\\`<div class="text-xs text-cyan-300">🔧 Domain: \\\${data.classification.domain} | Principles: \\\${data.classification.principles.length} proposed</div>\\\`;
          if (data.classification.principles.length > 0) {
            data.classification.principles.forEach(p => showPrincipleProposal(p));
          }
        }
      } catch {}
    }

    // --- Phase 2: Instruct Card Routing ---
    async function runInstruct(cardId) {
      const card = cards.find(c => c.id === cardId);
      const el = document.getElementById(\\\`card-\\\${cardId}\\\`);
      if (!card || !el) return;
      const textarea = el.querySelector(\\\`[data-content="\\\${cardId}"]\\\`);
      const output = el.querySelector(\\\`[data-instruct-output="\\\${cardId}"]\\\`);
      if (!textarea || !output) return;
      const instruction = textarea.value.trim();
      if (!instruction) { output.innerHTML = '<div class="text-xs text-red-400">Enter an instruction first.</div>'; return; }
      output.innerHTML = '<div class="text-xs text-yellow-400"><span class="spinner"></span> Routing through principle stack...</div>';
      try {
        const res = await fetch(API('/instruct'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cardId, instruction, domains: card.domains || [] }) });
        const data = await res.json();
        if (data.error) { output.innerHTML = \\\`<div class="text-xs text-red-400">\\\${data.error}</div>\\\`; return; }
        output.innerHTML = \\\`
          <div class="md-preview" style="max-height:250px;overflow-y:auto;">\\\${renderMarkdown(data.result || '')}</div>
          <div style="margin-top:6px;display:flex;gap:6px;">
            <button onclick="adoptInstructResult('\\\${cardId}', this.parentElement.previousElementSibling)" class="action-btn" style="font-size:10px;padding:3px 8px;">Adopt as Content</button>
            <span class="text-xs text-gray-500">Confidence: \\\${data.confidence || 'N/A'}</span>
          </div>
        \\\`;
      } catch(e) { output.innerHTML = \\\`<div class="text-xs text-red-400">Failed: \\\${e.message}</div>\\\`; }
    }
    function adoptInstructResult(cardId, previewEl) {
      const text = previewEl?.textContent || '';
      const card = cards.find(c => c.id === cardId);
      const el = document.getElementById(\\\`card-\\\${cardId}\\\`);
      if (!card || !el) return;
      const textarea = el.querySelector(\\\`[data-content="\\\${cardId}"]\\\`);
      if (textarea) { textarea.value = text; updateCard(cardId, { content: text }); }
    }
    async function checkPrincipleCompliance(cardId) {
      const card = cards.find(c => c.id === cardId);
      const el = document.getElementById(\\\`card-\\\${cardId}\\\`);
      if (!card || !el) return;
      const textarea = el.querySelector(\\\`[data-content="\\\${cardId}"]\\\`);
      const output = el.querySelector(\\\`[data-instruct-output="\\\${cardId}"]\\\`);
      if (!textarea || !output) return;
      const content = textarea.value.trim();
      if (!content) return;
      output.innerHTML = '<div class="text-xs text-yellow-400"><span class="spinner"></span> Checking compliance...</div>';
      try {
        const res = await fetch(API('/compliance'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cardId, content }) });
        const data = await res.json();
        const violations = data.violations || [];
        const suggestions = data.suggestions || [];
        let html = '';
        if (violations.length > 0) {
          html += '<div style="margin-bottom:6px;"><span class="text-xs font-bold text-red-400">Violations:</span>';
          violations.forEach(v => { html += \\\`<div class="text-xs text-red-300 ml-2">⚠ \\\${v}</div>\\\`; });
          html += '</div>';
        }
        if (suggestions.length > 0) {
          html += '<div><span class="text-xs font-bold text-yellow-400">Suggestions:</span>';
          suggestions.forEach(s => { html += \\\`<div class="text-xs text-yellow-300 ml-2">ℹ \\\${s}</div>\\\`; });
          html += '</div>';
        }
        if (!html) html = '<div class="text-xs text-green-400">✓ Content complies with all active principles.</div>';
        output.innerHTML = html;
      } catch(e) { output.innerHTML = \\\`<div class="text-xs text-red-400">Failed: \\\${e.message}</div>\\\`; }
    }

    // --- Phase 3: Domain Awareness ---
    let activeDomainStack = { primary: 'general', secondary: [] };
    function setDomain(cardId, domain) {
      const card = cards.find(c => c.id === cardId);
      if (!card) return;
      const domains = [domain];
      if (card.domains && card.domains.length > 1) domains.push(card.domains[1]);
      updateCard(cardId, { domains });
      activeDomainStack.primary = domain;
      showToast(\\\`Domain set to \\\${domain}\\\`, 'info');
      renderPrincipleBadges();
    }
    function getActiveDomainStack() { return activeDomainStack; }

    // --- Phase 3: Split View Live Rendering ---
    function setupSplitViewLiveRendering(cardId) {
      const el = document.getElementById(\\\`card-\\\${cardId}\\\`);
      if (!el) return;
      const textarea = el.querySelector(\\\`[data-content="\\\${cardId}"]\\\`);
      const preview = el.querySelector(\\\`[data-preview="\\\${cardId}"]\\\`);
      if (!textarea || !preview) return;
      textarea.addEventListener('input', () => {
        preview.innerHTML = renderMarkdown(textarea.value);
      });
      preview.innerHTML = renderMarkdown(textarea.value);
    }

    // --- Phase 4: BASE Confidence Scoring ---
    let confidenceScores = {};
    async function computeConfidence(cardId) {
      try {
        const res = await fetch(API('/confidence'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cardId }) });
        const data = await res.json();
        confidenceScores[cardId] = data;
        updateConfidenceDisplay(cardId, data);
        return data;
      } catch { return null; }
    }
    function updateConfidenceDisplay(cardId, score) {
      const el = document.getElementById(\\\`card-\\\${cardId}\\\`);
      if (!el || !score) return;
      let badge = el.querySelector('[data-confidence]');
      if (!badge) {
        badge = document.createElement('div');
        badge.dataset.confidence = cardId;
        badge.style.cssText = 'position:absolute;top:8px;right:40px;font-size:9px;padding:2px 6px;border-radius:3px;font-weight:600;z-index:10;';
        el.appendChild(badge);
      }
      const total = score.total || 0;
      const isEitl = score.eitlUnlocked;
      const color = total >= 0.8 ? '#4aff8a' : total >= 0.5 ? '#ffaa4a' : '#ff4a4a';
      badge.style.background = isEitl ? '#1a4a2a44' : '#1a1a2e';
      badge.style.color = color;
      badge.style.border = \\\`1px solid \\\${color}44\\\`;
      badge.textContent = \\\`\\\${(total * 100).toFixed(0)}%\\\${isEitl ? ' EITL' : ''}\\\`;
    }

    // --- Phase 4: EITL Expert Review ---
    let pendingReview = null;
    function openExpertReview(cardId) {
      const card = cards.find(c => c.id === cardId);
      if (!card) return;
      pendingReview = cardId;
      document.getElementById('eitlReviewContent').textContent = card.content;
      document.getElementById('eitlReviewModal').style.display = 'flex';
    }
    function closeExpertReview() { document.getElementById('eitlReviewModal').style.display = 'none'; pendingReview = null; }
    async function submitEitlReview(action) {
      if (!pendingReview) return;
      const comment = document.getElementById('eitlReviewComment').value;
      const res = await fetch(API('/eitl/review'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cardId: pendingReview, action, comment }) });
      if (res.ok) { showToast(\\\`Output \\\${action}\\\`, 'success'); closeExpertReview(); computeConfidence(pendingReview); }
    }

    function rewriteUrls(html, baseUrl) {
      if (!baseUrl) return html;
      try {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const base = new URL(baseUrl);
        doc.querySelectorAll('a[href]').forEach(a => {
          try { a.href = new URL(a.getAttribute('href'), base).href; } catch {}
        });
        doc.querySelectorAll('img[src]').forEach(img => {
          try { img.src = new URL(img.getAttribute('src'), base).href; } catch {}
        });
        doc.querySelectorAll('link[href]').forEach(link => {
          try { link.href = new URL(link.getAttribute('href'), base).href; } catch {}
        });
        doc.querySelectorAll('script[src]').forEach(s => {
          try { s.src = new URL(s.getAttribute('src'), base).href; } catch {}
        });
        // Add base target for links
        doc.querySelectorAll('a').forEach(a => { a.target = '_blank'; a.rel = 'noopener'; });
        return '<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:system-ui,sans-serif;font-size:14px;line-height:1.6;color:#222;padding:16px;max-width:100%;overflow-x:auto;}img{max-width:100%;height:auto;border-radius:4px;}a{color:#0066cc;}pre{background:#f5f5f5;padding:12px;border-radius:6px;overflow-x:auto;}code{background:#f0f0f0;padding:1px 4px;border-radius:3px;font-size:13px;}blockquote{border-left:3px solid #ccc;padding-left:12px;color:#555;margin:8px 0;}table{border-collapse:collapse;width:100%;}th,td{border:1px solid #ddd;padding:6px 10px;text-align:left;}th{background:#f5f5f5;}</style></head><body>' + doc.body.innerHTML + '</body></html>';
      } catch { return html; }
    }

    // ── Drag & Drop ──
    let dragCounter = 0;
    document.addEventListener('dragenter', (e) => {
      e.preventDefault();
      if (e.dataTransfer.types.includes('Files')) {
        dragCounter++;
        if (dragCounter === 1) document.getElementById('dropOverlay').style.display = 'flex';
      }
    });
    document.addEventListener('dragleave', (e) => {
      e.preventDefault();
      dragCounter--;
      if (dragCounter <= 0) { dragCounter = 0; document.getElementById('dropOverlay').style.display = 'none'; }
    });
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', async (e) => {
      e.preventDefault();
      dragCounter = 0;
      document.getElementById('dropOverlay').style.display = 'none';
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        for (const file of e.dataTransfer.files) {
          await processFile(file);
        }
      }
    });

    // ── File Upload Button ──
    document.getElementById('fileUpload').addEventListener('change', async (e) => {
      const files = e.target.files;
      if (!files) return;
      for (const file of files) {
        await processFile(file);
      }
      e.target.value = '';
    });

    // ── Paste Hint ──
    setTimeout(() => {
      const hint = document.getElementById('pasteHint');
      hint.classList.add('visible');
      setTimeout(() => hint.classList.remove('visible'), 4000);
    }, 1500);

    // ── Truth-Engine Query ──
    function promptQuery() {
      const query = prompt('Enter truth-engine query:');
      if (query) runQuery(query, ['general']);
    }
    async function runQuery(queryText, domains) {
      showSpinner('Querying...');
      try {
        const res = await fetch(API('/query'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: queryText, domains: domains || ['general'], scope: 'all' }),
        });
        const data = await res.json();
        hideSpinner();
        if (data.queryId) {
          if (data.card && !cards.find(c => c.id === data.card.id)) {
            cards.push(data.card); renderCard(data.card, cardCounter * 30 + 40, cardCounter * 30 + 40); cardCounter++; updateStatus();
          }
          showToast(\\\`Query complete: \\\${data.results?.length || 0} results, \\\${Math.round((data.coverageScore || 0) * 100)}% coverage\\\`, 'success');
        } else {
          showToast('Query failed: ' + (data.error || 'Unknown error'), 'error');
        }
      } catch (e) { hideSpinner(); showToast('Query error: ' + e.message, 'error'); }
    }

    function materializeQueryResult(queryCardId, resultIndex) {
      const card = cards.find(c => c.id === queryCardId);
      if (!card || !card.results || !card.results[resultIndex]) return;
      const result = card.results[resultIndex];
      if (result.sourceType === 'card') {
        const source = cards.find(c => c.id === result.sourceId);
        if (source) {
          toggleSelect(source.id);
          showToast('Selected source card: ' + source.title, 'success');
        }
      } else {
        showToast('Result: ' + (result.snippet || '').slice(0, 80), 'success');
      }
    }

    async function rerunQuery(queryCardId) {
      const card = cards.find(c => c.id === queryCardId);
      if (!card) return;
      await updateCard(queryCardId, { content: card.queryText || card.content });
      await runQuery(card.queryText || card.content, card.domains);
    }

    // ── Truth-Audit ──
    function promptAudit() {
      const selected = [...selectedIds];
      if (selected.length === 0) {
        if (cards.length === 0) { showToast('No cards to audit', 'warning'); return; }
        if (!confirm('No cards selected. Audit ALL ' + cards.length + ' cards?')) return;
        runAudit(cards.map(c => c.id), 'compliance');
        return;
      }
      const scope = prompt('Audit scope (compliance/full):', 'compliance') || 'compliance';
      runAudit(selected, scope);
    }
    async function runAudit(cardIds, auditScope) {
      showSpinner('Auditing...');
      try {
        const res = await fetch(API('/audit'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cardIds, auditScope: auditScope || 'compliance', includeSnapshots: true }),
        });
        const data = await res.json();
        hideSpinner();
        if (data.auditId) {
          if (data.card && !cards.find(c => c.id === data.card.id)) {
            cards.push(data.card); renderCard(data.card, cardCounter * 30 + 40, cardCounter * 30 + 40); cardCounter++; updateStatus();
          }
          showToast(\\\`Audit complete: \\\${data.status} (\\\${Math.round((data.overallConfidence || 0) * 100)}%)\\\`, data.status === 'pass' ? 'success' : data.status === 'conditional' ? 'warning' : 'error');
        } else {
          showToast('Audit failed: ' + (data.error || 'Unknown error'), 'error');
        }
      } catch (e) { hideSpinner(); showToast('Audit error: ' + e.message, 'error'); }
    }

    async function reAudit(auditCardId) {
      const card = cards.find(c => c.id === auditCardId);
      if (!card) return;
      await runAudit(card.targetCardIds || [], card.auditScope);
    }

    function exportAudit(auditCardId) {
      const card = cards.find(c => c.id === auditCardId);
      if (!card) return;
      const report = {
        auditId: card.auditId,
        status: card.status,
        overallConfidence: card.overallConfidence,
        findings: card.findings,
        principleCoverage: card.principleCoverage,
        domainStack: card.domainStack,
        exportedAt: new Date().toISOString(),
      };
      const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = \\\`audit-\\\${card.auditId}.json\\\`; a.click();
      URL.revokeObjectURL(url);
      showToast('Audit exported', 'success');
    }

    // ── Tab List (Queries / Audits / EITL) ──
    function openTabList(filterType) {
      const filtered = filterType === 'eitl'
        ? cards.filter(c => c.eitlStatus)
        : cards.filter(c => c.type === filterType);
      const typeLabel = filterType === 'eitl' ? 'EITL Review' : filterType + 's';
      const icon = filterType === 'Query' ? '🔎' : filterType === 'Audit' ? '🔍' : '⚙';
      let listHtml = '';
      if (filtered.length === 0) {
        listHtml = '<div style="color:#666;font-size:12px;padding:16px;text-align:center;">No ' + typeLabel + ' found. Run a ' + (filterType === 'eitl' ? 'review' : filterType.toLowerCase()) + ' to populate this list.</div>';
      } else {
        listHtml = filtered.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).map(c => {
          const date = c.createdAt ? new Date(c.createdAt).toLocaleDateString() : '';
          const conf = c.confidence?.total ? Math.round(c.confidence.total * 100) + '%' : c.overallConfidence ? Math.round(c.overallConfidence * 100) + '%' : '';
          const statusBadge = c.eitlStatus ? '<span style="color:' + (c.eitlStatus === 'elevated' ? '#4aff8a' : c.eitlStatus === 'remanded' ? '#ff4a4a' : '#ffaa4a') + ';font-size:10px;margin-left:6px;">' + c.eitlStatus.toUpperCase() + '</span>' : '';
          const statusDot = c.status ? '<span style="color:' + (c.status === 'pass' ? '#4aff8a' : c.status === 'conditional' ? '#ffaa4a' : '#ff4a4a') + ';font-size:10px;margin-left:6px;">' + c.status.toUpperCase() + '</span>' : '';
          const badge = c.type === 'Query' ? '#4a9fff' : c.type === 'Audit' ? '#ff4a6a' : '#888';
          return '<div class="picker-item" data-card-id="' + c.id + '">'
            + '<span class="picker-badge" style="background:' + badge + '22;color:' + badge + ';">' + c.type + '</span>'
            + '<span class="picker-title">' + (c.title || 'Untitled') + statusBadge + statusDot + '</span>'
            + '<span class="picker-meta">' + (conf ? conf + ' ' : '') + date + '</span>'
            + '<button class="flip-btn" onclick="flipCardEdit(\\\\'' + c.id + '\\\\')" title="Flip to edit">Edit</button>'
            + '<button class="flip-btn" onclick="elevateFromPicker(\\\\'' + c.id + '\\\\')" title="Elevate to knowledge" style="color:#4aff8a;border-color:#2a6a3a;">Elevate</button>'
            + '</div>';
        }).join('');
      }
      const cardHtml = '<div style="padding:12px;max-height:400px;overflow-y:auto;">'
        + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">'
        + '<span style="font-size:11px;color:#888;">' + filtered.length + ' items</span>'
        + '<button onclick="syncFromKV()" class="ctrl-btn" style="font-size:10px;padding:2px 8px;">Sync</button>'
        + '</div>'
        + listHtml + '</div>';
      const card = {
        type: 'Document',
        title: icon + ' ' + typeLabel,
        content: cardHtml,
        splitView: false,
        domains: ['general'],
      };
      createCard(card);
    }

    function openCardById(cardId) {
      const el = document.querySelector('[data-id="' + cardId + '"]');
      if (el) {
        el.style.boxShadow = '0 0 0 2px #ff6b1a, 0 8 32px rgba(0,0,0,0.5)';
        setTimeout(() => el.style.boxShadow = '', 800);
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }

    function flipCardEdit(cardId) {
      const card = cards.find(c => c.id === cardId);
      if (!card) return;
      const el = document.querySelector('[data-id="' + cardId + '"]');
      if (!el) return;
      const contentArea = el.querySelector('.card-content');
      if (!contentArea) return;
      const content = card.content || '';
      const flipHtml = '<div class="card-flip-container">'
        + '<div class="card-flip-inner" id="flip-inner-' + cardId + '">'
        + '<div class="card-flip-front"></div>'
        + '<div class="card-flip-back" style="padding:12px;">'
        + '<div style="font-size:11px;color:#ff6b1a;margin-bottom:6px;">Edit & Elevate</div>'
        + '<textarea id="flip-edit-' + cardId + '" style="width:100%;min-height:150px;background:#0d0d1a;color:#e0e0e0;border:1px solid #2a2a4a;border-radius:6px;padding:8px;font-size:12px;font-family:monospace;resize:vertical;">' + content.replace(/</g, '&lt;') + '</textarea>'
        + '<div style="display:flex;gap:8px;margin-top:8px;">'
        + '<button class="elevate-btn" onclick="elevateCardContent(\\\\'' + cardId + '\\\\')">Save as Elevated Knowledge</button>'
        + '<button class="flip-btn" onclick="unflipCard(\\\\'' + cardId + '\\\\')">Cancel</button>'
        + '</div></div></div></div>';
      const saved = contentArea.innerHTML;
      contentArea.dataset.savedHtml = saved;
      contentArea.innerHTML = flipHtml;
      const inner = document.getElementById('flip-inner-' + cardId);
      if (inner) setTimeout(() => inner.classList.add('flipped'), 10);
    }

    function unflipCard(cardId) {
      const el = document.querySelector('[data-id="' + cardId + '"]');
      if (!el) return;
      const contentArea = el.querySelector('.card-content');
      if (!contentArea) return;
      const inner = document.getElementById('flip-inner-' + cardId);
      if (inner) inner.classList.remove('flipped');
      setTimeout(() => {
        if (contentArea.dataset.savedHtml) {
          contentArea.innerHTML = contentArea.dataset.savedHtml;
          delete contentArea.dataset.savedHtml;
        }
      }, 300);
    }

    async function elevateCardContent(cardId) {
      const textarea = document.getElementById('flip-edit-' + cardId);
      if (!textarea) return;
      const content = textarea.value.trim();
      if (!content) { alert('Content is empty'); return; }
      const card = cards.find(c => c.id === cardId);
      const title = card ? card.title : 'Untitled';
      try {
        const res = await fetch(API('/elevate'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: cardId, title, content, domains: card?.domains || ['general'] })
        });
        const data = await res.json();
        if (data.success) {
          showToast('Elevated to knowledge base', 'success');
          unflipCard(cardId);
        } else {
          alert('Elevate failed: ' + (data.error || 'Unknown'));
        }
      } catch (e) {
        alert('Elevate failed: ' + e.message);
      }
    }

    async function elevateFromPicker(cardId) {
      const card = cards.find(c => c.id === cardId);
      if (!card) return;
      try {
        const res = await fetch(API('/elevate'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: card.id, title: card.title, content: card.content || '', domains: card.domains || ['general'] })
        });
        const data = await res.json();
        if (data.success) {
          showToast('Elevated to knowledge base', 'success');
        } else {
          alert('Elevate failed: ' + (data.error || 'Unknown'));
        }
      } catch (e) {
        alert('Elevate failed: ' + e.message);
      }
    }
    }

    async function syncFromKV() {
      showSpinner('Syncing from orproxy KV...');
      try {
        const res = await fetch(API('/sync'), { method: 'GET' });
        const data = await res.json();
        hideSpinner();
        if (data.synced > 0) {
          showToast('Synced ' + data.synced + ' items from KV', 'success');
          if (data.cards && data.cards.length) {
            data.cards.forEach(c => {
              if (!cards.find(x => x.id === c.id)) {
                cards.push(c);
                renderCard(c, cardCounter * 30 + 40, cardCounter * 30 + 40);
                cardCounter++;
              }
            });
            updateStatus();
          }
        } else {
          showToast('No new items to sync', 'info');
        }
      } catch (e) { hideSpinner(); showToast('Sync error: ' + e.message, 'error'); }
    }

    // ── Domain Browser ──
    function promptDomain() {
      const domain = prompt('Enter domain (general/legal/educational/medical/technical):', 'general');
      if (domain && ['general','legal','educational','medical','technical'].includes(domain)) {
        createDomainBrowser(domain);
      } else if (domain) {
        showToast('Invalid domain', 'error');
      }
    }
    async function createDomainBrowser(domain) {
      try {
        const res = await fetch(\\\`/api/domains/\\\${domain}/assets\\\`);
        const data = await res.json();
        const card = {
          type: 'DomainBrowser',
          title: \\\`\\\${domain.charAt(0).toUpperCase() + domain.slice(1)} Domain\\\`,
          content: '',
          domain,
          view: 'assets',
          assets: data.assets || [],
          principleCount: 0,
          activeStack: null,
          domains: [domain],
        };
        await createCard(card);
      } catch (e) {
        showToast('Failed to load domain: ' + e.message, 'error');
      }
    }

    function switchDomainView(cardId, view) {
      const card = cards.find(c => c.id === cardId);
      if (card) {
        card.view = view;
        updateCardDOM(card);
      }
    }

    async function syncDomainPrinciples(domain) {
      showSpinner('Syncing...');
      try {
        const res = await fetch('/api/domains/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ domain }),
        });
        const data = await res.json();
        hideSpinner();
        if (data.ok) showToast(\\\`Synced \\\${data.synced} principles to \\\${domain} KV\\\`, 'success');
        else showToast('Sync failed', 'error');
      } catch (e) { hideSpinner(); showToast('Sync error: ' + e.message, 'error'); }
    }

    function uploadToDomain(cardId, domain) {
      const input = document.createElement('input');
      input.type = 'file';
      input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const formData = new FormData();
        formData.append('file', file);
        showSpinner('Uploading...');
        try {
          const res = await fetch(\\\`/api/domains/\\\${domain}/assets\\\`, {
            method: 'POST',
            body: formData,
          });
          const data = await res.json();
          hideSpinner();
          if (data.ok) {
            showToast(\\\`Uploaded \\\${file.name} to \\\${domain}\\\`, 'success');
            const card = cards.find(c => c.id === cardId);
            if (card && card.type === 'DomainBrowser') {
              const assetsRes = await fetch(\\\`/api/domains/\\\${domain}/assets\\\`);
              const assetsData = await assetsRes.json();
              card.assets = assetsData.assets || [];
              updateCardDOM(card);
            }
          }
        } catch (e) { hideSpinner(); showToast('Upload error: ' + e.message, 'error'); }
      };
      input.click();
    }

    // ── Domain Stack Panel ──
    async function loadDomains() {
      try {
        const res = await fetch('/api/domains');
        const data = await res.json();
        return data.domains || [];
      } catch { return []; }
    }

    init();
  </script>
</body>
</html>
`
var server_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      return new Response(INDEX_HTML, {
        headers: { "Content-Type": "text/html;charset=UTF-8", ...cors() }
      });
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors() });
    }
    try {
      const workspaceId = url.searchParams.get("ws") || "default";
      const id = env.WORKSPACE.idFromName(workspaceId);
      const stub = env.WORKSPACE.get(id);
      return stub.fetch(request);
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }
};
var DomainManager = class {
  constructor(kv, r2, domain) {
    this.kv = kv;
    this.r2 = r2;
    this.domain = domain;
  }
  async getPrinciples() {
    try {
      const cached = await this.kv.get(KvKeys.principles(this.domain), { type: "json" });
      if (cached) return cached;
    } catch {
    }
    return null;
  }
  async syncPrinciples(principles) {
    try {
      await this.kv.put(KvKeys.principles(this.domain), JSON.stringify(principles), {
        expirationTtl: 3600
      });
    } catch {
    }
  }
  async getStack() {
    try {
      return await this.kv.get(KvKeys.stack(this.domain), { type: "json" });
    } catch {
      return null;
    }
  }
  async setStack(stack) {
    try {
      await this.kv.put(KvKeys.stack(this.domain), JSON.stringify(stack), {
        expirationTtl: 86400
      });
    } catch {
    }
  }
  async getCachedQuery(queryId) {
    try {
      return await this.kv.get(KvKeys.queryCache(this.domain, queryId), { type: "json" });
    } catch {
      return null;
    }
  }
  async cacheQuery(queryId, result) {
    try {
      await this.kv.put(KvKeys.queryCache(this.domain, queryId), JSON.stringify(result), {
        expirationTtl: 300
      });
    } catch {
    }
  }
  async getCachedAudit(auditId) {
    try {
      return await this.kv.get(KvKeys.auditCache(this.domain, auditId), { type: "json" });
    } catch {
      return null;
    }
  }
  async cacheAudit(auditId, result) {
    try {
      await this.kv.put(KvKeys.auditCache(this.domain, auditId), JSON.stringify(result), {
        expirationTtl: 600
      });
    } catch {
    }
  }
  async getSearchCache(queryHash) {
    try {
      return await this.kv.get(KvKeys.searchCache(this.domain, queryHash), { type: "json" });
    } catch {
      return null;
    }
  }
  async cacheSearch(queryHash, results) {
    try {
      await this.kv.put(KvKeys.searchCache(this.domain, queryHash), JSON.stringify(results), {
        expirationTtl: 300
      });
    } catch {
    }
  }
  async storeImport(id, filename, bytes, contentType) {
    try {
      const key = R2Paths.import(this.domain, id, filename);
      await this.r2.put(key, bytes, { httpMetadata: { contentType } });
      return key;
    } catch {
      return null;
    }
  }
  async getImport(id, filename) {
    try {
      return await this.r2.get(R2Paths.import(this.domain, id, filename));
    } catch {
      return null;
    }
  }
  async storeSnapshot(cardId, content) {
    try {
      const ts = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
      const key = R2Paths.snapshot(this.domain, cardId, ts);
      await this.r2.put(key, content, { httpMetadata: { contentType: "application/json" } });
      return key;
    } catch {
      return null;
    }
  }
  async storeTemplate(templateId, content) {
    try {
      const key = R2Paths.template(this.domain, templateId);
      await this.r2.put(key, content, { httpMetadata: { contentType: "application/json" } });
      return key;
    } catch {
      return null;
    }
  }
  async getTemplate(templateId) {
    try {
      return await this.r2.get(R2Paths.template(this.domain, templateId));
    } catch {
      return null;
    }
  }
  async listAssets(prefix = "") {
    try {
      const fullPrefix = R2Paths.listPrefix(this.domain, prefix);
      const listed = await this.r2.list({ prefix: fullPrefix });
      return listed.objects || [];
    } catch {
      return [];
    }
  }
  async getStats() {
    try {
      const principles = await this.getPrinciples();
      const assets = await this.listAssets();
      return {
        principleCount: principles?.length || 0,
        assetCount: assets.length,
        domain: this.domain
      };
    } catch {
      return { principleCount: 0, assetCount: 0, domain: this.domain };
    }
  }
};
var Workspace = class extends DurableObject {
  cards = null;
  principles = null;
  clusters = {};
  domainStacks = {};
  llm = null;
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
  }
  async ensureLoaded() {
    if (this.cards !== null) return;
    this.cards = await this.ctx.storage.get("cards") ?? [];
    this.principles = await this.ctx.storage.get("principles") ?? [];
    this.clusters = await this.ctx.storage.get("clusters") ?? {};
    this.domainStacks = await this.ctx.storage.get("domainStacks") ?? {};
  }
  async persist() {
    await this.ctx.storage.put("cards", this.cards);
    await this.ctx.storage.put("principles", this.principles);
    await this.ctx.storage.put("clusters", this.clusters);
    await this.ctx.storage.put("domainStacks", this.domainStacks);
  }
  getLLM() {
    if (!this.llm && this.env) {
      this.llm = new LLMRouter(
        this.env.AI,
        this.env.OPENROUTER_API_KEY || "",
        this.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1"
      );
    }
    return this.llm;
  }
  getDomainManager(domain) {
    if (!this.env) return null;
    return new DomainManager(this.env.KV, this.env.R2, domain);
  }
  broadcast(message) {
    const data = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
      }
    }
  }
  broadcastPresence() {
    this.broadcast({ type: "presence", count: this.ctx.getWebSockets().length });
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 400 });
      }
      const clientId = crypto.randomUUID();
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ clientId });
      await this.ensureLoaded();
      server.send(JSON.stringify({ type: "cards", cards: this.cards }));
      server.send(JSON.stringify({ type: "principles", principles: this.principles }));
      server.send(JSON.stringify({ type: "clusters", clusters: this.clusters }));
      this.broadcastPresence();
      return new Response(null, { status: 101, webSocket: client });
    }
    await this.ensureLoaded();
    if (url.pathname === "/api/cards" && request.method === "GET") {
      return json(this.cards);
    }
    if (url.pathname === "/api/cards" && request.method === "POST") {
      const body = await request.json();
      const card = {
        id: "card_" + crypto.randomUUID(),
        type: body.type ?? "Document",
        title: body.title ?? "Untitled",
        content: body.content ?? "",
        rawHtml: body.rawHtml,
        relationships: [],
        url: body.url,
        x: body.x ?? 0,
        y: body.y ?? 0,
        width: body.width ?? null,
        height: body.height ?? null,
        dockedTo: body.dockedTo ?? null,
        dockEdge: body.dockEdge ?? null,
        domains: body.domains ?? [],
        domain: body.domain,
        view: body.view,
        assets: body.assets,
        principleCount: body.principleCount,
        activeStack: body.activeStack,
        splitView: body.splitView ?? false,
        confidence: null,
        eitlStatus: body.eitlStatus ?? null,
        eitlReview: body.eitlReview,
        source: body.source,
        createdAt: (/* @__PURE__ */ new Date()).toISOString(),
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      this.cards.push(card);
      await this.persist();
      this.broadcast({ type: "card_created", card });
      return json(card, 201);
    }
    const idMatch = url.pathname.match(/^\/api\/cards\/([^/]+)$/);
    if (idMatch && request.method === "GET") {
      const id = decodeURIComponent(idMatch[1]);
      const card = this.cards.find((c) => c.id === id);
      if (!card) return json({ error: "Card not found" }, 404);
      return json(card);
    }
    if (idMatch && request.method === "DELETE") {
      const id = decodeURIComponent(idMatch[1]);
      this.cards = this.cards.filter((c) => c.id !== id);
      await this.persist();
      this.broadcast({ type: "card_deleted", id });
      return json({ ok: true });
    }
    if (idMatch && request.method === "PATCH") {
      const id = decodeURIComponent(idMatch[1]);
      const card = this.cards.find((c) => c.id === id);
      if (!card) return json({ error: "Card not found" }, 404);
      const body = await request.json();
      if (body.title !== void 0) card.title = body.title;
      if (body.content !== void 0) card.content = body.content;
      if (body.type !== void 0) card.type = body.type;
      if (body.rawHtml !== void 0) card.rawHtml = body.rawHtml;
      if (body.x !== void 0) card.x = body.x;
      if (body.y !== void 0) card.y = body.y;
      if (body.width !== void 0) card.width = body.width;
      if (body.height !== void 0) card.height = body.height;
      if (body.dockedTo !== void 0) card.dockedTo = body.dockedTo;
      if (body.dockEdge !== void 0) card.dockEdge = body.dockEdge;
      if (body.domains !== void 0) card.domains = body.domains;
      if (body.splitView !== void 0) card.splitView = body.splitView;
      if (body.confidence !== void 0) card.confidence = body.confidence;
      if (body.eitlStatus !== void 0) card.eitlStatus = body.eitlStatus;
      card.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
      await this.persist();
      this.broadcast({ type: "card_updated", card });
      return json(card);
    }
    if (url.pathname === "/api/proxy" && request.method === "GET") {
      const targetUrl = url.searchParams.get("url");
      if (!targetUrl) return new Response("Missing url param", { status: 400 });
      try {
        new URL(targetUrl);
      } catch {
        return new Response("Invalid URL", { status: 400 });
      }
      try {
        const resp = await fetch(targetUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5"
          },
          cf: { cacheTtl: 60 }
        });
        const headers = new Headers(resp.headers);
        headers.delete("x-frame-options");
        headers.delete("content-security-policy");
        headers.delete("content-security-policy-report-only");
        headers.delete("permissions-policy");
        headers.set("access-control-allow-origin", "*");
        const contentType = headers.get("content-type") || "";
        if (contentType.includes("text/html")) {
          let html = await resp.text();
          const target = new URL(targetUrl);
          html = html.replace(/<head([^>]*)>/i, `<head$1><base href="${target.origin}/">`);
          headers.delete("content-length");
          return new Response(html, { status: resp.status, headers });
        }
        return new Response(resp.body, { status: resp.status, headers });
      } catch (err) {
        return new Response(`<html><body style="font-family:sans-serif;padding:40px;background:#1a1a2e;color:#e0e0e0"><h2>Failed to load</h2><p style="color:#ff6b1a">${err.message}</p><p style="color:#888;font-size:13px">${targetUrl}</p></body></html>`, {
          status: 502,
          headers: { "content-type": "text/html" }
        });
      }
    }
    if (url.pathname === "/api/fetch" && request.method === "POST") {
      const { url: fetchUrl } = await request.json();
      if (!fetchUrl) return json({ error: "URL required" }, 400);
      try {
        const response = await fetch(fetchUrl, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; TruthEngine/1.0)" },
          cf: { cacheTtl: 300 }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const rawHtml = await response.text();
        const parsed = parsePage(rawHtml, fetchUrl);
        const card = {
          id: "card_" + crypto.randomUUID(),
          type: "Browser",
          title: parsed.title,
          content: parsed.content,
          rawHtml,
          relationships: [],
          url: fetchUrl,
          createdAt: (/* @__PURE__ */ new Date()).toISOString(),
          updatedAt: (/* @__PURE__ */ new Date()).toISOString()
        };
        this.cards.push(card);
        await this.persist();
        this.broadcast({ type: "card_created", card });
        return json(card, 201);
      } catch (err) {
        return json({ error: `Fetch failed: ${err.message}` }, 502);
      }
    }
    if (url.pathname === "/api/import" && request.method === "POST") {
      const { filename, mimeType, data } = await request.json();
      if (!data) return json({ error: "No file data" }, 400);
      const binaryStr = atob(data);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
      let extractedText = "";
      let cardTitle = filename.replace(/\.[^.]+$/, "");
      if (mimeType === "application/pdf" || mimeType.startsWith("image/")) {
        const input = mimeType.startsWith("image/") ? { image: Array.from(bytes) } : { document: Array.from(bytes) };
        const systemPrompt = mimeType.startsWith("image/") ? "You are a document analysis engine. Describe this image in detail. Extract any visible text, describe the layout, and identify key elements. Be thorough but concise." : "You are a PDF document parser. Extract ALL text content from this PDF document. Preserve the structure: headings, paragraphs, lists, tables. Output clean, readable text with proper markdown formatting (## for headings, - for lists, etc). Preserve all information faithfully.";
        const aiResponse = await this.env.AI.run("@cf/meta/llama-3.1-8b-instruct-fast", {
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: mimeType.startsWith("image/") ? [{ type: "image", image: input.image }] : `Extract and format all text content from this document. Preserve headings, lists, and structure.` }
          ],
          max_tokens: 2048
        });
        extractedText = aiResponse.response ?? JSON.stringify(aiResponse);
      } else if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
        try {
          const uint8arr = new Uint8Array(bytes);
          const textContent = [];
          const decoder = new TextDecoder("utf-8", { fatal: false });
          const fullText = decoder.decode(uint8arr);
          const wtMatches = fullText.match(/<w:t[^>]*>([^<]+)<\/w:t>/g);
          if (wtMatches && wtMatches.length > 0) {
            for (const match of wtMatches) {
              const text = match.replace(/<[^>]+>/g, "").trim();
              if (text) textContent.push(text);
            }
            const paragraphs = fullText.match(/<w:p[^>]*>[\s\S]*?<\/w:p>/g) || [];
            let lastStyle = "";
            const structuredContent = [];
            for (const p of paragraphs) {
              const styleMatch = p.match(/<w:pStyle[^>]*w:val="([^"]+)"/);
              const style = styleMatch ? styleMatch[1] : "";
              const pText = (p.match(/<w:t[^>]*>([^<]+)<\/w:t>/g) || []).map((t) => t.replace(/<[^>]+>/g, "").trim()).filter(Boolean).join(" ");
              if (!pText) continue;
              if (style.includes("Heading1")) structuredContent.push(`
## ${pText}`);
              else if (style.includes("Heading2")) structuredContent.push(`
### ${pText}`);
              else if (style.includes("Heading3")) structuredContent.push(`
#### ${pText}`);
              else if (style.includes("List")) structuredContent.push(`- ${pText}`);
              else structuredContent.push(pText);
            }
            extractedText = structuredContent.length > 0 ? structuredContent.join("\n\n").replace(/\n{3,}/g, "\n\n").trim() : textContent.join("\n\n");
          } else {
            extractedText = fullText.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 8e3);
          }
        } catch {
          extractedText = "(Could not parse DOCX \u2014 file may be corrupted)";
        }
      } else {
        return json({ error: `Unsupported file type: ${mimeType}` }, 400);
      }
      const card = {
        id: "card_" + crypto.randomUUID(),
        type: "Document",
        title: cardTitle,
        content: extractedText,
        relationships: [],
        createdAt: (/* @__PURE__ */ new Date()).toISOString(),
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      this.cards.push(card);
      await this.persist();
      this.broadcast({ type: "card_created", card });
      return json(card, 201);
    }
    if (url.pathname === "/api/cards/manipulate" && request.method === "POST") {
      const { action, cardIds, promptText } = await request.json();
      const targets = this.cards.filter((c) => cardIds.includes(c.id));
      if (targets.length === 0) return json({ error: "No matching cards found" }, 400);
      const combined = targets.map((c) => `--- CARD [${c.title}] (${c.type}) ---
${c.content}`).join("\n\n");
      const systemPrompt = "You are the Truth Engine core card processor. You operate with strict factual integrity and logic \u2014 no emotion, no embellishment. Accurately manipulate, merge, or distill the provided card contents according to the user instruction. Preserve factual integrity above all.";
      const actionVerbs = {
        merge: "Merge the following card contents into a single coherent document, resolving contradictions with logic.",
        distill: "Distill the following card contents down to their essential truths and core principles. Remove noise.",
        combine: "Combine the following card contents into a unified synthesis that preserves all distinct information.",
        rewrite: "Rewrite the following card contents according to the instruction, preserving factual integrity."
      };
      const userPrompt = `${actionVerbs[action]}

Instruction: ${promptText || "(none)"}

Data:
${combined}`;
      const aiResponse = await this.env.AI.run("@cf/meta/llama-3.1-8b-instruct-fast", {
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        max_tokens: 1024
      });
      const resultText = aiResponse.response ?? JSON.stringify(aiResponse);
      const newCard = {
        id: "card_" + crypto.randomUUID(),
        type: "Document",
        title: `${action.toUpperCase()}: Result`,
        content: resultText,
        relationships: cardIds,
        createdAt: (/* @__PURE__ */ new Date()).toISOString(),
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      this.cards.push(newCard);
      await this.persist();
      this.broadcast({ type: "card_created", card: newCard });
      return json(newCard, 201);
    }
    if (url.pathname === "/api/principles" && request.method === "GET") {
      return json({ principles: this.principles });
    }
    if (url.pathname === "/api/principles" && request.method === "POST") {
      const body = await request.json();
      if (body.action === "approve" || !body.action && (body.domainTag === "universal" || body.domainTag === "ethical")) {
        const principle = {
          id: body.id || "princ_" + crypto.randomUUID(),
          text: body.text,
          domainTag: body.domainTag ?? "legal",
          sourceCardId: body.sourceCardId ?? null,
          sourceCitation: body.sourceCitation ?? null,
          ratificationStatus: body.ratificationStatus ?? "auto",
          ratifiedBy: body.ratifiedBy ?? "system",
          ratifiedAt: (/* @__PURE__ */ new Date()).toISOString(),
          confidenceWeight: body.confidenceWeight ?? 1
        };
        this.principles.push(principle);
        await this.persist();
        this.broadcast({ type: "principles", principles: this.principles });
        return json({ ok: true, principle });
      }
      if (body.action === "kill") {
        return json({ ok: true, message: "Principle killed" });
      }
      return json({ error: "Invalid action" }, 400);
    }
    if (url.pathname === "/api/principles/kill" && request.method === "POST") {
      const body = await request.json();
      const principle = this.principles.find((p) => p.id === body.id);
      if (!principle) return json({ ok: true });
      if (principle.ratificationStatus === "auto") {
        return json({ error: "Constitutional immutability: universal and ethical principles cannot be removed. They are structural constraints.", immutable: true }, 403);
      }
      this.principles = this.principles.filter((p) => p.id !== body.id);
      await this.persist();
      this.broadcast({ type: "principles", principles: this.principles });
      return json({ ok: true });
    }
    if (url.pathname === "/api/search" && request.method === "POST") {
      const { query } = await request.json();
      if (!query) return json({ hits: [] });
      const q = query.toLowerCase();
      const hits = this.cards.filter((c) => {
        const haystack = `${c.title} ${c.content}`.toLowerCase();
        return haystack.includes(q);
      }).slice(0, 10).map((c) => ({
        id: c.id,
        title: c.title,
        type: c.type,
        snippet: c.content.slice(0, 200)
      }));
      return json({ hits });
    }
    if (url.pathname === "/api/classify" && request.method === "POST") {
      const { cardId, content } = await request.json();
      if (!content) return json({ classification: { domain: "general", principles: [] } });
      try {
        const aiResponse = await this.env.AI.run("@cf/meta/llama-3.1-8b-instruct-fast", {
          messages: [
            { role: "system", content: "You are a domain classification engine. Given content, determine: 1) the primary domain (legal, educational, medical, technical, general), 2) propose 2-3 governing principles that should apply to this content. Return JSON with { domain, principles: [{ text, domainTag }] }." },
            { role: "user", content: `Classify this content and propose governing principles:

${content.slice(0, 2e3)}` }
          ],
          max_tokens: 512
        });
        const text = aiResponse.response ?? "";
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const classification = JSON.parse(jsonMatch[0]);
          classification.principles = (classification.principles || []).map((p) => ({
            id: "princ_proposed_" + crypto.randomUUID(),
            text: p.text,
            domainTag: p.domainTag || classification.domain || "general",
            sourceCardId: cardId,
            sourceCitation: "AI proposed from imported content",
            ratificationStatus: "expert",
            confidenceWeight: 0.5
          }));
          return json({ classification });
        }
      } catch {
      }
      return json({ classification: { domain: "general", principles: [] } });
    }
    if (url.pathname === "/api/cards/dock" && request.method === "POST") {
      const { sourceId, targetId, edge } = await request.json();
      const source = this.cards.find((c) => c.id === sourceId);
      const target = this.cards.find((c) => c.id === targetId);
      if (source && target) {
        source.dockedTo = targetId;
        source.dockEdge = edge;
        if (!this.clusters[targetId]) this.clusters[targetId] = [];
        if (!this.clusters[targetId].includes(sourceId)) this.clusters[targetId].push(sourceId);
        await this.persist();
        this.broadcast({ type: "clusters", clusters: this.clusters });
        this.broadcast({ type: "card_updated", card: source });
      }
      return json({ ok: true });
    }
    if (url.pathname === "/api/instruct" && request.method === "POST") {
      const { cardId, instruction, domains } = await request.json();
      if (!instruction) return json({ error: "No instruction provided" }, 400);
      const activePrinciples = this.principles.filter((p) => {
        if (p.domainTag === "universal" || p.domainTag === "ethical") return true;
        return domains && domains.includes(p.domainTag);
      });
      const principleContext = activePrinciples.map((p) => `[${p.domainTag}] ${p.text}`).join("\n");
      const systemPrompt = `You are the NSM Instruct engine. You generate content strictly conditioned on the following ratified principles. Every output must satisfy these principles. If a principle conflicts with the instruction, note the conflict.

Active Principles:
${principleContext || "(none \u2014 general mode)"}`;
      const aiResponse = await this.env.AI.run("@cf/meta/llama-3.1-8b-instruct-fast", {
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: instruction }
        ],
        max_tokens: 1024
      });
      const result = aiResponse.response ?? "";
      const coverage = activePrinciples.length > 0 ? Math.min(0.85, 0.5 + activePrinciples.length * 0.05) : 0.3;
      return json({ result, confidence: `BASE ${(coverage * 100).toFixed(0)}%`, coverage });
    }
    if (url.pathname === "/api/compliance" && request.method === "POST") {
      const { cardId, content } = await request.json();
      if (!content) return json({ violations: [], suggestions: [] });
      const activePrinciples = this.principles.filter((p) => p.ratificationStatus === "auto" || p.ratificationStatus === "expert");
      if (activePrinciples.length === 0) return json({ violations: [], suggestions: ["No principles ratified yet. Import content to acquire principles."] });
      const principleList = activePrinciples.map((p) => `- [${p.domainTag}/${p.ratificationStatus}] ${p.text}`).join("\n");
      try {
        const aiResponse = await this.env.AI.run("@cf/meta/llama-3.1-8b-instruct-fast", {
          messages: [
            { role: "system", content: `You are a compliance checker. Compare the user's content against these ratified principles. Return JSON: { violations: [strings], suggestions: [strings] }. Violations are hard conflicts. Suggestions are improvements.

Principles:
${principleList}` },
            { role: "user", content: content.slice(0, 3e3) }
          ],
          max_tokens: 512
        });
        const text = aiResponse.response ?? "";
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) return json(JSON.parse(jsonMatch[0]));
      } catch {
      }
      return json({ violations: [], suggestions: [] });
    }
    if (url.pathname === "/api/confidence" && request.method === "POST") {
      const { cardId } = await request.json();
      const card = this.cards.find((c) => c.id === cardId);
      if (!card) return json({ error: "Card not found" }, 404);
      const activePrinciples = this.principles.filter((p) => {
        if (p.domainTag === "universal" || p.domainTag === "ethical") return true;
        return card.domains && card.domains.includes(p.domainTag);
      });
      const totalPrinciples = activePrinciples.length;
      const coveredPrinciples = totalPrinciples > 0 ? Math.min(totalPrinciples, Math.floor(card.content.length / 200)) : 0;
      const coverage = totalPrinciples > 0 ? Math.min(0.85, coveredPrinciples / totalPrinciples) : 0.3;
      const hasCitations = (card.content.match(/\[.*?\]\(.*?\)/g) || []).length;
      const integrity = Math.min(0.9, 0.5 + hasCitations * 0.05);
      const conflicts = this.principles.filter(
        (p) => p.ratificationStatus === "auto" && card.content.toLowerCase().includes("not") && p.text.toLowerCase().includes(card.content.toLowerCase().slice(0, 50))
      ).length;
      const consistency = Math.max(0.3, 1 - conflicts * 0.2);
      const base = Math.min(0.85, coverage * 0.4 + integrity * 0.3 + consistency * 0.3);
      const eitlUnlocked = card.eitlStatus === "elevated";
      const total = eitlUnlocked ? Math.min(1, base * 1.3) : base;
      const score = { base, coverage, integrity, consistency, eitlUnlocked, total, gapLog: [] };
      if (eitlUnlocked && card.confidence) {
        score.gapLog.push({ predicted: card.confidence.base, confirmed: total, differential: total - card.confidence.base });
      }
      card.confidence = score;
      await this.persist();
      return json(score);
    }
    if (url.pathname === "/api/eitl/review" && request.method === "POST") {
      const { cardId, action, comment } = await request.json();
      const card = this.cards.find((c) => c.id === cardId);
      if (!card) return json({ error: "Card not found" }, 404);
      card.eitlStatus = action;
      card.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
      if (action === "elevate") {
        if (!card.gapLog) card.gapLog = [];
        card.gapLog.push({
          timestamp: (/* @__PURE__ */ new Date()).toISOString(),
          baseConfidence: card.confidence?.base || 0,
          action,
          comment: comment || ""
        });
      }
      await this.persist();
      this.broadcast({ type: "card_updated", card });
      return json({ ok: true, eitlStatus: action });
    }
    if (url.pathname === "/api/query" && request.method === "POST") {
      await this.ensureLoaded();
      const body = await request.json();
      const { query, domains = ["general"], scope = "all", maxResults = 10 } = body;
      if (!query) return json({ error: "query is required" }, 400);
      const stack = createDomainStack(domains[0] || "general", domains.slice(1));
      const activeDomains = getActiveDomains(stack);
      let allPrinciples = [];
      for (const d of activeDomains) {
        const dm = this.getDomainManager(d);
        if (dm) {
          const cached = await dm.getPrinciples();
          if (cached) {
            allPrinciples.push(...cached.filter((p) => !allPrinciples.find((ep) => ep.id === p.id)));
          }
        }
      }
      if (allPrinciples.length === 0) {
        allPrinciples = this.principles.filter(
          (p) => p.domainTag === "universal" || p.domainTag === "ethical" || activeDomains.includes(p.domainTag)
        );
      }
      let searchCards = this.cards;
      if (scope === "principles") searchCards = [];
      const queryId = "qry_" + crypto.randomUUID();
      const llm = this.getLLM();
      let results = [];
      if (llm) {
        try {
          results = await llm.deepQuery(query, allPrinciples, searchCards);
        } catch {
        }
      }
      if (results.length === 0) {
        const q = query.toLowerCase();
        results = this.cards.filter(
          (c) => c.title && c.title.toLowerCase().includes(q) || c.content && c.content.toLowerCase().includes(q)
        ).slice(0, maxResults).map((c) => ({
          sourceType: "card",
          sourceId: c.id,
          domain: c.domains?.[0] || "general",
          relevance: 0.5,
          snippet: (c.content || "").slice(0, 200),
          confidence: c.confidence || { base: 0, total: 0 }
        }));
      }
      const coverageScore = allPrinciples.length > 0 ? results.filter((r) => r.sourceType === "principle").length / allPrinciples.length : 0;
      const queryResult = {
        queryId,
        results: results.slice(0, maxResults),
        domainStack: stack,
        principlesApplied: allPrinciples.map((p) => p.id),
        coverageScore: Math.min(coverageScore, 1),
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      };
      const qDm = this.getDomainManager(stack.primary);
      if (qDm) await qDm.cacheQuery(queryId, queryResult);
      const queryCard = {
        id: "card_" + crypto.randomUUID(),
        type: "Query",
        title: query.slice(0, 60),
        content: query,
        queryText: query,
        queryId,
        domainStack: stack,
        results: queryResult.results,
        coverageScore: queryResult.coverageScore,
        principlesApplied: queryResult.principlesApplied,
        domains: activeDomains,
        x: 100 + Math.random() * 200,
        y: 100 + Math.random() * 200,
        width: 480,
        height: null,
        dockedTo: null,
        dockEdge: null,
        splitView: false,
        confidence: null,
        eitlStatus: null,
        relationships: [],
        createdAt: (/* @__PURE__ */ new Date()).toISOString(),
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      this.cards.push(queryCard);
      await this.persist();
      this.broadcast({ type: "card_created", card: queryCard });
      return json({ ...queryResult, card: queryCard });
    }
    if (url.pathname === "/api/audit" && request.method === "POST") {
      await this.ensureLoaded();
      const body = await request.json();
      const { cardIds = [], auditScope = "compliance", domains, includeSnapshots = true } = body;
      if (cardIds.length === 0) return json({ error: "cardIds is required" }, 400);
      const targetCards = this.cards.filter((c) => cardIds.includes(c.id));
      if (targetCards.length === 0) return json({ error: "No matching cards found" }, 404);
      const auditDomains = domains || [...new Set(targetCards.flatMap((c) => c.domains || ["general"]))];
      const stack = createDomainStack(auditDomains[0] || "general", auditDomains.slice(1));
      const activeDomains = getActiveDomains(stack);
      let allPrinciples = [];
      for (const d of activeDomains) {
        const dm = this.getDomainManager(d);
        if (dm) {
          const cached = await dm.getPrinciples();
          if (cached) allPrinciples.push(...cached.filter((p) => !allPrinciples.find((ep) => ep.id === p.id)));
        }
      }
      if (allPrinciples.length === 0) {
        allPrinciples = this.principles.filter(
          (p) => p.domainTag === "universal" || p.domainTag === "ethical" || activeDomains.includes(p.domainTag)
        );
      }
      const auditId = "aud_" + crypto.randomUUID();
      let auditResult;
      const llm = this.getLLM();
      if (llm && auditScope === "full") {
        try {
          auditResult = await llm.deepAudit(targetCards, allPrinciples, auditScope);
        } catch {
        }
      }
      if (!auditResult) {
        auditResult = { findings: [], principleCoverage: { total: allPrinciples.length, satisfied: 0, violated: 0, unaddressed: allPrinciples.length }, overallConfidence: 0, status: "fail" };
        for (const card of targetCards) {
          for (const principle of allPrinciples) {
            const content = (card.content || "").toLowerCase();
            const pText = principle.text.toLowerCase();
            const words = pText.split(/\s+/).filter((w) => w.length > 3);
            const matched = words.filter((w) => content.includes(w));
            const ratio = words.length > 0 ? matched.length / words.length : 0;
            if (ratio > 0.6) {
              auditResult.principleCoverage.satisfied++;
              auditResult.findings.push({
                cardId: card.id,
                severity: "info",
                principleId: principle.id,
                principleText: principle.text,
                description: `Content aligns with principle`,
                suggestion: "",
                confidence: ratio
              });
            } else if (ratio > 0.2) {
              auditResult.principleCoverage.violated++;
              auditResult.findings.push({
                cardId: card.id,
                severity: "warning",
                principleId: principle.id,
                principleText: principle.text,
                description: `Partial alignment with principle \u2014 may need strengthening`,
                suggestion: `Consider expanding content to better address: ${principle.text}`,
                confidence: ratio
              });
            } else {
              auditResult.principleCoverage.unaddressed++;
              auditResult.findings.push({
                cardId: card.id,
                severity: "info",
                principleId: principle.id,
                principleText: principle.text,
                description: `Content does not address this principle`,
                suggestion: `Content may need sections addressing: ${principle.text}`,
                confidence: ratio
              });
            }
          }
        }
        const total = auditResult.principleCoverage.total || 1;
        auditResult.overallConfidence = auditResult.principleCoverage.satisfied / total;
        auditResult.status = auditResult.overallConfidence > 0.7 ? "pass" : auditResult.overallConfidence > 0.4 ? "conditional" : "fail";
      }
      const snapshots = [];
      if (includeSnapshots) {
        for (const card of targetCards) {
          const dm = this.getDomainManager(stack.primary);
          if (dm) {
            const key = await dm.storeSnapshot(card.id, JSON.stringify(card));
            if (key) snapshots.push(key);
          }
        }
      }
      const auditRecord = {
        auditId,
        status: auditResult.status || "fail",
        overallConfidence: auditResult.overallConfidence || 0,
        findings: auditResult.findings || [],
        principleCoverage: auditResult.principleCoverage || { total: 0, satisfied: 0, violated: 0, unaddressed: 0 },
        domainStack: stack,
        snapshots,
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      };
      const aDm = this.getDomainManager(stack.primary);
      if (aDm) await aDm.cacheAudit(auditId, auditRecord);
      const auditCard = {
        id: "card_" + crypto.randomUUID(),
        type: "Audit",
        title: `Audit: ${targetCards.map((c) => c.title).join(", ").slice(0, 50)}`,
        content: JSON.stringify(auditRecord, null, 2),
        auditId,
        auditScope,
        targetCardIds: cardIds,
        status: auditRecord.status,
        overallConfidence: auditRecord.overallConfidence,
        findings: auditRecord.findings,
        principleCoverage: auditRecord.principleCoverage,
        domainStack: stack,
        snapshots,
        domains: activeDomains,
        x: 100 + Math.random() * 200,
        y: 100 + Math.random() * 200,
        width: 520,
        height: null,
        dockedTo: null,
        dockEdge: null,
        splitView: false,
        confidence: null,
        eitlStatus: null,
        relationships: cardIds,
        createdAt: (/* @__PURE__ */ new Date()).toISOString(),
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      this.cards.push(auditCard);
      await this.persist();
      this.broadcast({ type: "card_created", card: auditCard });
      return json({ ...auditRecord, card: auditCard });
    }
    if (url.pathname === "/api/domains" && request.method === "GET") {
      await this.ensureLoaded();
      const domainStats = [];
      for (const [key, meta] of Object.entries(DOMAINS)) {
        const dm = this.getDomainManager(key);
        const stats = dm ? await dm.getStats() : { principleCount: 0, assetCount: 0 };
        const stack = this.domainStacks[key] || null;
        domainStats.push({
          id: key,
          ...meta,
          principleCount: stats.principleCount + this.principles.filter((p) => p.domainTag === key).length,
          assetCount: stats.assetCount,
          activeStack: stack
        });
      }
      return json({ domains: domainStats });
    }
    const domainAssetsMatch = url.pathname.match(/^\/api\/domains\/([^/]+)\/assets$/);
    if (domainAssetsMatch && request.method === "GET") {
      const domain = domainAssetsMatch[1];
      if (!DOMAINS[domain]) return json({ error: "Invalid domain" }, 400);
      const dm = this.getDomainManager(domain);
      if (!dm) return json({ error: "KV/R2 not configured" }, 500);
      const assets = await dm.listAssets();
      return json({ domain, assets: assets.map((a) => ({ key: a.key, size: a.size, uploaded: a.uploaded })) });
    }
    if (domainAssetsMatch && request.method === "POST") {
      const domain = domainAssetsMatch[1];
      if (!DOMAINS[domain]) return json({ error: "Invalid domain" }, 400);
      const dm = this.getDomainManager(domain);
      if (!dm) return json({ error: "KV/R2 not configured" }, 500);
      const formData = await request.formData();
      const file = formData.get("file");
      if (!file) return json({ error: "No file provided" }, 400);
      const bytes = await file.arrayBuffer();
      const key = await dm.storeImport(crypto.randomUUID(), file.name, bytes, file.type || "application/octet-stream");
      return json({ ok: true, key, filename: file.name });
    }
    const domainTemplateMatch = url.pathname.match(/^\/api\/domains\/([^/]+)\/templates\/([^/]+)$/);
    if (domainTemplateMatch && request.method === "GET") {
      const domain = domainTemplateMatch[1];
      const templateId = domainTemplateMatch[2];
      if (!DOMAINS[domain]) return json({ error: "Invalid domain" }, 400);
      const dm = this.getDomainManager(domain);
      if (!dm) return json({ error: "KV/R2 not configured" }, 500);
      const template = await dm.getTemplate(templateId);
      if (!template) return json({ error: "Template not found" }, 404);
      return json({ domain, templateId, content: await template.text() });
    }
    if (url.pathname === "/api/domains/stack" && request.method === "POST") {
      await this.ensureLoaded();
      const { primary = "general", secondary = [], sourceCardId } = await request.json();
      const stack = createDomainStack(primary, secondary, sourceCardId);
      this.domainStacks[stack.primary] = stack;
      await this.persist();
      const dm = this.getDomainManager(stack.primary);
      if (dm) await dm.setStack(stack);
      return json({ stack });
    }
    if (url.pathname === "/api/domains/stack" && request.method === "GET") {
      await this.ensureLoaded();
      const domain = url.searchParams.get("domain") || "general";
      const stack = this.domainStacks[domain] || createDomainStack(domain);
      return json({ stack });
    }
    if (url.pathname === "/api/domains/sync" && request.method === "POST") {
      await this.ensureLoaded();
      const { domain } = await request.json();
      if (!domain || !DOMAINS[domain]) return json({ error: "Valid domain required" }, 400);
      const dm = this.getDomainManager(domain);
      if (!dm) return json({ error: "KV not configured" }, 500);
      const domainPrinciples = this.principles.filter(
        (p) => p.domainTag === "universal" || p.domainTag === "ethical" || p.domainTag === domain
      );
      await dm.syncPrinciples(domainPrinciples);
      return json({ ok: true, synced: domainPrinciples.length, domain });
    }
    // ── EITL Sync: pull audits from AUDITS_KV into DO cards ──
    if (url.pathname === "/api/sync" && request.method === "GET") {
      await this.ensureLoaded();
      let synced = 0;
      const newCards = [];
      // Pull audits from AUDITS_KV
      if (this.env.AUDITS_KV) {
        try {
          const auditList = await this.env.AUDITS_KV.list({ prefix: "audit:" });
          for (const key of auditList.keys) {
            const existing = this.cards.find(c => c.auditId === key.name.replace("audit:", ""));
            if (!existing) {
              const data = await this.env.AUDITS_KV.get(key.name, { type: "json" });
              if (data) {
                const card = {
                  id: "card_" + crypto.randomUUID(),
                  type: "Audit",
                  title: (data.type || "audit") + " — " + (data.id || key.name),
                  content: data.lastResponse || data.rawText || JSON.stringify(data.messages || []),
                  auditId: data.id || key.name.replace("audit:", ""),
                  auditScope: data.type || "docket",
                  status: "completed",
                  overallConfidence: data.overallConfidence || 0.5,
                  findings: [],
                  principleCoverage: null,
                  domains: ["legal"],
                  confidence: null,
                  eitlStatus: null,
                  relationships: [],
                  x: 100 + Math.random() * 200,
                  y: 100 + Math.random() * 200,
                  width: 520,
                  height: null,
                  dockedTo: null,
                  dockEdge: null,
                  splitView: false,
                  createdAt: data.createdAt || (/* @__PURE__ */ new Date()).toISOString(),
                  updatedAt: data.updatedAt || data.createdAt || (/* @__PURE__ */ new Date()).toISOString()
                };
                this.cards.push(card);
                newCards.push(card);
                synced++;
              }
            }
          }
        } catch (e) {
          console.error("Audit sync error:", e.message);
        }
      }
      // Pull context memories from CONTEXT_KV
      if (this.env.CONTEXT_KV) {
        try {
          const ctxList = await this.env.CONTEXT_KV.list({ prefix: "ctx:" });
          for (const key of ctxList.keys) {
            if (!key.name.endsWith(":data")) continue;
            const contextId = key.name.replace("ctx:", "").replace(":data", "");
            const existing = this.cards.find(c => c.source === "context:" + contextId);
            if (!existing) {
              const data = await this.env.CONTEXT_KV.get(key.name, { type: "json" });
              if (data && Array.isArray(data) && data.length > 0) {
                const content = data.map(m => m.content || "").join("\n\n").slice(0, 4000);
                const card = {
                  id: "card_" + crypto.randomUUID(),
                  type: "Query",
                  title: "Context: " + contextId,
                  content,
                  queryText: content.slice(0, 200),
                  source: "context:" + contextId,
                  domains: ["general"],
                  confidence: null,
                  eitlStatus: null,
                  relationships: [],
                  x: 100 + Math.random() * 200,
                  y: 100 + Math.random() * 200,
                  width: 480,
                  height: null,
                  dockedTo: null,
                  dockEdge: null,
                  splitView: false,
                  createdAt: (/* @__PURE__ */ new Date()).toISOString(),
                  updatedAt: (/* @__PURE__ */ new Date()).toISOString()
                };
                this.cards.push(card);
                newCards.push(card);
                synced++;
              }
            }
          }
        } catch (e) {
          console.error("Context sync error:", e.message);
        }
      }
      if (synced > 0) {
        await this.persist();
        for (const card of newCards) {
          this.broadcast({ type: "card_created", card });
        }
      }
      return json({ synced, cards: newCards });
    }
    // ── EITL Elevate: revise content, bump confidence, write to master truths ──
    if (url.pathname === "/api/elevate" && request.method === "POST") {
      await this.ensureLoaded();
      const { cardId, revisedContent, confidence, title } = await request.json();
      const card = this.cards.find((c) => c.id === cardId);
      if (!card) return json({ error: "Card not found" }, 404);
      // Update card
      if (revisedContent !== void 0) card.content = revisedContent;
      if (title !== void 0) card.title = title;
      if (confidence !== void 0) card.confidence = { base: confidence, total: confidence, coverage: confidence, integrity: confidence, consistency: confidence, eitlUnlocked: true, gapLog: [] };
      card.eitlStatus = "elevated";
      card.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
      if (!card.gapLog) card.gapLog = [];
      card.gapLog.push({
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        action: "elevate",
        baseConfidence: card.confidence?.base || 0,
        newConfidence: confidence || 0,
        comment: "Elevated to master truth"
      });
      // Write to ORP_KV master truths
      if (this.env.ORP_KV) {
        try {
          const raw = await this.env.ORP_KV.get("master:all", { type: "json" });
          const knowledge = raw || { entries: [] };
          const entry = {
            id: "k_" + Date.now(),
            title: card.title || "Elevated truth",
            content: card.content,
            embedding: [],
            source: "eitl_elevate",
            auditId: card.auditId || null,
            createdAt: (/* @__PURE__ */ new Date()).toISOString(),
            updatedAt: (/* @__PURE__ */ new Date()).toISOString()
          };
          knowledge.entries.push(entry);
          await this.env.ORP_KV.put("master:all", JSON.stringify(knowledge));
        } catch (e) {
          console.error("ORP_KV write failed:", e.message);
        }
      }
      await this.persist();
      this.broadcast({ type: "card_updated", card });
      return json({ ok: true, card, elevated: true });
    }
    return json({ error: "Not found" }, 404);
  }
  async webSocketMessage(ws, message) {
    const attachment = ws.deserializeAttachment();
    const clientId = attachment?.clientId ?? "unknown";
    try {
      const data = JSON.parse(message);
      switch (data.type) {
        case "ping":
          ws.send(JSON.stringify({ type: "pong" }));
          break;
        case "cursor":
          this.broadcast({ type: "cursor", x: data.x, y: data.y, cardId: data.cardId, clientId });
          break;
        case "card:dock":
          if (data.sourceId && data.targetId && data.edge) {
            const source = this.cards.find((c) => c.id === data.sourceId);
            if (source) {
              source.dockedTo = data.targetId;
              source.dockEdge = data.edge;
              if (!this.clusters[data.targetId]) this.clusters[data.targetId] = [];
              if (!this.clusters[data.targetId].includes(data.sourceId)) this.clusters[data.targetId].push(data.sourceId);
              await this.persist();
              this.broadcast({ type: "clusters", clusters: this.clusters });
              this.broadcast({ type: "card_updated", card: source });
            }
          }
          break;
      }
    } catch {
    }
  }
  async webSocketClose(ws, code, reason, wasClean) {
    ws.close(code, reason);
    this.broadcastPresence();
  }
  async webSocketError(ws, error) {
    console.error("WebSocket error:", error);
  }
};
async function parsePage(html, sourceUrl) {
  let title = sourceUrl;
  let content = "";
  const base = new URL(sourceUrl);
  const rewriter = new HTMLRewriter().on("title", {
    text(t) {
      title += t.text;
      if (t.lastInTextNode) title = title.trim();
    }
  }).on("h1, h2, h3", {
    element(el) {
      content += `

## `;
    },
    text(t) {
      content += t.text;
      if (t.lastInTextNode) content += "\n";
    }
  }).on("p, li, blockquote", {
    element() {
      content += "\n";
    },
    text(t) {
      content += t.text;
      if (t.lastInTextNode) content += "\n";
    }
  }).on("a", {
    element(el) {
      let href = el.getAttribute("href");
      if (href) {
        try {
          href = new URL(href, base).href;
        } catch {
        }
        content += `[${href}] `;
      }
    }
  }).on("img", {
    element(el) {
      let src = el.getAttribute("src");
      if (src) {
        try {
          src = new URL(src, base).href;
        } catch {
        }
        content += `![image](${src}) `;
      }
    }
  }).on("script, style, nav, footer, header, aside", {
    element(el) {
      el.remove();
    }
  });
  const response = new Response(html);
  await rewriter.transform(response).text();
  content = content.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+/g, " ").trim().slice(0, 8e3);
  if (!title || title === sourceUrl) title = sourceUrl.replace(/^https?:\/\//, "").split("/")[0];
  return { title, content };
}
function cors() {
  const h = new Headers();
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type");
  return h;
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...cors() }
  });
}
export {
  Workspace,
  server_default as default
};
