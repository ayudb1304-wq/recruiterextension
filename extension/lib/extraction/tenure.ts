/**
 * Tenure parser (docs/04 §2).
 * "X yrs Y mos" / "X yr" / "less than a year" → "Xy Ym" / "<1y".
 * Unparseable → null (the raw string stays in `headline`, never invented).
 */

const LESS_THAN_A_YEAR = /less\s+than\s+a\s+year|<\s*1\s*yr?/i;

// "3 yrs 2 mos", "3 years", "1 yr 1 mo", "11 months", "2 mos in role"
const YEARS = /(\d+)\s*(?:yrs?|years?)\b/i;
const MONTHS = /(\d+)\s*(?:mos?|months?)\b/i;

export function parseTenure(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const text = raw.replace(/\u00A0/g, ' ');

  // Checked first: "<1 yr" also matches the years pattern, and the explicit
  // "less than a year" signal must win over it.
  if (LESS_THAN_A_YEAR.test(text)) return '<1y';

  const years = YEARS.exec(text);
  const months = MONTHS.exec(text);

  if (!years && !months) return null;

  const y = years?.[1] ? Number.parseInt(years[1], 10) : 0;
  const m = months?.[1] ? Number.parseInt(months[1], 10) : 0;

  if (!Number.isFinite(y) || !Number.isFinite(m)) return null;
  if (y === 0 && m === 0) return '<1y';
  if (y === 0) return `${m}m`;
  if (m === 0) return `${y}y`;
  return `${y}y ${m}m`;
}
