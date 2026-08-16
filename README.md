# RecruitExport

MV3 Chrome extension that exports LinkedIn Sales Navigator / Recruiter search
results to clean, enriched, ATS-ready CSVs. Cloudflare Workers + Supabase
backend, DodoPayments subscriptions.

`docs/` is the single source of truth. `CLAUDE.md` holds the guardrails.

## Layout

```
extension/   WXT + Svelte 5 MV3 extension
backend/     Cloudflare Worker (Hono) + Supabase migrations
shared/      types shared by both (CandidateRecord lives here, once)
site/        GitHub Pages: landing, privacy, terms, auth handoff
scripts/     icon generator, fixture sanitizer
docs/        the spec set (01–09)
```

## Getting started

```bash
pnpm install
pnpm verify              # typecheck + 319 unit tests — run before calling anything done

cp extension/.env.example extension/.env
pnpm --filter extension dev        # then load extension/.output/chrome-mv3 unpacked

cp backend/.dev.vars.example backend/.dev.vars
pnpm --filter backend dev          # wrangler dev on :8787
```

## Build status

| Phase (docs/07) | State |
|---|---|
| 0 — Scaffold | done |
| 1 — Extraction engine | code + tests done; **needs real fixtures** (see below) |
| 2 — Content script, throttle, job pipeline | done |
| 3 — Output layer (CSV, presets, Sheets) | done |
| 4 — Side panel UI | done |
| 5 — Backend | done; **needs a Supabase project + secrets** |
| 6 — Wire ext ↔ backend ↔ payments | code done; needs live accounts |
| 7 — Hardening + store prep | site pages + icons done; submission is human work |

Everything that could be built without a live account, a real LinkedIn page, or a
credit card is built and tested. What remains is listed below, honestly.

## What is NOT done, and why

### 1. The selector snapshot is an unverified seed ⚠️

`extension/lib/extraction/config.snapshot.json` ships as
`configVersion: "0.0.0-seed"`. Its selectors come from the examples in docs/03
§3 plus conservative anchors of the same family. **None have been checked against
a real LinkedIn page**, because no fixture existed and CLAUDE.md forbids
inventing LinkedIn DOM structure.

The engine is fully built and tested — 60 randomly-mutilated-DOM runs, every
strategy type, tier ordering, postprocess chains, degradation telemetry. What is
missing is the *data* it runs on.

To fix, per docs/03 §7:

1. Build with `WXT_DEV_CAPTURE=1`, open a Sales Navigator people search, use the
   panel's capture command. Raw HTML lands in Downloads as `raw-*.html`
   (gitignored — it contains real people).
2. `node scripts/sanitize-fixture.mjs <raw.html>`, then **read the output** and
   hand-fix anything the sanitizer missed.
3. Save to `extension/fixtures/salesnav_people_search/<date>-<note>.html`.
4. Fix the selectors, bump `configVersion` to a dated value, delete the
   "seed" assertion in `extension/tests/config-schema.test.ts`, run `pnpm test`.

### 2. Accounts and secrets (human-only)

| Needed | For | Where it goes |
|---|---|---|
| Supabase project | database | run `backend/migrations/0001_init.sql`, set `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` |
| `wrangler kv namespace create RE_KV` | rate limits | paste the id into `backend/wrangler.jsonc` |
| `JWT_SECRET` | auth | `wrangler secret put JWT_SECRET` |
| Transactional email account | magic links | `EMAIL_API_KEY`; record the vendor in docs/05 §1 |
| Google Cloud OAuth client | Sheets export | `WXT_GOOGLE_CLIENT_ID`; the manifest omits `oauth2` entirely until it is set |
| DodoPayments account + 2 products | billing | checkout URLs, portal URL, product ids, `DODO_WEBHOOK_SECRET` |
| Enrichment provider (~$40 prepay) | verified emails | `ENRICH_API_KEY`; implement the adapter in `backend/src/enrich/provider.ts` |

Until an enrichment provider is chosen, `ENRICH_PROVIDER=mock` returns
deterministic fake results so the whole paid path is exercisable.

### 3. Preset headers are drafts

Greenhouse and Lever column names in `extension/lib/presets/index.ts` are
docs/04 §6's drafts. Verify them against a real test import before telling a
customer they work. The UI says so too.

### 4. Trader / listing details

`site/privacy.html` has `[LEGAL NAME]`, `[REGISTERED ADDRESS]` and
`[SMS-VERIFIED PHONE]` placeholders — required by the EU DSA trader disclosure
before CWS submission (docs/08 §3, docs/09 §6). `site/auth.html` needs the
production `API_BASE` and the CWS extension id.

## Guardrails worth re-reading before changing anything

The extension is **read-only on LinkedIn**, paginates at **human speed** through
`lib/throttle.ts`, holds **no credentials and no API keys**, requests **five
permissions and one host**, and **never persists candidate data** anywhere.
These are enforced by tests (`permissions.test.ts`, `throttle.test.ts`,
`job.test.ts`) as well as by CLAUDE.md. See docs/08 for the reasoning.
