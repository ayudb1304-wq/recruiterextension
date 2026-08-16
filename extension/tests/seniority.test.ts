import { describe, expect, it } from 'vitest';
import { bucketSeniority } from '../lib/extraction/seniority';
import type { SeniorityBucket } from '@recruitexport/shared';

const CASES: Array<[string, SeniorityBucket | null]> = [
  // CXO
  ['CEO', 'CXO'],
  ['CTO & Co-Founder', 'CXO'],
  ['Chief Technology Officer', 'CXO'],
  ['Chief People Officer', 'CXO'],
  ['Chief of Staff', 'CXO'],
  ['Founder', 'CXO'],
  ['Managing Director', 'CXO'],
  ['President, EMEA', 'CXO'],
  ['Partner', 'CXO'],
  // VP
  ['VP Engineering', 'VP'],
  ['SVP of Sales', 'VP'],
  ['Vice President, Product', 'VP'],
  ['Head of Talent', 'VP'],
  ['General Manager', 'VP'],
  // Director
  ['Director of Engineering', 'Director'],
  ['Senior Director, Data', 'Director'],
  ['Engineering Director', 'Director'],
  // Manager
  ['Engineering Manager', 'Manager'],
  ['Product Manager', 'Manager'],
  ['Senior Engineering Manager', 'Manager'],
  ['Team Lead', 'Manager'],
  ['Supervisor', 'Manager'],
  // Lead
  ['Tech Lead', 'Lead'],
  ['Principal Engineer', 'Lead'],
  ['Staff Software Engineer', 'Lead'],
  ['Solutions Architect', 'Lead'],
  ['Distinguished Engineer', 'Lead'],
  // Senior
  ['Senior Software Engineer', 'Senior'],
  ['Sr. Backend Developer', 'Senior'],
  ['Snr Data Analyst', 'Senior'],
  ['Software Engineer III', 'Senior'],
  // IC
  ['Software Engineer', 'IC'],
  ['Backend Developer', 'IC'],
  ['Data Analyst', 'IC'],
  ['Recruiter', 'IC'],
  // demotions win over senior-looking words
  ['Engineering Intern', 'IC'],
  ['Junior Developer', 'IC'],
  ['Working Student, Data Science', 'IC'],
  ['Executive Assistant', 'IC'],
  ['Assistant to the CEO', 'IC'],
  // most-senior-signal-wins ordering
  ['VP Engineering, formerly Senior Manager', 'VP'],
  ['Director & Senior Principal Engineer', 'Director'],
  // nothing to go on
  ['', null],
  ['   ', null],
];

describe('bucketSeniority', () => {
  it.each(CASES)('%s → %s', (title, expected) => {
    expect(bucketSeniority(title)).toBe(expected);
  });

  it('returns null for null/undefined', () => {
    expect(bucketSeniority(null)).toBeNull();
    expect(bucketSeniority(undefined)).toBeNull();
  });
});
