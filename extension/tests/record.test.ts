import { describe, expect, it } from 'vitest';
import type { ExtractedCard, FieldName, FieldResult } from '@recruitexport/shared';
import { FIELD_NAMES } from '@recruitexport/shared';
import { buildCandidateRecord, coreConfidence } from '../lib/extraction/record';
import { computeDedupeHash, dedupeKey, HashRingBuffer } from '../lib/extraction/dedupe';

function hit(value: string, tier: 1 | 2 | 3 = 1): FieldResult {
  return { value, confidence: tier === 1 ? 'high' : tier === 2 ? 'medium' : 'low', strategyTier: tier };
}
const miss: FieldResult = { value: null, confidence: 'low', strategyTier: null };

function card(overrides: Partial<Record<FieldName, FieldResult>> = {}): ExtractedCard {
  const fields = {} as Record<FieldName, FieldResult>;
  for (const name of FIELD_NAMES) fields[name] = { ...miss };
  Object.assign(fields, overrides);
  return {
    fields,
    cardIndex: 0,
    pageNumber: 1,
    extractedAt: '2026-08-16T10:00:00.000Z',
    profileId: 'salesnav_people_search',
    configVersion: 'test-1',
  };
}

describe('buildCandidateRecord', () => {
  it('maps extracted fields and computes derived ones', async () => {
    const record = await buildCandidateRecord(
      card({
        fullName: hit('Dr. Amara Okafor'),
        headline: hit('VP Engineering at Initech LLC'),
        currentCompany: hit('Initech LLC'),
        profileUrl: hit('https://www.linkedin.com/in/amara-okafor?trk=x'),
        location: hit('Lagos, Nigeria'),
        tenureAtCompany: hit('3 yrs 2 mos', 2),
        mutualConnections: hit('1,234', 2),
        openToWork: hit('true'),
      }),
      { exportedAt: '2026-08-16T12:00:00.000Z' },
    );

    expect(record.firstName).toBe('Amara');
    expect(record.lastName).toBe('Okafor');
    expect(record.currentTitle).toBe('VP Engineering');
    expect(record.seniorityBucket).toBe('VP');
    expect(record.companyDomainGuess).toBe('initech.com');
    expect(record.profileUrl).toBe('https://www.linkedin.com/in/amara-okafor');
    expect(record.tenureAtCompany).toBe('3y 2m');
    expect(record.mutualConnections).toBe(1234);
    expect(record.openToWork).toBe(true);
    expect(record.exportedAt).toBe('2026-08-16T12:00:00.000Z');
  });

  it('leaves enrichment fields null — the worker fills them later', async () => {
    const record = await buildCandidateRecord(card({ fullName: hit('Jane Doe') }));
    expect(record.email).toBeNull();
    expect(record.emailStatus).toBeNull();
  });

  it('emits a complete record of nulls rather than throwing on an empty card', async () => {
    const record = await buildCandidateRecord(card());
    expect(record.fullName).toBeNull();
    expect(record.firstName).toBeNull();
    expect(record.seniorityBucket).toBeNull();
    expect(record.extractionConfidence).toBe('low');
    expect(record.dedupeHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('prefers an explicit currentTitle over the headline heuristic', async () => {
    const record = await buildCandidateRecord(
      card({
        headline: hit('Ignore me at Nowhere'),
        currentTitle: hit('Staff Engineer'),
      }),
    );
    expect(record.currentTitle).toBe('Staff Engineer');
    expect(record.seniorityBucket).toBe('Lead');
  });
});

describe('coreConfidence', () => {
  it('is the weakest tier across the core fields', () => {
    const fields = card({
      fullName: hit('Jane Doe', 1),
      currentCompany: hit('Acme', 3),
      profileUrl: hit('https://www.linkedin.com/in/jane', 1),
    }).fields as Record<string, FieldResult>;
    expect(coreConfidence(fields)).toBe('low');
  });

  it('is high only when every core field came from tier 1', () => {
    const fields = card({
      fullName: hit('Jane Doe', 1),
      currentCompany: hit('Acme', 1),
      profileUrl: hit('https://www.linkedin.com/in/jane', 1),
    }).fields as Record<string, FieldResult>;
    expect(coreConfidence(fields)).toBe('high');
  });

  it('treats a missing core field as low', () => {
    const fields = card({ fullName: hit('Jane Doe', 1) }).fields as Record<string, FieldResult>;
    expect(coreConfidence(fields)).toBe('low');
  });
});

describe('dedupe', () => {
  it('keys on the canonical profile URL when there is one', () => {
    expect(
      dedupeKey({
        profileUrl: 'https://www.linkedin.com/in/Jane-Doe?trk=x',
        fullName: 'Jane Doe',
        currentCompany: 'Acme',
      }),
    ).toBe('https://www.linkedin.com/in/jane-doe');
  });

  it('falls back to name|company', () => {
    expect(
      dedupeKey({ profileUrl: null, fullName: 'Jane Doe', currentCompany: 'Acme' }),
    ).toBe('jane doe|acme');
  });

  it('has no key at all when there is neither URL nor name', () => {
    expect(dedupeKey({ profileUrl: null, fullName: null, currentCompany: 'Acme' })).toBeNull();
  });

  it('gives the same hash to the same person found via different tracking URLs', async () => {
    const a = await computeDedupeHash({
      profileUrl: 'https://www.linkedin.com/in/jane-doe?trk=a',
      fullName: 'Jane Doe',
      currentCompany: 'Acme',
      fallbackSeed: '1',
    });
    const b = await computeDedupeHash({
      profileUrl: 'http://linkedin.com/in/jane-doe/?utm_source=b',
      fullName: 'Jane D.',
      currentCompany: 'Acme Inc',
      fallbackSeed: '2',
    });
    expect(a).toBe(b);
  });

  it('does not collapse two unkeyable blank rows into one duplicate', async () => {
    const a = await computeDedupeHash({
      profileUrl: null,
      fullName: null,
      currentCompany: null,
      fallbackSeed: 'row-1',
    });
    const b = await computeDedupeHash({
      profileUrl: null,
      fullName: null,
      currentCompany: null,
      fallbackSeed: 'row-2',
    });
    expect(a).not.toBe(b);
  });
});

describe('HashRingBuffer', () => {
  it('evicts oldest entries past capacity', () => {
    const buf = new HashRingBuffer(3);
    buf.add('a');
    buf.add('b');
    buf.add('c');
    buf.add('d');
    expect(buf.size).toBe(3);
    expect(buf.has('a')).toBe(false);
    expect(buf.has('d')).toBe(true);
  });

  it('ignores duplicate adds', () => {
    const buf = new HashRingBuffer(10);
    buf.add('a');
    buf.add('a');
    expect(buf.size).toBe(1);
  });

  it('seeds from stored history, keeping the newest', () => {
    const buf = new HashRingBuffer(2, ['a', 'b', 'c']);
    expect(buf.toArray()).toEqual(['b', 'c']);
  });
});
