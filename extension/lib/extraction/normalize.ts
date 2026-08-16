/**
 * Normalization helpers (docs/04 §2). All pure, all unit-tested.
 */

const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;

const EMOJI =
  /[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}]/gu;

export function stripZeroWidth(s: string): string {
  return s.replace(ZERO_WIDTH, '');
}

export function stripEmoji(s: string): string {
  return s.replace(EMOJI, ' ');
}

export function collapseWhitespace(s: string): string {
  return s.replace(/[\s\u00A0]+/g, ' ').trim();
}

/** Legal suffixes and noise that ruin a company→domain guess (docs/04 §2). */
const LEGAL_SUFFIXES = [
  'inc', 'inc.', 'incorporated', 'llc', 'l.l.c.', 'ltd', 'ltd.', 'limited',
  'plc', 'gmbh', 'mbh', 'ag', 'kg', 'ug', 'bv', 'b.v.', 'nv', 'n.v.', 'sa',
  's.a.', 'sas', 's.a.s.', 'sarl', 's.a.r.l.', 'srl', 's.r.l.', 'spa', 's.p.a.',
  'ab', 'as', 'a/s', 'oy', 'oyj', 'aps', 'pty', 'pte', 'pvt', 'private',
  'co', 'co.', 'corp', 'corp.', 'corporation', 'company', 'holding', 'holdings',
  'group', 'kft', 'zrt', 'doo', 'd.o.o.', 'sp', 'z.o.o.', 'sp.z.o.o.',
];

/**
 * "Acme GmbH · Full-time" → "Acme".
 * Conservative: never returns empty when the input had letters.
 */
export function cleanCompanyName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = collapseWhitespace(stripZeroWidth(raw));
  // drop employment-type / duration fragments LinkedIn appends
  s = s.split(/\s*[·•|]\s*/)[0] ?? s;
  s = s.replace(/\s*\((?:full|part)[-\s]?time\)\s*/gi, ' ');
  s = collapseWhitespace(s);
  if (!s) return null;

  let tokens = s.split(/\s+/);
  // strip trailing legal suffixes, possibly several ("Acme Holding GmbH")
  while (tokens.length > 1) {
    const last = (tokens[tokens.length - 1] as string)
      .toLowerCase()
      .replace(/[,]/g, '');
    if (LEGAL_SUFFIXES.includes(last)) {
      tokens = tokens.slice(0, -1);
    } else {
      break;
    }
  }
  const cleaned = tokens.join(' ').replace(/[,;:]+$/, '').trim();
  if (!cleaned || !/[\p{L}\p{N}]/u.test(cleaned)) return null;
  return cleaned;
}

/**
 * Naive company → domain guess used only as a HINT for the enrichment provider,
 * which does the real resolution (docs/05 §5). Returns null when the guess would
 * be noise rather than signal.
 */
export function guessCompanyDomain(company: string | null | undefined): string | null {
  const cleaned = cleanCompanyName(company);
  if (!cleaned) return null;
  const slug = cleaned
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]/g, '');
  // Too short or too long to be a plausible domain stem.
  if (slug.length < 2 || slug.length > 40) return null;
  return `${slug}.com`;
}

/** Tracking params LinkedIn hangs off profile links. */
const TRACKING_PARAMS = [
  'trk', 'trackingId', 'lipi', 'licu', 'lici', 'midToken', 'midSig',
  'eid', 'refId', 'originalReferer', 'original_referer', 'sid', 'session_redirect',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  '_l', 'authType', 'authToken',
];

/**
 * Canonicalize a profile URL (docs/03 §8): strip tracking params and the
 * trailing slash, force https, and convert a Sales Navigator lead URL to the
 * public /in/ form WHEN the public slug is actually present in it. We never
 * fabricate a public URL from a lead id — an unconvertible lead URL is kept
 * as-is, which is what the spec asks for.
 */
export function canonicalizeProfileUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    url = new URL(trimmed, 'https://www.linkedin.com');
  } catch {
    return null;
  }

  if (!/(^|\.)linkedin\.com$/i.test(url.hostname)) return null;
  url.protocol = 'https:';
  url.hostname = 'www.linkedin.com';
  url.hash = '';

  for (const p of TRACKING_PARAMS) url.searchParams.delete(p);

  // /in/<slug> — the canonical public form.
  const publicMatch = /^\/in\/([^/]+)/.exec(url.pathname);
  if (publicMatch?.[1]) {
    return `https://www.linkedin.com/in/${decodeURIComponent(publicMatch[1])}`;
  }

  // Sales Navigator lead URLs sometimes carry the public slug in a param.
  const slugParam =
    url.searchParams.get('profileUrn') ?? url.searchParams.get('publicIdentifier');
  if (slugParam && /^[A-Za-z0-9-]{3,}$/.test(slugParam)) {
    return `https://www.linkedin.com/in/${slugParam}`;
  }

  // Not convertible — keep the lead URL, minus tracking noise.
  url.search = url.searchParams.toString();
  const out = url.toString();
  return out.replace(/\/$/, '').replace(/\?$/, '');
}

/** First integer in a string ("12 mutual connections" → 12). */
export function parseFirstInt(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /(\d[\d,.\s]*)/.exec(s);
  if (!m?.[1]) return null;
  const n = Number.parseInt(m[1].replace(/[,.\s]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

/** Truthy strings a `exists`-mode or text probe can produce. */
export function toBoolean(s: string | null | undefined): boolean | null {
  if (s == null) return null;
  const v = s.trim().toLowerCase();
  if (!v) return null;
  if (['true', '1', 'yes', 'y'].includes(v)) return true;
  if (['false', '0', 'no', 'n'].includes(v)) return false;
  // Any non-empty text from a badge probe means the badge is present.
  return true;
}
