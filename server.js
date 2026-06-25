/* ============================================================
   IzdeMe — Backend API (Node.js, zero dependencies)
   Maps to the MVP spec architecture:
     Frontend  ──▶  Backend API  ──▶  Job Fetcher (hh.kz)
   Responsibilities:
     • Serve the static frontend
     • Proxy live vacancy search to the HeadHunter (hh.kz) API
       with a proper registered User-Agent (required by hh.ru)
     • Normalize vacancies to the spec shape
       (name, company, description, requirements, link)
   ------------------------------------------------------------
   Run:  node server.js   (Node 18+ for built-in fetch)
   ============================================================ */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");

/* ---------- minimal .env loader (no dotenv dependency) ---------- */
function loadEnv() {
  const f = path.join(__dirname, ".env");
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnv();

const PORT = Number(process.env.PORT || 4173);
const ROOT = __dirname;
// hh.ru REQUIRES a descriptive User-Agent: "AppName/version (contact-email)".
// Register a real app at https://dev.hh.ru/admin to get whitelisted in production.
const HH_USER_AGENT = process.env.HH_USER_AGENT || "IzdeMe-JobAgent/1.0 (murat.askarov@nu.edu.kz)";
const HH_AREA = process.env.HH_AREA || "40";    // 40 = Kazakhstan (hh.kz)
const HH_HOST = process.env.HH_HOST || "hh.kz";
const HH_TOKEN = process.env.HH_ACCESS_TOKEN || ""; // optional OAuth token (whitelists you past throttling)

// OpenAI (spec: AI resume parsing + Fit Score reasoning). Optional — the app
// falls back to local heuristics when no key is present.
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

const MIME = { ".html":"text/html; charset=utf-8", ".js":"text/javascript", ".css":"text/css",
  ".svg":"image/svg+xml", ".json":"application/json", ".ico":"image/x-icon", ".png":"image/png" };

/* strip hh <highlighttext> markup */
const clean = s => (s || "").replace(/<\/?highlighttext>/g, "");

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

  const server = r.headers.get("server") || "";
  if (!r.ok) {
    const err = new Error("hh responded " + r.status);
    err.status = r.status;
    err.ddosGuard = /ddos-guard/i.test(server);
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

/* ---------- OpenAI helpers ---------- */
function readJson(req) {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", c => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

async function callOpenAI(messages, { json = true, maxTokens = 700, temperature = 0.3 } = {}) {
  if (!OPENAI_KEY) { const e = new Error("OPENAI_API_KEY not set"); e.code = "NO_KEY"; throw e; }
  const body = { model: OPENAI_MODEL, messages, temperature, max_tokens: maxTokens };
  if (json) body.response_format = { type: "json_object" };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
  const r = await fetch(OPENAI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + OPENAI_KEY },
    body: JSON.stringify(body),
    signal: ctrl.signal,
  }).finally(() => clearTimeout(t));
  if (!r.ok) { const txt = await r.text(); const e = new Error(`OpenAI ${r.status}: ${txt.slice(0, 240)}`); e.status = r.status; throw e; }
  const data = await r.json();
  return data.choices?.[0]?.message?.content || "{}";
}

// Extract a resume PDF's text → structured JSON (spec 2.2)
async function aiParseResume(text) {
  const content = await callOpenAI([
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

// Resume + vacancy → tailored summary + explainability (spec 2.3 / 2.4)
async function aiTailor(resume, vacancy) {
  const content = await callOpenAI([
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

/* ---------- request routing ---------- */
function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "Content-Type": type, "Access-Control-Allow-Origin": "*" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);

  // --- API: health ---
  if (u.pathname === "/api/health") {
    return send(res, 200, { ok: true, userAgent: HH_USER_AGENT, area: HH_AREA, host: HH_HOST, oauth: !!HH_TOKEN });
  }

  // --- API: live vacancy search from hh.kz ---
  if (u.pathname === "/api/vacancies") {
    const q = (u.searchParams.get("text") || "").trim();
    if (!q) return send(res, 400, { error: "missing 'text' query param" });
    try {
      const result = await fetchVacancies(q, { perPage: Number(u.searchParams.get("per_page") || 30) });
      return send(res, 200, { source: "hh.kz", ...result });
    } catch (e) {
      // Surface why we failed so the frontend can fall back gracefully.
      return send(res, 502, {
        error: e.message,
        ddosGuard: !!e.ddosGuard,
        hint: e.ddosGuard
          ? "DDoS-Guard blocked this server IP. Use a residential IP, the client-side path, or register an app + OAuth token at https://dev.hh.ru/admin."
          : "hh.kz request failed — check User-Agent / rate limits.",
      });
    }
  }

  // --- API: is OpenAI configured? ---
  if (u.pathname === "/api/ai/status") {
    return send(res, 200, { enabled: !!OPENAI_KEY, model: OPENAI_MODEL });
  }

  // --- API: AI resume parsing (PDF text → JSON) ---
  if (u.pathname === "/api/ai/parse-resume" && req.method === "POST") {
    try {
      const { text } = await readJson(req);
      if (!text || String(text).length < 20) return send(res, 400, { error: "missing resume text" });
      const resume = await aiParseResume(text);
      return send(res, 200, { source: "openai", model: OPENAI_MODEL, resume });
    } catch (e) {
      return send(res, e.code === "NO_KEY" ? 503 : 502, { error: e.message, disabled: e.code === "NO_KEY" });
    }
  }

  // --- API: AI tailored summary + matches/gaps/suggestions ---
  if (u.pathname === "/api/ai/tailor" && req.method === "POST") {
    try {
      const { resume, vacancy } = await readJson(req);
      if (!resume || !vacancy) return send(res, 400, { error: "resume and vacancy required" });
      const out = await aiTailor(resume, vacancy);
      return send(res, 200, { source: "openai", model: OPENAI_MODEL, ...out });
    } catch (e) {
      return send(res, e.code === "NO_KEY" ? 503 : 502, { error: e.message, disabled: e.code === "NO_KEY" });
    }
  }

  // --- static files ---
  let p = decodeURIComponent(u.pathname);
  if (p === "/" || p === "") p = "/index.html";
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT)) return send(res, 403, "forbidden", "text/plain");
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, "not found", "text/plain");
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`\n  IzdeMe backend  →  http://localhost:${PORT}`);
  console.log(`  hh.kz proxy     →  /api/vacancies?text=...  (area=${HH_AREA}, host=${HH_HOST})`);
  console.log(`  User-Agent      →  ${HH_USER_AGENT}`);
  console.log(`  OAuth token     →  ${HH_TOKEN ? "set ✓" : "not set (optional)"}`);
  console.log(`  OpenAI          →  ${OPENAI_KEY ? `enabled ✓ (${OPENAI_MODEL})` : "not set → local heuristic fallback"}\n`);
});
