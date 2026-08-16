# _synthetic/ — engine test doubles, NOT LinkedIn markup

The HTML in this folder is invented. It does **not** claim to resemble any
LinkedIn page, and nothing here should ever be used to author real selectors.

Its only job is to exercise **engine mechanics** against a DOM:

- strategy tier ordering (first hit wins, winning tier recorded)
- each strategy `type` (`css`, `relative`, `textRegex`, `attr`, `urlParam`)
- the postprocess chain
- misses producing `{value: null, strategyTier: null}` rather than throwing
- resilience when nodes are randomly deleted (docs/07 Phase 1 DoD)

Real LinkedIn fixtures live in `../salesnav_people_search/` and
`../recruiter_search/` and can only be produced by the human capture +
sanitize procedure in docs/03 §7. Both folders are empty until then — see
`extension/lib/extraction/README.md`.

All people, companies and locations below are fictional.
