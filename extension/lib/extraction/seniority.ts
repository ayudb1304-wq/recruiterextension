/**
 * Seniority bucketing (docs/03 §8). Pure function, rule table, unit-tested.
 *
 * Ordering matters: the most senior signal in the title wins, so
 * "VP of Engineering, formerly Senior Manager" → VP, and
 * "Senior Director" → Director (not Senior).
 */

import type { SeniorityBucket } from '@recruitexport/shared';

interface Rule {
  bucket: SeniorityBucket;
  /** Checked in array order; first match wins. */
  patterns: RegExp[];
}

/** Most senior → least senior. */
const RULES: Rule[] = [
  {
    bucket: 'CXO',
    patterns: [
      /\b(?:c[etoifmhdsrp]o|cxo)\b/i, // CEO CTO CFO CIO CMO CHRO CDO CSO CPO CRO
      /\bchief\s+[a-z]+(?:\s+[a-z]+)?\s+officer\b/i,
      /\bchief\s+of\s+staff\b/i,
      /\b(?:founder|co-?founder)\b/i,
      /\b(?:owner|managing\s+partner|managing\s+director)\b/i,
      // "Vice President" is a VP, not a CXO — the lookbehind keeps it out.
      /(?<!\bvice\s)\bpresident\b/i,
      /\bpartner\b/i,
    ],
  },
  {
    bucket: 'VP',
    patterns: [
      /\b(?:vp|svp|evp|avp)\b/i,
      /\bvice\s+president\b/i,
      /\bhead\s+of\b/i,
      /\bgeneral\s+manager\b/i,
    ],
  },
  {
    bucket: 'Director',
    patterns: [/\bdirector\b/i, /\bdirecteur\b/i, /\bdir\.\b/i],
  },
  {
    bucket: 'Manager',
    patterns: [
      /\b(?:manager|mgr)\b/i,
      /\bengineering\s+manager\b/i,
      /\bteam\s+lead(?:er)?\b/i, // team lead = people management in practice
      /\bsupervisor\b/i,
    ],
  },
  {
    bucket: 'Lead',
    patterns: [
      /\blead\b/i,
      /\bprincipal\b/i,
      /\bstaff\b/i,
      /\barchitect\b/i,
      /\bdistinguished\b/i,
      /\bfellow\b/i,
    ],
  },
  {
    bucket: 'Senior',
    patterns: [/\b(?:senior|snr|sr\.?)\b/i, /\bsen\.\b/i, /\bIII\b/],
  },
];

/**
 * Titles that look senior but are not (interns, assistants to executives).
 * Checked before the rule table.
 */
const DEMOTIONS: RegExp[] = [
  /\b(?:intern|internship|trainee|apprentice|working\s+student|werkstudent)\b/i,
  /\bassistant\s+to\s+the\b/i,
  /\bexecutive\s+assistant\b/i,
  /\bjunior\b/i,
  /\bentry[-\s]level\b/i,
];

export function bucketSeniority(title: string | null | undefined): SeniorityBucket | null {
  if (!title) return null;
  const t = title.trim();
  if (!t) return null;

  if (DEMOTIONS.some((re) => re.test(t))) return 'IC';

  for (const rule of RULES) {
    if (rule.patterns.some((re) => re.test(t))) return rule.bucket;
  }

  // A real title we recognise nothing senior in is an individual contributor.
  return 'IC';
}
