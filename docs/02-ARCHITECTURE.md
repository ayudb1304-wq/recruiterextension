# 02 — Architecture

## 1. System diagram (textual)

```
┌─────────────────────────── User's Chrome ───────────────────────────┐
│  linkedin.com tab                         Extension                  │
│  ┌─────────────────┐   scrape DOM   ┌──────────────────────────┐    │
│  │ Sales Navigator │◄───────────────│ content script            │    │
│  │ / Recruiter page│   paginate     │  extraction engine        │    │
│  └─────────────────┘   (throttled)  │  (selectors from config)  │    │
│                                     └─────────────┬────────────┘    │
│                                                   │ rows (in-memory) │
│                                     ┌─────────────▼────────────┐    │
│                                     │ service worker            │    │
│                                     │  job orchestration        │    │
│                                     │  quota check, enrich call │    │
│                                     └───┬──────────────┬───────┘    │
│                                         │              │            │
│        ┌────────────────┐   UI state    │              │ CSV/Sheets │
│        │ side panel UI  │◄──────────────┘              ▼            │
│        └────────────────┘                    downloads API /        │
│                                              Google Sheets API      │
└──────────────────────────────────────────────┬──────────────────────┘
                                               │ HTTPS (JWT)
                              ┌────────────────▼─────────────────┐
                              │  Cloudflare Worker (Hono)         │
                              │  /auth /quota /enrich /config     │
                              │  /webhooks/dodo                   │
                              └───┬───────────────┬──────────────┘
                                  │               │
                        ┌─────────▼──────┐  ┌─────▼──────────────┐
                        │ Supabase (free)│  │ Enrichment API      │
                        │ users, subs,   │  │ (email find+verify, │
                        │ usage, config  │  │ prepaid credits)    │
                        └────────────────┘  └────────────────────┘
                                  ▲
                                  │ webhooks (subscription events)
                        ┌─────────┴──────┐
                        │ DodoPayments   │  (Merchant of Record,
                        │ hosted checkout│   hosted checkout page)
                        └────────────────┘
```

## 2. Components

### 2.1 Extension (`/extension`, WXT + TypeScript, Manifest V3)

- **Content script** (`entrypoints/linkedin.content.ts`)
  - Matches `https://www.linkedin.com/sales/*` and `https://www.linkedin.com/talent/*`.
  - Detects page type (Sales Nav people search vs Recruiter search) via URL +
    structural probes.
  - Runs the extraction engine (docs/03) over visible result cards; requests
    next page via throttled synthetic click/scroll; streams rows to the service
    worker via `chrome.runtime` port messages.
  - Holds NO business logic (quota, enrichment) — dumb extractor.
- **Service worker** (`entrypoints/background.ts`)
  - Owns the export job state machine:
    `idle → checking_quota → scraping → enriching → building_output → done|failed|cancelled`.
  - Talks to backend (`lib/api.ts`), enforces client-side mirror of quota,
    batches enrichment requests (25 rows/batch), assembles output.
  - Persists job history + dedupe hash set in `chrome.storage.local`.
- **Side panel UI** (`entrypoints/sidepanel/`, Svelte or React — pick one and
  stick to it; Svelte preferred for bundle size)
  - Screens per docs/06.
- **Key libs** (`/extension/lib`)
  - `extraction/` — engine + per-field extractors (docs/03).
  - `throttle.ts` — randomized delay scheduler, daily ceiling counter.
  - `csv.ts` — RFC 4180 builder, ATS preset mapper.
  - `sheets.ts` — Google Sheets append via `chrome.identity.getAuthToken`.
  - `api.ts` — backend client, JWT storage/refresh.

### 2.2 Backend (`/backend`, Cloudflare Workers + Hono + TypeScript)

- Free tier: 100k req/day — orders of magnitude more than needed.
- Routes per docs/05. Stateless; all state in Supabase.
- Secrets via `wrangler secret`: `SUPABASE_SERVICE_KEY`, `ENRICH_API_KEY`,
  `DODO_WEBHOOK_SECRET`, `JWT_SECRET`.
- Also serves `/config/selectors` — the remote selector config (docs/03 §5),
  cached at edge, `Cache-Control: max-age=300`.

### 2.3 Database (Supabase free tier, Postgres)

Tables per docs/04 §4: `users`, `subscriptions`, `usage_counters`,
`selector_configs`, `telemetry_daily`. **No candidate PII tables.**

### 2.4 Site (`/site`, GitHub Pages)

- `index.html` landing (keyword-aligned with CWS listing), `privacy.html`
  (docs/08 §6), `terms.html`. Zero build step, zero cost.

### 2.5 Third parties

- **DodoPayments**: hosted checkout links (one per plan), customer portal link
  for self-serve cancel, webhooks → `/webhooks/dodo`. We never touch card data.
- **Enrichment provider**: single provider behind an interface
  (`backend/src/enrich/provider.ts`) so we can swap (Hunter/Prospeo/Findymail-
  class API; chosen at Sept-1 signup based on current prepaid pricing).
  Interface: `findEmail({firstName, lastName, companyDomain}) →
  {email, status: verified|risky|not_found, providerRef}`.
- **Google Sheets API**: extension-side OAuth via `chrome.identity`; no Google
  tokens ever reach our backend.

## 3. Critical data flows

### 3.1 Export job (paid user, 200 rows, enrichment on)

1. User clicks Export in side panel → service worker `POST /quota/reserve`
   `{estimatedRows: 200}` → backend returns `{jobToken, allowedRows}`.
2. Content script scrapes page 1..N under throttle; rows stream to worker.
3. Worker batches 25 rows → `POST /enrich` with jobToken → backend calls
   provider, decrements usage, returns enriched batch.
4. Worker builds CSV/Sheets output client-side; `POST /quota/commit`
   `{jobToken, actualRows}` reconciles the reservation.
5. Telemetry summary (extraction rates only, no PII) → `POST /telemetry`.

### 3.2 Subscription lifecycle

Dodo hosted checkout (opened from side panel, prefilled email) → webhook
`subscription.active` → upsert `subscriptions` row → next `/quota` call
reflects paid plan. Cancellation/failure webhooks downgrade at period end.

### 3.3 Selector config update (the maintenance loop)

Telemetry alert (extraction rate drop) → human captures fresh fixture
(docs/03 §7) → fix selector JSON in Supabase `selector_configs` → extension
picks it up within 5 min via config poll. **No CWS review needed.** Config is
data (JSON matched against a strict schema), never executable code — MV3
prohibits remote code and we comply (docs/08 §3).

## 4. Environments & config

| Env | Extension | Backend | DB |
|---|---|---|---|
| dev | WXT dev build, `API_BASE=http://localhost:8787` | `wrangler dev` | Supabase project `dev` (or local) |
| prod | CWS build, `API_BASE=https://api.<domain>` | `wrangler deploy` | Supabase project `prod` |

Extension env is baked at build time via WXT `.env` files. No secrets in either.

## 5. Cost ceiling check (must stay ~$0 pre-revenue)

- Cloudflare Workers free, Supabase free, GitHub Pages free, WXT/Svelte free.
- Enrichment credits: only consumed by paid users; free tier has no enrichment.
- The only unavoidable spends: $5 CWS fee, ~$12 domain, ~$40 enrichment
  prepay — all on/after Sept 1 per the strategy plan.
