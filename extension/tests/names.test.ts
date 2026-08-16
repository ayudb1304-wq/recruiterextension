import { describe, expect, it } from 'vitest';
import { cleanDisplayName, splitName } from '../lib/extraction/names';

/**
 * The ≥40 tricky-name table docs/04 §2 asks for.
 * All names here are invented; none are real people.
 */
const CASES: Array<[input: string, first: string | null, last: string | null]> = [
  // plain
  ['Jane Doe', 'Jane', 'Doe'],
  ['Ana Silva', 'Ana', 'Silva'],
  ['Wei Chen', 'Wei', 'Chen'],
  // middle names stay with first
  ['Mary Jane Watson', 'Mary Jane', 'Watson'],
  ['John Ronald Reuel Tolkienesque', 'John Ronald Reuel', 'Tolkienesque'],
  // honorifics stripped
  ['Dr. Amara Okafor', 'Amara', 'Okafor'],
  ['Prof. Henrik Larsson', 'Henrik', 'Larsson'],
  ['Mr Tom Baker', 'Tom', 'Baker'],
  ['Ms. Rita Moreno', 'Rita', 'Moreno'],
  ['Mx. Robin Vale', 'Robin', 'Vale'],
  // credential suffixes moved out
  ['Jane Doe, PhD', 'Jane', 'Doe'],
  ['Jane Doe PhD', 'Jane', 'Doe'],
  ['Carlos Ruiz, MBA', 'Carlos', 'Ruiz'],
  ['Nina Patel, PhD, MBA', 'Nina', 'Patel'],
  ['Owen Brady CPA', 'Owen', 'Brady'],
  ['Sara Kim, PMP', 'Sara', 'Kim'],
  ['Dr. Lena Vogt, MD', 'Lena', 'Vogt'],
  // particles attach to the surname
  ['Ludwig van Beethovenson', 'Ludwig', 'van Beethovenson'],
  ['Vincent van der Berg', 'Vincent', 'van der Berg'],
  ['Klaus von Stauffen', 'Klaus', 'von Stauffen'],
  ['Maria de la Cruz', 'Maria', 'de la Cruz'],
  ['Joao dos Santos', 'Joao', 'dos Santos'],
  ['Ahmed bin Rashid', 'Ahmed', 'bin Rashid'],
  ['Omar al Farsi', 'Omar', 'al Farsi'],
  ['Sofia del Rio', 'Sofia', 'del Rio'],
  ['Pierre le Blanc', 'Pierre', 'le Blanc'],
  ['Elena della Rocca', 'Elena', 'della Rocca'],
  // comma-inverted form
  ['Doe, Jane', 'Jane', 'Doe'],
  ['Nakamura, Yuki', 'Yuki', 'Nakamura'],
  // decorations LinkedIn users add
  ['Jane Doe 🚀', 'Jane', 'Doe'],
  ['Jane Doe (She/Her)', 'Jane', 'Doe'],
  ['Marcus Webb (he/him)', 'Marcus', 'Webb'],
  ['Priya Raman | Hiring Backend Engineers', 'Priya', 'Raman'],
  ['Tom Ellis · Open to work', 'Tom', 'Ellis'],
  ['🌟 Aisha Bello', 'Aisha', 'Bello'],
  ['Jane Doe 2nd degree connection', 'Jane', 'Doe'],
  ['Ravi Shankar 3rd+', 'Ravi', 'Shankar'],
  // non-latin scripts must survive intact
  ['Ольга Иванова', 'Ольга', 'Иванова'],
  ['李 明', '李', '明'],
  ['Åsa Öberg', 'Åsa', 'Öberg'],
  ['François Lefèvre', 'François', 'Lefèvre'],
  ['Müller Schmidt', 'Müller', 'Schmidt'],
  // hyphenated
  ['Anne-Marie Dubois', 'Anne-Marie', 'Dubois'],
  ['Jean-Luc Picard-Reyes', 'Jean-Luc', 'Picard-Reyes'],
  // single token
  ['Madonna', 'Madonna', null],
  ['Prince', 'Prince', null],
  // generational suffixes
  ['Harold Finch Jr.', 'Harold', 'Finch'],
  ['Harold Finch III', 'Harold', 'Finch'],
  // degenerate input
  ['', null, null],
  ['   ', null, null],
  ['🚀🚀', null, null],
  ['---', null, null],
];

describe('splitName', () => {
  it.each(CASES)('%s → %s / %s', (input, first, last) => {
    const result = splitName(input);
    expect(result.firstName).toBe(first);
    expect(result.lastName).toBe(last);
  });

  it('never throws on null/undefined', () => {
    expect(splitName(null)).toEqual({ firstName: null, lastName: null });
    expect(splitName(undefined)).toEqual({ firstName: null, lastName: null });
  });

  it('table covers at least 40 cases (docs/04 §2)', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(40);
  });
});

describe('cleanDisplayName', () => {
  it('strips zero-width characters', () => {
    expect(cleanDisplayName('Ja​ne Doe')).toBe('Jane Doe');
  });

  it('collapses runs of whitespace', () => {
    expect(cleanDisplayName('  Jane   Doe  ')).toBe('Jane Doe');
  });

  it('returns null when nothing name-like remains', () => {
    expect(cleanDisplayName('🚀 | ')).toBeNull();
  });
});
