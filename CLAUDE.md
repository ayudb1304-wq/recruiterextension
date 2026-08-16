# CLAUDE.md — RecruitExport

MV3 Chrome extension that exports LinkedIn Sales Navigator / Recruiter search
results to clean, enriched, ATS-ready CSVs. Solo-founder product. Specs live in
`docs/` and are the single source of truth. If you make a design decision not
covered there, update the relevant doc in the same session.

## Repo layout

```
/extension        WXT-based MV3 extension (TypeScript)
  /entrypoints    content scripts, service worker, popup/sidepanel
  /lib            extraction engine, csv builder, throttle, presets
  /public         icons, _locales
/backend          Cloudflare Workers (Hono + TypeScript)
  /src/routes     auth, quota, enrich, webhooks, selector-config
  /src/db         Supabase client + queries
/shared           types shared by extension and backend (CandidateRecord, etc.)
/site             GitHub Pages: landing + privacy policy (plain HTML)
/docs             the spec set (01–09)
```

## Commands

- `pnpm dev` (in /extension): WXT dev build with HMR; load `/.output/chrome-mv3` unpacked.
- `pnpm build && pnpm zip` (in /extension): production zip for CWS upload.
- `pnpm dev` (in /backend): `wrangler dev` local worker.
- `pnpm deploy` (in /backend): `wrangler deploy`.
- `pnpm test` (root): vitest unit tests (extraction fixtures, csv builder, quota logic).
- `pnpm typecheck` (root): tsc across workspaces. Run before declaring any task done.

## Non-negotiable product guardrails

1. READ-ONLY on LinkedIn. Never implement: sending messages/InMails, connection
   requests, profile edits, likes, follows, or any DOM interaction that mutates
   LinkedIn state. Scrolling and pagination clicks to reveal already-listed
   results are the only permitted interactions. If a task seems to need more, stop
   and flag it — it's out of scope by design (docs/08).
2. HUMAN-SPEED. All pagination/scroll actions go through `lib/throttle.ts`
   (randomized delays, hard rate caps, per-day export ceiling). Never bypass it,
   including in tests against live pages.
3. NO CREDENTIALS. We never read, store, or prompt for LinkedIn passwords or
   cookies for off-browser use. The extension works only inside the user's own
   logged-in session.
4. SECRETS live only in the Worker (wrangler secrets). The extension bundle must
   contain zero API keys. Anyone can unzip a CRX.
5. MINIMAL PERMISSIONS. Host permissions: `https://www.linkedin.com/*` only.
   Extension permissions: `storage`, `sidePanel`, `downloads`, `identity` (for
   Google Sheets OAuth), `alarms`. Adding any permission requires updating
   docs/08 and the CWS listing justification text.
6. PII HANDLING. Scraped candidate data is processed in-memory and delivered to
   the user's CSV/Sheet. The backend stores counts and hashes for quota/dedupe,
   never full candidate records (docs/04 §5). Do not add candidate-data
   persistence "for convenience".

## Engineering conventions

- TypeScript strict everywhere. Shared types in `/shared` — never duplicate the
  `CandidateRecord` shape.
- Extraction NEVER throws on a missing field: every field extractor returns
  `{ value, confidence, strategyUsed }` and the record is emitted with nulls +
  a per-field miss recorded (docs/03 §4). A page-level extraction rate < 80%
  triggers telemetry, not a crash.
- No CSS-class-name selectors from LinkedIn's obfuscated set as PRIMARY
  strategy. Primary = structural/attribute/aria anchors; class names allowed
  only as fallback tier (docs/03 §3).
- Selector definitions are DATA, not code: they load from remote config with a
  bundled fallback snapshot (docs/03 §5). Fixing a broken selector must never
  require a CWS re-review.
- Every network call from the extension goes through `lib/api.ts` with the
  user's session token; no direct third-party calls from the extension.
- Tests: extraction runs against saved HTML fixtures in
  `extension/fixtures/` (sanitized, fake data). When LinkedIn changes markup,
  save a new fixture first, then fix selectors, keep old fixtures as regression.
- Conventional commits. Small PR-sized commits per task in docs/07.

## Definition of done (any task)

typecheck passes; unit tests pass; manual test script for the phase (docs/07)
executed; no new permissions; guardrails 1–6 intact; docs updated if behavior
diverged from spec.

## Things Claude Code should NOT do in this repo

- Don't scaffold a different framework (no CRA/Next/Vite-react-app inside
  /extension; WXT owns the build).
- Don't add analytics SDKs, remote code loading (`eval`, remote scripts — CWS
  prohibits it for MV3), or auto-update-bypassing tricks.
- Don't "improve" throttle timings downward.
- Don't invent LinkedIn DOM structure: if a fixture is missing, ask the human
  to capture one (docs/03 §7 capture procedure).
