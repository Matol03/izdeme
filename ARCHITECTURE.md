# IzdeMe — Algorithm & Architecture

How IzdeMe turns a résumé + a plain-language wish ("describe your dream job") into a
ranked list of real **hh.kz** vacancies with an explainable Fit Score and a tailored
résumé summary.

---

## 1. High-level architecture

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

- Sends the extracted text to an **OpenAI-compatible** chat endpoint in strict
  JSON mode. The prompt is deliberately conservative: *extract only what is
  explicitly present; never invent skills or dates.*
- The frontend runs the **local parser first (instant)**, then overlays the LLM
  result when it returns — so the UI is never blocked, and it still works offline.

---

## 5. Stage 3 — Vacancy retrieval (`fetchVacancies`)

The prompt (or a clicked recommendation chip) is sent to HeadHunter. A **3-tier
fallback** guarantees data:

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

Fit alone isn't enough — a perfect-fit but off-topic role shouldn't top the list. So
IzdeMe computes a lightweight **query-relevance** score per vacancy (how many prompt
words/skills appear in its text; skills weighted ×2), then ranks by a blend:

```
rankScore = queryRelevance · 8 + Fit%
```

Sorted descending, the **top 10** are shown.

---

## 8. Stage 6 — Explainability (`buildExplain`)

Every card decodes the score into plain language (spec requirement):
- **Matches** — résumé skills the job needs (from the Fit Score's `matches`).
- **Gaps** — required skills the résumé lacks (`gaps`).
- **Suggestions** — concrete next steps, generated from the gaps and sub-scores, e.g.
  *"Add PostgreSQL — required here but missing from your résumé,"* or *"Highlight a
  hands-on project to lift your experience score (56%)."*

---

## 9. Stage 7 — Tailored résumé patch

For the selected role, IzdeMe writes a **2–3 sentence summary** that weaves in the
matched skills and the role's keywords and signals movement on the top gap:
- **LLM path** (`/api/ai/tailor`) when a key is set — highest quality.
- **Local template** otherwise — deterministic, keyword-highlighted.
Matched terms are `<mark>`-highlighted, with copy-to-clipboard.

---

## 10. Providers, deployment & robustness

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

| Spec requirement | Where |
|---|---|
| Semantic vacancy search (hh.kz), 3–10 results | `fetchVacancies` + `/api/vacancies` |
| AI résumé parsing PDF → JSON | `extractPdfText` + `parseResume` / `/api/ai/parse-resume` |
| Weighted Fit Score (Hard 40 / Exp 30 / Soft 30) | `scoreVacancy` |
| Explainability: matches / gaps / suggestions | `buildExplain` |
| Web app: upload, query, vacancies, Fit Score | `index.html` |
