import { describe, expect, it } from 'vitest';
import type { CandidateRecord } from '@recruitexport/shared';
import { buildCsv, buildRows, cellValue, csvFilename, escapeCsvValue, UTF8_BOM } from '../lib/csv';
import { bundledPreset } from '../lib/presets';
import type { Preset } from '../lib/presets/types';

function record(overrides: Partial<CandidateRecord> = {}): CandidateRecord {
  return {
    fullName: 'Jane Doe',
    firstName: 'Jane',
    lastName: 'Doe',
    headline: 'Senior Backend Engineer at Acme',
    currentTitle: 'Senior Backend Engineer',
    currentCompany: 'Acme',
    tenureAtCompany: '3y 2m',
    totalExperienceHint: null,
    location: 'Berlin, Germany',
    profileUrl: 'https://www.linkedin.com/in/jane-doe',
    openToWork: true,
    mutualConnections: 12,
    seniorityBucket: 'Senior',
    companyDomainGuess: 'acme.com',
    email: 'jane@acme.com',
    emailStatus: 'verified',
    extractionConfidence: 'high',
    dedupeHash: 'a'.repeat(64),
    exportedAt: '2026-08-16T12:00:00.000Z',
    ...overrides,
  };
}

const simplePreset: Preset = {
  id: 'test',
  label: 'Test',
  description: '',
  columns: [
    { header: 'Name', source: { kind: 'field', field: 'fullName' }, included: true },
    { header: 'Company', source: { kind: 'field', field: 'currentCompany' }, included: true },
    { header: 'Hidden', source: { kind: 'field', field: 'email' }, included: false },
  ],
};

describe('escapeCsvValue — RFC 4180', () => {
  it.each([
    ['plain', 'plain'],
    ['with,comma', '"with,comma"'],
    ['with"quote', '"with""quote"'],
    ['with\nnewline', '"with\nnewline"'],
    ['with\r\ncrlf', '"with\r\ncrlf"'],
    ['', ''],
  ])('%j → %j', (input, expected) => {
    expect(escapeCsvValue(input)).toBe(expected);
  });

  it('renders null and undefined as empty, not "null"', () => {
    expect(escapeCsvValue(null)).toBe('');
    expect(escapeCsvValue(undefined)).toBe('');
  });
});

describe('escapeCsvValue — formula injection guard (docs/08 §1)', () => {
  it.each([
    ['=1+1', "'=1+1"],
    ['+1', "'+1"],
    ['-1', "'-1"],
    ['@SUM(A1)', "'@SUM(A1)"],
    // no comma or double-quote in this one, so it needs no RFC 4180 wrapping —
    // only the leading apostrophe that stops Excel treating it as a formula
    ['=cmd|\' /c calc\'!A1', '\'=cmd|\' /c calc\'!A1'],
  ])('neutralizes %j', (input, expected) => {
    expect(escapeCsvValue(input)).toBe(expected);
  });

  it('neutralizes a formula hidden behind a leading tab', () => {
    expect(escapeCsvValue('\t=1+1')).toBe("'\t=1+1");
  });

  it('leaves a normal headline alone', () => {
    expect(escapeCsvValue('Senior Engineer')).toBe('Senior Engineer');
  });
});

describe('buildCsv', () => {
  it('writes a BOM so Excel reads UTF-8 correctly', () => {
    const csv = buildCsv([record()], simplePreset);
    expect(csv.startsWith(UTF8_BOM)).toBe(true);
  });

  it('uses CRLF line endings', () => {
    const csv = buildCsv([record()], simplePreset, { bom: false });
    expect(csv).toBe('Name,Company\r\nJane Doe,Acme\r\n');
  });

  it('omits excluded columns', () => {
    const csv = buildCsv([record()], simplePreset, { bom: false });
    expect(csv).not.toContain('Hidden');
    expect(csv).not.toContain('jane@acme.com');
  });

  it('survives commas, quotes, emoji and RTL names', () => {
    const csv = buildCsv(
      [
        record({ fullName: 'Doe, Jane "JD"', currentCompany: 'Acme, Inc.' }),
        record({ fullName: 'أحمد الفارسي', currentCompany: 'شركة' }),
        record({ fullName: 'Jane 🚀 Doe', currentCompany: 'Acme' }),
      ],
      simplePreset,
      { bom: false },
    );
    const lines = csv.trim().split('\r\n');
    expect(lines[1]).toBe('"Doe, Jane ""JD""","Acme, Inc."');
    expect(lines[2]).toBe('أحمد الفارسي,شركة');
    expect(lines[3]).toBe('Jane 🚀 Doe,Acme');
  });

  it('emits an empty cell for a missed field rather than "null"', () => {
    const csv = buildCsv([record({ currentCompany: null })], simplePreset, { bom: false });
    expect(csv).toContain('Jane Doe,\r\n');
  });

  it('renders booleans as yes/no', () => {
    const preset: Preset = {
      ...simplePreset,
      columns: [{ header: 'OTW', source: { kind: 'field', field: 'openToWork' }, included: true }],
    };
    expect(buildCsv([record({ openToWork: true })], preset, { bom: false })).toContain('yes');
    expect(buildCsv([record({ openToWork: false })], preset, { bom: false })).toContain('no');
  });

  it('appends the attribution column only on the free plan (docs/01 F11)', () => {
    const free = buildCsv([record()], simplePreset, { bom: false, watermark: true });
    const paid = buildCsv([record()], simplePreset, { bom: false, watermark: false });
    expect(free).toContain('Exported with');
    expect(free).toContain('RecruitExport (free plan)');
    expect(paid).not.toContain('Exported with');
  });

  it('produces a header-only file for zero records', () => {
    expect(buildCsv([], simplePreset, { bom: false })).toBe('Name,Company\r\n');
  });
});

describe('presets', () => {
  it('Greenhouse hardcodes Source and composes Notes from headline + tenure', () => {
    const preset = bundledPreset('greenhouse');
    if (!preset) throw new Error('missing greenhouse preset');
    const csv = buildCsv([record()], preset, { bom: false });
    const [header, row] = csv.trim().split('\r\n');
    expect(header).toContain('Source');
    expect(row).toContain('RecruitExport');
    expect(row).toContain('Senior Backend Engineer at Acme · 3y 2m');
  });

  it('Lever tags the row with the seniority bucket and origin "sourced"', () => {
    const preset = bundledPreset('lever');
    if (!preset) throw new Error('missing lever preset');
    const csv = buildCsv([record()], preset, { bom: false });
    expect(csv).toContain('sourced');
    expect(csv).toContain('Senior');
  });

  it('Lever falls back to first+last when fullName missed', () => {
    const preset = bundledPreset('lever');
    if (!preset) throw new Error('missing lever preset');
    const csv = buildCsv([record({ fullName: null })], preset, { bom: false });
    expect(csv).toContain('Jane Doe');
  });

  it('Generic covers every CandidateRecord field', () => {
    const preset = bundledPreset('generic');
    if (!preset) throw new Error('missing generic preset');
    expect(preset.columns).toHaveLength(19);
    expect(preset.columns[0]!.header).toBe('full_name');
    expect(preset.columns.some((c) => c.header === 'email_status')).toBe(true);
  });
});

describe('cellValue', () => {
  it('reads constants and computed columns', () => {
    expect(
      cellValue(record(), { header: 'x', source: { kind: 'constant', value: 'k' }, included: true }),
    ).toBe('k');
    expect(
      cellValue(record(), { header: 'x', source: { kind: 'computed', id: 'tags' }, included: true }),
    ).toBe('Senior');
  });
});

describe('buildRows', () => {
  it('mirrors the CSV shape for the Sheets push', () => {
    const rows = buildRows([record()], simplePreset);
    expect(rows[0]).toEqual(['Name', 'Company']);
    expect(rows[1]).toEqual(['Jane Doe', 'Acme']);
  });

  it('does not apply the CSV formula guard — Sheets sends values as RAW', () => {
    const rows = buildRows([record({ fullName: '=1+1' })], simplePreset);
    expect(rows[1]![0]).toBe('=1+1');
  });
});

describe('csvFilename', () => {
  it('names the file by surface and timestamp', () => {
    const name = csvFilename('salesnav_people_search', new Date('2026-08-16T14:23:00'));
    expect(name).toBe('recruitexport-salesnav-2026-08-16-1423.csv');
  });

  it('distinguishes the Recruiter surface', () => {
    expect(csvFilename('recruiter_search', new Date('2026-08-16T09:05:00'))).toContain('recruiter');
  });
});
