/**
 * Name split heuristic (docs/04 §2).
 *
 * Rules:
 *  - honorific prefixes stripped (Dr., Mr., Ms., Mx., Prof., …)
 *  - credential suffixes moved out of lastName (PhD, MBA, CPA, …)
 *  - last token = lastName, the rest = firstName
 *  - particles (van, von, de, da, bin, al, …) attach to lastName
 *  - "Lastname, Firstname" comma form handled
 *  - decorations LinkedIn users add to their name (emoji, "| Hiring", pronouns,
 *    "(He/Him)", "🚀 We're hiring!") stripped before splitting
 */

const HONORIFICS = new Set([
  'dr', 'mr', 'mrs', 'ms', 'mx', 'miss', 'prof', 'professor', 'sir', 'dame',
  'rev', 'fr', 'capt', 'lt', 'col', 'sgt', 'eng', 'ing', 'ir',
]);

const SUFFIXES = new Set([
  'phd', 'ph.d', 'ph.d.', 'md', 'mba', 'msc', 'ma', 'ms', 'bsc', 'ba', 'bs',
  'jd', 'llm', 'cpa', 'cfa', 'pmp', 'cissp', 'rn', 'esq', 'dds', 'dvm',
  'jr', 'sr', 'ii', 'iii', 'iv', 'v', 'mcp', 'mct', 'pe', 'eit', 'shrm',
  'cscp', 'ceng', 'facs',
]);

/** Particles that belong with the surname, not the given name. */
const PARTICLES = new Set([
  'van', 'von', 'de', 'del', 'della', 'der', 'den', 'da', 'das', 'dos', 'du',
  'la', 'le', 'lo', 'bin', 'ibn', 'al', 'el', 'st', 'st.', 'san', 'santa',
  'ter', 'ten', 'op', 'zu', 'af', 'av', 'mac', 'mc', 'abu',
]);

const EMOJI =
  /[\u{1F000}-\u{1FAFF}\u{2190}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/gu;

const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;

/** "(he/him)", "she/her", "they/them" */
const PRONOUNS = /\(?\b(?:he|she|they|him|her|them|his|hers|theirs)\s*\/\s*(?:he|she|they|him|her|them|his|hers|theirs)(?:\s*\/\s*\w+)?\b\)?/gi;

/** Everything after a separator LinkedIn users use for taglines. */
const TAGLINE = /\s*[|·•‧—–]\s.*$/;

/** Degree/credential run at the end after a comma: "Jane Doe, PhD, MBA" */
function isSuffixToken(token: string): boolean {
  return SUFFIXES.has(token.toLowerCase().replace(/[.,]/g, ''));
}

function isHonorific(token: string): boolean {
  return HONORIFICS.has(token.toLowerCase().replace(/[.,]/g, ''));
}

export function cleanDisplayName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw
    .replace(ZERO_WIDTH, '')
    .replace(EMOJI, ' ')
    .replace(PRONOUNS, ' ')
    .replace(TAGLINE, '')
    // LinkedIn "3rd+ degree" connection markers glued to the name
    .replace(/\b(?:1st|2nd|3rd)\+?(?:\s*degree)?(?:\s*connection)?/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // trailing/leading punctuation left behind by the strips above
    .replace(/^[,\-–—·•|+]+|[,\-–—·•|+]+$/g, '')
    .trim();
  if (!s) return null;
  // A name that is only punctuation/digits is not a name.
  if (!/[\p{L}]/u.test(s)) return null;
  return s;
}

export interface SplitName {
  firstName: string | null;
  lastName: string | null;
}

export function splitName(raw: string | null | undefined): SplitName {
  const cleaned = cleanDisplayName(raw);
  if (!cleaned) return { firstName: null, lastName: null };

  // "Lastname, Firstname" — but not "Jane Doe, PhD" (suffix after the comma).
  const commaParts = cleaned.split(',').map((p) => p.trim()).filter(Boolean);
  let working = cleaned;
  if (commaParts.length >= 2) {
    const tail = commaParts.slice(1);
    const tailIsAllSuffixes = tail.every((part) =>
      part.split(/\s+/).every(isSuffixToken),
    );
    if (tailIsAllSuffixes) {
      working = commaParts[0] as string;
    } else if (commaParts.length === 2) {
      // Lastname, Firstname
      working = `${commaParts[1]} ${commaParts[0]}`;
    } else {
      working = commaParts[0] as string;
    }
  }

  let tokens = working.split(/\s+/).filter(Boolean);

  // strip leading honorifics
  while (tokens.length > 1 && isHonorific(tokens[0] as string)) tokens = tokens.slice(1);
  // strip trailing credential suffixes
  while (tokens.length > 1 && isSuffixToken(tokens[tokens.length - 1] as string)) {
    tokens = tokens.slice(0, -1);
  }

  if (tokens.length === 0) return { firstName: null, lastName: null };
  if (tokens.length === 1) return { firstName: tokens[0] as string, lastName: null };

  // Walk back over particles so "Ludwig van Beethoven" → last "van Beethoven".
  let splitAt = tokens.length - 1;
  while (splitAt > 1 && PARTICLES.has((tokens[splitAt - 1] as string).toLowerCase())) {
    splitAt -= 1;
  }

  const firstName = tokens.slice(0, splitAt).join(' ');
  const lastName = tokens.slice(splitAt).join(' ');
  return { firstName: firstName || null, lastName: lastName || null };
}
