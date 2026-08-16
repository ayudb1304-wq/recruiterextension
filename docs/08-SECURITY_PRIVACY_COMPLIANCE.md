# 08 — Security, Privacy & Compliance

## 1. Threat model (what we actually defend against)

| Threat | Defense |
|---|---|
| API keys stolen from CRX | No secrets in extension, ever. Enrichment via backend proxy only. |
| Quota abuse (free users scripting the backend) | JWT + reservation model + rolling caps + IP limits. Accept residual risk; free tier costs us $0 (no enrichment). |
| Webhook forgery (fake "subscribed" events) | Dodo signature verification + event-id idempotency. |
| CSV formula injection into recruiter's Excel | `'` prefix guard (docs/04 §2). |
| Config endpoint served malicious "selectors" | zod schema allows only declarative fields; postprocess limited to registered pure fns; no code paths from config. |
| Our backend breached | Nothing valuable there: no candidate data, no card data (Dodo holds it), no LinkedIn creds. Users table = emails only. State this in privacy policy. |
| User's LinkedIn account flagged | Throttle + ceilings + warning-abort + no write actions + honest UX guidance. Residual risk disclosed in Terms. |

## 2. Permissions policy (MV3 manifest)

| Permission | Justification (goes verbatim into CWS review notes) |
|---|---|
| `storage` | Save user settings, presets, export history hashes locally. |
| `sidePanel` | Primary UI surface. |
| `downloads` | Save the CSV the user requested. |
| `identity` | Google OAuth for the user's own Google Sheets export. |
| `alarms` | Periodic selector-config refresh. |
| Host `https://www.linkedin.com/*` | Read search results the user is viewing to build their export. Single-purpose core. |

Nothing else. No `tabs`, no `<all_urls>`, no `scripting` on arbitrary origins,
no `webRequest`. Any PR adding a permission must update this table + docs/09.

## 3. Chrome Web Store program-policy constraints we build around

Verified against current CWS policy pages during Phase 7 (👤 re-check at
submission; policies drift):

- **Single purpose**: listing + manifest description state one purpose —
  "export LinkedIn search results you can already see into spreadsheets."
- **No remote code** (MV3): our remote selector config is pure declarative
  JSON validated against a schema; no eval, no imported scripts, no WASM
  fetched at runtime. Documented in review notes proactively.
- **User data / privacy disclosures**: CWS data-usage form answers derived from
  §5 below; privacy policy URL required and live before submission.
- **Trader disclosure (EU DSA)**: paid extension ⇒ declare as trader; requires
  publicly displayed contact incl. SMS-verified phone. 👤 use dedicated VOIP
  number, not personal.
- **Affiliate/keyword spam rules**: listing keywords must be honest; no
  competitor names in the title (allowed in description context sparingly).

## 4. LinkedIn ToS posture (honest internal statement)

- LinkedIn's User Agreement prohibits scraping/automated data collection.
  A read-only, user-initiated, human-speed export of results the user's paid
  seat already displays sits in a widely-tolerated grey zone occupied by many
  commercial tools (Wiza, Evaboot, Scrupp class) — but it is NOT "compliant",
  and LinkedIn can act against users or the product.
- Product lines we therefore never cross (also CLAUDE.md Guardrail 1):
  no write actions, no bulk viewing beyond search results, no data resale,
  no shared/pooled LinkedIn accounts, no cookie export, no headless operation.
- User-facing honesty: Terms state the tool automates reading of pages the
  user can access, that LinkedIn's terms restrict automation, and usage is at
  the user's own risk; in-product "account-safe mode" framing reinforces real
  limits rather than promising immunity.
- Business continuity: docs/01 §7 risk 2; kill criteria live in the strategy
  doc (enforcement action ⇒ move to backup product).

## 5. Data handling summary (source for privacy policy + CWS form)

| Data | Where it lives | Retention |
|---|---|---|
| Candidate data scraped from LinkedIn | User's browser memory → user's CSV/Sheet | Never touches our servers except transient enrichment lookups (name+company in, email out; not logged, not stored) |
| Dedupe hashes | User's chrome.storage.local | Local only, user-clearable |
| User email | Supabase | Until account deletion |
| Subscription state | Supabase + DodoPayments (MoR holds billing/card data) | Per Dodo policy; we store no card data |
| Usage counters | Supabase | 13 months |
| Telemetry | Aggregated daily counters only | 13 months; opt-out toggle |
| Google Sheets token | chrome.identity (browser) | Never sent to backend |

GDPR stance: we are processor-light by design; data-subject requests = delete
users row + subscription row; candidate data is never held so no candidate DSR
surface exists on our side. (Enrichment provider is an independent controller —
link their policy in ours.)

## 6. Privacy policy (draft skeleton for site/privacy.html)

1. Who we are (product name, contact email, trader address/phone as per DSA).
2. What the extension reads and why (search results you view, to build your
   export). Explicit: "We do not receive or store the candidate data you
   export. It goes from your browser into your file."
3. Account data we hold (email, plan, usage counts).
4. Enrichment lookups (name+company sent to provider X to find a work email;
   not retained by us; provider policy link).
5. Payments (DodoPayments is Merchant of Record; card data never reaches us).
6. Telemetry (aggregate health stats; opt-out path).
7. Retention table (§5), rights, contact, updates.

## 7. Secrets & ops hygiene

- `wrangler secret` for all backend secrets; `.env` files gitignored; a
  `.env.example` documents required vars.
- Supabase service key never leaves the Worker.
- 2FA on: Google (CWS), Supabase, Cloudflare, Dodo, domain registrar (👤).
- Weekly free-tier backup: `pg_dump` of Supabase via GitHub Action to a private
  repo artifact (config-only data; acceptable).
