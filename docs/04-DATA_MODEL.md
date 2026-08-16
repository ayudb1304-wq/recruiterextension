# 04 — Data Model

## 1. CandidateRecord (shared/types.ts — the one true shape)

```ts
interface CandidateRecord {
  // extracted
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  headline: string | null;
  currentTitle: string | null;
  currentCompany: string | null;
  tenureAtCompany: string | null;      // normalized "3y 2m" format
  totalExperienceHint: string | null;
  location: string | null;
  profileUrl: string | null;
  openToWork: boolean | null;
  mutualConnections: number | null;
  // derived
  seniorityBucket: 'IC'|'Senior'|'Lead'|'Manager'|'Director'|'VP'|'CXO'|null;
  companyDomainGuess: string | null;
  // enrichment (paid)
  email: string | null;
  emailStatus: 'verified'|'risky'|'not_found'|'skipped'|null;
  // meta
  extractionConfidence: 'high'|'medium'|'low';  // min tier across core fields
  dedupeHash: string;                            // see §3
  exportedAt: string;                            // ISO
}
```

Core fields for confidence calc: fullName, currentCompany, profileUrl.

## 2. Normalization rules (extraction/postprocess.ts + normalize.ts)

- Whitespace collapsed; zero-width chars and emoji stripped from names.
- Honorifics stripped for name split: Dr., Mr., Ms., Mx., Prof., PhD/MBA/etc.
  suffixes moved out of lastName. Name split heuristic: last token = lastName,
  rest = firstName; particles (van, von, de, da, bin, al) attach to lastName.
  Unit-test with a fixture list of ≥40 tricky names.
- `tenureAtCompany`: parse "X yrs Y mos" / "X yr" / "less than a year" →
  normalized "Xy Ym" / "<1y". Keep raw in headline if unparseable → null.
- Company name cleanup for domain guessing: strip legal suffixes
  (Inc, LLC, GmbH, Ltd, Pvt, SAS…), punctuation, "· Full-time" fragments.
- Location kept as displayed (no geocoding in v1).
- CSV safety: values starting with `= + - @` prefixed with `'` (formula-
  injection guard); RFC 4180 quoting; UTF-8 BOM for Excel.

## 3. Dedupe

- `dedupeHash = sha256(lowercase(canonicalProfileUrl || fullName + '|' + currentCompany))`.
- Within-job: hash set in memory.
- Cross-job (local history): hashes stored in `chrome.storage.local` ring
  buffer (last 25,000 hashes). UI toggle: "skip candidates I've already
  exported" (default ON). Only hashes stored — no candidate data at rest beyond
  the user's own downloaded files.
- Backend NEVER stores candidate records or hashes tied to identities; enrich
  requests are processed and dropped (logs scrubbed of payloads).

## 4. Database schema (Supabase / Postgres)

```sql
create table users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  created_at timestamptz default now(),
  last_seen_at timestamptz
);

create table subscriptions (
  user_id uuid references users(id) primary key,
  dodo_customer_id text,
  dodo_subscription_id text,
  plan text not null default 'free',        -- free | pro_monthly | pro_annual
  status text not null default 'active',    -- active | past_due | cancelled
  current_period_end timestamptz,
  updated_at timestamptz default now()
);

create table usage_counters (
  user_id uuid references users(id),
  period_ym text not null,                  -- '2026-09'
  rows_exported int not null default 0,
  rows_enriched int not null default 0,
  jobs_run int not null default 0,
  primary key (user_id, period_ym)
);

-- rolling 24h ceiling enforced via a small events table
create table export_events (
  user_id uuid references users(id),
  at timestamptz not null default now(),
  rows int not null
);
create index on export_events (user_id, at);

create table selector_configs (
  id serial primary key,
  profile_id text not null,
  config_version text not null,
  config jsonb not null,                    -- validated against zod schema before insert
  is_active boolean default false,
  created_at timestamptz default now()
);

create table telemetry_daily (
  day date not null,
  profile_id text not null,
  config_version text,
  event text not null,
  count int not null default 0,
  extraction_rate_avg numeric,
  primary key (day, profile_id, event, config_version)
);
```

RLS: service-role key only (backend); no anon access. Implemented as RLS enabled
with **no permissive policies at all**, so a leaked anon key reads nothing.

### 4.1 Tables added during Phase 5

The sketch above needed three more tables, all operational, none holding
candidate data:

```sql
-- magic-link tokens: hashed, single-use, 15 min TTL (docs/05 §1)
auth_tokens (token_hash pk, email, created_at, expires_at, used_at)

-- quota reservations (docs/05 §4); uncommitted ones expire without counting
quota_reservations (job_token pk, user_id, allowed_rows, enrich_allowed,
                    enriched_used, created_at, expires_at,
                    committed_at, committed_rows, committed_enriched)

-- webhook idempotency by event id (docs/05 §6)
processed_webhooks (event_id pk, processed_at)
```

`processed_webhooks` is a Postgres table, not Worker KV as docs/05 §6 originally
said: it needs a real uniqueness constraint to make "insert or conflict" the
idempotency test, and KV's eventual consistency cannot give that.

### 4.2 Quota arithmetic lives in Postgres, not the Worker

`reserve_quota`, `commit_quota` and `consume_enrichment` are plpgsql functions
(`backend/migrations/0001_init.sql`). Doing this in the Worker would let two
concurrent panels both pass the same check and both reserve the full remaining
allowance. Two consequences worth knowing:

- **Live reservations count against the caps** until they commit or expire, so
  opening ten panels cannot claim the month ten times over.
- `commit_quota` is **idempotent per job token**, so the extension's offline
  commit-retry queue (docs/06 state E3) can safely replay.

Retention housekeeping is a `prune_old_rows()` function: export events 30 days,
usage counters and telemetry 13 months (matching docs/08 §5).

## 5. What we deliberately DO NOT store

- Candidate records, names, emails, profile URLs — never persisted server-side.
- LinkedIn search queries or page URLs.
- Google OAuth tokens (extension-side only, via chrome.identity).
This is both a privacy stance (docs/08) and a liability reducer, and it goes in
the CWS data-disclosure form verbatim.

## 6. ATS export presets (extension/lib/presets/*.json)

Preset = ordered column list mapping CandidateRecord fields → output headers.

**Greenhouse (candidate import CSV):**
`First Name, Last Name, Company, Title, Location, Email, LinkedIn URL, Source, Notes`
- Source hardcoded "RecruitExport"; Notes = headline + tenure.

**Lever:**
`name, email, company, title, location, links, origin, tags`
- links = profileUrl; origin = "sourced"; tags = seniorityBucket.

**Generic (default):**
every CandidateRecord field, snake_case headers, in the interface order.

Presets are user-editable (reorder/rename/exclude) with edits saved to
`chrome.storage.sync`; "reset to default" restores the bundled JSON. Verify the
exact expected headers against current Greenhouse/Lever import docs during
Phase 4 of the build plan and correct these lists — treat the above as drafts.

## 7. Quota model

| Plan | rows_exported/mo | rows_enriched/mo | rolling 24h rows | price |
|---|---|---|---|---|
| free | 50 | 0 | 50 | $0 |
| pro_monthly | 2,000 | 2,000 | 1,000 | $39 |
| pro_annual | 2,000/mo | 2,000/mo | 1,000 | $390/yr |

Server is authoritative; client mirrors for UX. Reservation model in docs/05 §4
prevents mid-job quota surprises.
