# 07 — Build Plan (phased for Claude Code sessions)

Each phase ≈ one focused Claude Code session. Do not start a phase until the
previous phase's Definition of Done (DoD) passes. Human tasks are marked 👤 —
Claude Code cannot do these.

## Phase 0 — Scaffold (½ session)

- Monorepo: pnpm workspaces (`extension`, `backend`, `shared`, `site`).
- `/extension`: WXT + TypeScript + Svelte template; MV3 manifest with ONLY the
  permissions in CLAUDE.md §Guardrail-5; host permission `https://www.linkedin.com/*`.
- `/backend`: Hono on Workers template + wrangler.toml (no deploy yet).
- `/shared`: `types.ts` with `CandidateRecord`, `FieldResult`, `ExtractedCard`,
  API request/response types from docs/05.
- Vitest wired at root; CI-less for now (solo) but `pnpm verify` script =
  typecheck + test.
- **DoD:** dev build loads unpacked in Chrome; empty side panel opens; `pnpm verify` green.

## Phase 1 — Extraction engine + fixtures (1–2 sessions) ← the moat

- 👤 Capture 2–3 REAL sanitized fixtures per docs/03 §7 for
  `salesnav_people_search` (Recruiter profile can lag to Phase 8).
- Implement: engine (strategy tiers, FieldResult contract), postprocess
  registry, seniority rules, name split, tenure parser, zod config schema,
  bundled config snapshot authored against the fixtures.
- Unit tests: every field × every fixture; the 40-name split table; tenure
  parser table.
- **DoD:** ≥95% field extraction across fixtures; engine never throws on a
  mutilated fixture (test with randomly deleted nodes).

## Phase 2 — Content script + throttle + job pipeline (1 session)

- Page-profile detection (URL + probes), card discovery, pagination via
  `throttle.ts` (docs/03 §6 numbers exactly), row streaming to service worker,
  captcha/warning abort probe.
- Service worker job state machine; in-memory rows; dedupe hash set; job
  history in storage.local.
- **DoD:** 👤 on a live Sales Nav search, a 100-row dry run completes with
  human-speed paging, produces rows in worker memory (log), aborts cleanly when
  human navigates away.

## Phase 3 — Output layer (½ session)

- `csv.ts` (RFC 4180, BOM, formula-injection guard), preset mapper + bundled
  Greenhouse/Lever/Generic presets, downloads API save.
- Google Sheets: chrome.identity OAuth, append rows, create-sheet-if-missing.
- 👤 Create Google Cloud OAuth client (free) for the extension id.
- **DoD:** exported CSV opens clean in Excel + Google Sheets incl. commas,
  quotes, emoji, RTL names; Sheets push appends correctly twice without dupes.

## Phase 4 — Side panel UI (1 session)

- All screens/states in docs/06 against mocked backend (`lib/api.ts` mock mode).
- Preset editor with storage.sync persistence.
- 👤 Verify current Greenhouse/Lever import headers; correct preset JSONs
  (docs/04 §6 marks them as drafts).
- **DoD:** every state S1–S6, E1–E7 reachable via mock switches; keyboard-only
  walkthrough passes.

## Phase 5 — Backend (1–2 sessions)

- Supabase schema (docs/04 §4) via migration SQL; Hono routes per docs/05;
  JWT auth; magic-link flow with free-tier email provider (👤 create account;
  record choice in docs/05 §1); reservation quota logic incl. rolling-24h;
  selector-config endpoint serving from `selector_configs`; telemetry ingest.
- Dodo webhooks: 👤 create DodoPayments account, products (pro_monthly $39,
  pro_annual $390), webhook secret; verify CURRENT event names against Dodo
  docs and update docs/05 §6. Implement idempotent handlers + signature check.
- **DoD:** local `wrangler dev` + real Supabase dev project: full auth → reserve
  → commit cycle green in an integration test script; webhook replay (Dodo test
  events) flips plan correctly and idempotently.

## Phase 6 — Wire extension ↔ backend ↔ payments (1 session)

- Replace api mock; auth handoff page on site; enrichment batching in worker
  (25/batch, allowance-exhausted path); E1–E3 states live.
- 👤 Load $40 enrichment credits (Sept 1); pick provider; implement adapter.
- **DoD:** 👤 end-to-end on live page: free-tier 50-row export; upgrade via Dodo
  TEST checkout; 200-row enriched export; usage bars correct; cancel-mid-job
  commits partial usage.

## Phase 7 — Hardening + store prep (1 session)

- Telemetry events wired; config remote-load with cache/fallback chain tested
  (kill the endpoint, extension still works on snapshot).
- `pnpm zip` production build; manifest description/single-purpose text; icons;
  screenshots (👤 capture on live UI with fake-data overlay); privacy policy +
  terms pages on GitHub Pages; CWS data-disclosure answers drafted from docs/08.
- 👤 Pay $5 CWS fee, complete trader disclosure (SMS-verified number), submit.
- **DoD:** zip passes `wxt zip` validation; docs/09 checklist 100% ticked;
  submission uploaded.

## Phase 8 — Post-launch fast-follows (as demanded, not before)

- Recruiter (`recruiter_search`) profile GA (fixtures → config → test).
- Preset requests from real users; annual-plan nudge; review-ask tuning.
- First selector-hotfix drill: 👤 simulate breakage by activating a stale
  config, confirm alert → fix → 5-min propagation works. Do this BEFORE it
  happens for real.

## Session hygiene for Claude Code

- Start each session: "Read CLAUDE.md, docs/07 Phase N, and the docs it
  references. List the tasks, then execute."
- One phase per branch; `pnpm verify` before merge; update docs when reality
  diverges (that instruction is in CLAUDE.md — enforce it).
- If a task needs live-LinkedIn info (markup, flows), STOP and request a
  fixture/screenshot rather than guessing (CLAUDE.md "should NOT do" list).
