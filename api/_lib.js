/* ============================================================
   IzdeMe — shared backend logic for Vercel serverless functions
   Mirrors server.js (used for local `node server.js` dev).
   Env vars are configured in the Vercel dashboard (Project →
   Settings → Environment Variables); sensible defaults below.
   ============================================================ */
"use strict";

const HH_USER_AGENT = process.env.HH_USER_AGENT || "IzdeMe-JobAgent/1.0 (murat.askarov@nu.edu.kz)";
const HH_AREA = process.env.HH_AREA || "40";   // 40 = Kazakhstan (hh.kz)
const HH_HOST = process.env.HH_HOST || "hh.kz";
const HH_TOKEN = process.env.HH_ACCESS_TOKEN || "";
// LLM providers — all OpenAI-compatible endpoints. The frontend can switch between
// any that have a key configured. Both have free tiers (no credit card).
const PROVIDERS = {
  groq: {
    label: "Groq",
    baseUrl: (process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/+$/, ""),
    apiKey: process.env.GROQ_API_KEY || process.env.LLM_API_KEY || "",   // LLM_API_KEY = legacy Groq key
    model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
  },
  gemini: {
    label: "Gemini",
    baseUrl: (process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai").replace(/\/+$/, ""),
    apiKey: process.env.GEMINI_API_KEY || "",
    model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
    // 2.5 models "think" by default and can exhaust the token budget mid-JSON; turn it off
    extra: { reasoning_effort: "none" },
  },
};
// Optionally LOCK to one provider: forces every call to it and hides the UI switch.
const LOCK = (PROVIDERS[process.env.LLM_LOCK] && PROVIDERS[process.env.LLM_LOCK].apiKey) ? process.env.LLM_LOCK : "";
const DEFAULT_PROVIDER = LOCK || ((PROVIDERS[process.env.LLM_PROVIDER] && PROVIDERS[process.env.LLM_PROVIDER].apiKey) ? process.env.LLM_PROVIDER
  : PROVIDERS.groq.apiKey ? "groq" : PROVIDERS.gemini.apiKey ? "gemini" : "groq");

function resolve(id) { return LOCK || ((PROVIDERS[id] && PROVIDERS[id].apiKey) ? id : DEFAULT_PROVIDER); }
function providerOf(id) {
  const p = PROVIDERS[resolve(id)];
  return { id: resolve(id), label: p.label, model: p.model, enabled: !!p.apiKey };
}
function providerStatus() {
  return {
    default: DEFAULT_PROVIDER,
    locked: LOCK || null,
    providers: Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label, model: p.model, enabled: !!p.apiKey })),
  };
}

const clean = s => (s || "").replace(/<\/?highlighttext>/g, "");

/* read a JSON body whether Vercel pre-parsed it or handed us a raw string */
function body(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body) { try { return JSON.parse(req.body); } catch { return {}; } }
  return {};
}

/* ---------- hh.kz vacancy proxy ---------- */
async function fetchVacancies(query, { page = 0, perPage = 30 } = {}) {
  const url = new URL("https://api.hh.ru/vacancies");
  url.searchParams.set("text", query);
  url.searchParams.set("area", HH_AREA);
  url.searchParams.set("host", HH_HOST);
  url.searchParams.set("order_by", "relevance");
  url.searchParams.set("per_page", String(perPage));
  url.searchParams.set("page", String(page));

  const headers = { "User-Agent": HH_USER_AGENT, "Accept": "application/json" };
  if (HH_TOKEN) headers["Authorization"] = "Bearer " + HH_TOKEN;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 7000);
  const r = await fetch(url, { headers, signal: ctrl.signal }).finally(() => clearTimeout(t));

  if (!r.ok) {
    const err = new Error("hh responded " + r.status);
    err.status = r.status;
    err.ddosGuard = /ddos-guard/i.test(r.headers.get("server") || "");
    throw err;
  }
  const data = await r.json();
  const items = (data.items || []).map(v => ({
    id: v.id,
    name: v.name,
    company: v.employer?.name || "Company",
    area: v.area?.name || "—",
    salary: v.salary ? [v.salary.from, v.salary.to, v.salary.currency] : null,
    requirements: clean(v.snippet?.requirement),
    responsibilities: clean(v.snippet?.responsibility),
    description: clean(`${v.snippet?.requirement || ""} ${v.snippet?.responsibility || ""}`).trim(),
    url: v.alternate_url,
    schedule: v.schedule?.name || null,
    experience: v.experience?.name || null,
  }));
  return { found: data.found, items };
}

/* ---------- LLM helpers (OpenAI-compatible: Groq / OpenAI / Gemini / …) ---------- */
async function callLLM(messages, { json = true, maxTokens = 700, temperature = 0.3, provider } = {}) {
  const p = PROVIDERS[resolve(provider)];
  if (!p || !p.apiKey) { const e = new Error(`${(p && p.label) || id} API key not set`); e.code = "NO_KEY"; throw e; }
  const reqBody = { model: p.model, messages, temperature, max_tokens: maxTokens };
  if (json) reqBody.response_format = { type: "json_object" };
  if (p.extra) Object.assign(reqBody, p.extra);   // provider-specific tuning (e.g. Gemini thinking off)
  const headers = { "Content-Type": "application/json", "Authorization": "Bearer " + p.apiKey };
  // retry transient 503 (free-tier "high demand") and network blips
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 400 * attempt));
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    let r;
    try {
      r = await fetch(p.baseUrl + "/chat/completions", { method: "POST", headers, body: JSON.stringify(reqBody), signal: ctrl.signal });
    } catch (e) { clearTimeout(t); lastErr = e; continue; }      // network/abort → retry
    clearTimeout(t);
    if (r.status === 503) { lastErr = new Error(`${p.label} 503 (busy)`); continue; }
    if (!r.ok) { const txt = await r.text(); const e = new Error(`${p.label} ${r.status}: ${txt.slice(0, 240)}`); e.status = r.status; throw e; }
    const data = await r.json();
    return data.choices?.[0]?.message?.content || "{}";
  }
  throw (lastErr instanceof Error ? lastErr : new Error(`${p.label} unavailable`));
}

async function aiParseResume(text, provider) {
  const content = await callLLM([
    { role: "system", content:
      "You are an expert resume parser. Extract ONLY information explicitly present in the resume. " +
      "Never invent, assume, or infer skills, employers, or dates that are not stated. Reply with strict JSON only." },
    { role: "user", content:
`Parse the resume below into JSON with EXACTLY these keys:
- "name": candidate full name, or "".
- "title": current/most-recent professional title, or "".
- "skills": array of hard/technical skills, lowercase, normalized to canonical names (e.g. "javascript" not "JS", "postgresql" not "Postgres", "kubernetes" not "k8s"). Deduplicate.
- "soft": array of soft skills explicitly mentioned, lowercase. Do not repeat anything from "skills".
- "experience": array of objects { "title": string, "company": string, "start": "YYYY" or "YYYY-MM" or "", "end": "YYYY"/"YYYY-MM"/"present"/"", "highlights": array of short bullet strings }. [] if none.
- "projects": array of short one-line project descriptions. [] if none.
- "education": array of objects { "degree": string, "institution": string, "year": string }. [] if none.
- "domains": array of industry/domain keywords, lowercase (e.g. "fintech","healthcare","ecology").
- "languages": array of spoken/written human languages.
- "certifications": array of certification names.
- "years": integer — TOTAL years of professional experience, computed by summing the experience date ranges (treat "present" as the current year). 0 if none.
- "seniority": one of "intern","junior","middle","senior","lead", inferred from titles/years, or "" if unclear.

Rules: valid JSON only, no commentary or markdown. Use [] for empty arrays and "" for empty strings. Prefer precision over recall — if unsure whether something is a skill, omit it.

Resume text:
"""
${String(text).slice(0, 9000)}
"""` },
  ], { maxTokens: 1200, temperature: 0, provider });
  return JSON.parse(content);
}

async function aiTailor(resume, vacancy, provider) {
  const content = await callLLM([
    { role: "system", content: "You are a precise career assistant. Reply with JSON only. Never invent skills the candidate does not have." },
    { role: "user", content:
      "Given a candidate resume profile and a job vacancy, return JSON with keys: " +
      "matches (array of skills the candidate already has that the job needs), " +
      "gaps (array of important skills the job needs but the candidate lacks), " +
      "suggestions (array of 2-3 concrete, specific actions to improve fit), " +
      "summary (a 2-3 sentence tailored resume summary for THIS role, weaving in the candidate's real skills and the job's keywords).\n\n" +
      "Resume: " + JSON.stringify(resume).slice(0, 2500) + "\n\nVacancy: " +
      JSON.stringify({ name: vacancy.name, company: vacancy.company, requirements: vacancy.requirements, responsibilities: vacancy.responsibilities }).slice(0, 2500) },
  ], { maxTokens: 500, provider });
  return JSON.parse(content);
}

module.exports = {
  HH_USER_AGENT, HH_AREA, HH_HOST, HH_TOKEN,
  PROVIDERS, DEFAULT_PROVIDER, providerOf, providerStatus,
  body, fetchVacancies, callLLM, aiParseResume, aiTailor,
};
