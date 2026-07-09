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
// hh.kz city → area id (verified from api.hh.ru/areas/40)
const KZ_AREAS = {
  kazakhstan:40, almaty:160, "alma-ata":160, astana:159, "nur-sultan":159, nursultan:159,
  shymkent:205, chimkent:205, karaganda:177, karagandy:177, aktobe:154, atyrau:153,
  pavlodar:181, kostanay:172, kostanai:172, kyzylorda:174, taraz:187, semey:185, semipalatinsk:185,
  aktau:152, kokshetau:176, taldykorgan:188, temirtau:190, "ust-kamenogorsk":194, oskemen:194, petropavlovsk:180,
};
const cityToArea = c => KZ_AREAS[String(c || "").toLowerCase().trim()] || HH_AREA;
const HH_CLIENT_ID = process.env.HH_CLIENT_ID || "";
const HH_CLIENT_SECRET = process.env.HH_CLIENT_SECRET || "";
// App access token: a static HH_ACCESS_TOKEN wins; otherwise obtained via
// client_credentials and cached (the token endpoint is DDoS-guarded, so hit it rarely).
let _hhTok = process.env.HH_ACCESS_TOKEN || "";
let _hhTokExp = _hhTok ? Infinity : 0;
async function hhToken(force) {
  const now = Date.now();
  if (!force && _hhTok && now < _hhTokExp) return _hhTok;
  if (!HH_CLIENT_ID || !HH_CLIENT_SECRET) return _hhTok;      // nothing to refresh with
  try {
    const r = await fetch("https://api.hh.ru/token", {
      method: "POST",
      headers: { "User-Agent": HH_USER_AGENT, "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=client_credentials&client_id=${encodeURIComponent(HH_CLIENT_ID)}&client_secret=${encodeURIComponent(HH_CLIENT_SECRET)}`,
    });
    if (!r.ok) return _hhTok;                                 // keep any existing token
    const j = await r.json();
    if (j.access_token) { _hhTok = j.access_token; _hhTokExp = now + ((j.expires_in || 1209600) * 1000) - 60000; }
    return _hhTok;
  } catch { return _hhTok; }
}
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
async function fetchVacancies(query, opts = {}) {
  const { page = 0, perPage = 30, area, schedule, experience, employment, salary, onlyWithSalary, orderBy } = opts;
  const url = new URL("https://api.hh.ru/vacancies");
  url.searchParams.set("text", query);
  url.searchParams.set("area", area || HH_AREA);
  url.searchParams.set("host", HH_HOST);
  url.searchParams.set("order_by", orderBy || "relevance");         // relevance|salary_desc|salary_asc|publication_time
  url.searchParams.set("per_page", String(perPage));
  url.searchParams.set("page", String(page));
  if (schedule) url.searchParams.set("schedule", schedule);         // e.g. "remote"
  if (experience) url.searchParams.set("experience", experience);   // noExperience|between1And3|between3And6|moreThan6
  if (employment) url.searchParams.set("employment", employment);   // full|part|project
  if (salary) url.searchParams.set("salary", String(salary));       // min monthly salary
  if (salary || onlyWithSalary) url.searchParams.set("only_with_salary", "true");

  const doFetch = async (tok) => {
    const headers = { "User-Agent": HH_USER_AGENT, "Accept": "application/json" };
    if (tok) headers["Authorization"] = "Bearer " + tok;      // authenticated → passes DDoS-Guard
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try { return await fetch(url, { headers, signal: ctrl.signal }); } finally { clearTimeout(t); }
  };

  let tok = await hhToken();
  let r = await doFetch(tok);
  if ((r.status === 401 || r.status === 403) && HH_CLIENT_ID && HH_CLIENT_SECRET) {
    tok = await hhToken(true);                                // token stale/missing → refresh once
    if (tok) r = await doFetch(tok);
  }

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

/* ---------- LLM-optimized vacancy search ---------- */

// 1) prompt → structured hh.kz search filters (keywords, city, remote, experience, salary…)
async function aiSearchPlan(prompt, provider) {
  const content = await callLLM([
    { role: "system", content: "You are a search-query engineer for HeadHunter (hh.kz). You turn a job seeker's natural-language request — conversational, multi-constraint, English or Russian — into precise hh.kz search filters. Reply with strict JSON only." },
    { role: "user", content:
`Convert the request into hh.kz search filters. Output JSON with EXACTLY these keys:

- "text": the hh.kz full-text query. Use hh query language and include ONLY the role + must-have skills (NEVER the city, remote, salary or experience — those are separate fields below):
    • operators AND / OR / NOT must be UPPERCASE.
    • group interchangeable roles/skills in parentheses with OR: (python OR django) backend
    • quote exact multi-word phrases with double quotes: "machine learning".
    • exclude what the seeker rejects with NOT: NOT manager
    • stay focused — 2–6 concepts, no filler words.
- "textSimple": the same core role/skills as plain space-separated keywords, no operators or quotes (fallback if "text" is too strict). e.g. "python backend developer".
- "city": one city in English from [Almaty, Astana, Shymkent, Karaganda, Aktobe, Atyrau, Pavlodar, Kostanay, Kyzylorda, Taraz, Semey, Aktau, Kokshetau, Taldykorgan, Temirtau, Ust-Kamenogorsk, Petropavlovsk] if one is named (translate Russian names, e.g. Алматы→Almaty), else "".
- "remote": true if remote / online / work-from-home / удалёнка is wanted, else false.
- "experience": map the seeker's seniority to one of "noExperience" (intern, graduate, no experience), "between1And3" (junior, 1–3 yrs), "between3And6" (middle/senior, 3–6 yrs), "moreThan6" (lead, 6+ yrs), or "" if unstated.
- "employment": one of "full","part","project", or "".
- "salary": integer desired MONTHLY salary if a number is given ("400k"→400000, "от 500000"→500000), else null.
- "onlyWithSalary": true if the seeker sets a minimum pay or insists the salary be disclosed, else false.
- "orderBy": "salary_desc" if they want the highest-paying roles, "publication_time" if they want the newest, else "relevance".

Examples:
Request: "remote python or golang backend, entry level, not fintech, at least 400k"
JSON: {"text":"(python OR golang) backend NOT fintech","textSimple":"python golang backend","city":"","remote":true,"experience":"noExperience","employment":"","salary":400000,"onlyWithSalary":true,"orderBy":"relevance"}
Request: "ищу работу senior аналитиком данных в Алматы, хочу самую высокую зарплату"
JSON: {"text":"(data analyst OR analytics)","textSimple":"data analyst","city":"Almaty","remote":false,"experience":"between3And6","employment":"","salary":null,"onlyWithSalary":false,"orderBy":"salary_desc"}

Request: """${String(prompt).slice(0, 900)}"""
Rules: JSON only, no prose. Use "" / null / false when a field is not stated.` },
  ], { maxTokens: 420, temperature: 0, provider });
  return JSON.parse(content);
}

// 2) rank fetched vacancies against the prompt using ALL metadata (city, remote, salary, seniority…)
async function aiRankVacancies(prompt, items, provider) {
  const compact = items.slice(0, 40).map((v, i) => ({
    i, title: v.name, company: v.company, city: v.area,
    schedule: v.schedule || "", experience: v.experience || "",
    salary: v.salary ? `${v.salary[0] || ""}-${v.salary[1] || ""} ${v.salary[2] || ""}`.trim() : "n/a",
    req: (v.requirements || "").slice(0, 130),
  }));
  const content = await callLLM([
    { role: "system", content: "You are a vacancy-matching engine. Score how well each vacancy matches the seeker's request, weighing ALL metadata: role/skills, city, remote vs on-site (schedule), seniority/experience, and salary. Reply with strict JSON only." },
    { role: "user", content:
`Request: """${String(prompt).slice(0, 700)}"""

Vacancies: ${JSON.stringify(compact)}

Return JSON {"ranked":[{"i":<index>,"score":<0-100>,"reason":"<max 9 words>"}]} sorted best first. Include only vacancies with score >= 45.` },
  ], { maxTokens: 1400, temperature: 0, provider });
  const j = JSON.parse(content);
  return Array.isArray(j.ranked) ? j.ranked : [];
}

// 3) full pipeline: plan → fetch (filtered) → rank
async function aiSearch(prompt, provider) {
  const plan = await aiSearchPlan(prompt, provider);          // throws NO_KEY if no LLM → caller falls back
  const area = cityToArea(plan.city);
  const advText = (plan.text || "").trim() || (plan.textSimple || "").trim() || prompt;
  const simpleText = (plan.textSimple || "").trim();
  // whitelist against hh's accepted order_by values — the LLM can hallucinate others,
  // and an unknown order_by makes hh 400 (killing every fetch below, including the relaxes).
  const orderBy = ["salary_desc", "salary_asc", "publication_time"].includes(plan.orderBy) ? plan.orderBy : undefined;
  const opts = { perPage: 40, area, orderBy,
    schedule: plan.remote ? "remote" : undefined,
    experience: plan.experience || undefined,
    employment: plan.employment || undefined,
    salary: plan.salary || undefined,
    onlyWithSalary: plan.onlyWithSalary || undefined };

  let { items } = await fetchVacancies(advText, opts);
  // relax 1: strict filters returned nothing → keep the advanced text + area (+ ordering) only
  if (!items.length && (opts.schedule || opts.experience || opts.employment || opts.salary || opts.onlyWithSalary)) {
    ({ items } = await fetchVacancies(advText, { perPage: 40, area, orderBy }));
  }
  // relax 2: the boolean query itself is too strict → fall back to plain keywords
  if (!items.length && simpleText && simpleText !== advText) {
    ({ items } = await fetchVacancies(simpleText, { perPage: 40, area, orderBy }));
  }

  let ranked = [];
  try { ranked = await aiRankVacancies(prompt, items, provider); } catch (e) { /* keep hh order */ }

  const out = ranked.length
    ? ranked.map(r => items[r.i] ? { ...items[r.i], _match: r.score, _reason: r.reason } : null).filter(Boolean)
    : items.map(v => ({ ...v }));

  return { plan: { ...plan, area }, items: out.slice(0, 15) };
}

module.exports = {
  HH_USER_AGENT, HH_AREA, HH_HOST, HH_CLIENT_ID, hhToken,
  PROVIDERS, DEFAULT_PROVIDER, providerOf, providerStatus,
  body, fetchVacancies, callLLM, aiParseResume, aiTailor,
  aiSearchPlan, aiRankVacancies, aiSearch,
};
