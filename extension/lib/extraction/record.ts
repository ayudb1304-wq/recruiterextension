/**
 * ExtractedCard → CandidateRecord (docs/04 §1, §2).
 *
 * This is where extracted fields become the one true shape and derived fields
 * are computed. Enrichment fields are left null here and filled in later by the
 * service worker (docs/02 §3.1 step 3).
 */

import {
  CORE_FIELDS,
  type CandidateRecord,
  type Confidence,
  type ExtractedCard,
  type FieldResult,
} from '@recruitexport/shared';
import { computeDedupeHash } from './dedupe';
import { splitName } from './names';
import { canonicalizeProfileUrl, guessCompanyDomain, parseFirstInt, toBoolean } from './normalize';
import { bucketSeniority } from './seniority';
import { parseTenure } from './tenure';

const CONFIDENCE_RANK: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };

/** Confidence = the weakest tier across the core fields (docs/04 §1). */
export function coreConfidence(fields: Record<string, FieldResult>): Confidence {
  let worst: Confidence = 'high';
  for (const name of CORE_FIELDS) {
    const result = fields[name];
    const c: Confidence = result?.value == null ? 'low' : result.confidence;
    if (CONFIDENCE_RANK[c] < CONFIDENCE_RANK[worst]) worst = c;
  }
  return worst;
}

function str(fields: Record<string, FieldResult>, name: string): string | null {
  return fields[name]?.value ?? null;
}

/**
 * `currentTitle` falls back to a headline heuristic when the surface has no
 * explicit "Current:" line (docs/03 §8): take the part before " at ".
 */
function titleFromHeadline(headline: string | null): string | null {
  if (!headline) return null;
  const m = /^(.+?)\s+(?:at|@|chez|bei)\s+/i.exec(headline);
  if (m?.[1]) return m[1].trim();
  // A short headline with no separator is usually just the title.
  const first = headline.split(/\s*[|·•]\s*/)[0]?.trim() ?? null;
  if (first && first.length <= 80) return first;
  return null;
}

export async function buildCandidateRecord(
  card: ExtractedCard,
  opts: { exportedAt?: string } = {},
): Promise<CandidateRecord> {
  const f = card.fields as Record<string, FieldResult>;

  const fullName = str(f, 'fullName');
  const headline = str(f, 'headline');
  const currentCompany = str(f, 'currentCompany');
  const profileUrl = canonicalizeProfileUrl(str(f, 'profileUrl'));
  const currentTitle = str(f, 'currentTitle') ?? titleFromHeadline(headline);

  const { firstName, lastName } = splitName(fullName);

  const dedupeHash = await computeDedupeHash({
    profileUrl,
    fullName,
    currentCompany,
    fallbackSeed: `${card.profileId}:${card.pageNumber}:${card.cardIndex}:${card.extractedAt}`,
  });

  return {
    fullName,
    firstName,
    lastName,
    headline,
    currentTitle,
    currentCompany,
    tenureAtCompany: parseTenure(str(f, 'tenureAtCompany')),
    totalExperienceHint: str(f, 'totalExperienceHint'),
    location: str(f, 'location'),
    profileUrl,
    openToWork: toBoolean(str(f, 'openToWork')),
    mutualConnections: parseFirstInt(str(f, 'mutualConnections')),

    seniorityBucket: bucketSeniority(currentTitle),
    companyDomainGuess: guessCompanyDomain(currentCompany),

    email: null,
    emailStatus: null,

    extractionConfidence: coreConfidence(f),
    dedupeHash,
    exportedAt: opts.exportedAt ?? new Date().toISOString(),
  };
}
