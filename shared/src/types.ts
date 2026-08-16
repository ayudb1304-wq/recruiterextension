/**
 * The one true shapes. docs/04 §1, docs/03 §4.
 * NEVER duplicate CandidateRecord anywhere else (CLAUDE.md § Engineering conventions).
 */

// ─── Extraction primitives (docs/03 §4) ──────────────────────────────────────

export type StrategyTier = 1 | 2 | 3;
export type Confidence = 'high' | 'medium' | 'low';

/** Tier → confidence mapping is fixed: 1→high, 2→medium, 3→low. */
export const TIER_CONFIDENCE: Record<StrategyTier, Confidence> = {
  1: 'high',
  2: 'medium',
  3: 'low',
};

/**
 * Extraction NEVER throws on a missing field. A miss is `{value:null, tier:null}`,
 * never an exception (CLAUDE.md § Engineering conventions).
 */
export interface FieldResult<T = string> {
  value: T | null;
  confidence: Confidence;
  /** null = every strategy missed. */
  strategyTier: StrategyTier | null;
}

export const FIELD_NAMES = [
  'fullName',
  'headline',
  'currentTitle',
  'currentCompany',
  'tenureAtCompany',
  'totalExperienceHint',
  'location',
  'profileUrl',
  'openToWork',
  'mutualConnections',
] as const;

/** Fields the engine reads off the DOM. Derived fields are computed, not extracted. */
export type FieldName = (typeof FIELD_NAMES)[number];

/** Fields whose absence defines a low-confidence record (docs/04 §1). */
export const CORE_FIELDS: readonly FieldName[] = ['fullName', 'currentCompany', 'profileUrl'];

export interface ExtractedCard {
  fields: Record<FieldName, FieldResult>;
  cardIndex: number;
  pageNumber: number;
  /** ISO 8601 UTC */
  extractedAt: string;
  profileId: ProfileId;
  configVersion: string;
}

// ─── Page profiles (docs/03 §2) ──────────────────────────────────────────────

export const PROFILE_IDS = ['salesnav_people_search', 'recruiter_search'] as const;
export type ProfileId = (typeof PROFILE_IDS)[number];

// ─── CandidateRecord (docs/04 §1) ────────────────────────────────────────────

export type SeniorityBucket =
  | 'IC'
  | 'Senior'
  | 'Lead'
  | 'Manager'
  | 'Director'
  | 'VP'
  | 'CXO';

export type EmailStatus = 'verified' | 'risky' | 'not_found' | 'skipped';

export interface CandidateRecord {
  // extracted
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  headline: string | null;
  currentTitle: string | null;
  currentCompany: string | null;
  /** normalized "3y 2m" / "<1y" format (docs/04 §2) */
  tenureAtCompany: string | null;
  totalExperienceHint: string | null;
  location: string | null;
  profileUrl: string | null;
  openToWork: boolean | null;
  mutualConnections: number | null;
  // derived
  seniorityBucket: SeniorityBucket | null;
  companyDomainGuess: string | null;
  // enrichment (paid)
  email: string | null;
  emailStatus: EmailStatus | null;
  // meta
  /** min tier across CORE_FIELDS */
  extractionConfidence: Confidence;
  /** sha256, see docs/04 §3 */
  dedupeHash: string;
  /** ISO 8601 UTC */
  exportedAt: string;
}

/** Field order for the Generic preset (docs/04 §6) — interface order, snake_case. */
export const CANDIDATE_FIELD_ORDER: readonly (keyof CandidateRecord)[] = [
  'fullName',
  'firstName',
  'lastName',
  'headline',
  'currentTitle',
  'currentCompany',
  'tenureAtCompany',
  'totalExperienceHint',
  'location',
  'profileUrl',
  'openToWork',
  'mutualConnections',
  'seniorityBucket',
  'companyDomainGuess',
  'email',
  'emailStatus',
  'extractionConfidence',
  'dedupeHash',
  'exportedAt',
];

// ─── Plans & quota (docs/04 §7) ──────────────────────────────────────────────

export type Plan = 'free' | 'pro_monthly' | 'pro_annual';
export type SubscriptionStatus = 'active' | 'past_due' | 'cancelled';

export interface PlanLimits {
  rowsPerMonth: number;
  enrichedRowsPerMonth: number;
  rowsPerRolling24h: number;
}

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: { rowsPerMonth: 50, enrichedRowsPerMonth: 0, rowsPerRolling24h: 50 },
  pro_monthly: { rowsPerMonth: 2000, enrichedRowsPerMonth: 2000, rowsPerRolling24h: 1000 },
  pro_annual: { rowsPerMonth: 2000, enrichedRowsPerMonth: 2000, rowsPerRolling24h: 1000 },
};

// ─── Telemetry (docs/03 §9) ──────────────────────────────────────────────────

export const TELEMETRY_EVENTS = [
  'profile_detect_fail',
  'extraction_degraded',
  'extractor_exception',
  'config_invalid',
  'abort_platform_warning',
  'job_summary',
] as const;

export type TelemetryEventName = (typeof TELEMETRY_EVENTS)[number];

/**
 * Payloads carry counts, rates, versions and profile ids — NEVER scraped values,
 * search queries, or URLs (docs/03 §9, docs/08 §5). The backend drops any event
 * with unexpected keys.
 */
export interface TelemetryEvent {
  event: TelemetryEventName;
  profileId: ProfileId | 'unknown';
  configVersion: string | null;
  extensionVersion: string;
  /** ISO 8601 UTC */
  at: string;
  /** counts / rates only */
  metrics?: Record<string, number>;
  /** per-field miss counts, keyed by FieldName */
  fieldMisses?: Record<string, number>;
}
