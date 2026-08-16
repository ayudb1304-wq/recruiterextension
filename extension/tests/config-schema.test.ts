import { describe, expect, it } from 'vitest';
import snapshot from '../lib/extraction/config.snapshot.json';
import { parseSelectorConfig } from '../lib/extraction/config-schema';
import { POSTPROCESS_NAMES } from '../lib/extraction/postprocess';

const validProfile = {
  profileId: 'salesnav_people_search',
  urlPatterns: ['^https://www\\.linkedin\\.com/sales/search/people'],
  probes: [
    { id: 'a', selector: '#a' },
    { id: 'b', selector: '#b' },
  ],
  resultsContainer: ['#a'],
  cardSelectors: ['li'],
  pagination: {},
  fields: [
    {
      field: 'fullName',
      strategies: [{ tier: 1, type: 'css', selector: '#name' }],
    },
  ],
};

const validConfig = {
  configVersion: '2026-08-16.1',
  profiles: { salesnav_people_search: validProfile },
};

describe('bundled snapshot', () => {
  it('is structurally valid against the schema', () => {
    const parsed = parseSelectorConfig(snapshot);
    expect(parsed.ok, parsed.ok ? '' : parsed.issue).toBe(true);
  });

  it('ships both v1 profiles', () => {
    const parsed = parseSelectorConfig(snapshot);
    if (!parsed.ok) throw new Error(parsed.issue);
    expect(Object.keys(parsed.config.profiles).sort()).toEqual([
      'recruiter_search',
      'salesnav_people_search',
    ]);
  });

  it('uses only registered postprocess names', () => {
    const parsed = parseSelectorConfig(snapshot);
    if (!parsed.ok) throw new Error(parsed.issue);
    for (const profile of Object.values(parsed.config.profiles)) {
      for (const field of profile!.fields) {
        for (const name of field.postprocess) {
          expect(POSTPROCESS_NAMES).toContain(name);
        }
      }
    }
  });

  it('never uses a class-name selector as a tier-1 strategy (docs/03 §3)', () => {
    const parsed = parseSelectorConfig(snapshot);
    if (!parsed.ok) throw new Error(parsed.issue);
    for (const profile of Object.values(parsed.config.profiles)) {
      for (const field of profile!.fields) {
        for (const strategy of field.strategies) {
          if (strategy.tier !== 1) continue;
          const selector =
            'selector' in strategy ? strategy.selector : 'path' in strategy ? strategy.path : '';
          // A leading `.foo` or a bare `.artdeco-*` anywhere is the churn-prone
          // obfuscated set — allowed only at tier 3.
          expect(selector).not.toMatch(/\.artdeco-/);
          expect(selector.trim().startsWith('.')).toBe(false);
        }
      }
    }
  });

  it('is marked as an unverified seed until real fixtures land', () => {
    const parsed = parseSelectorConfig(snapshot);
    if (!parsed.ok) throw new Error(parsed.issue);
    // Delete this assertion in the same commit that lands real fixtures and a
    // dated configVersion (docs/07 Phase 1).
    expect(parsed.config.configVersion).toBe('0.0.0-seed');
  });
});

describe('parseSelectorConfig', () => {
  it('accepts a minimal valid config and applies defaults', () => {
    const parsed = parseSelectorConfig(validConfig);
    if (!parsed.ok) throw new Error(parsed.issue);
    const profile = parsed.config.profiles.salesnav_people_search!;
    expect(profile.minProbes).toBe(2);
    expect(profile.platformWarning).toEqual([]);
    expect(profile.fields[0]!.postprocess).toEqual([]);
    expect(profile.fields[0]!.expected).toBe(true);
  });

  it('rejects rather than throws on garbage', () => {
    for (const bad of [null, undefined, 42, 'nope', [], {}]) {
      const parsed = parseSelectorConfig(bad);
      expect(parsed.ok).toBe(false);
    }
  });

  it('rejects an unregistered postprocess name — config cannot name code', () => {
    const bad = structuredClone(validConfig);
    (bad.profiles.salesnav_people_search.fields[0] as Record<string, unknown>).postprocess = [
      'evalThis',
    ];
    expect(parseSelectorConfig(bad).ok).toBe(false);
  });

  it('rejects an unknown strategy type', () => {
    const bad = structuredClone(validConfig);
    (bad.profiles.salesnav_people_search.fields[0] as Record<string, unknown>).strategies = [
      { tier: 1, type: 'javascript', code: 'fetch("https://evil.example")' },
    ];
    expect(parseSelectorConfig(bad).ok).toBe(false);
  });

  it('rejects an unknown field name', () => {
    const bad = structuredClone(validConfig);
    (bad.profiles.salesnav_people_search.fields[0] as Record<string, unknown>).field = 'ssn';
    expect(parseSelectorConfig(bad).ok).toBe(false);
  });

  it('rejects a tier outside 1-3', () => {
    const bad = structuredClone(validConfig);
    (bad.profiles.salesnav_people_search.fields[0] as Record<string, unknown>).strategies = [
      { tier: 9, type: 'css', selector: '#x' },
    ];
    expect(parseSelectorConfig(bad).ok).toBe(false);
  });

  it('requires at least two detection probes', () => {
    const bad = structuredClone(validConfig);
    bad.profiles.salesnav_people_search.probes = [{ id: 'a', selector: '#a' }];
    expect(parseSelectorConfig(bad).ok).toBe(false);
  });

  it('drops unknown top-level keys rather than executing anything', () => {
    const withExtra = {
      ...validConfig,
      _readme: 'note',
      script: 'alert(1)',
      onLoad: 'fetch("https://evil.example")',
    };
    const parsed = parseSelectorConfig(withExtra);
    if (!parsed.ok) throw new Error(parsed.issue);
    expect(parsed.config).not.toHaveProperty('script');
    expect(parsed.config).not.toHaveProperty('onLoad');
    expect(parsed.config).not.toHaveProperty('_readme');
  });

  it('caps selector and regex length so config cannot smuggle a payload', () => {
    const bad = structuredClone(validConfig);
    (bad.profiles.salesnav_people_search.fields[0] as Record<string, unknown>).strategies = [
      { tier: 1, type: 'css', selector: 'a'.repeat(1000) },
    ];
    expect(parseSelectorConfig(bad).ok).toBe(false);
  });
});
