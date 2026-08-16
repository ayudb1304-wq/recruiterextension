/**
 * Postprocess registry (docs/03 §3).
 *
 * Config can only reference these NAMES. It can never supply a function body,
 * an expression, or anything else executable — that is what keeps the remote
 * selector config "data, not code" under MV3 (docs/08 §3).
 *
 * Every function here must be PURE and total: string in, string-or-null out,
 * never throws.
 */

import {
  cleanCompanyName,
  canonicalizeProfileUrl,
  collapseWhitespace,
  stripEmoji,
  stripZeroWidth,
} from './normalize';
import { cleanDisplayName } from './names';
import { parseTenure } from './tenure';

type PostprocessFn = (input: string) => string | null;

const registry = {
  trim: (s) => s.trim(),
  collapseWhitespace,
  stripEmoji,
  stripZeroWidth,
  lowercase: (s) => s.toLowerCase(),
  /** Empty/whitespace-only becomes a proper miss rather than "". */
  nullIfEmpty: (s) => (s.trim() ? s : null),
  /** Name-shaped cleanup: emoji, pronouns, "| Hiring" taglines, degree markers. */
  cleanName: (s) => cleanDisplayName(s),
  /** "Acme GmbH · Full-time" → "Acme" */
  cleanCompany: (s) => cleanCompanyName(s),
  /** "3 yrs 2 mos in role" → "3y 2m"; unparseable → null */
  normalizeTenure: (s) => parseTenure(s),
  /** strip tracking params, force https, public /in/ form when derivable */
  canonicalizeUrl: (s) => canonicalizeProfileUrl(s),
  /** drop a leading label like "Current:" or "Location:" */
  stripLeadingLabel: (s) => s.replace(/^\s*[\p{L}\s]{1,24}:\s*/u, '').trim(),
  /** keep only digits — for counts rendered as "1,234 mutual connections" */
  digitsOnly: (s) => {
    const m = /(\d[\d,. \s]*)/.exec(s);
    return m?.[1] ? m[1].replace(/[^\d]/g, '') : null;
  },
  /** first line of a multi-line block */
  firstLine: (s) => (s.split(/\r?\n/)[0] ?? '').trim(),
  /** text after the last "at " — "Engineer at Acme" → "Acme" */
  afterAt: (s) => {
    const m = /\s+at\s+(.+)$/i.exec(s);
    return m?.[1]?.trim() ?? null;
  },
  /** text before the first " at " — "Engineer at Acme" → "Engineer" */
  beforeAt: (s) => {
    const m = /^(.+?)\s+at\s+/i.exec(s);
    return m?.[1]?.trim() ?? null;
  },
} satisfies Record<string, PostprocessFn>;

export type PostprocessName = keyof typeof registry;

/** Tuple form for the zod schema — the ONLY names config may reference. */
export const POSTPROCESS_NAMES = Object.keys(registry) as [
  PostprocessName,
  ...PostprocessName[],
];

/**
 * Run a named chain. An unknown name is skipped (defensive: a config that
 * passed validation cannot contain one, but the engine never trusts input).
 * A step that returns null short-circuits to a miss.
 */
export function applyPostprocess(
  value: string | null,
  names: readonly string[],
): string | null {
  let current = value;
  for (const name of names) {
    if (current == null) return null;
    const fn = (registry as Record<string, PostprocessFn | undefined>)[name];
    if (!fn) continue;
    try {
      current = fn(current);
    } catch {
      // A postprocess fn must never break a job (docs/03 §1 fail-soft).
      return null;
    }
  }
  if (current != null && current.trim() === '') return null;
  return current;
}
