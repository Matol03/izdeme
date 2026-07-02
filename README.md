# IzdeMe — AI Career Agent (MVP)

Semantic **hh.kz** vacancy matching + AI resume parsing + a weighted, explainable **Fit Score**.
Built to the `ТЗ_Izdeme` MVP spec.

```
Frontend (index.html)  ──▶  Backend API (server.js)  ──▶  Job Fetcher → hh.kz
   │  pdf.js resume parsing                  │  proper User-Agent, area=40
   │  Fit Score 40/30/30                      │  /api/vacancies, /api/health
   └─ matches / gaps / suggestions           └─ curated fallback on block
```

## How it works

> Full deep-dive with all formulas: [ARCHITECTURE.md](ARCHITECTURE.md).

### What the AI is responsible for

The LLM (Groq by default, Gemini switchable — any OpenAI-compatible model) handles the
**language-understanding** parts only:

1. **Résumé parsing** (`/api/ai/parse-resume`) — turns the raw PDF text into structured
   JSON: `name, title, skills, soft skills, experience, projects, education, domains,
   languages, years, seniority`. The prompt is deliberately strict — *extract only what
   is explicitly written; never invent skills or dates.*
2. **Résumé tailoring & reasoning** (`/api/ai/tailor`) — for a chosen vacancy, writes a
   2–3 sentence tailored summary and phrases the **matches / gaps / suggestions**.

What the AI does **not** do: it does **not** fetch vacancies and does **not** decide the
match percentage. Vacancy selection and the Fit Score are **deterministic** code, so
results are reproducible and explainable. The AI is also **optional** — with no API key
the app falls back to a local heuristic parser that produces the same JSON shape, so
everything still works offline.

### How vacancies are selected

1. **Query** — the user's prompt ("describe your dream job") or a clicked recommendation
   chip (e.g. *Remote job*, *Python*, *Data-driven management*).
2. **Source** — vacancies come from the **HeadHunter API** for Kazakhstan
   (`api.hh.ru/vacancies?area=40&host=hh.kz`, `order_by=relevance`), fetched through a
   **3-tier chain** so results always appear: authenticated backend proxy → direct
   client call → curated fallback set. Up to ~30 candidates are pulled per query.
3. **Rank & trim** — each candidate gets a **query-relevance** score (how many prompt
   words/skills appear in its title + requirements + responsibilities; skills count
   double) which is blended with its Fit Score, then the **top 10** are shown:

   ```
   rankScore = queryRelevance · 8 + FitScore%
   ```

   This keeps results both **on-topic** (relevance) and **well-suited to you** (fit).

### How the match (Fit Score) is calculated

For every vacancy IzdeMe compares **your parsed résumé** against the **vacancy's
requirements** (the same skill/soft/domain extractors run over the job text). The match
is a weighted, explainable **Fit Score = Hard skills 40% · Experience 30% · Soft skills 30%**:

| Component | Weight | How it's measured |
|---|---|---|
| **Hard skills** | 40% | share of the job's required technical skills you already have |
| **Experience** | 30% | project/keyword coverage (55%) + seniority vs. required years (30%) + domain match (15%) |
| **Soft skills** | 30% | overlap of soft skills (communication, leadership, …) |

```
FitScore% = clamp( round( 0.40·hard + 0.30·experience + 0.30·soft ) , 35 , 99 )
```

The three sub-scores are shown as the Hard/Experience/Soft bars on each card, and the
score is decoded into **Matches** (skills you have that the job needs), **Gaps** (skills
it needs that you lack), and **Suggestions** (concrete steps to raise the score).

## Run

```bash
git clone https://github.com/Matol03/izdeme.git
cd izdeme
cp .env.example .env        # adjust if needed (add a free LLM_API_KEY to enable AI)
node server.js              # → http://localhost:4173   (Node 18+)
```

No `npm install` required — the backend uses only Node built-ins.

## Deploy (Vercel)

The repo is Vercel-ready: the frontend (`index.html`) is served static and the backend
runs as **serverless functions** under `api/` (`server.js` is only for local dev).

```bash
vercel --prod        # from the repo root (or import the GitHub repo in the dashboard)
```

Optional environment variables (Project → Settings → Environment Variables):

| Var | Default | Purpose |
|---|---|---|
| `HH_USER_AGENT` | `IzdeMe-JobAgent/1.0 (…)` | required by the hh.ru API |
| `HH_AREA` / `HH_HOST` | `40` / `hh.kz` | Kazakhstan region/site |
| `HH_ACCESS_TOKEN` | — | hh.ru OAuth token (avoids throttling) |
| `LLM_API_KEY` | — | enables AI parsing + tailoring (free Groq key: https://console.groq.com/keys) |
| `LLM_BASE_URL` | `https://api.groq.com/openai/v1` | any OpenAI-compatible endpoint |
| `LLM_MODEL` | `llama-3.3-70b-versatile` | model name for the chosen provider |

> Note: serverless functions run on Vercel's datacenter IPs, which hh.kz's DDoS-Guard
> blocks, so `/api/vacancies` falls through to the client-side direct call (works from the
> visitor's own browser) and then the curated dataset. The LLM functions work normally.

## Spec coverage

| Spec requirement | Where |
|---|---|
| Semantic vacancy search (hh.kz), 3–10 results | `fetchVacancies()` + `/api/vacancies` (area=40, host=hh.kz) |
| AI resume parsing PDF → JSON (skills/projects/education) | `parseResume()` via pdf.js (client-side) |
| Weighted Fit Score: Hard 40% / Experience 30% / Soft 30% | `scoreVacancy()` |
| Explainability: matches / gaps / suggestions | `buildExplain()` + card UI |
| Web app: upload, query, vacancies, Fit Score | `index.html` |
| LLM (Groq/OpenAI/Gemini): AI resume parsing + Fit Score reasoning | `server.js` → `/api/ai/*` |

## Connecting the **real** hh.kz API

hh.kz sits behind **DDoS-Guard**, which blocks datacenter/sandbox IPs (you'll see HTTP 403,
`Server: ddos-guard`). The app handles this with a 3-tier fetch and degrades gracefully:

1. **Backend proxy** `/api/vacancies` — server-to-server with a registered `User-Agent`.
2. **Direct client call** — from a real browser on a residential IP this passes DDoS-Guard
   (CORS is open: `Access-Control-Allow-Origin: *`), so **live data works when you open the
   page in your own Chrome**.
3. **Curated fallback** — 14 KZ roles, so the demo always shows 10 ranked matches.

To make tier 1 fully live in production:

1. Register an application at **https://dev.hh.ru/admin**.
2. Put your contact in `HH_USER_AGENT` and your OAuth token in `HH_ACCESS_TOKEN` (`.env`).
   An authenticated, whitelisted app is not throttled/blocked.
3. Deploy the backend on an IP with good reputation (or proxy via a residential/whitelisted egress).

The source badge in the UI shows which tier served the results
(`hh.kz · backend`, `hh.kz · direct`, or `curated demo set`).

## AI integration — switchable models (free)

The LLM endpoints call any **OpenAI-compatible** API. Two providers ship configured, both with
free tiers (no credit card) — set either or both:

| Provider | Free key | Env vars | Default model |
|---|---|---|---|
| **Groq** | https://console.groq.com/keys | `GROQ_API_KEY` (+ `GROQ_MODEL`) | `llama-3.3-70b-versatile` |
| **Gemini** | https://aistudio.google.com/apikey | `GEMINI_API_KEY` (+ `GEMINI_MODEL`) | `gemini-2.5-flash` |

When **both** keys are set, an **AI-model switch (Groq ⇄ Gemini)** appears in the UI; flipping it
re-parses the resume and re-tailors with the chosen model so you can compare. `LLM_PROVIDER` picks
the default. With no key set, the app falls back to the local heuristic parser/scorer (always runs).
(Gemini 2.5 "thinking" is disabled via `reasoning_effort:"none"` so JSON output isn't truncated.)

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/ai/status` | GET | `{ enabled, default, providers:[{id,label,model,enabled}] }` |
| `/api/ai/parse-resume` | POST `{text, provider}` | LLM resume → `{skills, soft, projects, education, domains, years}` |
| `/api/ai/tailor` | POST `{resume, vacancy, provider}` | `{matches, gaps, suggestions, summary}` for a role |

Flow when enabled:
1. PDF text is extracted client-side (pdf.js), then sent to `/api/ai/parse-resume` for richer parsing.
2. The 10-card grid uses the fast local 40/30/30 score (stays well under the spec's 5s budget).
3. The focused **AI Resume Patch** calls `/api/ai/tailor` for an LLM-written summary — a "✦ <provider>" badge appears.

Switch provider by setting `LLM_BASE_URL` + `LLM_MODEL` (e.g. OpenAI `https://api.openai.com/v1` +
`gpt-4o-mini`, or Gemini `https://generativelanguage.googleapis.com/v1beta/openai` +
`gemini-2.0-flash`). Without a key the API returns a clean `disabled` signal and the UI uses heuristics.

## Files

- `index.html` — frontend (UI, resume parsing, scoring, explainability)
- `server.js` — Node backend for local dev (static serving + hh.kz proxy + AI routes)
- `api/` — Vercel serverless functions (prod); shared logic in `api/_lib.js`
- `ARCHITECTURE.md` — full algorithm & data-flow writeup
- `.env` / `.env.example` — configuration
- `package.json` — `npm start`

## Next (spec Этап 2/3)

PostgreSQL (Supabase) caching of vacancies, user auth, and a RAG layer for embedding-based
semantic search. The `Resume Parser` and `Fit Score Engine` are already isolated functions, and
a provider-agnostic LLM is wired in — moving the full scorer server-side behind RAG is the remaining step.
