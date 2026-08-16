# 01 — Product Requirements Document (PRD)

## 1. One-liner

Turn any LinkedIn Sales Navigator or Recruiter search into a clean,
deduplicated, enriched, ATS-ready candidate spreadsheet in one click.

## 2. User & buyer

- **User:** agency recruiters (primary persona: tech-recruiting agency
  recruiter/sourcer, 1–20 person agency, US/EU/UK, has a Sales Navigator or
  LinkedIn Recruiter seat).
- **Buyer:** same person or their agency owner. Expenses the tool. Price
  insensitivity up to ~$50/mo when ROI is hours saved per week.
- **Explicit non-target in v1:** SDR/sales prospecting teams (served by Wiza,
  Apollo, Evaboot, Scrupp). We win by being recruiter-shaped, not by being a
  cheaper generic scraper.

## 3. Problem

A recruiter runs a Sales Navigator search (e.g. "backend engineers, Berlin,
5+ yrs"), gets 25–1000 results, and then manually copies profile data into a
sheet, guesses/verifies emails with 2–3 other tools, cleans and reformats
columns, and imports into an ATS (Greenhouse/Lever). 2–3 hours per search,
several searches per week, error-prone, mind-numbing.

## 4. v1 scope (in)

| # | Capability | Notes |
|---|---|---|
| F1 | One-click export of the current Sales Navigator **people search** results | Auto-paginates at human speed up to a user-set cap (default 100, max 1000/day) |
| F2 | Same for **LinkedIn Recruiter** search results (if user has Recruiter) | Second DOM profile; ship behind a flag if fixtures are hard to obtain pre-launch |
| F3 | Extracted fields | full name, headline/title, current company, tenure at company, total experience (if shown), location, profile URL, open-to-work badge, mutual connections count |
| F4 | Derived fields | seniority bucket (rule-based from title), name split (first/last), company domain guess |
| F5 | Enrichment (paid plans) | verified work email via enrichment API through our backend; per-row status: `verified / risky / not_found` |
| F6 | Dedupe | within export and against user's local export history (hash-based, client-side) |
| F7 | Output: CSV download | UTF-8, RFC 4180, Excel-safe |
| F8 | Output: Google Sheets push | OAuth via chrome.identity; appends to a chosen sheet |
| F9 | ATS presets | column mapping presets: Greenhouse, Lever, Generic. User-editable mapping saved locally |
| F10 | Safe-rate throttle | randomized 2–5s pagination delay, daily export ceiling, visible to user as a feature ("account-safe mode"), not hidden |
| F11 | Free tier | 50 exported rows/month, no enrichment, watermark column removed on paid |
| F12 | Paid tier ($39/mo or $390/yr) | 2,000 enriched rows/mo, all presets, Sheets push |
| F13 | Account/auth | email magic link; license checked server-side per export |
| F14 | Payments | DodoPayments hosted checkout + webhooks; upgrade/downgrade/cancel reflected within 1 min |
| F15 | Selector remote config + extraction telemetry | see docs/03; this is a v1 feature, not an afterthought — it is the maintenance moat |

## 5. Explicitly NOT in v1 (focus/support reasons)

- Automated messaging, connection requests, sequencing — **never**, not just v1
  (ToS line; users get banned; CWS risk).
- Team seats / shared quotas — support burden before product-market fit.
- Direct ATS API integrations (Greenhouse Harvest API etc.) — presets deliver
  80% of the value; API integrations create OAuth-app review dependencies on
  third parties.
- Public API / MCP endpoint.
- Multi-vertical presets (sales, agencies…) — dilutes positioning.
- Firefox/Edge builds — Chrome-only until MRR > $500 (Edge sideloads Chrome
  CWS anyway for many users).
- Phone-number enrichment — cost per lookup too high for the price point.

## 6. Success metrics

- Activation: ≥60% of installs complete a first export within 24h.
- Extraction health: ≥95% field-level extraction success on monitored fields
  (rolling 7-day, from telemetry).
- Conversion: ≥4% free→paid within 30 days of first export.
- Business checkpoints (from the strategy doc): first revenue in Sept; 8–12
  paying end-Oct; $500+ MRR by Dec 31.

## 7. Key risks (product-level)

1. LinkedIn DOM churn breaks extraction → mitigated by docs/03 remote config +
   telemetry + fixture regression suite.
2. User accounts flagged by LinkedIn → mitigated by read-only design, human-speed
   throttle, daily ceilings, and honest in-product guidance ("don't run 1000-row
   exports on a 1-week-old account").
3. CWS rejection → mitigated by minimal permissions, clear single-purpose
   description, no remote code, honest data disclosure (docs/08, 09).
4. Enrichment cost blowout → per-plan hard caps enforced server-side; enrichment
   only on paid plans.
