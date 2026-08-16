# extraction/ — read this before touching selectors

## The bundled snapshot is a SEED, not a verified config

`config.snapshot.json` ships as `configVersion: "0.0.0-seed"`. Its selectors are:

- the examples the spec itself gives (docs/03 §3: `[data-anonymize='person-name']`,
  `.artdeco-entity-lockup__title a`), plus
- conservative structural/attribute anchors of the same family.

**None of them have been validated against a real LinkedIn page.** No fixtures
existed when the engine was written, and CLAUDE.md forbids inventing LinkedIn
DOM structure. So the seed is a shape to fix, not a config to trust.

Until real fixtures land, expect the engine to run and fail *soft* — nulls and
recorded misses, never a crash. That is the designed behaviour, and the
`extraction_degraded` telemetry event exists precisely for this state.

## Making it real (docs/07 Phase 1, docs/03 §7)

1. 👤 **Capture.** Open a Sales Navigator people search, run the dev-only capture
   command (`WXT_DEV_CAPTURE=1` build → side panel → "Capture fixture"). It
   serializes the results-list subtree only.
2. **Sanitize.** `pnpm tsx scripts/sanitize-fixture.ts <raw.html>` replaces every
   name, company, location, image URL and profile URL with fake equivalents
   while preserving structure and attributes exactly.
3. **Save** to `extension/fixtures/salesnav_people_search/<yyyy-mm-dd>-<note>.html`.
4. **Fix selectors** in `config.snapshot.json`, bump `configVersion` to
   `<yyyy-mm-dd>.<n>`, and run `pnpm test`.
5. **Keep old fixtures.** They are the regression suite — LinkedIn serves
   different layouts to different accounts, and a fix for today's markup must
   not break yesterday's.

Raw (unsanitized) captures are gitignored: `fixtures/**/raw-*.html`. Never
commit one.

## Tier discipline (docs/03 §3)

| Tier | What | Confidence | Use as |
|---|---|---|---|
| 1 | ARIA / `data-*` / structural anchors | high | primary |
| 2 | text-pattern regex ("Current:", "3 yrs") | medium | secondary |
| 3 | obfuscated class names (`artdeco-*`) | low | last resort only |

A field whose tier-1 strategies stop winning is an early warning that LinkedIn
changed markup — the telemetry watches tier distribution, not just success rate.
Never promote a class-name selector to tier 1 to make a number look better.

## Config is data, not code

`config-schema.ts` accepts only selectors, regex sources, and *names* of
functions registered in `postprocess.ts`. There is no field that can carry
JavaScript. This is what lets us hot-fix selectors from the server without a
CWS re-review while staying inside MV3's remote-code prohibition (docs/08 §3).
If you are about to add a field that holds an expression: don't.
