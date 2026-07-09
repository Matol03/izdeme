# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

IzdeMe is an AI career agent: it turns a PDF résumé + a plain-language "dream job"
prompt into a ranked list of real **hh.kz** vacancies with an explainable **Fit Score**
and a tailored résumé summary. Live at `https://izdeme.vercel.app`. There is no build
step, no `npm install`, no framework, and no test/lint suite — everything runs directly
from source.

## Commands

```bash
node server.js        # local dev → http://localhost:4173  (Node 18+ for built-in fetch)
npm start / npm run dev   # same thing
vercel --prod         # production deploy (or just `git push origin master` — auto-deploys)
```

- **Local dev needs an `.env`** (gitignored; copy from `.env.example`). AI features need a
  free `GROQ_API_KEY`; without any LLM key the app still runs on local heuristics.
- **No tests and no linter exist.** Verify changes by running `node server.js` and
  exercising the flow in a browser (upload a résumé or click "Try the sample", run a
  search). The backend endpoints (`/api/search`, `/api/ai/*`) can be probed with `curl`.
- `git push origin master` deploys to production — treat the default branch as a deploy trigger.

## The one rule that matters most: the dual backend

**The backend logic exists in two mirrored copies, and every change must touch both:**

- `server.js` — a single zero-dependency Node HTTP server, used for **local dev only**.
- `api/*.js` — **Vercel serverless functions** (one file per route) used in **production**;
  all shared logic lives in `api/_lib.js`.

`server.js` and `api/_lib.js` contain the *same* functions (`fetchVacancies`, `callLLM`,
`aiParseResume`, `aiTailor`, `aiSearchPlan`, `aiRankVacancies`, `aiSearch`, the provider
registry, the hh OAuth token cache). **Change one → change the other**, keeping them
character-identical apart from wiring (`server.js` uses Node's `http`; `api/*.js` use the
`(req,res)` handler signature and `require("./_lib")`). After editing, `node --check` both
files and diff the changed function across them to confirm they stayed in sync.

Routes: `/api/health`, `/api/vacancies`, `/api/search`, `/api/ai/status`,
`/api/ai/parse-resume`, `/api/ai/tailor`.

## Architecture big picture

**The frontend is one self-contained file — `index.html` (~1060 lines).** HTML + inline
CSS + inline vanilla JS, no imports, no bundler. It holds the entire client: PDF text
extraction, the local heuristic parser/scorer, all UI rendering, and the API calls. When
asked to change "the UI" or "the scoring", this is the file. Key anchors:
`parseResume`/`computeYears`/`extractIdentity` (local parser), `scoreVacancy`/
`vacancyProfile`/`buildExplain` (deterministic Fit Score + explainability), `card`/
`renderResume`/`runMatch` (rendering), `fetchVacancies` (client-side 3-tier fetch),
and the `HARD_SKILLS`/`SOFT_SKILLS`/`DOMAINS`/`SKILL_ALIASES`/`ACR` lexicons the parser matches against.

**AI is optional and does language-understanding only.** The split is deliberate:
- The **LLM** (Groq default, Gemini switchable — any OpenAI-compatible endpoint) does:
  résumé parsing (`/api/ai/parse-resume`), tailored summaries (`/api/ai/tailor`), search
  planning + re-ranking (`/api/search`). It does **not** pick vacancies or compute the
  match %.
- **Deterministic code** does vacancy retrieval and the **Fit Score** (Hard 40% /
  Experience 30% / Soft 30%), so results are reproducible and explainable.
- The frontend runs the **local parser first (instant)**, then overlays the LLM result
  when it returns — the UI never blocks and still works with no key. Same JSON shape from
  both parsers.

**Graceful degradation is a hard requirement** — every external dependency has a fallback:
no LLM key → local heuristic parser/scorer; hh.kz unreachable → direct client call →
curated dataset. Never introduce a code path that can leave the user with no result.

**Two functions named `fetchVacancies` exist and are different.** The backend one
(`server.js`/`_lib.js`) is the authenticated server→hh.kz proxy. The frontend one (in
`index.html`) is the client-side 3-tier fallback chain (`/api/search` → `/api/vacancies`
→ direct `api.hh.ru` call → curated `FALLBACK_POOL`). Don't conflate them.

## LLM-optimized search pipeline (`aiSearch`)

`aiSearchPlan` (prompt → structured hh filters) → `fetchVacancies` (filtered) →
`aiRankVacancies` (re-rank by all metadata). The plan converts natural-language, possibly
Russian, multi-constraint prompts into a real **hh.kz query-language** `text` string
(uppercase `AND`/`OR`/`NOT`, parenthesized alternatives, quoted phrases) plus filters:
`city`→area id, `remote`→`schedule`, `experience`, `employment`, `salary`,
`onlyWithSalary`, `orderBy`, and a plain-keyword `textSimple` fallback. `aiSearch` relaxes
in two stages so an over-strict boolean query never returns empty (drop filters → fall
back to `textSimple`). **Validate LLM-provided enum values before passing them to hh**
(e.g. `orderBy` is whitelisted) — a hallucinated value makes hh 400 and, because the first
fetch isn't wrapped in try/catch, throws before the relax steps can recover.

## hh.kz access (DDoS-Guard + OAuth)

hh.kz sits behind **DDoS-Guard**, which returns 403 (`Server: ddos-guard`) to
*unauthenticated* datacenter IPs. Requests carry an **hh application token**
(`client_credentials` grant) as a Bearer, so **authenticated** calls bypass DDoS-Guard.
Gotcha: the `/token` endpoint is *itself* DDoS-guarded from datacenter IPs, so production
relies on a **pre-minted static `HH_ACCESS_TOKEN`** (re-mint via `client_credentials` from
a residential IP when it expires). `HH_AREA=40` / `HH_HOST=hh.kz` = Kazakhstan; the
`KZ_AREAS` map resolves city → area id (Almaty=160, Astana=159, …).

## Config & providers

Secrets are **Vercel env vars** (not bundled; `.vercelignore` excludes the local-only
`.env`, which `server.js` loads via a hand-rolled loader — no `dotenv`):
`HH_ACCESS_TOKEN`, `HH_CLIENT_ID/SECRET`, `GROQ_API_KEY`, `GEMINI_API_KEY`, `LLM_LOCK`.
Providers are OpenAI-compatible; Groq (`llama-3.3-70b-versatile`) and Gemini
(`gemini-2.5-flash`, sent with `reasoning_effort:"none"` so JSON isn't truncated) ship
configured. A UI model switch appears when ≥2 keys are set; `LLM_LOCK=groq` currently pins
one. The favicon is an inline data-URI in `<head>` (Vercel didn't serve a static
`/favicon.svg` with the functions setup).

For the full algorithm, formulas, and data flow, see **`ARCHITECTURE.md`**; user-facing
setup and hh/LLM config tables are in **`README.md`**.
