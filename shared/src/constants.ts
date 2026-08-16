/** Numbers that both the extension and the backend must agree on. */

/**
 * Throttle + safety caps (docs/03 §6). Client-enforced AND server-verified.
 * CLAUDE.md guardrail 2: never "improve" these downward.
 */
export const THROTTLE = {
  /** uniform random pagination delay, ms */
  pageDelayMinMs: 2000,
  pageDelayMaxMs: 5000,
  /** 1-in-N chance of a longer "reading pause" */
  readingPauseChance: 8,
  readingPauseMinMs: 8000,
  readingPauseMaxMs: 15000,
  /** incremental scroll steps that mimic reading, not instant jumps */
  scrollStepMinPx: 300,
  scrollStepMaxPx: 800,
  scrollDelayMinMs: 150,
  scrollDelayMaxMs: 400,
  /** hard caps */
  maxPagesPerJob: 25,
  maxRowsPerRolling24h: 1000,
} as const;

/** UI default row cap (user-raisable to plan limit) — docs/06 §S2. */
export const DEFAULT_ROW_CAP = 100;

/** Cross-job dedupe ring buffer size in chrome.storage.local (docs/04 §3). */
export const DEDUPE_HISTORY_MAX = 25_000;

/** Selector config refresh cadence (chrome.alarms), minutes. */
export const CONFIG_REFRESH_MINUTES = 5;

/** Page-level extraction rate below which we emit `extraction_degraded` (docs/03 §4). */
export const EXTRACTION_DEGRADED_THRESHOLD = 0.8;

/** Health chip thresholds (docs/06 §S3). */
export const EXTRACTION_HEALTH = {
  green: 0.95,
  amber: 0.8,
} as const;

/** Quota reservation TTL (docs/05 §4). */
export const RESERVATION_TTL_MS = 2 * 60 * 60 * 1000;

/** Rate limits (docs/05 §8). */
export const RATE_LIMITS = {
  perUserPerMin: 60,
  perIpPerMin: 120,
  authLinkPerEmailPerHour: 3,
  authLinkPerIpPerHour: 10,
} as const;

/**
 * The complete permission set (CLAUDE.md guardrail 5, docs/08 §2).
 * Adding anything here requires updating docs/08 §2 and the CWS justification
 * text in docs/09. A unit test asserts this list has not drifted.
 */
export const MANIFEST_PERMISSIONS = [
  'storage',
  'sidePanel',
  'downloads',
  'identity',
  'alarms',
] as const;

export const HOST_PERMISSIONS = ['https://www.linkedin.com/*'] as const;

/** Magic-link token TTL (docs/05 §1). */
export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;

/** JWT lifetime (docs/05 §1). */
export const JWT_TTL_SECONDS = 30 * 24 * 60 * 60;
