import { describe, expect, it } from 'vitest';
import { parseTenure } from '../lib/extraction/tenure';

const CASES: Array<[string, string | null]> = [
  ['3 yrs 2 mos', '3y 2m'],
  ['3 yrs 2 mos in role', '3y 2m'],
  ['3 yrs', '3y'],
  ['3 years', '3y'],
  ['1 yr', '1y'],
  ['1 yr 1 mo', '1y 1m'],
  ['1 year 11 months', '1y 11m'],
  ['11 mos', '11m'],
  ['11 months', '11m'],
  ['2 mos in company', '2m'],
  ['less than a year', '<1y'],
  ['Less Than A Year', '<1y'],
  ['<1 yr', '<1y'],
  ['0 yrs 0 mos', '<1y'],
  ['10 yrs 0 mos', '10y'],
  ['0 yrs 6 mos', '6m'],
  // embedded in a longer string
  ['Senior Engineer · 4 yrs 3 mos in role', '4y 3m'],
  ['Acme · Full-time · 2 yrs', '2y'],
  // non-breaking space between number and unit
  ['3 yrs 2 mos', '3y 2m'],
  // unparseable → null, never a guess
  ['Sometime', null],
  ['', null],
  ['—', null],
  ['Present', null],
];

describe('parseTenure', () => {
  it.each(CASES)('%s → %s', (input, expected) => {
    expect(parseTenure(input)).toBe(expected);
  });

  it('never throws on null/undefined', () => {
    expect(parseTenure(null)).toBeNull();
    expect(parseTenure(undefined)).toBeNull();
  });
});
