import type { CandidateRecord } from '@recruitexport/shared';
import type { ComputedColumnId } from './types';

/**
 * Derived output columns. Pure functions of one record — a preset may only
 * reference one of these ids, never arbitrary logic (same data-not-code stance
 * as the selector config).
 */
export const COMPUTED: Record<ComputedColumnId, (r: CandidateRecord) => string> = {
  /** Greenhouse "Notes": headline + tenure, per docs/04 §6. */
  notes: (r) => [r.headline, r.tenureAtCompany].filter(Boolean).join(' · '),
  /** Lever "tags": seniority bucket. */
  tags: (r) => r.seniorityBucket ?? '',
  /** Lever "name": one field; fall back to the split parts if fullName missed. */
  fullNameOrParts: (r) =>
    r.fullName ?? [r.firstName, r.lastName].filter(Boolean).join(' '),
};
