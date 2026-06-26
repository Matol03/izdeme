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
// LLM provider — any OpenAI-compatible endpoint. Defaults to Groq, which has a
// free tier (no credit card). Override LLM_BASE_URL/LLM_MODEL for OpenAI, Gemini, etc.
let LLM_API_KEY    = process.env.LLM_API_KEY || process.env.GROQ_API_KEY || "";
const LLM_BASE_URL = (process.env.LLM_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/+$/, "");
const LLM_MODEL    = process.env.LLM_MODEL || "llama-3.3-70b-versatile";
// only fall back to an OpenAI key when the base URL is actually OpenAI
if (!LLM_API_KEY && /openai\.com/.test(LLM_BASE_URL)) LLM_API_KEY = process.env.OPENAI_API_KEY || "";
const LLM_PROVIDER = /groq\.com/.test(LLM_BASE_URL) ? "Groq"
  : /openai\.com/.test(LLM_BASE_URL) ? "OpenAI"
  : /googleapis\.com/.test(LLM_BASE_URL) ? "Gemini" : "LLM";

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
async function callLLM(messages, { json = true, maxTokens = 700, temperature = 0.3 } = {}) {
  if (!LLM_API_KEY) { const e = new Error("LLM_API_KEY not set"); e.code = "NO_KEY"; throw e; }
  const reqBody = { model: LLM_MODEL, messages, temperature, max_tokens: maxTokens };
  if (json) reqBody.response_format = { type: "json_object" };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 22000);
  const r = await fetch(LLM_BASE_URL + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + LLM_API_KEY },
    body: JSON.stringify(reqBody),
    signal: ctrl.signal,
  }).finally(() => clearTimeout(t));
  if (!r.ok) { const txt = await r.text(); const e = new Error(`${LLM_PROVIDER} ${r.status}: ${txt.slice(0, 240)}`); e.status = r.status; throw e; }
  const data = await r.json();
  return data.choices?.[0]?.message?.content || "{}";
}

async function aiParseResume(text) {
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
  ], { maxTokens: 1200, temperature: 0 });
  return JSON.parse(content);
}

async function aiTailor(resume, vacancy) {
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
  ], { maxTokens: 500 });
  return JSON.parse(content);
}

module.exports = {
  HH_USER_AGENT, HH_AREA, HH_HOST, HH_TOKEN,
  LLM_API_KEY, LLM_MODEL, LLM_PROVIDER, LLM_BASE_URL,
  body, fetchVacancies, callLLM, aiParseResume, aiTailor,
};
