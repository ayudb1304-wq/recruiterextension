// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { extractPage, findCards } from '../lib/extraction/engine';
import { parseSelectorConfig, type ProfileConfig } from '../lib/extraction/config-schema';
import { detectProfile, isPlatformWarning } from '../lib/extraction/profiles';
import FIXTURE from '../fixtures/_synthetic/engine-cards.html?raw';

/**
 * A test-only profile config aimed at the synthetic fixture. It exercises every
 * strategy type and both tier-1-wins and tier-3-fallback paths. It is NOT a
 * LinkedIn config — see fixtures/_synthetic/README.md.
 */
const TEST_CONFIG_INPUT = {
  configVersion: 'test-1',
  profiles: {
    salesnav_people_search: {
      profileId: 'salesnav_people_search',
      urlPatterns: ['^https://www\\.linkedin\\.com/sales/search/people'],
      minProbes: 2,
      probes: [
        { id: 'resultsList', selector: '#results' },
        { id: 'resultCard', selector: 'li.result-card' },
        { id: 'pager', selector: 'nav.pager' },
      ],
      resultsContainer: ['#results'],
      cardSelectors: ['li.result-card'],
      pagination: {
        nextButton: ["button[aria-label='Next']"],
        scrollContainer: ['#results'],
        pageIndicator: ['.page-state'],
      },
      platformWarning: ['#captcha-internal', "form[action*='checkpoint']"],
      fields: [
        {
          field: 'fullName',
          strategies: [
            { tier: 1, type: 'css', selector: "[data-anonymize='person-name']" },
            { tier: 3, type: 'css', selector: 'a.lockup-title' },
          ],
          postprocess: ['cleanName', 'collapseWhitespace', 'nullIfEmpty'],
        },
        {
          field: 'profileUrl',
          strategies: [{ tier: 1, type: 'attr', selector: 'a.lockup-title', attribute: 'href' }],
          postprocess: ['canonicalizeUrl'],
        },
        {
          field: 'headline',
          strategies: [
            { tier: 1, type: 'css', selector: "[data-anonymize='headline']" },
            { tier: 3, type: 'css', selector: '.lockup-subtitle' },
          ],
          postprocess: ['collapseWhitespace', 'nullIfEmpty'],
        },
        {
          field: 'currentCompany',
          strategies: [
            { tier: 2, type: 'textRegex', within: '.meta', pattern: 'at\\s+(.+)$', group: 1 },
          ],
          postprocess: ['cleanCompany', 'nullIfEmpty'],
        },
        {
          field: 'currentTitle',
          strategies: [
            {
              tier: 2,
              type: 'textRegex',
              within: '.meta',
              pattern: 'Current:\\s*(.+?)\\s+at\\s',
              group: 1,
            },
          ],
          postprocess: ['collapseWhitespace', 'nullIfEmpty'],
        },
        {
          field: 'location',
          strategies: [
            { tier: 1, type: 'relative', from: 'cardRoot', path: "[data-anonymize='location']" },
            { tier: 3, type: 'css', selector: '.lockup-caption' },
          ],
          postprocess: ['collapseWhitespace', 'nullIfEmpty'],
        },
        {
          field: 'tenureAtCompany',
          strategies: [{ tier: 2, type: 'textRegex', within: '.tenure', pattern: '(.+)', group: 1 }],
          postprocess: ['normalizeTenure'],
          expected: false,
        },
        {
          field: 'mutualConnections',
          strategies: [
            { tier: 2, type: 'textRegex', within: '.shared', pattern: '([\\d,]+)\\s+shared', group: 1 },
          ],
          postprocess: ['digitsOnly'],
          expected: false,
        },
        {
          field: 'openToWork',
          strategies: [
            { tier: 1, type: 'css', selector: "[data-anonymize='open-to-work']", extract: 'exists' },
          ],
          postprocess: [],
          expected: false,
        },
      ],
    },
  },
};

function loadProfile(): ProfileConfig {
  const parsed = parseSelectorConfig(TEST_CONFIG_INPUT);
  if (!parsed.ok) throw new Error(parsed.issue);
  const profile = parsed.config.profiles.salesnav_people_search;
  if (!profile) throw new Error('missing test profile');
  return profile;
}

function mountFixture(html: string = FIXTURE): Document {
  document.body.innerHTML = html;
  return document;
}

let profile: ProfileConfig;

beforeEach(() => {
  profile = loadProfile();
  mountFixture();
});

describe('findCards', () => {
  it('finds every result card', () => {
    expect(findCards(document, profile)).toHaveLength(4);
  });

  it('returns [] rather than throwing when the container is gone', () => {
    mountFixture('<main></main>');
    expect(findCards(document, profile)).toEqual([]);
  });
});

describe('extractPage — strategy tiers', () => {
  it('prefers the tier-1 anchor and records high confidence', () => {
    const { cards } = extractPage({
      doc: document,
      profile,
      configVersion: 'test-1',
      pageNumber: 1,
    });
    const first = cards[0]!;
    expect(first.fields.fullName.value).toBe('Jane Doe');
    expect(first.fields.fullName.strategyTier).toBe(1);
    expect(first.fields.fullName.confidence).toBe('high');
  });

  it('falls back to the tier-3 class-name selector and records low confidence', () => {
    const { cards } = extractPage({
      doc: document,
      profile,
      configVersion: 'test-1',
      pageNumber: 1,
    });
    const second = cards[1]!;
    expect(second.fields.fullName.value).toBe('Carlos Ruiz, MBA');
    expect(second.fields.fullName.strategyTier).toBe(3);
    expect(second.fields.fullName.confidence).toBe('low');
    expect(second.fields.headline.strategyTier).toBe(3);
  });

  it('records a genuine miss as null with tier null — never an exception', () => {
    const { cards } = extractPage({
      doc: document,
      profile,
      configVersion: 'test-1',
      pageNumber: 1,
    });
    const sparse = cards[2]!;
    expect(sparse.fields.fullName.value).toBe('Wei Chen');
    expect(sparse.fields.location.value).toBeNull();
    expect(sparse.fields.location.strategyTier).toBeNull();
    expect(sparse.fields.currentCompany.value).toBeNull();
  });
});

describe('extractPage — strategy types and postprocessing', () => {
  it('runs css, relative, attr, textRegex and the postprocess chain', () => {
    const { cards } = extractPage({
      doc: document,
      profile,
      configVersion: 'test-1',
      pageNumber: 1,
    });
    const first = cards[0]!;
    expect(first.fields.profileUrl.value).toBe('https://www.linkedin.com/in/jane-doe-1');
    expect(first.fields.location.value).toBe('Berlin, Germany');
    expect(first.fields.currentTitle.value).toBe('Senior Backend Engineer');
    expect(first.fields.currentCompany.value).toBe('Acme'); // legal suffix stripped
    expect(first.fields.tenureAtCompany.value).toBe('3y 2m');
    expect(first.fields.mutualConnections.value).toBe('12');
    expect(first.fields.openToWork.value).toBe('true');
  });

  it('handles non-breaking spaces and decorated names', () => {
    const { cards } = extractPage({
      doc: document,
      profile,
      configVersion: 'test-1',
      pageNumber: 1,
    });
    const fourth = cards[3]!;
    expect(fourth.fields.fullName.value).toBe('Dr. Amara Okafor');
    expect(fourth.fields.headline.value).toBe('VP Engineering at Initech LLC');
    expect(fourth.fields.mutualConnections.value).toBe('1234');
  });

  it('keeps an unconvertible lead URL but strips its tracking params', () => {
    const { cards } = extractPage({
      doc: document,
      profile,
      configVersion: 'test-1',
      pageNumber: 1,
    });
    const url = cards[3]!.fields.profileUrl.value ?? '';
    expect(url).toContain('/sales/lead/');
    expect(url).not.toContain('trk=');
  });

  it('normalizes "less than a year"', () => {
    const { cards } = extractPage({
      doc: document,
      profile,
      configVersion: 'test-1',
      pageNumber: 1,
    });
    expect(cards[1]!.fields.tenureAtCompany.value).toBe('<1y');
  });

  it('carries cardIndex, pageNumber and configVersion through', () => {
    const { cards } = extractPage({
      doc: document,
      profile,
      configVersion: 'test-1',
      pageNumber: 3,
      startIndex: 50,
    });
    expect(cards[0]!.cardIndex).toBe(50);
    expect(cards[3]!.cardIndex).toBe(53);
    expect(cards[0]!.pageNumber).toBe(3);
    expect(cards[0]!.configVersion).toBe('test-1');
    expect(cards[0]!.profileId).toBe('salesnav_people_search');
  });
});

describe('extractPage — health metrics', () => {
  it('reports a rate and per-field miss counts', () => {
    const { extractionRate, fieldMisses, cardsFound } = extractPage({
      doc: document,
      profile,
      configVersion: 'test-1',
      pageNumber: 1,
    });
    expect(cardsFound).toBe(4);
    expect(extractionRate).toBeGreaterThan(0);
    expect(extractionRate).toBeLessThanOrEqual(1);
    // The sparse card misses these; counts only, no values (docs/03 §9).
    expect(fieldMisses.location).toBe(1);
    expect(fieldMisses.currentCompany).toBe(1);
    expect(Object.values(fieldMisses).every((v) => typeof v === 'number')).toBe(true);
  });

  it('reports rate 0 and cardsFound 0 when nothing matches', () => {
    mountFixture('<main><p>nothing here</p></main>');
    const result = extractPage({
      doc: document,
      profile,
      configVersion: 'test-1',
      pageNumber: 1,
    });
    expect(result.cardsFound).toBe(0);
    expect(result.extractionRate).toBe(0);
    expect(result.cards).toEqual([]);
  });
});

describe('extractPage — resilience (docs/07 Phase 1 DoD)', () => {
  /** Deterministic PRNG so a failure is reproducible. */
  function mulberry32(seed: number) {
    return () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('never throws on randomly mutilated fixtures', () => {
    for (let seed = 0; seed < 60; seed += 1) {
      const rand = mulberry32(seed);
      mountFixture();
      const all = Array.from(document.querySelectorAll('#results *'));
      for (const el of all) {
        if (rand() < 0.35) el.remove();
      }
      expect(() =>
        extractPage({ doc: document, profile, configVersion: 'test-1', pageNumber: 1 }),
      ).not.toThrow();
    }
  });

  it('never throws on an empty document', () => {
    mountFixture('');
    expect(() =>
      extractPage({ doc: document, profile, configVersion: 'test-1', pageNumber: 1 }),
    ).not.toThrow();
  });

  it('survives an invalid selector in config as a miss, not a crash', () => {
    const broken = structuredClone(TEST_CONFIG_INPUT);
    broken.profiles.salesnav_people_search.fields[0]!.strategies = [
      { tier: 1, type: 'css', selector: '>>>not a selector<<<' },
    ] as never;
    const parsed = parseSelectorConfig(broken);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const p = parsed.config.profiles.salesnav_people_search!;
    const { cards } = extractPage({ doc: document, profile: p, configVersion: 'x', pageNumber: 1 });
    expect(cards[0]!.fields.fullName.value).toBeNull();
  });
});

describe('detectProfile', () => {
  it('detects when the URL matches and probes pass', () => {
    const parsed = parseSelectorConfig(TEST_CONFIG_INPUT);
    if (!parsed.ok) throw new Error(parsed.issue);
    const outcome = detectProfile(
      document,
      'https://www.linkedin.com/sales/search/people?query=x',
      parsed.config,
    );
    expect(outcome.status).toBe('detected');
  });

  it('reports unsupported_layout when the URL matches but probes fail', () => {
    mountFixture('<main><p>redesigned</p></main>');
    const parsed = parseSelectorConfig(TEST_CONFIG_INPUT);
    if (!parsed.ok) throw new Error(parsed.issue);
    const outcome = detectProfile(
      document,
      'https://www.linkedin.com/sales/search/people',
      parsed.config,
    );
    expect(outcome.status).toBe('unsupported_layout');
  });

  it('reports not_a_search_page off-surface', () => {
    const parsed = parseSelectorConfig(TEST_CONFIG_INPUT);
    if (!parsed.ok) throw new Error(parsed.issue);
    const outcome = detectProfile(document, 'https://www.linkedin.com/feed/', parsed.config);
    expect(outcome.status).toBe('not_a_search_page');
  });
});

describe('isPlatformWarning', () => {
  it('is false on a normal page', () => {
    expect(isPlatformWarning(document, profile)).toBe(false);
  });

  it('fires when a challenge form appears (docs/03 §6)', () => {
    mountFixture('<form action="https://www.linkedin.com/checkpoint/challenge"></form>');
    expect(isPlatformWarning(document, profile)).toBe(true);
  });
});
