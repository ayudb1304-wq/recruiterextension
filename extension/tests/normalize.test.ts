import { describe, expect, it } from 'vitest';
import {
  canonicalizeProfileUrl,
  cleanCompanyName,
  collapseWhitespace,
  guessCompanyDomain,
  parseFirstInt,
  toBoolean,
} from '../lib/extraction/normalize';

describe('cleanCompanyName', () => {
  it.each([
    ['Acme Inc', 'Acme'],
    ['Acme Inc.', 'Acme'],
    ['Acme, Inc.', 'Acme'],
    ['Acme LLC', 'Acme'],
    ['Acme GmbH', 'Acme'],
    ['Acme Holding GmbH', 'Acme'],
    ['Acme Pvt Ltd', 'Acme'],
    ['Acme S.A.S.', 'Acme'],
    ['Acme GmbH · Full-time', 'Acme'],
    ['Acme · 3 yrs 2 mos', 'Acme'],
    ['Acme (Full-time)', 'Acme'],
    ['  Acme   Systems  ', 'Acme Systems'],
    // a company whose whole name is a legal suffix must survive
    ['Group', 'Group'],
    ['', null],
    ['···', null],
  ])('%s → %s', (input, expected) => {
    expect(cleanCompanyName(input)).toBe(expected);
  });
});

describe('guessCompanyDomain', () => {
  it.each([
    ['Acme Inc', 'acme.com'],
    ['Acme Systems', 'acmesystems.com'],
    ['Björn & Co', 'bjornand.com'],
    ['A', null],
    ['', null],
  ])('%s → %s', (input, expected) => {
    expect(guessCompanyDomain(input)).toBe(expected);
  });

  it('rejects absurdly long stems rather than emitting garbage', () => {
    expect(guessCompanyDomain('a'.repeat(60))).toBeNull();
  });
});

describe('canonicalizeProfileUrl', () => {
  it('reduces a public profile URL to its canonical form', () => {
    expect(
      canonicalizeProfileUrl('https://www.linkedin.com/in/jane-doe-123/?trk=search_srp&lipi=abc'),
    ).toBe('https://www.linkedin.com/in/jane-doe-123');
  });

  it('upgrades http and normalizes the host', () => {
    expect(canonicalizeProfileUrl('http://linkedin.com/in/jane-doe')).toBe(
      'https://www.linkedin.com/in/jane-doe',
    );
  });

  it('resolves a relative href against linkedin.com', () => {
    expect(canonicalizeProfileUrl('/in/jane-doe')).toBe('https://www.linkedin.com/in/jane-doe');
  });

  it('drops the fragment and tracking params', () => {
    expect(
      canonicalizeProfileUrl('https://www.linkedin.com/in/jane-doe?utm_source=x&trackingId=y#top'),
    ).toBe('https://www.linkedin.com/in/jane-doe');
  });

  it('keeps an unconvertible Sales Navigator lead URL rather than inventing one', () => {
    const out = canonicalizeProfileUrl(
      'https://www.linkedin.com/sales/lead/ACwAAA123,NAME_SEARCH,abcd?trk=x',
    );
    expect(out).toContain('/sales/lead/');
    expect(out).not.toContain('trk=');
  });

  it('converts a lead URL when the public slug is actually present', () => {
    expect(
      canonicalizeProfileUrl(
        'https://www.linkedin.com/sales/lead/ACwAAA123?publicIdentifier=jane-doe',
      ),
    ).toBe('https://www.linkedin.com/in/jane-doe');
  });

  it('rejects non-LinkedIn hosts', () => {
    expect(canonicalizeProfileUrl('https://evil.example.com/in/jane')).toBeNull();
  });

  it('returns null for junk instead of throwing', () => {
    expect(canonicalizeProfileUrl('')).toBeNull();
    expect(canonicalizeProfileUrl(null)).toBeNull();
    expect(canonicalizeProfileUrl('http://[::bad::]')).toBeNull();
  });
});

describe('parseFirstInt', () => {
  it.each([
    ['12 mutual connections', 12],
    ['1,234 shared connections', 1234],
    ['no digits here', null],
    ['', null],
  ])('%s → %s', (input, expected) => {
    expect(parseFirstInt(input)).toBe(expected);
  });
});

describe('toBoolean', () => {
  it('maps badge text to true and empty to null', () => {
    expect(toBoolean('true')).toBe(true);
    expect(toBoolean('Open to work')).toBe(true);
    expect(toBoolean('false')).toBe(false);
    expect(toBoolean('')).toBeNull();
    expect(toBoolean(null)).toBeNull();
  });
});

describe('collapseWhitespace', () => {
  it('collapses non-breaking spaces too', () => {
    expect(collapseWhitespace('a \n b')).toBe('a b');
  });
});
