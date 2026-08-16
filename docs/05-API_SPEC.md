# 05 — Backend API Specification

Base: `https://api.<domain>` (Cloudflare Worker, Hono). All JSON. All
authenticated routes require `Authorization: Bearer <JWT>`.

## 1. Auth (magic link)

### POST /auth/request-link
Body: `{ "email": "user@agency.com" }`
- Rate limit: 3/email/hour, 10/IP/hour.
- Sends magic link email. v1 email transport: enrichment budget must not be
  touched — use a free-tier transactional email service chosen at Phase 3
  (candidates: Resend/Brevo-class free tier; decision recorded here when made).
- **Implementation status:** `backend/src/lib/email.ts` ships a Resend-shaped
  adapter as the default because its API is a single POST. 👤 **Decision still
  open** — create the account, set `EMAIL_API_KEY`, and record the vendor and its
  free-tier limits here. With no key set, the Worker logs the link instead of
  sending it, so local dev needs no account.
- Always returns `{ "ok": true }` (no account enumeration).

### POST /auth/verify
- One-time token (15 min TTL, stored hashed in Supabase).
- **Changed from `GET /auth/verify?token=` during Phase 5.** The token now
  travels in the URL *fragment* to `site/auth.html`, which POSTs it here. A
  fragment is never sent to a server, so the one-time token stays out of
  GitHub Pages access logs, out of the Referer header, and out of our Worker
  logs — which a query parameter would not.
- On success: upserts the user and returns `{token, expiresAt, email}`. The page
  hands the JWT to the extension via `chrome.runtime.sendMessage` (the
  extension's `externally_connectable` allowlist), with a copy-code fallback.
- JWT: 30-day expiry, `{ sub: userId, email }`, HS256 with `JWT_SECRET`.

### POST /auth/refresh
- Valid JWT in → fresh JWT out.

## 2. Account

### GET /me
→
```json
{
  "email": "...",
  "plan": "pro_monthly",
  "status": "active",
  "periodEnd": "2026-10-04T...",
  "usage": { "rowsExported": 340, "rowsEnriched": 340, "monthCap": 2000, "rolling24h": 120, "rolling24hCap": 1000 },
  "checkoutUrls": { "pro_monthly": "https://checkout.dodopayments.com/...", "pro_annual": "..." },
  "portalUrl": "https://..."
}
```

## 3. Selector config

### GET /config/selectors?profile=salesnav_people_search&v=1.2.0
- Public (no auth) — the extension needs it before login too.
- Edge-cached 5 min. Returns active config for profile:
```json
{ "configVersion": "2026-09-14.2", "profile": { ...validated selector map... } }
```
- `v` (extension version) lets us serve version-gated configs later; ignore in v1 logic, log it.

## 4. Quota (reservation model)

### POST /quota/reserve
Body: `{ "estimatedRows": 200, "enrich": true }`
- Checks: plan status, monthly caps, rolling-24h ceiling (`export_events`).
- Grants min(requested, remaining). →
```json
{ "jobToken": "jt_...", "allowedRows": 200, "enrichAllowed": true, "expiresAt": "...+2h" }
```
- 402-style response if free user requests enrich, with upgrade URL:
  `{ "error": "plan_required", "checkoutUrl": "..." }`
- 429 with `retryAfter` if rolling ceiling hit.

### POST /quota/commit
Body: `{ "jobToken": "jt_...", "actualRows": 187, "actualEnriched": 187 }`
- Reconciles reservation → increments `usage_counters`, inserts `export_events`.
- Idempotent per jobToken.

Uncommitted reservations expire (2h) without counting against quota.

## 5. Enrichment proxy

### POST /enrich
Headers: jobToken required alongside JWT.
Body:
```json
{ "jobToken": "jt_...", "batch": [
  { "rowId": "r1", "firstName": "Jane", "lastName": "Doe", "companyName": "Acme GmbH", "companyDomainGuess": null }
]}
```
- Max 25/batch. Backend resolves domain if missing (provider feature or naive
  `companyName→domain` lookup), calls provider `findEmail`, maps to:
```json
{ "results": [ { "rowId": "r1", "email": "jane.doe@acme.com", "emailStatus": "verified", "companyDomain": "acme.com" } ] }
```
- Decrements enrichment allowance transactionally; if allowance exhausted
  mid-job, remaining rows return `emailStatus: "skipped"` + flag
  `allowanceExhausted: true` (job continues; UI shows partial-enrichment note).
- **No request/response payload logging.** Log counts + latency only.
- Provider abstraction: `enrich/provider.ts` interface; concrete adapter chosen
  Sept 1 (record decision + pricing here). Timeout 10s/row budget; provider
  errors → `emailStatus: "not_found"`, never job failure.

## 6. Payments webhooks (DodoPayments)

### POST /webhooks/dodo

**Event names and signature scheme VERIFIED against the live Dodo docs on
2026-08-16** (`docs.dodopayments.com/developer-resources/webhooks` and
`.../webhooks/intents/webhook-events-guide`), as this section previously
required. The draft list was incomplete; the verified mapping is below.

**Signature (Standard Webhooks).** Headers `webhook-id`, `webhook-timestamp`,
`webhook-signature`. The signed string is `{id}.{timestamp}.{raw body}`,
HMAC-SHA256 with the secret (base64 after its `whsec_` prefix), base64-encoded.
The header may carry several space-separated `v1,<sig>` values during a secret
rotation; any match passes. Requests older than **5 minutes are rejected** to
stop replays. Unsigned or invalid → 401. The raw body must be read before
parsing, since the signature covers exact bytes.

**Handled events** (idempotently, by `webhook-id` stored in `processed_webhooks`):

| Event | Effect |
|---|---|
| `subscription.active`, `subscription.renewed`, `subscription.unpaused`, `subscription.plan_changed` | status `active`, plan from the product-id mapping |
| `subscription.on_hold`, `subscription.failed`, `subscription.paused`, `payment.failed` | status `past_due`, **plan left unchanged** so a recovered payment restores Pro without a re-purchase |
| `subscription.cancelled` | status `cancelled`, plan kept — usable until `current_period_end` |
| `subscription.expired` | status `cancelled`, plan `free` |
| `refund.succeeded` | status `cancelled`, plan `free`, immediately + logged for manual review |

`effectivePlan()` (backend/src/db/queries.ts) is what actually gates quota: it
downgrades `past_due` to free caps and treats a `cancelled` subscription as paid
only until its period end. A missed webhook therefore fails safe.

**Acknowledged but not acted on** (200 + log): `payment.succeeded`,
`payment.processing`, `payment.cancelled`, `refund.failed`, all `dispute.*`,
`subscription.updated`, `subscription.update_payment_method`, and anything else.
Unknown events are never a 500 — that would trigger a retry storm.

## 7. Telemetry

### POST /telemetry
Body: array of events from docs/03 §9 schema. No auth required BUT rate-limited
by IP; payload schema strictly validated; anything with unexpected keys dropped.
Aggregated into `telemetry_daily` (upsert-increment). Raw events not stored.

## 8. Errors, limits, misc

- Error envelope: `{ "error": "code", "message": "human readable", ...extras }`.
- Global rate limit: 60 req/min/user, 120 req/min/IP (Worker KV counter).
- CORS: allow extension origin (`chrome-extension://<id>`) + site origin for
  the auth handoff page. Deny `*`.
- Health: `GET /healthz` → `{ ok: true, version }`.
- All timestamps ISO 8601 UTC.
