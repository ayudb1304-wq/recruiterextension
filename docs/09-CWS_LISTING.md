# 09 — Chrome Web Store Listing & Launch Assets

## 1. Naming (keyword-first — the highest-leverage free distribution decision)

The NAME field carries the most CWS search ranking weight. Candidates
(≤75 chars; pick after checking live competition for exact-phrase collisions):

1. **"Recruiter Export — Sales Navigator to CSV & ATS"** ← default choice
2. "LinkedIn Recruiter Export: Sales Navigator → CSV, Sheets"
3. "Sales Navigator Export for Recruiters — CSV + Emails"

Rules: must contain "Sales Navigator", "Export", and a recruiter signal.
"LinkedIn" inside the name risks trademark-complaint takedown pressure —
prefer forms where LinkedIn appears in the description, not the title
(option 1). 👤 Final check at submission time against current CWS practice.

## 2. Target search phrases (CWS internal search)

Primary: `sales navigator export`, `sales navigator to csv`,
`linkedin recruiter export`, `export linkedin search results`.
Secondary: `sales navigator scraper`, `linkedin to google sheets`,
`recruiter sourcing tool`, `linkedin candidate export greenhouse`.
Name covers primary #1–2; short description covers the rest naturally.

## 3. Short description (132 chars max)

"One-click export of Sales Navigator & Recruiter searches to clean CSV, Google
Sheets, and ATS-ready files with verified emails."

## 4. Full description skeleton

- Line 1: the exact pain ("Stop copy-pasting candidates into spreadsheets.").
- What it does (bullets: one-click export, verified emails, Greenhouse/Lever
  presets, dedupe, Sheets push).
- **Account-safe by design** section (human-speed paging, daily limits, read-
  only, no password required) — differentiator AND reviewer reassurance.
- Who it's for (recruiting agencies & sourcers).
- Free tier terms (50 rows/mo) + Pro ($39/mo, 2,000 enriched rows).
- Data honesty paragraph (mirrors privacy policy: "your candidate data never
  touches our servers").
- Not affiliated with LinkedIn disclaimer.

## 5. Asset checklist

| Asset | Spec | Note |
|---|---|---|
| Icon 128/48/16 | simple glyph: table+arrow | no LinkedIn logo/blue-in-a-square (trademark) |
| Screenshots ×5 | 1280×800 | S2 ready-state, S3 running, S4 done, preset editor, Sheets result — all with FAKE candidate data |
| Promo tile 440×280 | name + one-line value | |
| Demo video | 60–90s Loom → YouTube unlisted | also reused for outreach |

## 6. Submission checklist (👤 human, Sept 1 week)

- [ ] Google dev account + $5 one-time fee paid
- [ ] 2-Step Verification enabled
- [ ] Trader declaration: business email, address, VOIP phone SMS-verified
- [ ] Privacy policy URL live (site/privacy.html)
- [ ] Data-usage form answers = docs/08 §5 (no sale of data, no unrelated use,
      no creditworthiness use)
- [ ] Permissions justification notes = docs/08 §2 table, pasted into review
      notes field
- [ ] Single-purpose statement pasted
- [ ] Category: Productivity → Tools (verify best-fit at submission)
- [ ] Pricing: listing is free-with-in-app-purchases (billing handled off-store
      via DodoPayments — CWS no longer offers native payments)
- [ ] Review-time contact email monitored daily (expect 1–7 day review; DOM-
      touching LinkedIn extensions sometimes get slower review — plan for it)

## 7. Review-risk notes (pre-empting rejection)

- Reviewer question we should answer before asked (review notes): why
  linkedin.com host permission → single purpose text; why identity → Sheets
  export; confirmation of no remote code (selector config = data, schema-
  validated; include the schema file path).
- If rejected for "scraping" framing: resubmit with emphasis on user-initiated
  export of user-visible data, read-only design, rate limits; precedent
  category exists (many live Sales Navigator export extensions). Do NOT argue
  in the resubmission — adjust listing language.

## 8. Launch sequencing hooks (ties to strategy doc Phase B)

- Day 1: publish → convert the 3+ August verbal pre-commits personally (DM +
  Loom walkthrough each).
- Week 1–4: 10–15 personalized recruiter DMs/day referencing THEIR niche;
  free-value posts (e.g. "I analyzed 50 SalesNav boolean strings that fail —
  fixes inside") in r/recruiting, RecOps/sourcing Slacks, LinkedIn.
- Review flywheel: S4 one-time ask after first successful export; personally
  ask every paying customer at day 7.
- Product Hunt: November, after ≥10 reviews and a case study exist (per
  strategy doc; PH before social proof wastes the spike).
