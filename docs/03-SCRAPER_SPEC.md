# 03 — Scraper / Extraction Specification

This is the core of the product and the maintenance moat. Read fully before
touching `extension/lib/extraction/`.

## 1. Principles

1. **Read-only.** The only permitted DOM interactions: scrolling containers and
   clicking pagination controls that reveal results the user's search already
   returned. Nothing that mutates LinkedIn state.
2. **Never trust the DOM.** LinkedIn A/B tests layouts per account, ships
   changes without notice, and uses obfuscated/generated class names. Every
   selector WILL break. The system is designed around graceful degradation,
   measurement, and hot-fixing via remote config.
3. **Fail soft, measure everything.** A missing field yields `null` + a recorded
   miss. A page that extracts <80% of expected fields emits a telemetry event.
   The extension never crashes or blocks the user because markup changed.
4. **Selectors are data.** All extraction targets are defined in a versioned
   JSON config, loadable remotely, with a bundled snapshot as fallback.

## 2. Page profiles

A **page profile** = detection rules + extraction map for one LinkedIn surface.

v1 profiles:

| Profile id | Surface | URL pattern | Result container concept |
|---|---|---|---|
| `salesnav_people_search` | Sales Navigator people search | `linkedin.com/sales/search/people*` | list of result "lead" cards |
| `recruiter_search` | LinkedIn Recruiter / Recruiter Lite search | `linkedin.com/talent/search*` | list of candidate cards |

Detection = URL match AND ≥2 structural probes passing (e.g., presence of a
results-list landmark and a pagination control). If URL matches but probes
fail, show "unsupported layout" state in UI + emit telemetry `profile_detect_fail`.

## 3. Selector strategy tiers

For every field, the config defines an ordered list of **strategies**. The
engine tries them in order; first hit wins; the winning tier is recorded.

Tier order (strongest → weakest):

1. **Structural/semantic anchors**: ARIA roles/labels, `data-*` attributes,
   landmark elements, stable id prefixes, element hierarchy relative to the
   card root ("first link inside the card header").
2. **Text-pattern anchors**: label text ("Current:", "· 3 yrs"), regex over
   a subtree's textContent. Locale-sensitive — v1 supports English UI only;
   detect non-English UI and warn (docs/06 §4 state E5).
3. **Obfuscated class names** (e.g. `artdeco-entity-lockup__title`): allowed
   ONLY as last-tier fallback, because they churn.

A strategy is expressed in config JSON, e.g.:

```json
{
  "field": "fullName",
  "strategies": [
    {"tier": 1, "type": "css", "selector": "[data-anonymize='person-name']"},
    {"tier": 1, "type": "relative", "from": "cardRoot", "path": "header a[href*='/sales/lead/']", "extract": "textContent"},
    {"tier": 3, "type": "css", "selector": ".artdeco-entity-lockup__title a", "extract": "textContent"}
  ],
  "postprocess": ["trim", "collapseWhitespace", "stripEmoji"]
}
```

Supported strategy `type`s the engine must implement: `css`, `relative`
(CSS scoped to card root), `textRegex` (regex over subtree text with capture
group), `attr` (attribute of matched node), `urlParam` (extract from an href).
`postprocess` is a whitelist of pure functions in `extraction/postprocess.ts` —
config can only reference registered names (this keeps config data-not-code).

### 3.1 Final grammar (as implemented)

The authoritative definition is the zod schema in
`extension/lib/extraction/config-schema.ts`. Fields the schema adds beyond the
sketch above, decided during Phase 1:

| Key | Where | Meaning |
|---|---|---|
| `extract` | `css`, `relative` | `"textContent"` (default) or `"exists"`. `"exists"` yields `"true"` when the selector matches and a miss otherwise — this is how boolean badges like `openToWork` are read without inventing a sixth strategy type. |
| `within` | `css` | `"card"` (default) or `"document"`. Almost everything is card-scoped; `"document"` exists for page-level probes. |
| `within` | `textRegex` | Optional CSS narrowing the subtree searched before the regex runs. |
| `flags`, `group` | `textRegex`, `urlParam` | Regex flags (default `i`) and capture-group index (default 1). |
| `param` \| `pattern` | `urlParam` | Either a query-string parameter name, or a regex capture over the whole URL. |
| `expected` | field map | Default `true`. `false` excludes the field from the page extraction-rate denominator — for fields that are legitimately absent on many cards (tenure, mutual connections, open-to-work), so their absence does not fake a "degraded" reading. |

A **profile** carries, alongside `fields`:

| Key | Meaning |
|---|---|
| `urlPatterns` | Regex sources matched against `location.href`. |
| `probes` + `minProbes` | Structural probes for detection (§2). Detection = URL match AND ≥ `minProbes` passing. |
| `resultsContainer`, `cardSelectors` | Ordered selector candidates; first non-empty match wins. |
| `pagination.nextButton` / `.scrollContainer` / `.pageIndicator` | Ordered candidates for the only two DOM interactions we permit, plus an optional progress reading. |
| `platformWarning` | Selectors that mean LinkedIn is showing an interstitial. Any match aborts the job (§6). |

Every string field is length-capped by the schema, and unknown keys are stripped
rather than stored. There is no key in the grammar that can carry an expression.

### 3.2 Registered postprocess names

`trim`, `collapseWhitespace`, `stripEmoji`, `stripZeroWidth`, `lowercase`,
`nullIfEmpty`, `cleanName`, `cleanCompany`, `normalizeTenure`, `canonicalizeUrl`,
`stripLeadingLabel`, `digitsOnly`, `firstLine`, `afterAt`, `beforeAt`.

Adding one means adding a pure, total function to `postprocess.ts` and to this
list. A step returning `null` short-circuits the chain to a miss.

## 4. Extraction engine contract

```ts
// shared/types.ts
interface FieldResult<T = string> {
  value: T | null;
  confidence: 'high' | 'medium' | 'low'; // by tier: 1→high, 2→medium, 3→low
  strategyTier: 1 | 2 | 3 | null;        // null = all strategies missed
}

interface ExtractedCard {
  fields: Record<FieldName, FieldResult>;
  cardIndex: number;
  pageNumber: number;
  extractedAt: string; // ISO
  profileId: string;
  configVersion: string;
}
```

Rules:
- Per-card extraction wrapped in try/catch; a throwing extractor logs
  `extractor_exception` and yields nulls, never aborts the job.
- Engine computes per-page `extractionRate` = fields extracted / fields
  expected. `< 0.8` → telemetry event `extraction_degraded` with per-field miss
  counts and `configVersion` (NO scraped values, no PII in telemetry).
- Duplicate card guard: cards hashed (docs/04 §3) and skipped if already seen
  in this job.

## 5. Remote selector config

- Endpoint: `GET {API_BASE}/config/selectors?profile=<id>&v=<extensionVersion>`
  → `{configVersion, profile: {...}}`, edge-cached 5 min. **As implemented**, the
  loader accepts both that single-profile shape and a full
  `{configVersion, profiles: {...}}` document, merging a single profile over the
  bundled set so the other profile keeps working. No active config in the
  database is a `204`, not an error — the extension falls back to its snapshot,
  which is the designed behaviour.
- Extension caches last-good config in `chrome.storage.local`; a bundled
  snapshot (`extension/lib/extraction/config.snapshot.json`) ships in the CRX
  as final fallback. Load order: fresh remote → cached → bundled.
- Config is validated against a zod schema on load; invalid remote config is
  rejected (keep last-good) + telemetry `config_invalid`.
- **Compliance note (do not violate):** config contains only declarative
  selector/regex/postprocess-name data matched against the schema. No JS, no
  eval, no dynamic imports. This keeps us inside MV3's remote-code prohibition
  while still allowing selector hot-fixes without CWS re-review (docs/08 §3).

## 6. Throttle & safety layer (`lib/throttle.ts`)

- Pagination delay: uniform random **2000–5000 ms** ± jitter; additionally a
  1-in-8 chance of a longer "reading pause" of 8–15 s.
- Scroll behavior: incremental scrolls (300–800 px steps, 150–400 ms apart) to
  mimic reading, not instant jumps.
- Hard caps (client-enforced AND server-verified via quota):
  - max 25 pages per job (Sales Nav page = 25 results → 625 rows theoretical;
    UI default cap 100 rows, user-raisable to plan limit),
  - max 1000 rows per rolling 24h per user,
  - one job at a time; concurrent job attempts rejected in UI.
- If LinkedIn shows an interstitial/captcha/unusual-activity signal (detected
  by probe: results list disappears + warning landmark appears), **abort the
  job immediately**, keep rows already extracted, show state E4 (docs/06), emit
  `abort_platform_warning`. Never auto-retry past a warning.
- Caps are product features, surfaced in UI as "Account-safe mode" — not hidden.
  Do not add a "turbo mode".

## 7. Fixture capture procedure (human-in-the-loop)

Claude Code must never invent LinkedIn markup. When a fixture is needed:

1. Human opens the target page, runs the capture snippet (dev-only command in
   side panel when built with `DEV_CAPTURE=1`): serializes the results-list
   subtree HTML.
2. Sanitizer (`scripts/sanitize-fixture.ts`) replaces all names, companies,
   locations, image URLs, and profile URLs with fake equivalents while
   preserving structure/attributes exactly.
3. Save under `extension/fixtures/<profileId>/<yyyy-mm-dd>-<note>.html`.
   The sanitizer ships as `scripts/sanitize-fixture.mjs`; raw captures land as
   `raw-*.html` and are gitignored. **Status: no real fixture exists yet.** The
   bundled `config.snapshot.json` is an unverified seed (`configVersion:
   "0.0.0-seed"`) built from this document's own selector examples — see
   `extension/lib/extraction/README.md`. Until a real capture lands, treat every
   selector in it as a hypothesis.
4. Unit tests run every profile's extraction map against ALL its fixtures;
   old fixtures stay as regression tests (a selector fix must not break on the
   older layout still being served to some accounts).

## 8. Field inventory (v1)

| FieldName | Source surface(s) | Notes |
|---|---|---|
| `fullName` | both | |
| `headline` | both | raw headline string |
| `currentTitle` | both | parsed from "Current:" line when present, else headline heuristic |
| `currentCompany` | both | |
| `tenureAtCompany` | salesnav | "3 yrs 2 mos in role/company" text-regex |
| `totalExperienceHint` | recruiter | if surfaced |
| `location` | both | |
| `profileUrl` | both | canonicalized (strip tracking params); Sales Nav lead URLs converted to public form when derivable, else kept as-is |
| `openToWork` | both | boolean, badge probe |
| `mutualConnections` | salesnav | integer, text-regex |
| Derived: `firstName`,`lastName` | — | split heuristic + honorific strip |
| Derived: `seniorityBucket` | — | rule table in `extraction/seniority.ts` (IC/Senior/Lead/Manager/Director/VP/CXO), pure function, unit-tested |
| Derived: `companyDomainGuess` | — | company name → domain via enrichment provider (paid) or blank |

## 9. Telemetry (privacy-preserving, docs/08 §5)

Event set: `profile_detect_fail`, `extraction_degraded`, `extractor_exception`,
`config_invalid`, `abort_platform_warning`, `job_summary` (rows, duration,
extraction rate, config version, plan tier). Payloads contain counts, rates,
versions, profile ids — never scraped values, queries, or URLs beyond the
profile id. Batched, sent at job end only. Opt-out toggle in settings.
