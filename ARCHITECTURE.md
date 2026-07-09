# IzdeMe — Algorithm & Architecture

How IzdeMe turns a résumé + a plain-language wish ("describe your dream job") into a
ranked list of real **hh.kz** vacancies with an explainable Fit Score and a tailored
résumé summary.

---

## 1. High-level architecture

> **In simple terms:** The app is a web page that talks to a few small backend routes.
> The page reads your PDF and does the quick scoring itself; the backend fetches jobs
> from hh.kz and uses an LLM for the smart language parts. The backend ships as two
> matching copies — one for local dev, one for Vercel.

```
                         ┌─────────────────────────────────────────────┐
   Browser (client)      │  index.html  (vanilla JS, no build step)     │
                         │  • pdf.js résumé text extraction             │
                         │  • local heuristic parser + scorer           │
                         │  • UI: search, chips, cards, résumé patch    │
                         └───────────────┬─────────────────────────────┘
                                         │  fetch()
              ┌──────────────────────────┼───────────────────────────────┐
              ▼                          ▼                                ▼
   /api/vacancies              /api/ai/parse-resume              /api/ai/tailor
   (hh.kz proxy)               (LLM résumé → JSON)               (LLM summary)
              │                          │                                │
   ┌──────────┴──────────┐       ┌───────┴────────┐              ┌────────┴───────┐
   │ HeadHunter API      │       │  LLM provider  │              │  LLM provider  │
   │ api.hh.ru (area=40) │       │  Groq / Gemini │              │  Groq / Gemini │
   │ OAuth app token     │       │  (OpenAI-compat)│             │  (OpenAI-compat)│
   └─────────────────────┘       └────────────────┘              └────────────────┘

Backend exists in two mirrored forms:
  • server.js        → local dev (one zero-dependency Node HTTP server)
  • api/*.js         → Vercel serverless functions (prod); shared logic in api/_lib.js
```

**Design principle — graceful degradation.** Every external dependency (HeadHunter,
the LLM) has a fallback, so the product always produces a result:
- No LLM key → local heuristic parser + scorer.
- HeadHunter unreachable → direct client call → curated dataset.

---

## 2. End-to-end pipeline

> **In simple terms:** Two things go in — your résumé and your job wish. The résumé
> becomes structured data and the wish becomes a job search; the two meet to produce a
> Fit Score, a plain-language explanation, and a tailored summary.

```
  PDF résumé ──▶ [1] extract text ──▶ [2] parse to JSON ─┐
                                                         ├─▶ [4] Fit Score ─▶ [5] rank
  prompt / chip ──────────────▶ [3] fetch vacancies ─────┘        │
                                                                  ▼
                                              [6] explainability (matches/gaps/suggestions)
                                                                  ▼
                                              [7] tailored résumé patch
```

---

## 3. Stage 1 — Résumé text extraction (`extractPdfText`)

> **In simple terms:** We pull the text out of your PDF right in the browser (it never
> leaves your device), and rebuild the lines using each word's on-page position so
> headings and bullet points survive.

- The PDF is read **entirely in the browser** with **pdf.js** (privacy: the file never
  leaves the device for the local path).
- Naïvely dumping `getTextContent()` loses layout, so IzdeMe **reconstructs visual
  lines from glyph coordinates**: each text item's `transform` gives its `(x, y)`.
  Items are grouped into rows by `y` (±3.5px tolerance), rows sorted top→bottom,
  items within a row sorted left→right. This preserves section headers and bullets,
  which the parser depends on.

Output: a newline-delimited plain-text version of the résumé.

---

## 4. Stage 2 — Résumé parsing (text → structured JSON)

> **In simple terms:** Turn the résumé text into clean JSON (skills, years, projects,
> education…). Two engines produce the exact same shape: a built-in one that always
> works, and a smarter LLM one when an API key is set.

Two interchangeable parsers produce the **same JSON shape**:

```json
{
  "name": "…", "title": "…", "seniority": "junior|middle|senior",
  "skills": ["python","sql", …],        // hard/technical
  "soft":   ["communication", …],
  "domains":["fintech","ecology", …],
  "projects":["…"], "experience":[…], "education":"…",
  "languages":[…], "certifications":[…], "years": 4
}
```

### 4a. Local heuristic parser (`parseResume`) — always available, no key

> **In simple terms:** The always-on parser matches your text against skill word-lists,
> carefully counts real work years (ignoring school dates and not double-counting
> overlapping jobs), and picks out your name, title, and projects.

- **Hard/soft skills, domains, languages** — matched against curated lexicons
  (`HARD_SKILLS`, `SOFT_SKILLS`, `DOMAINS`, `LANGUAGES`) using word-boundary regex.
  An **alias map** normalizes variants before matching (`js→javascript`,
  `k8s→kubernetes`, `postgres→postgresql`, `sklearn→scikit-learn`, …).
- **Years of experience (`computeYears`)** — the important one:
  - Parses employment date ranges (`2019–2021`, `Jan 2021 – Present`), treating
    "present/current" as the current year.
  - **Excludes education lines** (degree/university dates aren't work experience).
  - **Merges overlapping intervals** so concurrent roles aren't double-counted.
  - Takes `max(summed tenure, an explicit "N years of experience" statement)`.
- **Name & title (`extractIdentity`)** — from the résumé header (first lines).
- **Projects** — section-aware: reads bullets under `PROJECTS`/`EXPERIENCE`
  headings and action-verb lines; strips bullet glyphs.
- **Seniority** — from the title (senior/lead/junior keywords) else derived from years.
- Display casing is normalized via an acronym map (`SQL`, `NumPy`, `PyTorch`, …).

### 4b. LLM parser (`/api/ai/parse-resume`) — richer, when a key is set

> **In simple terms:** When an API key exists, an LLM does the parsing instead — richer
> results, but told strictly to use only what's actually written and never invent
> skills or dates. The UI shows the instant local result first, then swaps in the LLM's.

- Sends the extracted text to an **OpenAI-compatible** chat endpoint in strict
  JSON mode. The prompt is deliberately conservative: *extract only what is
  explicitly present; never invent skills or dates.*
- The frontend runs the **local parser first (instant)**, then overlays the LLM
  result when it returns — so the UI is never blocked, and it still works offline.

---

## 5. Stage 3 — Vacancy retrieval

> **In simple terms:** Find real jobs. Best case, the LLM turns your wish into precise
> hh.kz filters (role, city, remote, experience, salary) and re-ranks what comes back.
> If there's no key or hh.kz is blocked, a 3-step fallback still guarantees jobs to show.

### Primary path — LLM-optimized search (`/api/search` → `aiSearch`)

> **In simple terms:** The LLM first writes a smart search (real filters from your
> words), fetches matching jobs, then scores each one against your request with a
> one-line reason — so ordering reflects your actual intent, not just keyword overlap.

Instead of dumping the raw prompt into hh's `text` field, the LLM first **plans a
structured query** (`aiSearchPlan`) so the search uses real vacancy **metadata**:

```
prompt ──LLM──▶ { text (role + core skills),
                  city   → hh area id (Almaty=160, Astana=159, …),
                  remote → schedule=remote,
                  experience (noExperience | between1And3 | between3And6 | moreThan6),
                  employment, salary }
```

Those filters are applied to `api.hh.ru/vacancies` (up to ~40 candidates; if strict
filters return nothing it relaxes to text + city and retries). The candidates are then
**re-ranked by the LLM** (`aiRankVacancies`): each vacancy's full metadata (title,
company, **city**, **schedule/remote**, **experience**, **salary**, requirements) is
scored 0–100 against the request, with a one-line reason. This is the "matched with
information from the prompt" step. Runs on the free Groq model.

### Fallback path — plain 3-tier fetch (`fetchVacancies`)

> **In simple terms:** With no LLM (or if the smart search fails), search hh.kz plainly
> through three levels — authenticated server proxy → direct browser call → curated
> demo set — so there are always jobs to show.

If no LLM key is set (or `/api/search` errors), the prompt is searched directly with a
**3-tier fallback** that guarantees data:

1. **Backend proxy** `/api/vacancies` → `api.hh.ru/vacancies?area=40&host=hh.kz`
   (Kazakhstan). Requests carry an **OAuth application token** obtained via the
   `client_credentials` grant. This matters because hh.kz sits behind **DDoS-Guard**,
   which blocks *unauthenticated* datacenter IPs (403) — an **authenticated** request
   passes, so the server returns real live data. The token is cached and only
   re-minted on a 401/403.
2. **Direct client call** — if the backend path fails, the browser calls `api.hh.ru`
   directly (CORS is open); from a real residential IP this succeeds.
3. **Curated dataset** — a built-in set of representative KZ roles, so the demo
   always shows results.

Each vacancy is **normalized** to: `name, company, area, salary, requirements,
responsibilities, url, schedule, experience`.

---

## 6. Stage 4 — Fit Score (`scoreVacancy`)

> **In simple terms:** Score how well your CV fits each job from 0–100 using a fixed
> recipe: hard skills 40%, experience 30%, soft skills 30%. It's plain code (no AI),
> so the number is always reproducible and explainable.

For each vacancy a **`vacancyProfile`** is built by running the same lexicon
matchers over `name + requirements + responsibilities` → the vacancy's required
`hard`, `soft`, and `domain` sets.

The score is a **weighted model: Hard 40% · Experience 30% · Soft 30%.**

**1) Hard skills (40%)** — coverage of what the job asks for:
```
hardScore = |resumeSkills ∩ vacancyHard| / |vacancyHard|
            (0.6 if the job lists no detectable hard skills but the résumé has some)
```

**2) Experience (30%)** — a blend of three signals:
```
projScore = (vacancy hard skills that also appear in the résumé's projects/skills/domains)
            / |vacancyHard|
domHit    = 1 if a résumé domain matches a vacancy domain, else 0.4 (0.6 if none listed)
senScore  = 1 if candidate seniority ≥ required, else max(0.3, 1 − (gap)·0.32)
            (required level parsed from the vacancy's "experience" field;
             candidate level from years: ≥6→3, ≥3→2, ≥1→1, else 0)

expScore  = projScore·0.55 + senScore·0.30 + domHit·0.15
```

**3) Soft skills (30%)**:
```
softScore = 0.45 + 0.55 · (|resumeSoft ∩ vacancySoft| / |vacancySoft|)
            (0.6 if the job lists no soft skills)
```

**Combine & normalize:**
```
overall = hardScore·0.40 + expScore·0.30 + softScore·0.30
Fit%    = clamp( round(overall·100), 35, 99 )
```

The per-vacancy result also carries the 3 sub-scores (shown as the Hard/Experience/
Soft bars) and the `matches` / `gaps` skill sets.

---

## 7. Stage 5 — Ranking

> **In simple terms:** Two different questions are kept apart — does the job match what
> you *asked for*, and does *your CV* fit it. With an LLM the order follows the request
> match; without one, a simple "keyword relevance + fit" blend. Either way, top 10 show.

Two distinct axes are kept separate: **prompt-match** (does this role match what you
asked for?) and **résumé-fit** (how well does *your CV* fit it?).

- **LLM path** — order is driven by the **LLM metadata match score** (Stage 3), so the
  list reflects the request's city/remote/seniority/salary intent. The résumé Fit Score
  is still computed and shown per card.
- **Fallback path** (no LLM) — a lightweight **query-relevance** score (how many prompt
  words/skills appear in the vacancy text; skills ×2) blended with fit:
  ```
  rankScore = queryRelevance · 8 + Fit%
  ```

Either way, the **top 10** are shown.

Sorted descending, the **top 10** are shown.

---

## 8. Stage 6 — Explainability (`buildExplain`)

> **In simple terms:** Translate the score into words — what matched, what's missing,
> and concrete next steps to raise your fit.

Every card decodes the score into plain language (spec requirement):
- **Matches** — résumé skills the job needs (from the Fit Score's `matches`).
- **Gaps** — required skills the résumé lacks (`gaps`).
- **Suggestions** — concrete next steps, generated from the gaps and sub-scores, e.g.
  *"Add PostgreSQL — required here but missing from your résumé,"* or *"Highlight a
  hands-on project to lift your experience score (56%)."*

---

## 9. Stage 7 — Tailored résumé patch

> **In simple terms:** For the job you pick, write a short 2–3 sentence summary that
> highlights your matching skills and the role's keywords — by LLM if a key is set,
> otherwise from a template — with matched words highlighted and a copy button.

For the selected role, IzdeMe writes a **2–3 sentence summary** that weaves in the
matched skills and the role's keywords and signals movement on the top gap:
- **LLM path** (`/api/ai/tailor`) when a key is set — highest quality.
- **Local template** otherwise — deterministic, keyword-highlighted.
Matched terms are `<mark>`-highlighted, with copy-to-clipboard.

---

## 10. Providers, deployment & robustness

> **In simple terms:** Any OpenAI-style model works (Groq and Gemini ship built in). The
> two backend copies must stay identical, secrets live in Vercel rather than the code,
> and pushing to `master` deploys. Everything has a fallback so the app never dead-ends.

- **LLM is provider-agnostic** (any OpenAI-compatible endpoint). Ships with **Groq**
  (`llama-3.3-70b-versatile`) and **Gemini** (`gemini-2.5-flash`); a UI switch appears
  when ≥2 are keyed, and `LLM_LOCK` pins one (currently Groq). Transient `503`s are
  retried; on failure the app falls back to local heuristics.
- **Dual backend kept in sync:** `server.js` (local) mirrors `api/_lib.js` + `api/*.js`
  (Vercel serverless).
- **Secrets** live as Vercel env vars (not bundled); local dev uses a gitignored `.env`.
- **Config:** `HH_CLIENT_ID/SECRET`, `HH_ACCESS_TOKEN`, `HH_AREA=40`, `HH_HOST=hh.kz`,
  `LLM_API_KEY`/`GROQ_API_KEY`/`GEMINI_API_KEY`, `LLM_PROVIDER`, `LLM_LOCK`.
- **Deploy:** GitHub `Matol03/izdeme` → Vercel (`https://izdeme.vercel.app`); push to
  `master` auto-deploys.

---

## 11. Spec mapping (ТЗ_Izdeme)

> **In simple terms:** A quick table showing where each requirement from the original
> project spec is actually implemented in the code.

| Spec requirement | Where |
|---|---|
| Semantic vacancy search (hh.kz), 3–10 results | `fetchVacancies` + `/api/vacancies` |
| AI résumé parsing PDF → JSON | `extractPdfText` + `parseResume` / `/api/ai/parse-resume` |
| Weighted Fit Score (Hard 40 / Exp 30 / Soft 30) | `scoreVacancy` |
| Explainability: matches / gaps / suggestions | `buildExplain` |
| Web app: upload, query, vacancies, Fit Score | `index.html` |
