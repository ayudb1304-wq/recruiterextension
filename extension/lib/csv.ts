/**
 * CSV builder — RFC 4180, Excel-safe, formula-injection-guarded (docs/04 §2).
 *
 * The output opens in Excel, Numbers and Google Sheets without a mangled column
 * and without executing anything. That last part matters: a candidate's headline
 * is attacker-controlled text that lands in a recruiter's spreadsheet.
 */

import type { CandidateRecord } from '@recruitexport/shared';
import { COMPUTED } from './presets/computed';
import type { Preset, PresetColumn } from './presets/types';

/** Excel reads UTF-8 correctly only with a BOM. */
export const UTF8_BOM = '﻿';

const CRLF = '\r\n';

/**
 * Formula-injection guard (docs/08 §1). A cell starting with one of these is a
 * formula to Excel/Sheets; prefixing with an apostrophe makes it literal text.
 * Tab and CR are included because they are stripped by some parsers first,
 * re-exposing the leading character.
 */
const FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];

export function escapeCsvValue(raw: unknown): string {
  if (raw === null || raw === undefined) return '';

  let value = typeof raw === 'string' ? raw : String(raw);
  if (value === '') return '';

  if (FORMULA_PREFIXES.includes(value[0] as string)) {
    value = `'${value}`;
  }

  // RFC 4180: quote if the value contains a comma, quote, CR or LF; double any
  // embedded quotes.
  if (/[",\r\n]/.test(value)) {
    value = `"${value.replace(/"/g, '""')}"`;
  }

  return value;
}

export function cellValue(record: CandidateRecord, column: PresetColumn): string {
  const { source } = column;
  switch (source.kind) {
    case 'constant':
      return source.value;
    case 'computed':
      return COMPUTED[source.id]?.(record) ?? '';
    case 'field': {
      const value = record[source.field];
      if (value === null || value === undefined) return '';
      if (typeof value === 'boolean') return value ? 'yes' : 'no';
      return String(value);
    }
    default:
      return '';
  }
}

export interface BuildCsvOptions {
  /**
   * Free tier appends an attribution column (docs/01 F11). Paid exports do not
   * carry it. This is the ONLY difference between free and paid output shape.
   */
  watermark?: boolean;
  bom?: boolean;
}

export function buildCsv(
  records: readonly CandidateRecord[],
  preset: Preset,
  opts: BuildCsvOptions = {},
): string {
  const columns = preset.columns.filter((c) => c.included);
  const headers = columns.map((c) => c.header);
  const rows: string[] = [];

  if (opts.watermark) headers.push('Exported with');

  rows.push(headers.map(escapeCsvValue).join(','));

  for (const record of records) {
    const cells = columns.map((c) => escapeCsvValue(cellValue(record, c)));
    if (opts.watermark) cells.push(escapeCsvValue('RecruitExport (free plan)'));
    rows.push(cells.join(','));
  }

  return (opts.bom === false ? '' : UTF8_BOM) + rows.join(CRLF) + CRLF;
}

/** Same shape as the CSV, as a 2-D array — used by the Sheets append path. */
export function buildRows(
  records: readonly CandidateRecord[],
  preset: Preset,
  opts: BuildCsvOptions = {},
): string[][] {
  const columns = preset.columns.filter((c) => c.included);
  const header = columns.map((c) => c.header);
  if (opts.watermark) header.push('Exported with');

  const body = records.map((record) => {
    const cells = columns.map((c) => cellValue(record, c));
    if (opts.watermark) cells.push('RecruitExport (free plan)');
    return cells;
  });

  return [header, ...body];
}

/** `recruitexport-salesnav-2026-08-16-1423.csv` */
export function csvFilename(profileId: string, at: Date = new Date()): string {
  const surface = profileId.startsWith('recruiter') ? 'recruiter' : 'salesnav';
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}`;
  return `recruitexport-${surface}-${stamp}.csv`;
}

/**
 * Service workers have no URL.createObjectURL, so the download uses a data URL.
 * Encoded as UTF-8 base64 to survive non-Latin names.
 */
export function csvDataUrl(csv: string): string {
  const bytes = new TextEncoder().encode(csv);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:text/csv;charset=utf-8;base64,${btoa(binary)}`;
}
