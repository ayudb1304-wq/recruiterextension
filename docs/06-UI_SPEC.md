# 06 — UI Specification (Side Panel + Popup)

Surface: Chrome **side panel** (primary) opened via toolbar icon; the toolbar
popup is just a launcher ("Open panel" + status dot). Framework: Svelte.
Design: clean, dense, utilitarian — recruiters live in dense UIs. Light theme
only in v1. No onboarding carousel; the empty state teaches.

## 1. Screens

### S1 — Not on a supported page
- Illustration-free. Text: "Open a Sales Navigator or Recruiter people search
  and I'll take it from there." + link "See a 60-sec demo" (Loom).
- If logged out of the extension: inline email field for magic link (S5 flow).

### S2 — Ready (supported search detected)
- Header: detected surface badge ("Sales Navigator search") + result-count
  estimate if visible on page.
- Controls:
  - Rows to export: stepper/input, default 100, max = plan-remaining (shown).
  - Toggle: "Find & verify emails" (paid; free users see lock + upgrade link).
  - Toggle: "Skip already-exported candidates" (default on).
  - Preset select: Generic / Greenhouse / Lever / Edit presets…
  - Destination: CSV download | Google Sheets (connect on first use).
- Primary button: **Export N candidates**.
- Footer strip: "Account-safe mode: human-speed paging, max 1,000 rows/day."
  (Always visible. This is positioning, not fine print.)

### S3 — Running
- Progress: "Page 3 of 8 · 64 candidates · 61 enriched".
- Live extraction-health chip: green ≥95%, amber 80–95%, red <80% ("layout
  changed — capturing what I can").
- Cancel button (keeps rows so far → S4 with partial flag).

### S4 — Done
- Summary: rows, enriched/verified counts, skipped dupes, extraction health.
- Buttons: Download CSV / Open Sheet / Run again.
- If partial (cancelled, quota, or platform warning): amber banner with the
  specific reason and what was kept.
- Post-first-success only: one-time inline ask — "Saved you an hour? A Chrome
  Web Store review keeps this tool alive →" (dismiss forever option).

### S5 — Account / Plan
- Email, plan, usage bars (month + 24h), Manage billing (Dodo portal link),
  Upgrade buttons (open Dodo hosted checkout, email prefilled).
- Settings: telemetry opt-out, default preset, default row cap.

### S6 — Preset editor
- Table: output column ⇄ field mapping, drag to reorder, rename header,
  include/exclude. Save (to storage.sync) / Reset to default.

## 2. Error & edge states

| Id | Trigger | UI |
|---|---|---|
| E1 | Quota exhausted (month) | "You've used your 2,000 rows for September. Resets Oct 1." + upgrade/annual link for free/monthly |
| E2 | Rolling 24h ceiling | "Account-safe limit reached (1,000 rows/24h). Try again after {time}." No override. |
| E3 | Backend unreachable | Export allowed WITHOUT enrichment for paid users? NO — fail closed for enrichment, allow plain CSV export within cached quota mirror, sync commit later. Banner explains. |
| E4 | Platform warning/captcha detected | Job aborted. "LinkedIn showed an unusual-activity check, so I stopped to protect your account. Your {n} rows so far are saved." Never auto-retry. |
| E5 | Non-English LinkedIn UI | "Your LinkedIn is set to {lang}. v1 extracts English UI only — switch language or expect missing fields." Proceed allowed. |
| E6 | Free user toggles enrichment | Inline lock: "Verified emails are on Pro — $39/mo, cancel anytime." |
| E7 | Sheets auth failure | Retry + fallback to CSV in one click. |

## 3. Copy tone

Direct, zero hype, recruiter-respectful. Never say "AI-powered". Say what
happened and what to do next. All user-facing strings in
`extension/lib/strings.ts` (single file — makes copy tweaks and future i18n
trivial).

## 4. Empty/loading skeletons

Side panel must render <100 ms with cached state; network states hydrate in.
No spinners longer than 300 ms without a text explanation.

## 5. Accessibility

Keyboard operable end-to-end; visible focus; aria-labels on all controls;
contrast AA. (We sell to agencies — some have accessibility procurement rules;
also it's cheap to do now and painful later.)
